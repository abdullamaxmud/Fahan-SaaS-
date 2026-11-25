import { Router, type Request } from 'express';
import type { ClientSession, Document, ObjectId } from 'mongodb';
import { z } from 'zod';
import { can, isBranchBound } from '@fahan/policy';
import type { Deps } from '../../context';
import { AppError, Errors } from '../../lib/errors';
import { localDate } from '../../lib/time';
import { idParam, objectId, parse } from '../../lib/validate';
import { audit } from '../../middleware/audit';
import { assertBranch, deny, need } from '../../middleware/authorize';
import { assertRecentMfa } from '../../middleware/session';
import { CASH_ACCOUNT, CURRENCIES, postEntry, reverseEntry, type Currency } from '../accounting/ledger';
import { loadPatient } from '../patients/access';
import { CATEGORY_ACCOUNT, DISCOUNT_APPROVAL_PERCENT, REFUND_APPROVAL_THRESHOLD_MINOR, applyPayment, captureCharge } from './service';

const minor = z.number().int().min(0).max(1e12);
const METHODS = ['cash', 'card', 'mobile-money', 'bank'] as const;
const NewPrice = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,30}$/),
  name: z.string().trim().min(2).max(120),
  category: z.enum(['consultation', 'laboratory', 'imaging', 'pharmacy', 'inpatient', 'procedure', 'other']),
  priceMinor: minor.refine((n) => n > 0, 'Price must be more than zero'),
  currency: z.enum(CURRENCIES),
});
const ManualCharge = z.object({ patientId: objectId, encounterId: objectId.optional(), serviceCode: z.string().trim().toUpperCase(), quantity: z.number().int().min(1).max(1000), note: z.string().trim().max(200).optional() });
const NewInvoice = z.object({ patientId: objectId, chargeIds: z.array(objectId).max(200).optional() });
const Discount = z.object({ amountMinor: minor, reason: z.string().trim().min(5).max(300) });
const Reason = z.object({ reason: z.string().trim().min(5).max(300) });
const OpenSession = z.object({ currency: z.enum(CURRENCIES), openingFloatMinor: minor });
const CloseSession = z.object({ countedCashMinor: minor, note: z.string().trim().max(300).optional() });
const Pay = z.object({ amountMinor: minor, method: z.enum(METHODS), reference: z.string().trim().max(60).optional() });
const NewRefund = z.object({ amountMinor: minor.refine((n) => n > 0, 'Refund must be more than zero'), method: z.enum(METHODS), reason: z.string().trim().min(5).max(300) });

const id = (x: { _id: ObjectId }) => x._id.toHexString();

/**
 * Spec §5.19 billing & cashier and §6 "Revenue cycle": charge captured → invoice issued → payment →
 * allocation → receipt → ledger posting → daily reconciliation; refunds by separate approval and posting.
 */
