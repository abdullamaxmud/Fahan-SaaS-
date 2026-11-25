import { Router, type Request } from 'express';
import type { Document, ObjectId } from 'mongodb';
import { z } from 'zod';
import type { Deps } from '../../context';
import { AppError, Errors } from '../../lib/errors';
import { idParam, objectId, parse } from '../../lib/validate';
import { audit } from '../../middleware/audit';
import { assertBranch, need } from '../../middleware/authorize';
import { loadPatient } from '../patients/access';

const NewPlan = z.object({
  problem: z.string().trim().min(3).max(200),
  goal: z.string().trim().min(3).max(300),
  interventions: z.array(z.string().trim().min(2).max(200)).min(1).max(15),
});
const ClosePlan = z.object({ status: z.enum(['resolved', 'discontinued']), outcome: z.string().trim().min(3).max(500), version: z.number().int().positive() });
const Handover = z.object({
  shift: z.enum(['day', 'night']),
  summary: z.string().trim().min(5).max(5_000),
  items: z
    .array(z.object({ admissionId: objectId, note: z.string().trim().min(2).max(1_000), risks: z.array(z.enum(['fall', 'pressure-injury', 'infection', 'deterioration', 'self-harm'])).default([]) }))
    .max(60)
    .default([]),
});

const id = (x: { _id: ObjectId }) => x._id.toHexString();

