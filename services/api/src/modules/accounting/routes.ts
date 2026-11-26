import { Router, type Request } from 'express';
import type { ClientSession, Document, ObjectId } from 'mongodb';
import { z } from 'zod';
import type { Deps } from '../../context';
import { AppError, Errors } from '../../lib/errors';
import { localDate } from '../../lib/time';
import { idParam, parse } from '../../lib/validate';
import { audit } from '../../middleware/audit';
import { need } from '../../middleware/authorize';
import { assertRecentMfa } from '../../middleware/session';
import { computeFinance } from '../intel/metrics';
import { CURRENCIES, balances, ensureChart, postEntry, reverseEntry, type Currency } from './ledger';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM');
const minor = z.number().int().min(0).max(1e13);
const NewAccount = z.object({ code: z.string().regex(/^\d{4}$/, 'Use a 4-digit code'), name: z.string().trim().min(2).max(80), type: z.enum(['asset', 'liability', 'equity', 'revenue', 'expense']) });
const Journal = z.object({
  postingDate: day,
  currency: z.enum(CURRENCIES),
  memo: z.string().trim().min(3).max(300),
  lines: z.array(z.object({ accountCode: z.string().regex(/^\d{4}$/), debitMinor: minor.default(0), creditMinor: minor.default(0), costCenter: z.string().trim().max(30).optional() })).min(2).max(50),
});
const Reason = z.object({ reason: z.string().trim().min(5).max(300) });
const Report = z.object({ period: month, currency: z.enum(CURRENCIES).default('USD') });

const id = (x: { _id: ObjectId }) => x._id.toHexString();

