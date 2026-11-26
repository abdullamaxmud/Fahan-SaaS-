import { createHmac } from 'node:crypto';
import { Router, type Request } from 'express';
import type { Document, ObjectId } from 'mongodb';
import { z } from 'zod';
import { can } from '@fahan/policy';
import type { Deps } from '../../context';
import { AppError, Errors } from '../../lib/errors';
import { localDate } from '../../lib/time';
import { idParam, parse } from '../../lib/validate';
import { audit } from '../../middleware/audit';
import { deny, need } from '../../middleware/authorize';
import { assertRecentMfa } from '../../middleware/session';
import { CURRENCIES, type Currency } from '../accounting/ledger';
import { AI_DISCLOSURE, snapshotIntact, writeInsight } from './insights';
import { canonical, factsHash, hospitalTz, metricDef } from './metrics';
import { captureSnapshot } from './snapshots';

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM');
const id = (x: Document) => (x._id as ObjectId).toHexString();

type Cell = { metricId: string; label: string; unit: string; value: number | null; snapshotId: string; unavailable?: string };

/**
 * Spec §5.32 / §9.5 / §9.8 — monthly Hospital 360 report: Queued → Built → Reviewed → Approved → Published.
 * Built only from certified snapshots; every figure cites its metric id and snapshot; human sign-off by finance and
 * clinical reviewers and the owner; the published version is hashed and signed and never edited (corrections are new versions).
 */
