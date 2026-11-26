import { Router, type Request } from 'express';
import type { Document, ObjectId } from 'mongodb';
import { z } from 'zod';
import { can, isBranchBound } from '@fahan/policy';
import type { Deps } from '../../context';
import { AppError, Errors } from '../../lib/errors';
import { localDate } from '../../lib/time';
import { idParam, objectId, parse } from '../../lib/validate';
import { audit } from '../../middleware/audit';
import { assertBranch, deny, need } from '../../middleware/authorize';
import { assertRecentMfa } from '../../middleware/session';
import { recordMovements, takeStock } from '../inventory/stock';
import { encLevelOk, loadPatient } from '../patients/access';
import { orderingContext } from '../orders/common';
import { chargeEvent } from '../billing/service';

const FREQ = ['once', 'stat', 'daily', 'bid', 'tid', 'qid', 'q4h', 'q6h', 'q8h', 'q12h', 'weekly', 'prn'] as const;
const NewRx = z.object({
  encounterId: objectId,
  itemId: objectId,
  dose: z.string().trim().min(1).max(40),
  frequency: z.enum(FREQ),
  durationDays: z.number().int().min(1).max(365),
  quantity: z.number().int().positive().max(10_000),
  instructions: z.string().trim().max(500).optional(),
});
const Sign = z.object({ overrideReason: z.string().trim().min(10, 'Explain the override in at least 10 characters').max(300).optional() });
const Dispense = z.object({ storeId: objectId });
const Return = z.object({ quantity: z.number().int().positive(), reason: z.string().trim().min(3).max(300) });
const Cancel = z.object({ reason: z.string().trim().min(3).max(300) });
const Admin = z.object({ status: z.enum(['given', 'held', 'refused']), doseGiven: z.string().trim().max(40).optional(), reason: z.string().trim().max(300).optional() });

const id = (x: { _id: ObjectId }) => x._id.toHexString();

/**
 * Spec §4.2 medication safety, §5.14 pharmacy (Draft → Signed → Verified → Dispensed / Cancelled) and
 * §6 "Prescription & dispensing". Dispensing is transactional and idempotent.
 */