/** Spec §5.20 accounting: Draft → Approved → Posted → Reversed; balanced; closed periods immutable. */
export function accountingRoutes(deps: Deps): Router {
  const r = Router();
  const db = (req: Request) => req.actor!.db!;
  const today = () => localDate(deps.config.now(), 'Africa/Mogadishu');

  async function txn<T>(fn: (s: ClientSession) => Promise<T>): Promise<T> {
    const s = deps.data.client.startSession();
    try {
      let out: T | undefined;
      await s.withTransaction(async () => {
        out = await fn(s);
      });
      return out as T;
    } finally {
      await s.endSession();
    }
  }

  r.get('/accounts', need(deps, 'acct', 'V'), async (req, res) => {
    await ensureChart(db(req), req.actor!.tenantId!);
    const list = await db(req).collection('accounts').find({ tenantId: req.actor!.tenantId }).sort({ code: 1 }).toArray();
    res.json({ data: list.map((a) => ({ code: a.code, name: a.name, type: a.type, system: Boolean(a.system), active: a.active })) });
  });

  r.post('/accounts', need(deps, 'acct', 'A'), async (req, res) => {
    const body = parse(NewAccount, req.body);
    await ensureChart(db(req), req.actor!.tenantId!);
    try {
      await db(req).collection('accounts').insertOne({ tenantId: req.actor!.tenantId, ...body, system: false, active: true, createdAt: new Date() });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw Errors.conflict('ACCOUNT_EXISTS', `Account ${body.code} already exists`);
      throw e;
    }
    await audit(deps, req, { action: 'acct.account.create', resource: `account:${body.code}`, outcome: 'success' });
    res.status(201).json({ data: body });
  });

  // ---- manual journals: drafted by an accountant, approved by someone else ----
  r.post('/journals', need(deps, 'acct', 'E'), async (req, res) => {
    const body = parse(Journal, req.body);
    const dr = body.lines.reduce((n, l) => n + l.debitMinor, 0);
    const cr = body.lines.reduce((n, l) => n + l.creditMinor, 0);
    if (dr !== cr || !dr) throw new AppError(409, 'UNBALANCED_ENTRY', `Debits (${dr}) must equal credits (${cr})`);
    const ins = await db(req).collection('journal_drafts').insertOne({ tenantId: req.actor!.tenantId, ...body, status: 'Draft', createdBy: req.actor!.userId, createdAt: new Date() });
    res.status(201).json({ data: { id: ins.insertedId.toHexString(), status: 'Draft' } });
  });

  r.get('/journals/drafts', need(deps, 'acct', 'V'), async (req, res) => {
    const list = await db(req).collection('journal_drafts').find({ tenantId: req.actor!.tenantId, status: 'Draft' }).sort({ createdAt: 1 }).limit(200).toArray();
    const users = await db(req).collection('users').find({ _id: { $in: list.map((d) => d.createdBy) } }, { projection: { name: 1 } }).toArray();
    res.json({
      data: list.map((d) => ({ id: id(d), postingDate: d.postingDate, currency: d.currency, memo: d.memo, lines: d.lines, totalMinor: (d.lines as { debitMinor: number }[]).reduce((n, l) => n + l.debitMinor, 0), mine: d.createdBy.equals(req.actor!.userId), createdByName: users.find((u) => u._id.equals(d.createdBy))?.name ?? null })),
    });
  });

  r.post('/journals/:id/approve', need(deps, 'acct', 'S'), async (req, res) => {
    const d = await db(req).collection('journal_drafts').findOne({ _id: idParam(req.params.id, 'Journal'), tenantId: req.actor!.tenantId });
    if (!d) throw Errors.notFound('Journal');
    const a = req.actor!;
    if (d.createdBy.equals(a.userId)) throw new AppError(403, 'FOUR_EYES', 'Segregation of duties: someone else approves your journal');
    assertRecentMfa(deps, req);
    if (d.status !== 'Draft') throw Errors.conflict('INVALID_TRANSITION', `Journal is ${String(d.status).toLowerCase()}`);
    const entryId = await txn(async (s) => {
      const eid = await postEntry(db(req), s, { tenantId: a.tenantId!, postingDate: d.postingDate, currency: d.currency, memo: d.memo, lines: d.lines, source: { type: 'manual', id: id(d), kind: 'journal' }, by: a.userId });
      await db(req).collection('journal_drafts').updateOne({ _id: d._id, status: 'Draft' }, { $set: { status: 'Posted', approvedBy: a.userId, entryId: eid } }, { session: s });
      return eid;
    });
    await audit(deps, req, { action: 'acct.journal.post', resource: `journal_entry:${entryId.toHexString()}`, outcome: 'success' });
    res.json({ data: { id: id(d), status: 'Posted', entryId: entryId.toHexString() } });
  });

  r.get('/journals', need(deps, 'acct', 'V'), async (req, res) => {
    const q = parse(z.object({ period: month.optional(), currency: z.enum(CURRENCIES).optional() }), req.query);
    const f: Document = { tenantId: req.actor!.tenantId };
    if (q.period) f.periodKey = q.period;
    if (q.currency) f.currency = q.currency;
    const list = await db(req).collection('journal_entries').find(f).sort({ postingDate: -1, entryNo: -1 }).limit(500).toArray();
    res.json({
      data: list.map((j) => ({ id: id(j), entryNo: j.entryNo, postingDate: j.postingDate, currency: j.currency, memo: j.memo, totalMinor: j.totalMinor, state: j.state, source: j.source, lines: j.lines, reversalOf: j.reversalOf?.toHexString() ?? null })),
    });
  });

  r.post('/journals/:id/reverse', need(deps, 'acct', 'S'), async (req, res) => {
    const { reason } = parse(Reason, req.body);
    assertRecentMfa(deps, req);
    const a = req.actor!;
    const rid = await txn((s) => reverseEntry(db(req), s, { tenantId: a.tenantId!, entryId: idParam(req.params.id, 'Journal entry'), postingDate: today(), reason, by: a.userId }));
    await audit(deps, req, { action: 'acct.journal.reverse', resource: `journal_entry:${req.params.id}`, outcome: 'success', meta: { reason } });
    res.json({ data: { reversalId: rid.toHexString() } });
  });

  // ---- periods ----
  r.get('/periods', need(deps, 'acct', 'V'), async (req, res) => {
    const list = await db(req).collection('periods').find({ tenantId: req.actor!.tenantId }).sort({ key: -1 }).toArray();
    res.json({ data: list.map((p) => ({ key: p.key, status: p.status, closedAt: p.closedAt ?? null })) });
  });

  /** Closing is final: no reopen endpoint exists; corrections go into the next open period. */
  r.post('/periods/:key/close', need(deps, 'acct', 'A'), async (req, res) => {
    const key = parse(month, req.params.key);
    assertRecentMfa(deps, req);
    if (key >= today().slice(0, 7)) throw Errors.validation([{ path: 'key', message: 'Only past months can be closed' }]);
    const a = req.actor!;
    const tb = await balances(db(req), a.tenantId!, 'USD', { periodKey: key });
    const dr = tb.reduce((n, x) => n + x.debitMinor, 0);
    const cr = tb.reduce((n, x) => n + x.creditMinor, 0);
    if (dr !== cr) throw new AppError(409, 'TRIAL_BALANCE_OFF', 'The trial balance does not balance; investigate before closing');
    const existing = await db(req).collection('periods').findOne({ tenantId: a.tenantId, key });
    if (existing?.status === 'closed') throw Errors.conflict('PERIOD_CLOSED', `${key} is already closed`);
    try {
      await db(req).collection('periods').updateOne({ tenantId: a.tenantId, key, status: { $ne: 'closed' } }, { $set: { status: 'closed', closedAt: new Date(), closedBy: a.userId } }, { upsert: true });
    } catch (e) {
      // Two people closing at once: the unique index lets one win; the other gets a clear answer, not a 500.
      if ((e as { code?: number }).code === 11000) throw Errors.conflict('PERIOD_CLOSED', `${key} is already closed`);
      throw e;
    }
    await audit(deps, req, { action: 'acct.period.close', resource: `period:${key}`, outcome: 'success' });
    res.json({ data: { key, status: 'closed' } });
  });

  // ---- reports ----
  r.get('/trial-balance', need(deps, 'acct', 'V'), async (req, res) => {
    const q = parse(z.object({ currency: z.enum(CURRENCIES).default('USD'), upTo: day.optional() }), req.query);
    const rows = await balances(db(req), req.actor!.tenantId!, q.currency as Currency, { upTo: q.upTo });
    const dr = rows.reduce((n, x) => n + x.debitMinor, 0);
    const cr = rows.reduce((n, x) => n + x.creditMinor, 0);
    res.json({ data: { rows, totalDebitMinor: dr, totalCreditMinor: cr, balanced: dr === cr } });
  });

  /**
   * Spec §9.4 exact financial metrics for one month. Billed, recognised and collected are different numbers;
   * cash collected is never reported as revenue.
   */
  r.get('/summary', need(deps, 'acct', 'V'), async (req, res) => {
    const q = parse(Report, req.query);
    // One implementation of the certified finance metrics serves this report and the AI layer (spec §5.30).
    const f = await computeFinance(db(req), req.actor!.tenantId!, q.period, q.currency as Currency);
    const m = f.metrics;
    res.json({
      data: {
        period: q.period,
        currency: q.currency,
        grossBilledMinor: m['fin.grossBilled'],
        netBilledMinor: m['fin.netBilled'],
        cashCollectedMinor: m['fin.cashCollected'],
        accountsReceivableMinor: m['fin.accountsReceivable'],
        recognizedRevenueMinor: m['fin.recognizedRevenue'],
        operatingExpensesMinor: m['fin.operatingExpenses'],
        operatingResultMinor: m['fin.operatingResult'],
        metricVersion: 'finance-v1',
      },
    });
  });

  return r;
}
