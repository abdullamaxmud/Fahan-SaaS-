import { Router, type Request } from 'express';
import type { ObjectId } from 'mongodb';
import { z } from 'zod';
import { can, type Level } from '@fahan/policy';
import type { Deps } from '../../context';
import { AppError, Errors } from '../../lib/errors';
import { idParam, objectId, parse } from '../../lib/validate';
import { audit } from '../../middleware/audit';
import { deny, need } from '../../middleware/authorize';
import { requireRecentMfa } from '../../middleware/session';
import { loadPatient } from '../patients/access';

const CLINICAL = ['opd', 'er', 'nur', 'icu', 'mat'] as const;
const clinicalLevel = (req: Request, l: Level) => CLINICAL.some((m) => can(req.actor!.perms, m, l));

const NewAllergy = z.object({
  substance: z.string().trim().min(2).max(120),
  category: z.enum(['drug', 'food', 'environment', 'other']),
  reaction: z.string().trim().max(200).optional(),
  severity: z.enum(['mild', 'moderate', 'severe', 'life-threatening']),
  verification: z.enum(['suspected', 'confirmed']),
});
const EditAllergy = z.object({ status: z.enum(['inactive', 'entered-in-error']), reason: z.string().trim().min(3).max(300), version: z.number().int().positive() });
const BreakGlass = z.object({ patientId: objectId, reason: z.string().trim().min(20, 'Explain the emergency in at least 20 characters').max(500) });
const Review = z.object({ outcome: z.enum(['justified', 'unjustified']), note: z.string().trim().min(3).max(500) });

/** Minutes a break-glass grant stays open (spec §3.4: limited scope and expiry). */
export const BREAK_GLASS_MINUTES = 45;

export const publicAllergy = (x: Record<string, any>) => ({
  id: x._id.toHexString(),
  substance: x.substance,
  category: x.category,
  reaction: x.reaction ?? null,
  severity: x.severity,
  verification: x.verification,
  status: x.status,
  recordedAt: x.recordedAt,
  version: x.version,
});

