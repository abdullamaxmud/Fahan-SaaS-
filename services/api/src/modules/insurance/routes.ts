import { Router, type Request } from 'express';
import type { ClientSession, Document, ObjectId } from 'mongodb';
import { z } from 'zod';
import type { Deps } from '../../context';
import { AppError, Errors } from '../../lib/errors';
import { localDate } from '../../lib/time';
import { idParam, objectId, parse } from '../../lib/validate';
import { audit } from '../../middleware/audit';
import { assertBranch, need } from '../../middleware/authorize';
import { CURRENCIES, postEntry, type Currency } from '../accounting/ledger';
import { loadPatient } from '../patients/access';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const minor = z.number().int().min(0).max(1e12);
export const DENIAL_CODES = ['not-covered', 'policy-inactive', 'missing-documents', 'pre-authorisation-missing', 'duplicate-claim', 'limit-exceeded', 'coding-error', 'other'] as const;

const NewPayer = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,20}$/),
  name: z.string().trim().min(2).max(120),
  kind: z.enum(['insurer', 'employer', 'ngo', 'government']),
  currency: z.enum(CURRENCIES),
  paymentTermsDays: z.number().int().min(0).max(365).default(30),
});
const NewPolicy = z.object({
  patientId: objectId,
  payerId: objectId,
  memberNumber: z.string().trim().min(2).max(40),
  coveragePercent: z.number().int().min(1).max(100),
  validFrom: day,
  validTo: day,
});
const NewClaim = z.object({ invoiceId: objectId, policyId: objectId, preAuthorisation: z.string().trim().max(60).optional() });
const Respond = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('accept'), approvedMinor: minor, denialCode: z.enum(DENIAL_CODES).optional(), note: z.string().trim().max(300).optional() }),
  z.object({ decision: z.literal('reject'), denialCode: z.enum(DENIAL_CODES), note: z.string().trim().min(5).max(300) }),
]);
const Remit = z.object({ amountMinor: minor, reference: z.string().trim().min(3).max(60), shortPayReason: z.string().trim().min(5).max(300).optional() });

const id = (x: { _id: ObjectId }) => x._id.toHexString();

/**
 * Spec §5.20 insurance & claims. Submitting moves the claimed amount from patient to insurer receivable and holds it on
 * the invoice; a denial gives it back to the patient; remittance settles it; a short payment is written off with a reason.
 */
