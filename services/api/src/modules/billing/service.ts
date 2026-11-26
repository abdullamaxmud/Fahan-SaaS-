import type { ClientSession, Db, Document, ObjectId } from 'mongodb';
import type { Request } from 'express';
import { AppError } from '../../lib/errors';
import { CASH_ACCOUNT, postEntry, type Currency } from '../accounting/ledger';

export const CATEGORY_ACCOUNT: Record<string, string> = {
  consultation: '4000',
  laboratory: '4010',
  imaging: '4020',
  pharmacy: '4030',
  inpatient: '4040',
  procedure: '4050',
  other: '4090',
};

/** Finance policy (spec §4.3): refunds above this need the finance director; discounts above this % need approval. */
export const REFUND_APPROVAL_THRESHOLD_MINOR = 5_000;
export const DISCOUNT_APPROVAL_PERCENT = 10;

/**
 * Captures a charge with a price snapshot (spec §5.19). The (source, service) pair is unique, so the same
 * clinical event never creates two charges. Returns null when the event was already charged.
 */
export async function captureCharge(
  db: Db,
  c: { tenantId: ObjectId; branchId: ObjectId; patientId: ObjectId; encounterId?: ObjectId; serviceCode: string; quantity: number; sourceType: string; sourceId: string; description?: string; by: ObjectId },
  s?: ClientSession,
): Promise<ObjectId | null> {
  const price = await db.collection('service_prices').findOne({ tenantId: c.tenantId, code: c.serviceCode, active: true }, { session: s });
  try {
    const ins = await db.collection('charges').insertOne(
      {
        tenantId: c.tenantId,
        branchId: c.branchId,
        patientId: c.patientId,
        encounterId: c.encounterId,
        serviceCode: c.serviceCode,
        description: price?.name ?? c.description ?? c.serviceCode,
        category: price?.category ?? 'other',
        quantity: c.quantity,
        unitPriceMinor: price?.priceMinor ?? 0,
        currency: price?.currency ?? 'USD',
        priceVersion: price?.version ?? null,
        // Unpriced services are held for the billing officer instead of being lost or billed at zero.
        status: price ? 'unbilled' : 'unpriced',
        sourceType: c.sourceType,
        sourceId: c.sourceId,
        active: true,
        capturedAt: new Date(),
        capturedBy: c.by,
      },
      { session: s },
    );
    return ins.insertedId;
  } catch (e) {
    if ((e as { code?: number }).code === 11000) return null;
    throw e;
  }
}

/** Applies a settled payment to an invoice and posts Dr cash/bank, Cr receivable, in the caller's transaction. */
export async function applyPayment(
  db: Db,
  s: ClientSession,
  p: { tenantId: ObjectId; invoice: Document; amountMinor: number; method: string; reference?: string; idempotencyKey: string; sessionId?: ObjectId; by: ObjectId; receivedOn: string; provider?: string },
): Promise<Document> {
  if (p.amountMinor <= 0) throw new AppError(400, 'INVALID_AMOUNT', 'Payment must be more than zero');
  // Spec §5.21: the part an insurer is expected to pay is held, so the patient is never asked for it twice.
  const patientDue = (p.invoice.balanceMinor as number) - ((p.invoice.insuranceHoldMinor as number) ?? 0);
  if (p.amountMinor > patientDue) throw new AppError(409, 'OVERPAYMENT', `Patient balance due is ${patientDue}; take no more than that`);
  const c = await db.collection<{ _id: string; seq: number }>('counters').findOneAndUpdate({ _id: `rct:${p.receivedOn.slice(0, 4)}` }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after', session: s });
  const receiptNo = `RCT-${p.receivedOn.slice(0, 4)}-${String(c!.seq).padStart(6, '0')}`;
  const doc = {
    tenantId: p.tenantId,
    invoiceId: p.invoice._id,
    patientId: p.invoice.patientId,
    branchId: p.invoice.branchId,
    currency: p.invoice.currency,
    amountMinor: p.amountMinor,
    method: p.method,
    reference: p.reference,
    provider: p.provider,
    idempotencyKey: p.idempotencyKey,
    sessionId: p.sessionId,
    receiptNo,
    receivedOn: p.receivedOn,
    receivedAt: new Date(),
    by: p.by,
  };
  const ins = await db.collection('payments').insertOne(doc, { session: s });
  const paid = (p.invoice.paidMinor as number) + p.amountMinor;
  const balance = (p.invoice.totalMinor as number) - paid - ((p.invoice.adjustmentMinor as number) ?? 0);
  const upd = await db.collection('invoices').updateOne(
    { _id: p.invoice._id, version: p.invoice.version },
    { $set: { paidMinor: paid, balanceMinor: balance, status: balance === 0 ? 'Paid' : 'PartiallyPaid' }, $inc: { version: 1 } },
    { session: s },
  );
  if (!upd.modifiedCount) throw new AppError(409, 'VERSION_CONFLICT', 'The invoice changed while taking payment. Reload and try again');
  await postEntry(db, s, {
    tenantId: p.tenantId,
    postingDate: p.receivedOn,
    currency: p.invoice.currency as Currency,
    memo: `Payment ${receiptNo} for ${p.invoice.invoiceNumber}`,
    lines: [
      { accountCode: CASH_ACCOUNT[p.method] ?? '1010', debitMinor: p.amountMinor },
      { accountCode: '1100', creditMinor: p.amountMinor },
    ],
    source: { type: 'payment', id: ins.insertedId.toHexString(), kind: 'settle' },
    by: p.by,
  });
  return { _id: ins.insertedId, ...doc, invoiceStatus: balance === 0 ? 'Paid' : 'PartiallyPaid', balanceMinor: balance };
}

/**
 * Charge capture from a clinical event (lab release, report signed, dispense, visit closed). Best effort: a billing
 * problem is logged and left for the billing officer, it never blocks or undoes clinical work. Missing prices are
 * held as "unpriced" charges, and replays of the same event create nothing (unique source + service).
 */
export async function chargeEvent(
  req: Request,
  ev: { branchId: ObjectId; patientId: ObjectId; encounterId?: ObjectId; serviceCode: string; quantity?: number; sourceType: string; sourceId: ObjectId | string; description?: string },
): Promise<void> {
  const a = req.actor!;
  try {
    await captureCharge(a.db!, {
      tenantId: a.tenantId!,
      branchId: ev.branchId,
      patientId: ev.patientId,
      encounterId: ev.encounterId,
      serviceCode: ev.serviceCode.toUpperCase(),
      quantity: ev.quantity ?? 1,
      sourceType: ev.sourceType,
      sourceId: typeof ev.sourceId === 'string' ? ev.sourceId : ev.sourceId.toHexString(),
      description: ev.description,
      by: a.userId,
    });
  } catch (e) {
    req.log?.error({ err: e, service: ev.serviceCode, source: ev.sourceType }, 'charge capture failed');
  }
}