/** Patient safety records (allergies) and emergency access (break-glass) with retrospective review. */
export function clinicalRoutes(deps: Deps): Router {
  const r = Router();

  r.get('/patients/:id/allergies', async (req, res) => {
    const p = await loadPatient(deps, req, idParam(req.params.id, 'Patient'), { clinical: true });
    const list = await req.actor!.db!.collection('allergies').find({ tenantId: req.actor!.tenantId, patientId: p._id }).sort({ status: 1, recordedAt: -1 }).toArray();
    res.json({ data: list.map(publicAllergy) });
  });

  r.post('/patients/:id/allergies', async (req, res) => {
    if (!clinicalLevel(req, 'E')) await deny(deps, req, 'allergies', 'requires a clinical module at E');
    const body = parse(NewAllergy, req.body);
    const p = await loadPatient(deps, req, idParam(req.params.id, 'Patient'), { clinical: true });
    const a = req.actor!;
    const dup = await a.db!.collection('allergies').findOne({ patientId: p._id, status: 'active', substance: { $regex: `^${body.substance.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } });
    if (dup) throw Errors.conflict('ALLERGY_EXISTS', `${body.substance} is already on the allergy list`);
    const doc = { tenantId: a.tenantId, patientId: p._id, ...body, status: 'active', recordedBy: a.userId, recordedAt: new Date(), version: 1 };
    const ins = await a.db!.collection('allergies').insertOne(doc);
    await audit(deps, req, { action: 'clinical.allergy.add', resource: `patient:${p._id.toHexString()}`, outcome: 'success', meta: { severity: body.severity } });
    res.status(201).json({ data: publicAllergy({ _id: ins.insertedId, ...doc }) });
  });

  r.patch('/patients/:id/allergies/:allergyId', async (req, res) => {
    if (!clinicalLevel(req, 'E')) await deny(deps, req, 'allergies', 'requires a clinical module at E');
    const body = parse(EditAllergy, req.body);
    const p = await loadPatient(deps, req, idParam(req.params.id, 'Patient'), { clinical: true });
    const upd = await req
      .actor!.db!.collection('allergies')
      .findOneAndUpdate(
        { _id: idParam(req.params.allergyId, 'Allergy'), patientId: p._id, status: 'active', version: body.version },
        { $set: { status: body.status, statusReason: body.reason, statusAt: new Date(), statusBy: req.actor!.userId }, $inc: { version: 1 } },
        { returnDocument: 'after' },
      );
    if (!upd) throw Errors.conflict('VERSION_CONFLICT', 'This allergy changed or is no longer active. Reload and try again');
    await audit(deps, req, { action: 'clinical.allergy.status', resource: `patient:${p._id.toHexString()}`, outcome: 'success', meta: { status: body.status } });
    res.json({ data: publicAllergy(upd) });
  });

  // ---- break-glass ----

  r.post(
    '/break-glass',
    async (req, _res, next) => {
      // Refuse non-clinical roles before asking anyone for an MFA code.
      if (!clinicalLevel(req, 'E')) await deny(deps, req, 'break-glass', 'only clinical staff may use emergency access');
      next();
    },
    requireRecentMfa(deps),
    async (req, res) => {
    const body = parse(BreakGlass, req.body);
    const a = req.actor!;
    const p = await a.db!.collection('patients').findOne({ _id: body.patientId, tenantId: a.tenantId });
    if (!p) throw Errors.notFound('Patient');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + BREAK_GLASS_MINUTES * 60_000);
    const ins = await a.db!.collection('break_glass').insertOne({
      tenantId: a.tenantId,
      userId: a.userId,
      userName: a.name,
      roles: a.roles,
      patientId: p._id,
      mrn: p.mrn,
      reason: body.reason,
      createdAt: now,
      expiresAt,
      review: null,
    });
    await audit(deps, req, { action: 'security.break_glass', resource: `patient:${p._id.toHexString()}`, outcome: 'allow', meta: { minutes: BREAK_GLASS_MINUTES, grant: ins.insertedId.toHexString() } });
    res.status(201).json({ data: { id: ins.insertedId.toHexString(), patientId: p._id.toHexString(), expiresAt: expiresAt.toISOString() } });
    },
  );

  r.get('/security/break-glass', need(deps, 'sec', 'V'), async (req, res) => {
    const q = parse(z.object({ status: z.enum(['pending', 'reviewed', 'all']).default('pending') }), req.query);
    const a = req.actor!;
    const filter: Record<string, unknown> = { tenantId: a.tenantId };
    if (q.status === 'pending') filter.review = null;
    if (q.status === 'reviewed') filter.review = { $ne: null };
    const list = await a.db!.collection('break_glass').find(filter).sort({ createdAt: -1 }).limit(200).toArray();
    const reads = await a
      .db!.collection('audit_events')
      .aggregate([
        { $match: { actorId: { $in: list.map((g) => (g.userId as ObjectId).toHexString()) }, resource: { $in: list.map((g) => `patient:${(g.patientId as ObjectId).toHexString()}`) } } },
        { $group: { _id: { actor: '$actorId', resource: '$resource' }, n: { $sum: 1 } } },
      ])
      .toArray();
    res.json({
      data: list.map((g) => ({
        id: g._id.toHexString(),
        user: { id: g.userId.toHexString(), name: g.userName, roles: g.roles },
        patient: { id: g.patientId.toHexString(), mrn: g.mrn },
        reason: g.reason,
        createdAt: g.createdAt,
        expiresAt: g.expiresAt,
        eventsOnPatient: reads.find((x) => x._id.actor === g.userId.toHexString() && x._id.resource === `patient:${g.patientId.toHexString()}`)?.n ?? 0,
        review: g.review,
      })),
    });
  });

  r.post('/security/break-glass/:id/review', need(deps, 'sec', 'A'), async (req, res) => {
    const body = parse(Review, req.body);
    const a = req.actor!;
    const id = idParam(req.params.id, 'Break-glass grant');
    const g = await a.db!.collection('break_glass').findOne({ _id: id, tenantId: a.tenantId });
    if (!g) throw Errors.notFound('Break-glass grant');
    if (g.userId.equals(a.userId)) throw new AppError(403, 'FOUR_EYES', 'You cannot review your own emergency access');
    const upd = await a
      .db!.collection('break_glass')
      .updateOne({ _id: id, review: null }, { $set: { review: { outcome: body.outcome, note: body.note, by: a.userId, at: new Date() }, expiresAt: new Date() } });
    if (!upd.modifiedCount) throw Errors.conflict('ALREADY_REVIEWED', 'This access has already been reviewed');
    await audit(deps, req, { action: 'security.break_glass.review', resource: `break_glass:${id.toHexString()}`, outcome: 'success', meta: { outcome: body.outcome } });
    res.json({ data: { id: id.toHexString(), outcome: body.outcome } });
  });

  return r;
}