export function h360Routes(deps: Deps): Router {
  const r = Router();
  const db = (req: Request) => req.actor!.db!;
  const sign = (hash: string) => createHmac('sha256', deps.config.dataKey).update(`h360:${hash}`).digest('hex');

  const cellsFrom = (snap: Document, ids: string[]): Cell[] =>
    ids.map((mid) => {
      const v = (snap.facts.metrics as Record<string, number | null>)[mid];
      const d = metricDef(mid);
      const unavailable = (snap.facts.unavailable as Record<string, string> | undefined)?.[mid];
      return { metricId: mid, label: d?.label ?? mid, unit: d?.unit ?? 'count', value: v ?? null, snapshotId: id(snap), ...(v === null || v === undefined ? { unavailable: unavailable ?? 'Not recorded for this month.' } : {}) };
    });

  async function build(req: Request, period: string, currency: Currency) {
    const a = req.actor!;
    const fin = await captureSnapshot(deps, req, 'finance', period, currency);
    const dis = await captureSnapshot(deps, req, 'disease', period, currency);
    const ops = await captureSnapshot(deps, req, 'operations', period, currency);
    const finText = await writeInsight(req, fin);
    const disText = await writeInsight(req, dis);
    const tenant = await deps.data.control().collection('tenants').findOne({ _id: a.tenantId }, { projection: { name: 1 } });
    const branches = await db(req).collection('branches').find({ tenantId: a.tenantId }, { projection: { code: 1, name: 1 } }).sort({ code: 1 }).toArray();
    const content = {
      cover: { organisation: tenant?.name ?? '', facilities: branches.map((b) => `${b.code} · ${b.name}`), period, currency, timezone: await hospitalTz(db(req), a.tenantId!) },
      executive: [
        ...cellsFrom(ops, ['ops.admissions', 'ops.occupancy', 'ops.opdVisits', 'ops.erVisits', 'ops.labTatMedian', 'ops.imagingBacklog']),
        ...cellsFrom(fin, ['fin.recognizedRevenue', 'fin.operatingExpenses', 'fin.cashCollected']),
      ],
      financial: {
        metrics: cellsFrom(fin, ['fin.grossBilled', 'fin.netBilled', 'fin.discounts', 'fin.refundsPaid', 'fin.accountsReceivable', 'fin.operatingResult']),
        revenueMix: fin.facts.revenueMix,
        expenseMix: fin.facts.expenseMix,
        budget: { unavailable: 'No budget has been set for this month.' },
      },
      clinical: {
        topConditions: (dis.facts.rows as Document[]).filter((x) => typeof x.confirmedPatients === 'number' && x.confirmedPatients > 0).slice(0, 10).map((x) => ({ code: x.code, display: x.display, confirmedPatients: x.confirmedPatients, newPatients: x.newPatients, suspectedPatients: x.suspectedPatients, snapshotId: id(dis) })),
        countingMethod: metricDef('dis.confirmedPatients')!.definition,
        suppressedCells: dis.facts.suppressedCells,
        readmissions: { unavailable: 'Readmission measures are not defined yet.' },
      },
      operations: cellsFrom(ops, ['ops.alos', 'ops.discharges', 'ops.labReleased', 'ops.dispenses', 'ops.stockouts', 'ops.purchaseOrdersApproved', 'ops.equipmentOutOfService', 'ops.rosterGaps']),
      quality: cellsFrom(ops, ['ops.criticalAckMedian', 'ops.qualityIncidents']),
      narrative: {
        disclosure: AI_DISCLOSURE,
        finance: finText.narrative,
        clinical: disText.narrative,
        citedFacts: [...finText.citedFacts, ...disText.citedFacts],
      },
      sources: [fin, dis, ops].map((s) => ({ snapshotId: id(s), kind: s.kind, seq: s.seq, hash: s.hash, metricVersion: s.metricVersion })),
    };
    const ok = finText.check.ok && disText.check.ok;
    return { content, check: { ok, finance: finText.check, clinical: disText.check }, sources: [fin._id, dis._id, ops._id] as ObjectId[] };
  }

  const view = (x: Document, full = true) => ({
    id: id(x),
    period: x.period,
    currency: x.currency,
    version: x.version,
    status: x.status,
    contentHash: x.contentHash,
    signature: x.signature ?? null,
    signoffs: x.signoffs,
    check: x.check,
    history: (x.history as Document[]).map((h) => ({ at: h.at, action: h.action, byName: h.byName, note: h.note ?? null })),
    builtAt: x.builtAt,
    ...(full ? { content: x.content } : {}),
  });

  async function load(req: Request) {
    const x = await db(req).collection('h360_reports').findOne({ _id: idParam(req.params.id, 'Report'), tenantId: req.actor!.tenantId });
    if (!x) throw Errors.notFound('Report');
    return x;
  }

  r.get('/', need(deps, 'ai360', 'V'), async (req, res) => {
    const list = await db(req).collection('h360_reports').find({ tenantId: req.actor!.tenantId }).sort({ period: -1, version: -1 }).limit(60).toArray();
    res.json({ data: list.map((x) => view(x, false)) });
  });

  r.get('/:id', need(deps, 'ai360', 'V'), async (req, res) => {
    res.json({ data: view(await load(req)) });
  });

  r.post('/', need(deps, 'ai360', 'S'), async (req, res) => {
    const body = parse(z.object({ period: month, currency: z.enum(CURRENCIES).default('USD') }), req.body);
    const a = req.actor!;
    const tz = await hospitalTz(db(req), a.tenantId!);
    if (body.period > localDate(deps.config.now(), tz).slice(0, 7)) throw Errors.validation([{ path: 'period', message: 'That month has not started yet' }]);
    const { content, check, sources } = await build(req, body.period, body.currency as Currency);
    const contentHash = factsHash(content);
    const latest = await db(req).collection('h360_reports').findOne({ tenantId: a.tenantId, period: body.period, currency: body.currency }, { sort: { version: -1 } });
    const doc = {
      tenantId: a.tenantId,
      period: body.period,
      currency: body.currency,
      version: ((latest?.version as number) ?? 0) + 1,
      previousVersion: latest?._id ?? null,
      status: check.ok ? 'Built' : 'Failed',
      content,
      contentHash,
      sources,
      check,
      signoffs: { finance: null, clinical: null, owner: null },
      history: [{ at: new Date(), action: check.ok ? 'built' : 'failed-check', by: a.userId, byName: a.name }],
      builtAt: new Date(),
      builtBy: a.userId,
    };
    const ins = await db(req).collection('h360_reports').insertOne(doc);
    await audit(deps, req, { action: 'ai360.build', resource: `h360:${ins.insertedId.toHexString()}`, outcome: 'success', meta: { period: body.period, version: doc.version, checkOk: check.ok } });
    res.status(201).json({ data: view({ _id: ins.insertedId, ...doc }) });
  });

  async function guardSources(req: Request, x: Document) {
    for (const sid of x.sources as ObjectId[]) {
      const s = await db(req).collection('metric_snapshots').findOne({ _id: sid }, { projection: { hash: 1 } });
      if (!s || !(await snapshotIntact(req, sid, s.hash as string))) throw new AppError(409, 'SNAPSHOT_TAMPERED', 'A source snapshot no longer matches its fingerprint; rebuild the report');
    }
    if (factsHash(x.content) !== x.contentHash) throw new AppError(409, 'REPORT_TAMPERED', 'The stored report no longer matches its fingerprint');
  }

  /** Section sign-off: finance by a finance approver, clinical by a clinical reviewer; nobody signs both. */
  r.post('/:id/signoff', need(deps, 'ai360', 'S'), async (req, res) => {
    const body = parse(z.object({ section: z.enum(['finance', 'clinical']), note: z.string().trim().max(500).optional() }), req.body);
    const x = await load(req);
    const a = req.actor!;
    if (x.status !== 'Built') throw Errors.conflict('INVALID_TRANSITION', `Report is ${String(x.status).toLowerCase()}`);
    const qualified = body.section === 'finance' ? can(a.perms, 'acct', 'S') : can(a.perms, 'aidis', 'V');
    if (!qualified) await deny(deps, req, `h360:${id(x)}`, `${body.section} sign-off needs a ${body.section} reviewer`);
    const other = body.section === 'finance' ? x.signoffs.clinical : x.signoffs.finance;
    if (other && (other.by as ObjectId).equals(a.userId)) throw new AppError(403, 'FOUR_EYES', 'One person cannot sign both sections');
    if (x.signoffs[body.section]) throw Errors.conflict('ALREADY_SIGNED', `The ${body.section} section is already signed`);
    await guardSources(req, x);
    const both = Boolean(other);
    const upd = await db(req).collection('h360_reports').updateOne(
      { _id: x._id, status: 'Built', [`signoffs.${body.section}`]: null },
      { $set: { [`signoffs.${body.section}`]: { by: a.userId, byName: a.name, at: new Date(), note: body.note ?? null }, ...(both ? { status: 'Reviewed' } : {}) }, $push: { history: { at: new Date(), action: `${body.section}-signed`, by: a.userId, byName: a.name, note: body.note } } as Document },
    );
    if (!upd.modifiedCount) throw Errors.conflict('INVALID_TRANSITION', 'Someone else signed meanwhile');
    await audit(deps, req, { action: `ai360.signoff.${body.section}`, resource: `h360:${id(x)}`, outcome: 'success' });
    res.json({ data: { id: id(x), status: both ? 'Reviewed' : 'Built' } });
  });

  r.post('/:id/approve', need(deps, 'ai360', 'A'), async (req, res) => {
    const { note } = parse(z.object({ note: z.string().trim().max(500).optional() }), req.body);
    const x = await load(req);
    const a = req.actor!;
    assertRecentMfa(deps, req);
    if (x.status !== 'Reviewed') throw Errors.conflict('INVALID_TRANSITION', 'Both sections are signed before the owner approves');
    await guardSources(req, x);
    const upd = await db(req).collection('h360_reports').updateOne({ _id: x._id, status: 'Reviewed' }, { $set: { status: 'Approved', 'signoffs.owner': { by: a.userId, byName: a.name, at: new Date(), note: note ?? null } }, $push: { history: { at: new Date(), action: 'approved', by: a.userId, byName: a.name, note } } as Document });
    if (!upd.modifiedCount) throw Errors.conflict('INVALID_TRANSITION', 'Report changed meanwhile');
    await audit(deps, req, { action: 'ai360.approve', resource: `h360:${id(x)}`, outcome: 'success' });
    res.json({ data: { id: id(x), status: 'Approved' } });
  });

  r.post('/:id/publish', need(deps, 'ai360', 'A'), async (req, res) => {
    const x = await load(req);
    const a = req.actor!;
    assertRecentMfa(deps, req);
    if (x.status !== 'Approved') throw Errors.conflict('INVALID_TRANSITION', 'Only approved reports are published');
    await guardSources(req, x);
    const signature = sign(x.contentHash);
    const upd = await db(req).collection('h360_reports').updateOne({ _id: x._id, status: 'Approved' }, { $set: { status: 'Published', signature, publishedAt: new Date() }, $push: { history: { at: new Date(), action: 'published', by: a.userId, byName: a.name } } as Document });
    if (!upd.modifiedCount) throw Errors.conflict('INVALID_TRANSITION', 'Report changed meanwhile');
    // A correction replaces the earlier published version; the old one stays readable, marked superseded.
    await db(req).collection('h360_reports').updateMany({ tenantId: a.tenantId, period: x.period, currency: x.currency, status: 'Published', _id: { $ne: x._id } }, { $set: { status: 'Superseded', supersededBy: x._id } });
    await audit(deps, req, { action: 'ai360.publish', resource: `h360:${id(x)}`, outcome: 'success', meta: { period: x.period as string, version: x.version as number } });
    res.json({ data: { id: id(x), status: 'Published', signature } });
  });

  r.post('/:id/reject', need(deps, 'ai360', 'S'), async (req, res) => {
    const { note } = parse(z.object({ note: z.string().trim().min(5).max(500) }), req.body);
    const x = await load(req);
    const a = req.actor!;
    const upd = await db(req).collection('h360_reports').updateOne({ _id: x._id, status: { $in: ['Built', 'Reviewed', 'Approved'] } }, { $set: { status: 'Rejected' }, $push: { history: { at: new Date(), action: 'rejected', by: a.userId, byName: a.name, note } } as Document });
    if (!upd.modifiedCount) throw Errors.conflict('INVALID_TRANSITION', 'Published reports are corrected by a new version, not rejected');
    await audit(deps, req, { action: 'ai360.reject', resource: `h360:${id(x)}`, outcome: 'success' });
    res.json({ data: { id: id(x), status: 'Rejected' } });
  });

  /** Export manifest (spec §9.6): content, fingerprint, signature, sign-offs. Published reports only; audited. */
  r.get('/:id/export', need(deps, 'ai360', 'V'), async (req, res) => {
    const x = await load(req);
    if (!['Published', 'Superseded'].includes(x.status)) throw Errors.conflict('NOT_PUBLISHED', 'Only published reports are exported');
    await audit(deps, req, { action: 'ai360.export', resource: `h360:${id(x)}`, outcome: 'success', meta: { version: x.version as number } });
    res.setHeader('content-disposition', `attachment; filename="hospital-360-${x.period}-v${x.version}.json"`);
    res.json({ data: { manifest: { format: 'fahan-h360-v1', period: x.period, currency: x.currency, version: x.version, status: x.status, contentHash: x.contentHash, signature: x.signature, signoffs: x.signoffs, exportedAt: new Date(), exportedBy: req.actor!.name }, content: x.content } });
  });

  r.get('/:id/verify', need(deps, 'ai360', 'V'), async (req, res) => {
    const x = await load(req);
    const hashOk = factsHash(x.content) === x.contentHash;
    res.json({ data: { id: id(x), contentIntact: hashOk, signatureValid: Boolean(x.signature) && x.signature === sign(x.contentHash), canonicalLength: canonical(x.content).length } });
  });

  return r;
}