/** Spec §5.9 nursing & vitals: care plans with ownership, shift handovers, verification of nursing notes. */
export function nursingRoutes(deps: Deps): Router {
  const r = Router();
  const db = (req: Request) => req.actor!.db!;

  async function admission(req: Request, admissionId: ObjectId) {
    const x = await db(req).collection('admissions').findOne({ _id: admissionId, tenantId: req.actor!.tenantId });
    if (!x) throw Errors.notFound('Admission');
    await loadPatient(deps, req, x.patientId, { clinical: true });
    return x;
  }

  // ---- care plans ----

  r.get('/admissions/:id/care-plans', need(deps, 'nur', 'V'), async (req, res) => {
    const x = await admission(req, idParam(req.params.id, 'Admission'));
    const list = await db(req).collection('care_plans').find({ admissionId: x._id }).sort({ status: 1, createdAt: -1 }).toArray();
    res.json({ data: list.map(({ _id, tenantId, admissionId, patientId, ownerId, ...p }) => ({ id: _id.toHexString(), ...p, ownerId: ownerId.toHexString() })) });
  });

  r.post('/admissions/:id/care-plans', need(deps, 'nur', 'E'), async (req, res) => {
    const body = parse(NewPlan, req.body);
    const x = await admission(req, idParam(req.params.id, 'Admission'));
    if (x.status !== 'Admitted') throw Errors.conflict('INVALID_TRANSITION', 'Care plans are for admitted patients');
    const a = req.actor!;
    const doc = { tenantId: a.tenantId, admissionId: x._id, patientId: x.patientId, ...body, status: 'active', ownerId: a.userId, ownerName: a.name, createdAt: new Date(), version: 1 };
    const ins = await db(req).collection('care_plans').insertOne(doc);
    await audit(deps, req, { action: 'nur.care_plan.create', resource: `admission:${id(x)}`, outcome: 'success' });
    res.status(201).json({ data: { id: ins.insertedId.toHexString(), status: 'active' } });
  });

  r.patch('/care-plans/:id', need(deps, 'nur', 'E'), async (req, res) => {
    const body = parse(ClosePlan, req.body);
    const p = await db(req).collection('care_plans').findOne({ _id: idParam(req.params.id, 'Care plan'), tenantId: req.actor!.tenantId });
    if (!p) throw Errors.notFound('Care plan');
    await loadPatient(deps, req, p.patientId, { clinical: true });
    const upd = await db(req).collection('care_plans').updateOne(
      { _id: p._id, status: 'active', version: body.version },
      { $set: { status: body.status, outcome: body.outcome, closedBy: req.actor!.userId, closedAt: new Date() }, $inc: { version: 1 } },
    );
    if (!upd.modifiedCount) throw Errors.conflict('VERSION_CONFLICT', 'This care plan changed or is already closed. Reload and try again');
    await audit(deps, req, { action: 'nur.care_plan.close', resource: `care_plan:${id(p)}`, outcome: 'success', meta: { status: body.status } });
    res.json({ data: { id: id(p), status: body.status } });
  });

  // ---- handovers ----

  async function ward(req: Request, wardId: ObjectId) {
    const w = await db(req).collection('wards').findOne({ _id: wardId, tenantId: req.actor!.tenantId });
    if (!w) throw Errors.notFound('Ward');
    await assertBranch(deps, req, w.branchId);
    return w;
  }

  r.get('/wards/:id/handovers', need(deps, 'nur', 'V'), async (req, res) => {
    const w = await ward(req, idParam(req.params.id, 'Ward'));
    const list = await db(req).collection('handovers').find({ wardId: w._id }).sort({ createdAt: -1 }).limit(20).toArray();
    res.json({
      data: list.map((h) => ({
        id: id(h),
        shift: h.shift,
        summary: h.summary,
        items: h.items.map((i: Document) => ({ ...i, admissionId: i.admissionId.toHexString() })),
        authorName: h.authorName,
        createdAt: h.createdAt,
        acknowledgedBy: h.ack?.name ?? null,
        acknowledgedAt: h.ack?.at ?? null,
      })),
    });
  });

  r.post('/wards/:id/handovers', need(deps, 'nur', 'E'), async (req, res) => {
    const body = parse(Handover, req.body);
    const w = await ward(req, idParam(req.params.id, 'Ward'));
    const ids = body.items.map((i) => i.admissionId);
    const ok = await db(req).collection('admissions').countDocuments({ _id: { $in: ids }, wardId: w._id, status: 'Admitted' });
    if (ok !== new Set(ids.map(String)).size) throw Errors.validation([{ path: 'items', message: 'Every handover item must be a patient currently on this ward' }]);
    const a = req.actor!;
    const ins = await db(req)
      .collection('handovers')
      .insertOne({ tenantId: a.tenantId, wardId: w._id, ...body, authorId: a.userId, authorName: a.name, createdAt: new Date() });
    await audit(deps, req, { action: 'nur.handover.create', resource: `ward:${id(w)}`, outcome: 'success', meta: { items: body.items.length } });
    res.status(201).json({ data: { id: ins.insertedId.toHexString() } });
  });

  r.post('/handovers/:id/acknowledge', need(deps, 'nur', 'E'), async (req, res) => {
    const h = await db(req).collection('handovers').findOne({ _id: idParam(req.params.id, 'Handover'), tenantId: req.actor!.tenantId });
    if (!h) throw Errors.notFound('Handover');
    await ward(req, h.wardId);
    const a = req.actor!;
    if (h.authorId.equals(a.userId)) throw new AppError(403, 'FOUR_EYES', 'The incoming nurse acknowledges the handover, not the author');
    const upd = await db(req).collection('handovers').updateOne({ _id: h._id, ack: { $exists: false } }, { $set: { ack: { by: a.userId, name: a.name, at: new Date() } } });
    if (!upd.modifiedCount) throw Errors.conflict('ALREADY_ACKNOWLEDGED', 'This handover was already acknowledged');
    await audit(deps, req, { action: 'nur.handover.acknowledge', resource: `handover:${id(h)}`, outcome: 'success' });
    res.json({ data: { id: id(h), acknowledged: true } });
  });

  // ---- verification of nursing notes (Recorded → Verified) ----

  r.post('/notes/:id/verify', need(deps, 'nur', 'S'), async (req, res) => {
    const n = await db(req).collection('clinical_notes').findOne({ _id: idParam(req.params.id, 'Note'), tenantId: req.actor!.tenantId });
    if (!n || n.status !== 'Draft' || !['progress', 'nursing'].includes(n.kind)) throw Errors.notFound('Nursing note awaiting verification');
    await loadPatient(deps, req, n.patientId, { clinical: true });
    const a = req.actor!;
    if (n.authorId.equals(a.userId)) throw new AppError(403, 'FOUR_EYES', 'Another nurse verifies your notes');
    const now = new Date();
    const upd = await db(req)
      .collection('clinical_notes')
      .updateOne({ _id: n._id, status: 'Draft' }, { $set: { status: 'Signed', signedAt: now, signedBy: a.userId, verifiedBy: a.userId, verifiedByName: a.name }, $inc: { version: 1 } });
    if (!upd.modifiedCount) throw Errors.conflict('NOTE_SIGNED', 'This note was already verified');
    await audit(deps, req, { action: 'nur.note.verify', resource: `note:${id(n)}`, outcome: 'success' });
    res.json({ data: { id: id(n), status: 'Signed', verifiedBy: a.name } });
  });

  return r;
}