export function pharmacyRoutes(deps: Deps): Router {
  const r = Router();
  const db = (req: Request) => req.actor!.db!;
  const now = () => deps.config.now();

  async function loadRx(req: Request) {
    const x = await db(req).collection('prescriptions').findOne({ _id: idParam(req.params.id, 'Prescription'), tenantId: req.actor!.tenantId });
    if (!x) throw Errors.notFound('Prescription');
    return x;
  }

  const view = (x: Document) => ({
    id: id(x as { _id: ObjectId }),
    status: x.status,
    drug: x.drug,
    dose: x.dose,
    frequency: x.frequency,
    durationDays: x.durationDays,
    quantity: x.quantity,
    instructions: x.instructions ?? null,
    encounterId: x.encounterId.toHexString(),
    patientId: x.patientId.toHexString(),
    prescriberName: x.prescriberName,
    signedAt: x.signedAt ?? null,
    verifiedByName: x.verifiedByName ?? null,
    dispensed: x.dispensed ? { at: x.dispensed.at, lots: x.dispensed.lots, byName: x.dispensed.byName } : null,
    override: x.override ?? null,
    returned: x.returnedQuantity ?? 0,
  });

  /** Safety checks before signing: allergies (by ingredient, name or drug class) and duplicate therapy. */
  async function safetyIssues(req: Request, x: Document) {
    const issues: { path: string; message: string }[] = [];
    const allergies = await db(req).collection('allergies').find({ patientId: x.patientId, status: 'active' }).toArray();
    const terms = [x.drug.ingredient, x.drug.name, ...(x.drug.classes ?? [])].map((t: string) => t.toLowerCase());
    for (const al of allergies) {
      const s = String(al.substance).toLowerCase();
      if (terms.some((t) => t.includes(s) || s.includes(t))) issues.push({ path: 'allergy', message: `Allergy to ${al.substance} (${al.severity})` });
    }
    const dup = await db(req)
      .collection('prescriptions')
      .findOne({ _id: { $ne: x._id }, encounterId: x.encounterId, 'drug.ingredient': x.drug.ingredient, status: { $in: ['Signed', 'Verified', 'Dispensed'] } });
    if (dup) issues.push({ path: 'duplicate', message: `${x.drug.ingredient} is already prescribed on this visit` });
    return issues;
  }

  /** Formulary for prescribers and pharmacy: medicines only, no stock or cost data. */
  r.get('/formulary', need(deps, 'rx', 'V'), async (req, res) => {
    const list = await db(req).collection('items').find({ tenantId: req.actor!.tenantId, kind: 'medicine' }, { projection: { code: 1, name: 1, medicine: 1 } }).sort({ name: 1 }).limit(1000).toArray();
    res.json({ data: list.map((i) => ({ id: id(i), code: i.code, name: i.name, ...i.medicine })) });
  });

  r.post('/prescriptions', need(deps, 'rx', 'S'), async (req, res) => {
    const body = parse(NewRx, req.body);
    const { e } = await orderingContext(deps, req, body.encounterId);
    const item = await db(req).collection('items').findOne({ _id: body.itemId, tenantId: req.actor!.tenantId, kind: 'medicine' });
    if (!item?.medicine) throw Errors.validation([{ path: 'itemId', message: 'Choose a medicine from the formulary' }]);
    const a = req.actor!;
    const ins = await db(req).collection('prescriptions').insertOne({
      ...body,
      tenantId: a.tenantId,
      branchId: e.branchId,
      encounterId: e._id,
      patientId: e.patientId,
      itemId: item._id,
      drug: { name: item.name, ingredient: item.medicine.ingredient, strength: item.medicine.strength, form: item.medicine.form, route: item.medicine.route, classes: item.medicine.classes ?? [] },
      status: 'Draft',
      prescriberId: a.userId,
      prescriberName: a.name,
      createdAt: now(),
      version: 1,
    });
    res.status(201).json({ data: { id: ins.insertedId.toHexString(), status: 'Draft' } });
  });

  r.post('/prescriptions/:id/sign', need(deps, 'rx', 'S'), async (req, res) => {
    const body = parse(Sign, req.body);
    const x = await loadRx(req);
    if (!x.prescriberId.equals(req.actor!.userId)) throw Errors.forbidden('Only the prescriber signs this prescription');
    assertRecentMfa(deps, req);
    if (x.status !== 'Draft') throw Errors.conflict('INVALID_TRANSITION', `Prescription is ${String(x.status).toLowerCase()}`);
    const issues = await safetyIssues(req, x);
    if (issues.length && !body.overrideReason) {
      throw new AppError(409, issues.some((i) => i.path === 'allergy') ? 'ALLERGY_CONFLICT' : 'DUPLICATE_THERAPY', 'Safety check: review before signing', issues);
    }
    const set: Document = { status: 'Signed', signedAt: now() };
    if (issues.length) set.override = { reason: body.overrideReason, issues: issues.map((i) => i.message), by: req.actor!.name, at: now() };
    await db(req).collection('prescriptions').updateOne({ _id: x._id, status: 'Draft' }, { $set: set, $inc: { version: 1 } });
    await audit(deps, req, {
      action: issues.length ? 'rx.sign.override' : 'rx.sign',
      resource: `prescription:${id(x)}`,
      outcome: 'success',
      meta: { drug: x.drug.name, issues: issues.map((i) => i.path).join(',') || null },
    });
    res.json({ data: { id: id(x), status: 'Signed', overridden: issues.length > 0 } });
  });

  r.get('/prescriptions', async (req, res) => {
    const q = parse(z.object({ encounterId: objectId }), req.query);
    const e = await db(req).collection('encounters').findOne({ _id: q.encounterId, tenantId: req.actor!.tenantId });
    if (!e) throw Errors.notFound('Visit');
    await loadPatient(deps, req, e.patientId, { clinical: true });
    const list = await db(req).collection('prescriptions').find({ encounterId: e._id }).sort({ createdAt: -1 }).toArray();
    res.json({ data: list.map(view) });
  });

  r.get('/queue', need(deps, 'rx', 'S'), async (req, res) => {
    const a = req.actor!;
    if (a.scope === 'assigned-patient') await deny(deps, req, 'pharmacy queue', 'the queue is for pharmacy staff');
    const q = parse(z.object({ status: z.enum(['open', 'dispensed']).default('open') }), req.query);
    // "dispensed": the last seven days, for returns.
    const f: Document =
      q.status === 'dispensed'
        ? { tenantId: a.tenantId, status: 'Dispensed', 'dispensed.at': { $gte: new Date(now().getTime() - 7 * 86_400_000) } }
        : { tenantId: a.tenantId, status: { $in: ['Signed', 'Verified'] } };
    if (isBranchBound(a.scope)) f.branchId = a.branchId ?? null;
    const list = await db(req).collection('prescriptions').find(f).sort({ signedAt: 1 }).limit(300).toArray();
    const pats = await db(req).collection('patients').find({ _id: { $in: list.map((x) => x.patientId) } }, { projection: { names: 1, mrn: 1 } }).toArray();
    res.json({ data: list.map((x) => ({ ...view(x), patient: pats.find((p) => p._id.equals(x.patientId)) ?? null })) });
  });

  r.post('/prescriptions/:id/verify', need(deps, 'rx', 'S'), async (req, res) => {
    const x = await loadRx(req);
    await assertBranch(deps, req, x.branchId);
    const a = req.actor!;
    if (x.prescriberId.equals(a.userId)) throw new AppError(403, 'FOUR_EYES', 'A pharmacist other than the prescriber verifies');
    if (a.scope === 'assigned-patient') await deny(deps, req, `prescription:${id(x)}`, 'verification is pharmacy work');
    const upd = await db(req).collection('prescriptions').updateOne({ _id: x._id, status: 'Signed' }, { $set: { status: 'Verified', verifiedBy: a.userId, verifiedByName: a.name, verifiedAt: now() }, $inc: { version: 1 } });
    if (!upd.modifiedCount) throw Errors.conflict('INVALID_TRANSITION', `Prescription is ${String(x.status).toLowerCase()}`);
    await audit(deps, req, { action: 'rx.verify', resource: `prescription:${id(x)}`, outcome: 'success' });
    res.json({ data: { id: id(x), status: 'Verified' } });
  });

  /** Spec §8.1: Idempotency-Key required; a replay returns the original dispense and never takes stock twice. */
  r.post('/prescriptions/:id/dispense', need(deps, 'rx', 'S'), async (req, res) => {
    const key = req.get('idempotency-key');
    if (!key || !/^[\w-]{8,80}$/.test(key)) throw Errors.validation([{ path: 'Idempotency-Key', message: 'Send an Idempotency-Key header (8–80 letters, digits, - or _)' }]);
    const body = parse(Dispense, req.body);
    const x = await loadRx(req);
    await assertBranch(deps, req, x.branchId);
    const a = req.actor!;
    const prior = await db(req).collection('dispense_events').findOne({ tenantId: a.tenantId, idempotencyKey: key });
    if (prior) {
      if (!prior.prescriptionId.equals(x._id)) throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'This key was used for a different prescription');
      return res.json({ data: { id: id(x), status: 'Dispensed', lots: prior.lots, replay: true } });
    }
    if (x.status !== 'Verified') throw Errors.conflict('NOT_VERIFIED', x.status === 'Dispensed' ? 'Already dispensed' : 'A pharmacist must verify before dispensing');
    const store = await db(req).collection('stores').findOne({ _id: body.storeId, tenantId: a.tenantId, branchId: x.branchId });
    if (!store) throw Errors.notFound('Store');
    const s = deps.data.client.startSession();
    let lots: { lotId: ObjectId; batch: string; expiry: string; quantity: number }[] = [];
    try {
      await s.withTransaction(async () => {
        lots = await takeStock(db(req), s, { tenantId: a.tenantId!, storeId: store._id, itemId: x.itemId, quantity: x.quantity, today: localDate(now(), 'Africa/Mogadishu') });
        await recordMovements(db(req), s, { tenantId: a.tenantId!, storeId: store._id, itemId: x.itemId, type: 'dispense', by: a.userId, ref: `prescription:${id(x)}` }, lots.map((l) => ({ lotId: l.lotId, quantity: -l.quantity })));
        await db(req).collection('dispense_events').insertOne({ tenantId: a.tenantId, prescriptionId: x._id, storeId: store._id, idempotencyKey: key, lots, at: now(), by: a.userId }, { session: s });
        const upd = await db(req).collection('prescriptions').updateOne(
          { _id: x._id, status: 'Verified' },
          { $set: { status: 'Dispensed', dispensed: { at: now(), by: a.userId, byName: a.name, storeId: store._id, lots } }, $inc: { version: 1 } },
          { session: s },
        );
        if (!upd.modifiedCount) throw Errors.conflict('NOT_VERIFIED', 'This prescription was dispensed by someone else');
      });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) {
        const again = await db(req).collection('dispense_events').findOne({ tenantId: a.tenantId, idempotencyKey: key });
        return res.json({ data: { id: id(x), status: 'Dispensed', lots: again?.lots ?? [], replay: true } });
      }
      throw e;
    } finally {
      await s.endSession();
    }
    await audit(deps, req, { action: 'rx.dispense', resource: `prescription:${id(x)}`, outcome: 'success', meta: { batches: lots.map((l) => l.batch).join(',') } });
    const item = await db(req).collection('items').findOne({ _id: x.itemId }, { projection: { code: 1 } });
    if (item) await chargeEvent(req, { branchId: x.branchId, patientId: x.patientId, encounterId: x.encounterId, serviceCode: `RX-${item.code}`, quantity: x.quantity, sourceType: 'prescription', sourceId: x._id, description: x.drug?.name ?? String(item.code) });
    res.json({ data: { id: id(x), status: 'Dispensed', lots: lots.map((l) => ({ batch: l.batch, expiry: l.expiry, quantity: l.quantity })) } });
  });

  r.post('/prescriptions/:id/return', need(deps, 'rx', 'S'), async (req, res) => {
    const body = parse(Return, req.body);
    const x = await loadRx(req);
    await assertBranch(deps, req, x.branchId);
    if (x.status !== 'Dispensed') throw Errors.conflict('INVALID_TRANSITION', 'Only dispensed medicine can be returned');
    const left = x.quantity - (x.returnedQuantity ?? 0);
    if (body.quantity > left) throw Errors.validation([{ path: 'quantity', message: `At most ${left} can be returned` }]);
    const a = req.actor!;
    const s = deps.data.client.startSession();
    try {
      await s.withTransaction(async () => {
        let need = body.quantity;
        const back: { lotId: ObjectId; quantity: number }[] = [];
        // Return into the batches it came from, latest expiry first.
        for (const l of [...x.dispensed.lots].sort((p: Document, q: Document) => String(q.expiry).localeCompare(String(p.expiry)))) {
          if (need <= 0) break;
          const n = Math.min(need, l.quantity);
          await db(req).collection('stock_lots').updateOne({ _id: l.lotId }, { $inc: { quantity: n, version: 1 } }, { session: s });
          back.push({ lotId: l.lotId, quantity: n });
          need -= n;
        }
        await recordMovements(db(req), s, { tenantId: a.tenantId!, storeId: x.dispensed.storeId, itemId: x.itemId, type: 'return', by: a.userId, reason: body.reason, ref: `prescription:${id(x)}` }, back);
        await db(req).collection('prescriptions').updateOne({ _id: x._id }, { $inc: { returnedQuantity: body.quantity, version: 1 } }, { session: s });
      });
    } finally {
      await s.endSession();
    }
    await audit(deps, req, { action: 'rx.return', resource: `prescription:${id(x)}`, outcome: 'success', meta: { quantity: body.quantity } });
    res.json({ data: { id: id(x), returned: (x.returnedQuantity ?? 0) + body.quantity } });
  });

  r.post('/prescriptions/:id/cancel', async (req, res) => {
    const { reason } = parse(Cancel, req.body);
    const x = await loadRx(req);
    const a = req.actor!;
    if (!x.prescriberId.equals(a.userId) && !can(a.perms, 'rx', 'S')) await deny(deps, req, `prescription:${id(x)}`, 'only the prescriber or pharmacy cancels');
    const upd = await db(req).collection('prescriptions').updateOne({ _id: x._id, status: { $in: ['Draft', 'Signed', 'Verified'] } }, { $set: { status: 'Cancelled', cancelReason: reason, cancelledBy: a.userId }, $inc: { version: 1 } });
    if (!upd.modifiedCount) throw Errors.conflict('INVALID_TRANSITION', 'Dispensed medicine is returned, not cancelled');
    await audit(deps, req, { action: 'rx.cancel', resource: `prescription:${id(x)}`, outcome: 'success' });
    res.json({ data: { id: id(x), status: 'Cancelled' } });
  });

  /** Medication administration record (MAR): nurses chart each dose as given, held or refused. */
  r.post('/prescriptions/:id/administrations', async (req, res) => {
    const body = parse(Admin, req.body);
    const x = await loadRx(req);
    const e = await db(req).collection('encounters').findOne({ _id: x.encounterId });
    await loadPatient(deps, req, x.patientId, { clinical: true });
    if (!encLevelOk(req.actor!.perms, e!.type, 'E')) await deny(deps, req, `prescription:${id(x)}`, 'charting needs clinical access to the visit');
    if (x.status !== 'Dispensed') throw Errors.conflict('NOT_DISPENSED', 'Only dispensed medicine is charted');
    if (body.status !== 'given' && !body.reason) throw Errors.validation([{ path: 'reason', message: 'Say why the dose was held or refused' }]);
    const a = req.actor!;
    const ins = await db(req).collection('administrations').insertOne({ tenantId: a.tenantId, prescriptionId: x._id, patientId: x.patientId, encounterId: x.encounterId, ...body, at: now(), by: a.userId, byName: a.name });
    await audit(deps, req, { action: 'rx.administer', resource: `prescription:${id(x)}`, outcome: 'success', meta: { status: body.status } });
    res.status(201).json({ data: { id: ins.insertedId.toHexString() } });
  });

  r.get('/prescriptions/:id/administrations', async (req, res) => {
    const x = await loadRx(req);
    await loadPatient(deps, req, x.patientId, { clinical: true });
    const list = await db(req).collection('administrations').find({ prescriptionId: x._id }).sort({ at: -1 }).toArray();
    res.json({ data: list.map((m) => ({ id: id(m), status: m.status, doseGiven: m.doseGiven ?? null, reason: m.reason ?? null, at: m.at, byName: m.byName })) });
  });

  return r;
}