export function insuranceRoutes(deps: Deps): Router {
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

  /** Moves money between patient (1100) and insurer (1110) receivable and adjusts the invoice hold, in one step. */
  async function transfer(req: Request, s: ClientSession, claim: Document, kind: string, amount: number, toInsurer: boolean) {
    if (amount <= 0) return;
    await postEntry(db(req), s, {
      tenantId: req.actor!.tenantId!,
      postingDate: today(),
      currency: claim.currency as Currency,
      memo: `Claim ${claim.claimNumber} ${kind}`,
      lines: toInsurer
        ? [{ accountCode: '1110', debitMinor: amount }, { accountCode: '1100', creditMinor: amount }]
        : [{ accountCode: '1100', debitMinor: amount }, { accountCode: '1110', creditMinor: amount }],
      source: { type: 'claim', id: id(claim as { _id: ObjectId }), kind },
      by: req.actor!.userId,
    });
    await db(req).collection('invoices').updateOne({ _id: claim.invoiceId }, { $inc: { insuranceHoldMinor: toInsurer ? amount : -amount, version: 1 } }, { session: s });
  }

  async function loadClaim(req: Request) {
    const c = await db(req).collection('claims').findOne({ _id: idParam(req.params.id, 'Claim'), tenantId: req.actor!.tenantId });
    if (!c) throw Errors.notFound('Claim');
    await assertBranch(deps, req, c.branchId);
    return c;
  }

  const claimView = (c: Document) => ({
    id: id(c as { _id: ObjectId }),
    claimNumber: c.claimNumber,
    status: c.status,
    invoiceId: c.invoiceId.toHexString(),
    invoiceNumber: c.invoiceNumber,
    patientId: c.patientId.toHexString(),
    payerName: c.payerName,
    memberNumber: c.memberNumber,
    currency: c.currency,
    claimedMinor: c.claimedMinor,
    approvedMinor: c.approvedMinor ?? null,
    remittedMinor: c.remittedMinor ?? 0,
    writtenOffMinor: c.writtenOffMinor ?? 0,
    denialCode: c.denialCode ?? null,
    submittedOn: c.submittedOn ?? null,
    createdAt: c.createdAt,
  });

  // ---- payers and policies ----
  r.get('/payers', need(deps, 'ins', 'V'), async (req, res) => {
    const list = await db(req).collection('payers').find({ tenantId: req.actor!.tenantId, active: true }).sort({ name: 1 }).toArray();
    res.json({ data: list.map((p) => ({ id: id(p), code: p.code, name: p.name, kind: p.kind, currency: p.currency, paymentTermsDays: p.paymentTermsDays })) });
  });

  r.post('/payers', need(deps, 'ins', 'S'), async (req, res) => {
    const body = parse(NewPayer, req.body);
    try {
      const ins = await db(req).collection('payers').insertOne({ tenantId: req.actor!.tenantId, ...body, active: true, createdAt: new Date(), createdBy: req.actor!.userId });
      await audit(deps, req, { action: 'ins.payer.create', resource: `payer:${ins.insertedId.toHexString()}`, outcome: 'success', meta: { code: body.code } });
      res.status(201).json({ data: { id: ins.insertedId.toHexString() } });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw Errors.conflict('PAYER_EXISTS', `Payer ${body.code} already exists`);
      throw e;
    }
  });

  r.get('/policies', need(deps, 'ins', 'V'), async (req, res) => {
    const q = parse(z.object({ patientId: objectId }), req.query);
    await loadPatient(deps, req, q.patientId);
    const list = await db(req).collection('policies').find({ tenantId: req.actor!.tenantId, patientId: q.patientId }).sort({ validTo: -1 }).toArray();
    res.json({ data: list.map((p) => ({ id: id(p), payerId: p.payerId.toHexString(), payerName: p.payerName, memberNumber: p.memberNumber, coveragePercent: p.coveragePercent, validFrom: p.validFrom, validTo: p.validTo, active: p.validFrom <= today() && p.validTo >= today() })) });
  });

  r.post('/policies', need(deps, 'ins', 'E'), async (req, res) => {
    const body = parse(NewPolicy, req.body);
    if (body.validTo < body.validFrom) throw Errors.validation([{ path: 'validTo', message: 'The policy must end after it starts' }]);
    const p = await loadPatient(deps, req, body.patientId);
    const payer = await db(req).collection('payers').findOne({ _id: body.payerId, tenantId: req.actor!.tenantId, active: true });
    if (!payer) throw Errors.notFound('Payer');
    const ins = await db(req).collection('policies').insertOne({ tenantId: req.actor!.tenantId, ...body, patientId: p._id, payerName: payer.name, createdAt: new Date(), createdBy: req.actor!.userId });
    await audit(deps, req, { action: 'ins.policy.create', resource: `patient:${id(p)}`, outcome: 'success', meta: { payer: payer.code } });
    res.status(201).json({ data: { id: ins.insertedId.toHexString() } });
  });

  // ---- claims ----
  r.post('/claims', need(deps, 'ins', 'E'), async (req, res) => {
    const body = parse(NewClaim, req.body);
    const a = req.actor!;
    const inv = await db(req).collection('invoices').findOne({ _id: body.invoiceId, tenantId: a.tenantId });
    if (!inv) throw Errors.notFound('Invoice');
    await assertBranch(deps, req, inv.branchId);
    if (!['Issued', 'PartiallyPaid'].includes(inv.status)) throw Errors.conflict('NOT_CLAIMABLE', 'Only issued invoices with a balance can be claimed');
    const pol = await db(req).collection('policies').findOne({ _id: body.policyId, tenantId: a.tenantId, patientId: inv.patientId });
    if (!pol) throw Errors.notFound('Policy for this patient');
    if (pol.validFrom > inv.issuedOn || pol.validTo < inv.issuedOn) throw new AppError(409, 'POLICY_INACTIVE', 'The policy did not cover the invoice date');
    const payer = await db(req).collection('payers').findOne({ _id: pol.payerId });
    if (payer!.currency !== inv.currency) throw Errors.validation([{ path: 'policyId', message: `This payer settles in ${payer!.currency}` }]);
    const covered = Math.floor((inv.totalMinor * pol.coveragePercent) / 100);
    const patientDue = inv.balanceMinor - (inv.insuranceHoldMinor ?? 0);
    const claimed = Math.min(covered, patientDue);
    if (claimed <= 0) throw Errors.conflict('NOTHING_TO_CLAIM', 'Nothing on this invoice is left for the insurer to pay');
    const y = today().slice(0, 4);
    try {
      const out = await txn(async (s) => {
        const c = await db(req).collection<{ _id: string; seq: number }>('counters').findOneAndUpdate({ _id: `clm:${y}` }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after', session: s });
        const claimNumber = `CLM-${y}-${String(c!.seq).padStart(6, '0')}`;
        const ins = await db(req).collection('claims').insertOne(
          {
            tenantId: a.tenantId,
            branchId: inv.branchId,
            claimNumber,
            invoiceId: inv._id,
            invoiceNumber: inv.invoiceNumber,
            patientId: inv.patientId,
            policyId: pol._id,
            payerId: pol.payerId,
            payerName: pol.payerName,
            memberNumber: pol.memberNumber,
            preAuthorisation: body.preAuthorisation,
            currency: inv.currency,
            lines: inv.lines,
            claimedMinor: claimed,
            status: 'Draft',
            open: true,
            createdBy: a.userId,
            createdAt: new Date(),
          },
          { session: s },
        );
        return { id: ins.insertedId.toHexString(), claimNumber };
      });
      res.status(201).json({ data: { ...out, claimedMinor: claimed, status: 'Draft' } });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw Errors.conflict('CLAIM_OPEN', 'This invoice already has an open claim');
      throw e;
    }
  });

  r.get('/claims', need(deps, 'ins', 'V'), async (req, res) => {
    const q = parse(z.object({ status: z.enum(['Draft', 'Submitted', 'Accepted', 'Rejected', 'Settled']).optional(), invoiceId: objectId.optional() }), req.query);
    const f: Document = { tenantId: req.actor!.tenantId };
    if (q.status) f.status = q.status;
    if (q.invoiceId) f.invoiceId = q.invoiceId;
    const list = await db(req).collection('claims').find(f).sort({ createdAt: -1 }).limit(300).toArray();
    res.json({ data: list.map(claimView) });
  });

  r.get('/claims/:id', need(deps, 'ins', 'V'), async (req, res) => {
    const c = await loadClaim(req);
    res.json({ data: { ...claimView(c), lines: c.lines, history: c.history ?? [] } });
  });

  r.post('/claims/:id/submit', need(deps, 'ins', 'S'), async (req, res) => {
    const c = await loadClaim(req);
    if (c.status !== 'Draft') throw Errors.conflict('INVALID_TRANSITION', `Claim is ${String(c.status).toLowerCase()}`);
    await txn(async (s) => {
      // Re-check the patient part inside the transaction: a cashier may have taken money meanwhile.
      const inv = await db(req).collection('invoices').findOne({ _id: c.invoiceId }, { session: s });
      if (!inv || inv.balanceMinor - (inv.insuranceHoldMinor ?? 0) < c.claimedMinor) throw Errors.conflict('NOTHING_TO_CLAIM', 'The patient has paid part of this since the claim was drafted; draft it again');
      const upd = await db(req).collection('claims').updateOne({ _id: c._id, status: 'Draft' }, { $set: { status: 'Submitted', submittedOn: today(), submittedBy: req.actor!.userId } }, { session: s });
      if (!upd.modifiedCount) throw Errors.conflict('INVALID_TRANSITION', 'Claim changed meanwhile');
      await transfer(req, s, c, 'submit', c.claimedMinor, true);
    });
    await audit(deps, req, { action: 'ins.claim.submit', resource: `claim:${id(c)}`, outcome: 'success', meta: { claimedMinor: c.claimedMinor } });
    res.json({ data: { id: id(c), status: 'Submitted' } });
  });

  r.post('/claims/:id/respond', need(deps, 'ins', 'S'), async (req, res) => {
    const body = parse(Respond, req.body);
    const c = await loadClaim(req);
    if (c.status !== 'Submitted') throw Errors.conflict('INVALID_TRANSITION', 'Only submitted claims get a payer response');
    const approved = body.decision === 'accept' ? body.approvedMinor : 0;
    if (approved > c.claimedMinor) throw Errors.validation([{ path: 'approvedMinor', message: 'The payer cannot approve more than was claimed' }]);
    if (body.decision === 'accept' && approved < c.claimedMinor && !body.denialCode) throw Errors.validation([{ path: 'denialCode', message: 'Give the reason the payer cut the claim' }]);
    if (body.decision === 'accept' && approved === 0) throw Errors.validation([{ path: 'decision', message: 'A zero approval is a rejection' }]);
    const status = body.decision === 'accept' ? 'Accepted' : 'Rejected';
    await txn(async (s) => {
      const upd = await db(req).collection('claims').updateOne(
        { _id: c._id, status: 'Submitted' },
        {
          $set: { status, approvedMinor: approved, denialCode: body.denialCode ?? null, respondedOn: today(), ...(status === 'Rejected' ? { open: false } : {}) },
          $push: { history: { at: new Date(), decision: body.decision, approvedMinor: approved, denialCode: body.denialCode ?? null, note: body.note ?? null, by: req.actor!.name } } as Document,
        },
        { session: s },
      );
      if (!upd.modifiedCount) throw Errors.conflict('INVALID_TRANSITION', 'Claim changed meanwhile');
      // What the payer will not pay goes back to the patient's account.
      await transfer(req, s, c, status === 'Rejected' ? 'deny' : 'partial-deny', c.claimedMinor - approved, false);
      if (status === 'Rejected') await db(req).collection('claims').updateOne({ _id: c._id }, { $unset: { open: '' } }, { session: s });
    });
    await audit(deps, req, { action: `ins.claim.${body.decision}`, resource: `claim:${id(c)}`, outcome: 'success', meta: { approvedMinor: approved, denial: body.denialCode ?? null } });
    res.json({ data: { id: id(c), status, approvedMinor: approved, returnedToPatientMinor: c.claimedMinor - approved } });
  });

  r.post('/claims/:id/remit', need(deps, 'ins', 'S'), async (req, res) => {
    const body = parse(Remit, req.body);
    const c = await loadClaim(req);
    if (c.status !== 'Accepted') throw Errors.conflict('INVALID_TRANSITION', 'Only accepted claims are settled');
    if (body.amountMinor > c.approvedMinor) throw Errors.validation([{ path: 'amountMinor', message: 'More than the payer approved; record the excess as a separate receipt' }]);
    const short = c.approvedMinor - body.amountMinor;
    if (short > 0 && !body.shortPayReason) throw Errors.validation([{ path: 'shortPayReason', message: 'Explain the short payment before writing it off' }]);
    const a = req.actor!;
    const on = today();
    await txn(async (s) => {
      const inv = await db(req).collection('invoices').findOne({ _id: c.invoiceId }, { session: s });
      if (body.amountMinor > 0) {
        await postEntry(db(req), s, {
          tenantId: a.tenantId!,
          postingDate: on,
          currency: c.currency,
          memo: `Remittance ${body.reference} for ${c.claimNumber}`,
          lines: [{ accountCode: '1010', debitMinor: body.amountMinor }, { accountCode: '1110', creditMinor: body.amountMinor }],
          source: { type: 'claim', id: id(c), kind: 'remit' },
          by: a.userId,
        });
      }
      if (short > 0) {
        await postEntry(db(req), s, {
          tenantId: a.tenantId!,
          postingDate: on,
          currency: c.currency,
          memo: `Contractual adjustment on ${c.claimNumber}: ${body.shortPayReason}`,
          lines: [{ accountCode: '4900', debitMinor: short }, { accountCode: '1110', creditMinor: short }],
          source: { type: 'claim', id: id(c), kind: 'writeoff' },
          by: a.userId,
        });
      }
      const paid = inv!.paidMinor + body.amountMinor;
      const adjustment = (inv!.adjustmentMinor ?? 0) + short;
      const balance = inv!.totalMinor - paid - adjustment;
      await db(req).collection('invoices').updateOne(
        { _id: inv!._id, version: inv!.version },
        { $set: { paidMinor: paid, adjustmentMinor: adjustment, balanceMinor: balance, status: balance === 0 ? 'Paid' : 'PartiallyPaid' }, $inc: { insuranceHoldMinor: -c.approvedMinor, version: 1 } },
        { session: s },
      );
      const upd = await db(req).collection('claims').updateOne(
        { _id: c._id, status: 'Accepted' },
        { $set: { status: 'Settled', remittedMinor: body.amountMinor, writtenOffMinor: short, remittanceRef: body.reference, settledOn: on }, $unset: { open: '' } },
        { session: s },
      );
      if (!upd.modifiedCount) throw Errors.conflict('INVALID_TRANSITION', 'Claim changed meanwhile');
    });
    await audit(deps, req, { action: 'ins.claim.remit', resource: `claim:${id(c)}`, outcome: 'success', meta: { amountMinor: body.amountMinor, writtenOffMinor: short } });
    res.json({ data: { id: id(c), status: 'Settled', remittedMinor: body.amountMinor, writtenOffMinor: short } });
  });

  /** Spec §5.20 reports: open insurer receivable by age, and denials by reason. */
  r.get('/reports/ageing', need(deps, 'ins', 'V'), async (req, res) => {
    const list = await db(req).collection('claims').find({ tenantId: req.actor!.tenantId, status: { $in: ['Submitted', 'Accepted'] } }).toArray();
    const t = new Date(`${today()}T00:00:00Z`).getTime();
    const buckets = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
    for (const c of list) {
      const days = Math.floor((t - new Date(`${c.submittedOn}T00:00:00Z`).getTime()) / 86_400_000);
      const k = days <= 30 ? '0-30' : days <= 60 ? '31-60' : days <= 90 ? '61-90' : '90+';
      buckets[k] += c.status === 'Accepted' ? c.approvedMinor : c.claimedMinor;
    }
    res.json({ data: { buckets, openClaims: list.length } });
  });

  r.get('/reports/denials', need(deps, 'ins', 'V'), async (req, res) => {
    const rows = await db(req)
      .collection('claims')
      .aggregate([
        { $match: { tenantId: req.actor!.tenantId, denialCode: { $type: 'string' } } },
        { $group: { _id: '$denialCode', claims: { $sum: 1 }, deniedMinor: { $sum: { $subtract: ['$claimedMinor', { $ifNull: ['$approvedMinor', 0] }] } } } },
        { $sort: { deniedMinor: -1 } },
      ])
      .toArray();
    res.json({ data: rows.map((x) => ({ denialCode: x._id, claims: x.claims, deniedMinor: x.deniedMinor })) });
  });

  return r;
}