export function billingRoutes(deps: Deps): Router {
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

  const invoiceView = (i: Document) => ({
    id: id(i as { _id: ObjectId }),
    invoiceNumber: i.invoiceNumber ?? null,
    patientId: i.patientId.toHexString(),
    currency: i.currency,
    lines: i.lines,
    subtotalMinor: i.subtotalMinor,
    discountMinor: i.discountMinor,
    totalMinor: i.totalMinor,
    paidMinor: i.paidMinor,
    refundedMinor: i.refundedMinor,
    balanceMinor: i.balanceMinor,
    status: i.status,
    issuedOn: i.issuedOn ?? null,
    version: i.version,
  });

  async function loadInvoice(req: Request) {
    const i = await db(req).collection('invoices').findOne({ _id: idParam(req.params.id, 'Invoice'), tenantId: req.actor!.tenantId });
    if (!i) throw Errors.notFound('Invoice');
    await assertBranch(deps, req, i.branchId);
    return i;
  }

  // ---- price catalogue (versioned; charges keep the price they were captured at) ----
  r.get('/prices', need(deps, 'bill', 'V'), async (req, res) => {
    const list = await db(req).collection('service_prices').find({ tenantId: req.actor!.tenantId, active: true }).sort({ code: 1 }).toArray();
    res.json({ data: list.map((p) => ({ code: p.code, name: p.name, category: p.category, priceMinor: p.priceMinor, currency: p.currency, version: p.version, effectiveFrom: p.effectiveFrom })) });
  });

  r.post('/prices', need(deps, 'bill', 'A'), async (req, res) => {
    const body = parse(NewPrice, req.body);
    const a = req.actor!;
    const version = await txn(async (s) => {
      const prev = await db(req).collection('service_prices').findOneAndUpdate({ tenantId: a.tenantId, code: body.code, active: true }, { $set: { active: false, effectiveTo: new Date() } }, { session: s });
      const v = ((prev?.version as number) ?? 0) + 1;
      await db(req).collection('service_prices').insertOne({ tenantId: a.tenantId, ...body, version: v, active: true, effectiveFrom: new Date(), createdBy: a.userId }, { session: s });
      return v;
    });
    await audit(deps, req, { action: 'bill.price.set', resource: `price:${body.code}`, outcome: 'success', meta: { priceMinor: body.priceMinor, version } });
    res.status(201).json({ data: { code: body.code, version } });
  });

  // ---- charges ----
  r.get('/charges', need(deps, 'bill', 'V'), async (req, res) => {
    const q = parse(z.object({ patientId: objectId.optional(), status: z.enum(['unbilled', 'unpriced', 'billed', 'cancelled']).optional() }), req.query);
    const a = req.actor!;
    const f: Document = { tenantId: a.tenantId };
    if (q.patientId) f.patientId = q.patientId;
    if (q.status) f.status = q.status;
    if (isBranchBound(a.scope)) f.branchId = a.branchId ?? null;
    const list = await db(req).collection('charges').find(f).sort({ capturedAt: -1 }).limit(500).toArray();
    res.json({ data: list.map((c) => ({ id: id(c), patientId: c.patientId.toHexString(), serviceCode: c.serviceCode, description: c.description, category: c.category, quantity: c.quantity, unitPriceMinor: c.unitPriceMinor, currency: c.currency, status: c.status, sourceType: c.sourceType })) });
  });

  r.post('/charges', need(deps, 'bill', 'E'), async (req, res) => {
    const body = parse(ManualCharge, req.body);
    const p = await loadPatient(deps, req, body.patientId);
    const a = req.actor!;
    const price = await db(req).collection('service_prices').findOne({ tenantId: a.tenantId, code: body.serviceCode, active: true });
    if (!price) throw Errors.validation([{ path: 'serviceCode', message: 'No active price for this service' }]);
    const cid = await captureCharge(db(req), {
      tenantId: a.tenantId!,
      branchId: a.branchId ?? (p.branchIds as ObjectId[])[0]!,
      patientId: p._id,
      encounterId: body.encounterId,
      serviceCode: body.serviceCode,
      quantity: body.quantity,
      sourceType: 'manual',
      sourceId: `${a.userId.toHexString()}:${Date.now()}`,
      description: body.note,
      by: a.userId,
    });
    await audit(deps, req, { action: 'bill.charge.manual', resource: `patient:${id(p)}`, outcome: 'success', meta: { service: body.serviceCode } });
    res.status(201).json({ data: { id: cid?.toHexString() ?? null } });
  });

  r.post('/charges/:id/price', need(deps, 'bill', 'S'), async (req, res) => {
    const c = await db(req).collection('charges').findOne({ _id: idParam(req.params.id, 'Charge'), tenantId: req.actor!.tenantId, status: 'unpriced' });
    if (!c) throw Errors.notFound('Unpriced charge');
    const price = await db(req).collection('service_prices').findOne({ tenantId: req.actor!.tenantId, code: c.serviceCode, active: true });
    if (!price) throw Errors.validation([{ path: 'serviceCode', message: `Add a price for ${c.serviceCode} first` }]);
    await db(req).collection('charges').updateOne({ _id: c._id, status: 'unpriced' }, { $set: { status: 'unbilled', unitPriceMinor: price.priceMinor, currency: price.currency, description: price.name, category: price.category, priceVersion: price.version } });
    res.json({ data: { id: id(c), status: 'unbilled' } });
  });

  r.post('/charges/:id/cancel', need(deps, 'bill', 'S'), async (req, res) => {
    const { reason } = parse(Reason, req.body);
    const c = await db(req).collection('charges').findOne({ _id: idParam(req.params.id, 'Charge'), tenantId: req.actor!.tenantId });
    if (!c) throw Errors.notFound('Charge');
    const upd = await db(req).collection('charges').updateOne({ _id: c._id, status: { $in: ['unbilled', 'unpriced'] } }, { $set: { status: 'cancelled', cancelReason: reason }, $unset: { active: '' } });
    if (!upd.modifiedCount) throw Errors.conflict('CHARGE_BILLED', 'Billed charges are removed by voiding the invoice');
    await audit(deps, req, { action: 'bill.charge.cancel', resource: `charge:${id(c)}`, outcome: 'success', meta: { reason } });
    res.json({ data: { id: id(c), status: 'cancelled' } });
  });

  // ---- invoices ----
  r.post('/invoices', need(deps, 'bill', 'E'), async (req, res) => {
    const body = parse(NewInvoice, req.body);
    const p = await loadPatient(deps, req, body.patientId);
    const a = req.actor!;
    const f: Document = { tenantId: a.tenantId, patientId: p._id, status: 'unbilled' };
    if (body.chargeIds) f._id = { $in: body.chargeIds };
    const charges = await db(req).collection('charges').find(f).toArray();
    if (!charges.length) throw Errors.validation([{ path: 'chargeIds', message: 'There are no unbilled charges to invoice' }]);
    if (body.chargeIds && charges.length !== body.chargeIds.length) throw Errors.conflict('CHARGE_ALREADY_BILLED', 'Some charges are already billed, cancelled or unpriced');
    const currencies = [...new Set(charges.map((c) => c.currency))];
    if (currencies.length > 1) throw Errors.validation([{ path: 'chargeIds', message: 'Invoice one currency at a time' }]);
    const lines = charges.map((c) => ({ chargeId: c._id, serviceCode: c.serviceCode, description: c.description, category: c.category, quantity: c.quantity, unitPriceMinor: c.unitPriceMinor, amountMinor: c.quantity * c.unitPriceMinor }));
    const subtotal = lines.reduce((n, l) => n + l.amountMinor, 0);
    const invId = await txn(async (s) => {
      const ins = await db(req).collection('invoices').insertOne(
        {
          tenantId: a.tenantId,
          branchId: charges[0]!.branchId,
          patientId: p._id,
          currency: currencies[0],
          lines,
          subtotalMinor: subtotal,
          discountMinor: 0,
          totalMinor: subtotal,
          paidMinor: 0,
          refundedMinor: 0,
          balanceMinor: subtotal,
          status: 'Draft',
          createdBy: a.userId,
          createdAt: new Date(),
          version: 1,
        },
        { session: s },
      );
      // Spec §5.19 no duplicate charges: each charge moves to exactly one invoice.
      const upd = await db(req).collection('charges').updateMany({ _id: { $in: charges.map((c) => c._id) }, status: 'unbilled' }, { $set: { status: 'billed', invoiceId: ins.insertedId } }, { session: s });
      if (upd.modifiedCount !== charges.length) throw Errors.conflict('CHARGE_ALREADY_BILLED', 'Some charges were just billed by someone else');
      return ins.insertedId;
    });
    res.status(201).json({ data: { id: invId.toHexString(), subtotalMinor: subtotal, status: 'Draft' } });
  });

  r.get('/invoices', need(deps, 'bill', 'V'), async (req, res) => {
    const q = parse(z.object({ patientId: objectId.optional(), status: z.string().optional() }), req.query);
    const a = req.actor!;
    const f: Document = { tenantId: a.tenantId };
    if (q.patientId) f.patientId = q.patientId;
    if (q.status) f.status = q.status;
    if (isBranchBound(a.scope)) f.branchId = a.branchId ?? null;
    const list = await db(req).collection('invoices').find(f).sort({ createdAt: -1 }).limit(300).toArray();
    const pats = await db(req).collection('patients').find({ _id: { $in: list.map((i) => i.patientId) } }, { projection: { names: 1, mrn: 1 } }).toArray();
    res.json({ data: list.map((i) => ({ ...invoiceView(i), patient: pats.find((p) => p._id.equals(i.patientId)) ?? null })) });
  });

  r.get('/invoices/:id', need(deps, 'bill', 'V'), async (req, res) => {
    const i = await loadInvoice(req);
    const pays = await db(req).collection('payments').find({ invoiceId: i._id }).sort({ receivedAt: 1 }).toArray();
    res.json({ data: { ...invoiceView(i), payments: pays.map((p) => ({ receiptNo: p.receiptNo, amountMinor: p.amountMinor, method: p.method, receivedOn: p.receivedOn })) } });
  });

  r.post('/invoices/:id/discount', need(deps, 'bill', 'S'), async (req, res) => {
    const body = parse(Discount, req.body);
    const i = await loadInvoice(req);
    if (i.status !== 'Draft') throw Errors.conflict('INVALID_TRANSITION', 'Discounts are applied before the invoice is issued');
    if (body.amountMinor > i.subtotalMinor) throw Errors.validation([{ path: 'amountMinor', message: 'Discount cannot exceed the subtotal' }]);
    if (body.amountMinor * 100 > i.subtotalMinor * DISCOUNT_APPROVAL_PERCENT && !can(req.actor!.perms, 'bill', 'A')) {
      await deny(deps, req, `invoice:${id(i)}`, `discounts above ${DISCOUNT_APPROVAL_PERCENT}% need finance approval`);
    }
    const total = i.subtotalMinor - body.amountMinor;
    await db(req).collection('invoices').updateOne({ _id: i._id, version: i.version }, { $set: { discountMinor: body.amountMinor, discountReason: body.reason, totalMinor: total, balanceMinor: total }, $inc: { version: 1 } });
    await audit(deps, req, { action: 'bill.discount', resource: `invoice:${id(i)}`, outcome: 'success', meta: { amountMinor: body.amountMinor } });
    res.json({ data: { id: id(i), totalMinor: total } });
  });

  /** Issue = recognise revenue: Dr receivable (+ discounts), Cr revenue by service category. */
  r.post('/invoices/:id/issue', need(deps, 'bill', 'E'), async (req, res) => {
    const i = await loadInvoice(req);
    if (i.status !== 'Draft') throw Errors.conflict('INVALID_TRANSITION', `Invoice is ${String(i.status).toLowerCase()}`);
    const a = req.actor!;
    const on = today();
    const number = await txn(async (s) => {
      const c = await db(req).collection<{ _id: string; seq: number }>('counters').findOneAndUpdate({ _id: `inv:${on.slice(0, 4)}` }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after', session: s });
      const invoiceNumber = `INV-${on.slice(0, 4)}-${String(c!.seq).padStart(6, '0')}`;
      const byAccount = new Map<string, number>();
      for (const l of i.lines as Document[]) byAccount.set(CATEGORY_ACCOUNT[l.category] ?? '4090', (byAccount.get(CATEGORY_ACCOUNT[l.category] ?? '4090') ?? 0) + l.amountMinor);
      const lines = [
        ...(i.totalMinor > 0 ? [{ accountCode: '1100', debitMinor: i.totalMinor as number }] : []),
        ...(i.discountMinor > 0 ? [{ accountCode: '4900', debitMinor: i.discountMinor as number }] : []),
        ...[...byAccount].map(([accountCode, creditMinor]) => ({ accountCode, creditMinor })),
      ];
      const entryId = await postEntry(db(req), s, { tenantId: a.tenantId!, postingDate: on, currency: i.currency as Currency, memo: `Invoice ${invoiceNumber}`, lines, source: { type: 'invoice', id: id(i), kind: 'issue' }, by: a.userId });
      const upd = await db(req).collection('invoices').updateOne(
        { _id: i._id, status: 'Draft', version: i.version },
        { $set: { status: i.totalMinor === 0 ? 'Paid' : 'Issued', invoiceNumber, issuedOn: on, issuedAt: new Date(), issuedBy: a.userId, issueEntryId: entryId }, $inc: { version: 1 } },
        { session: s },
      );
      if (!upd.modifiedCount) throw Errors.conflict('VERSION_CONFLICT', 'The invoice changed. Reload and try again');
      return invoiceNumber;
    });
    await audit(deps, req, { action: 'bill.invoice.issue', resource: `invoice:${id(i)}`, outcome: 'success', meta: { number, totalMinor: i.totalMinor } });
    res.json({ data: { id: id(i), invoiceNumber: number, status: 'Issued' } });
  });

  r.post('/invoices/:id/void', need(deps, 'bill', 'S'), async (req, res) => {
    const { reason } = parse(Reason, req.body);
    const i = await loadInvoice(req);
    if (i.paidMinor > 0) throw Errors.conflict('HAS_PAYMENTS', 'Refund the payments before voiding');
    if (!['Draft', 'Issued'].includes(i.status)) throw Errors.conflict('INVALID_TRANSITION', `Invoice is ${String(i.status).toLowerCase()}`);
    const a = req.actor!;
    await txn(async (s) => {
      if (i.issueEntryId) await reverseEntry(db(req), s, { tenantId: a.tenantId!, entryId: i.issueEntryId, postingDate: today(), reason: `Void ${i.invoiceNumber}: ${reason}`, by: a.userId });
      await db(req).collection('invoices').updateOne({ _id: i._id, version: i.version }, { $set: { status: 'Voided', voidReason: reason, voidedBy: a.userId, balanceMinor: 0 }, $inc: { version: 1 } }, { session: s });
      await db(req).collection('charges').updateMany({ invoiceId: i._id }, { $set: { status: 'unbilled' }, $unset: { invoiceId: '' } }, { session: s });
    });
    await audit(deps, req, { action: 'bill.invoice.void', resource: `invoice:${id(i)}`, outcome: 'success', meta: { reason } });
    res.json({ data: { id: id(i), status: 'Voided' } });
  });

  // ---- cashier sessions (spec §4.3 shift closing and discrepancy approval) ----
  async function openSession(req: Request) {
    return db(req).collection('cashier_sessions').findOne({ tenantId: req.actor!.tenantId, cashierId: req.actor!.userId, status: 'open' });
  }

  r.post('/cashier/open', need(deps, 'bill', 'E'), async (req, res) => {
    const body = parse(OpenSession, req.body);
    const a = req.actor!;
    if (!a.branchId) throw Errors.validation([{ message: 'Your account is not assigned to a branch' }]);
    try {
      const ins = await db(req).collection('cashier_sessions').insertOne({ tenantId: a.tenantId, branchId: a.branchId, cashierId: a.userId, cashierName: a.name, ...body, status: 'open', openedAt: new Date() });
      await audit(deps, req, { action: 'bill.session.open', resource: `cashier_session:${ins.insertedId.toHexString()}`, outcome: 'success', meta: { floatMinor: body.openingFloatMinor } });
      res.status(201).json({ data: { id: ins.insertedId.toHexString(), status: 'open' } });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw Errors.conflict('SESSION_OPEN', 'You already have an open cashier session');
      throw e;
    }
  });

  async function sessionTotals(req: Request, sessionId: ObjectId) {
    const pays = await db(req).collection('payments').aggregate([{ $match: { sessionId } }, { $group: { _id: '$method', n: { $sum: '$amountMinor' } } }]).toArray();
    const refs = await db(req).collection('refunds').aggregate([{ $match: { paidSessionId: sessionId, status: 'Paid' } }, { $group: { _id: '$method', n: { $sum: '$amountMinor' } } }]).toArray();
    const by = (rows: Document[], m: string) => (rows.find((x) => x._id === m)?.n as number) ?? 0;
    return Object.fromEntries(METHODS.map((m) => [m, { inMinor: by(pays, m), outMinor: by(refs, m) }]));
  }

  r.get('/cashier/current', need(deps, 'bill', 'E'), async (req, res) => {
    const s = await openSession(req);
    if (!s) return res.json({ data: null });
    res.json({ data: { id: id(s), currency: s.currency, openingFloatMinor: s.openingFloatMinor, openedAt: s.openedAt, totals: await sessionTotals(req, s._id) } });
  });

  r.post('/cashier/close', need(deps, 'bill', 'E'), async (req, res) => {
    const body = parse(CloseSession, req.body);
    const s = await openSession(req);
    if (!s) throw Errors.conflict('NO_SESSION', 'You have no open cashier session');
    const totals = await sessionTotals(req, s._id);
    const expected = s.openingFloatMinor + totals.cash!.inMinor - totals.cash!.outMinor;
    const discrepancy = body.countedCashMinor - expected;
    const status = discrepancy === 0 ? 'closed' : 'pending-approval';
    await db(req).collection('cashier_sessions').updateOne({ _id: s._id, status: 'open' }, { $set: { status, closedAt: new Date(), countedCashMinor: body.countedCashMinor, expectedCashMinor: expected, discrepancyMinor: discrepancy, totals, closeNote: body.note } });
    await audit(deps, req, { action: 'bill.session.close', resource: `cashier_session:${id(s)}`, outcome: 'success', meta: { discrepancyMinor: discrepancy } });
    res.json({ data: { id: id(s), status, expectedCashMinor: expected, discrepancyMinor: discrepancy, totals } });
  });

  r.post('/cashier/:id/approve', need(deps, 'bill', 'A'), async (req, res) => {
    const { reason } = parse(Reason, req.body);
    const s = await db(req).collection('cashier_sessions').findOne({ _id: idParam(req.params.id, 'Session'), tenantId: req.actor!.tenantId });
    if (!s) throw Errors.notFound('Session');
    if (s.cashierId.equals(req.actor!.userId)) throw new AppError(403, 'FOUR_EYES', 'Someone else approves your discrepancy');
    const upd = await db(req).collection('cashier_sessions').updateOne({ _id: s._id, status: 'pending-approval' }, { $set: { status: 'closed', discrepancyApprovedBy: req.actor!.userId, discrepancyReason: reason } });
    if (!upd.modifiedCount) throw Errors.conflict('INVALID_TRANSITION', 'Nothing to approve');
    await audit(deps, req, { action: 'bill.session.discrepancy_approve', resource: `cashier_session:${id(s)}`, outcome: 'success', meta: { discrepancyMinor: s.discrepancyMinor } });
    res.json({ data: { id: id(s), status: 'closed' } });
  });

  // ---- payments (spec §8.1: Idempotency-Key required) ----
  r.post('/invoices/:id/payments', need(deps, 'bill', 'E'), async (req, res) => {
    const key = req.get('idempotency-key');
    if (!key || !/^[\w-]{8,80}$/.test(key)) throw Errors.validation([{ path: 'Idempotency-Key', message: 'Send an Idempotency-Key header (8–80 letters, digits, - or _)' }]);
    const body = parse(Pay, req.body);
    const a = req.actor!;
    const prior = await db(req).collection('payments').findOne({ tenantId: a.tenantId, idempotencyKey: key });
    if (prior) return res.json({ data: { receiptNo: prior.receiptNo, amountMinor: prior.amountMinor, replay: true } });
    const i = await loadInvoice(req);
    if (!['Issued', 'PartiallyPaid'].includes(i.status)) throw Errors.conflict('NOT_PAYABLE', `Invoice is ${String(i.status).toLowerCase()}`);
    const session = await openSession(req);
    if (body.method === 'cash' && (!session || session.currency !== i.currency)) throw new AppError(409, 'NO_SESSION', `Open a ${i.currency} cashier session before taking cash`);
    try {
      const p = await txn((s) => applyPayment(db(req), s, { tenantId: a.tenantId!, invoice: i, amountMinor: body.amountMinor, method: body.method, reference: body.reference, idempotencyKey: key, sessionId: session?._id, by: a.userId, receivedOn: today() }));
      await audit(deps, req, { action: 'bill.payment', resource: `invoice:${id(i)}`, outcome: 'success', meta: { receipt: p.receiptNo, amountMinor: body.amountMinor, method: body.method } });
      res.status(201).json({ data: { receiptNo: p.receiptNo, amountMinor: body.amountMinor, invoiceStatus: p.invoiceStatus, balanceMinor: p.balanceMinor } });
    } catch (e) {
      if ((e as { code?: number }).code === 11000 || (e as AppError).code === 'ALREADY_POSTED') {
        const again = await db(req).collection('payments').findOne({ tenantId: a.tenantId, idempotencyKey: key });
        if (again) return res.json({ data: { receiptNo: again.receiptNo, amountMinor: again.amountMinor, replay: true } });
      }
      throw e;
    }
  });

  // ---- refunds: requested, then approved by someone else; large refunds need the finance director ----
  r.post('/invoices/:id/refunds', need(deps, 'bill', 'E'), async (req, res) => {
    const body = parse(NewRefund, req.body);
    const i = await loadInvoice(req);
    const pending = await db(req).collection('refunds').aggregate([{ $match: { invoiceId: i._id, status: 'Requested' } }, { $group: { _id: null, n: { $sum: '$amountMinor' } } }]).toArray();
    const refundable = i.paidMinor - i.refundedMinor - ((pending[0]?.n as number) ?? 0);
    if (body.amountMinor > refundable) throw Errors.validation([{ path: 'amountMinor', message: `At most ${refundable} can be refunded` }]);
    const a = req.actor!;
    const ins = await db(req).collection('refunds').insertOne({ tenantId: a.tenantId, branchId: i.branchId, invoiceId: i._id, currency: i.currency, ...body, status: 'Requested', requestedBy: a.userId, requestedByName: a.name, requestedAt: new Date() });
    await audit(deps, req, { action: 'bill.refund.request', resource: `invoice:${id(i)}`, outcome: 'success', meta: { amountMinor: body.amountMinor } });
    res.status(201).json({ data: { id: ins.insertedId.toHexString(), status: 'Requested', needsFinanceDirector: body.amountMinor > REFUND_APPROVAL_THRESHOLD_MINOR } });
  });

  r.get('/refunds', need(deps, 'bill', 'S'), async (req, res) => {
    const list = await db(req).collection('refunds').find({ tenantId: req.actor!.tenantId, status: 'Requested' }).sort({ requestedAt: 1 }).toArray();
    res.json({ data: list.map((x) => ({ id: id(x), invoiceId: x.invoiceId.toHexString(), amountMinor: x.amountMinor, currency: x.currency, method: x.method, reason: x.reason, requestedByName: x.requestedByName, needsFinanceDirector: x.amountMinor > REFUND_APPROVAL_THRESHOLD_MINOR })) });
  });

  async function loadRefund(req: Request) {
    const x = await db(req).collection('refunds').findOne({ _id: idParam(req.params.id, 'Refund'), tenantId: req.actor!.tenantId });
    if (!x) throw Errors.notFound('Refund');
    await assertBranch(deps, req, x.branchId);
    return x;
  }

  /** Spec §14.2: a refund above threshold is rejected without authorised approval and preserved in audit. */
  r.post('/refunds/:id/approve', need(deps, 'bill', 'S'), async (req, res) => {
    const x = await loadRefund(req);
    const a = req.actor!;
    if (x.requestedBy.equals(a.userId)) throw new AppError(403, 'FOUR_EYES', 'Someone other than the requester approves a refund');
    if (x.amountMinor > REFUND_APPROVAL_THRESHOLD_MINOR && !can(a.perms, 'bill', 'A')) await deny(deps, req, `refund:${id(x)}`, 'refund above threshold needs the finance director');
    assertRecentMfa(deps, req);
    if (x.status !== 'Requested') throw Errors.conflict('INVALID_TRANSITION', `Refund is ${String(x.status).toLowerCase()}`);
    const on = today();
    await txn(async (s) => {
      const inv = await db(req).collection('invoices').findOne({ _id: x.invoiceId }, { session: s });
      if (!inv || inv.paidMinor - inv.refundedMinor < x.amountMinor) throw Errors.conflict('NOT_REFUNDABLE', 'Not enough has been paid on this invoice to refund that amount');
      const requesterSession = x.method === 'cash' ? await db(req).collection('cashier_sessions').findOne({ tenantId: a.tenantId, cashierId: x.requestedBy, status: 'open' }, { session: s }) : null;
      await postEntry(db(req), s, {
        tenantId: a.tenantId!,
        postingDate: on,
        currency: x.currency,
        memo: `Refund on ${inv.invoiceNumber}: ${x.reason}`,
        lines: [
          { accountCode: '4910', debitMinor: x.amountMinor },
          { accountCode: CASH_ACCOUNT[x.method] ?? '1010', creditMinor: x.amountMinor },
        ],
        source: { type: 'refund', id: id(x), kind: 'pay' },
        by: a.userId,
      });
      await db(req).collection('refunds').updateOne({ _id: x._id, status: 'Requested' }, { $set: { status: 'Paid', approvedBy: a.userId, paidOn: on, paidSessionId: requesterSession?._id } }, { session: s });
      await db(req).collection('invoices').updateOne({ _id: inv._id }, { $inc: { refundedMinor: x.amountMinor, version: 1 } }, { session: s });
    });
    await audit(deps, req, { action: 'bill.refund.approve', resource: `refund:${id(x)}`, outcome: 'success', meta: { amountMinor: x.amountMinor } });
    res.json({ data: { id: id(x), status: 'Paid' } });
  });

  r.post('/refunds/:id/reject', need(deps, 'bill', 'S'), async (req, res) => {
    const { reason } = parse(Reason, req.body);
    const x = await loadRefund(req);
    const upd = await db(req).collection('refunds').updateOne({ _id: x._id, status: 'Requested' }, { $set: { status: 'Rejected', rejectReason: reason, rejectedBy: req.actor!.userId } });
    if (!upd.modifiedCount) throw Errors.conflict('INVALID_TRANSITION', 'Only requested refunds can be rejected');
    await audit(deps, req, { action: 'bill.refund.reject', resource: `refund:${id(x)}`, outcome: 'success', meta: { reason } });
    res.json({ data: { id: id(x), status: 'Rejected' } });
  });

  return r;
}
