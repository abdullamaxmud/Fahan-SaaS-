import { Router, type Request } from 'express';
import type { Document, ObjectId } from 'mongodb';
import { z } from 'zod';
import { isBranchBound } from '@fahan/policy';
import type { Deps } from '../../context';
import { AppError, Errors } from '../../lib/errors';
import { localDate } from '../../lib/time';
import { idParam, objectId, parse } from '../../lib/validate';
import { audit } from '../../middleware/audit';
import { assertBranch, need } from '../../middleware/authorize';

export const MODALITIES = ['XR', 'CT', 'MR', 'US', 'MG', 'FL', 'ECG', 'ECHO', 'ENDO', 'EEG'] as const;
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const NewAsset = z.object({
  branchId: objectId,
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,16}$/),
  name: z.string().trim().min(2).max(120),
  kind: z.enum(['imaging', 'diagnostic', 'monitor', 'ventilator', 'infusion-pump', 'anesthesia', 'autoclave', 'other']),
  modality: z.enum(MODALITIES).optional(),
  serial: z.string().trim().max(60).optional(),
  nextCalibrationDue: day.optional(),
});
const Reason = z.object({ reason: z.string().trim().min(3).max(300) });
const NewJob = z.object({ kind: z.enum(['preventive', 'repair', 'calibration']), scheduledFor: day, notes: z.string().trim().max(1_000).optional() });
const CompleteJob = z.object({ result: z.enum(['pass', 'fail']), notes: z.string().trim().min(3).max(1_000), nextCalibrationDue: day.optional() });

const id = (x: { _id: ObjectId }) => x._id.toHexString();

/** Spec §5.24: a device can be used only when it is available and its calibration is not overdue. */
export function assetUsable(a: Document, today: string): { ok: boolean; reason?: string } {
  if (a.status !== 'Available') return { ok: false, reason: `${a.code} is ${a.status === 'OutOfService' ? 'out of service' : String(a.status).toLowerCase()}${a.statusReason ? `: ${a.statusReason}` : ''}` };
  if (a.nextCalibrationDue && a.nextCalibrationDue < today) return { ok: false, reason: `${a.code} calibration was due ${a.nextCalibrationDue}` };
  return { ok: true };
}

/** Spec §5.24 equipment, CSSD & facilities: Available → Scheduled (maintenance) → OutOfService → Released. */
export function equipmentRoutes(deps: Deps): Router {
  const r = Router();
  const db = (req: Request) => req.actor!.db!;
  const today = () => localDate(deps.config.now(), 'Africa/Mogadishu');

  async function asset(req: Request, assetId: ObjectId) {
    const x = await db(req).collection('assets').findOne({ _id: assetId, tenantId: req.actor!.tenantId });
    if (!x) throw Errors.notFound('Equipment');
    await assertBranch(deps, req, x.branchId);
    return x;
  }

  r.get('/assets', async (req, res) => {
    const a = req.actor!;
    const q = parse(z.object({ modality: z.enum(MODALITIES).optional() }), req.query);
    const f: Document = { tenantId: a.tenantId };
    if (isBranchBound(a.scope)) f.branchId = a.branchId ?? null;
    if (q.modality) f.modality = q.modality;
    const list = await db(req).collection('assets').find(f).sort({ code: 1 }).toArray();
    const t = today();
    res.json({
      data: list.map((x) => ({
        id: id(x),
        code: x.code,
        name: x.name,
        kind: x.kind,
        modality: x.modality ?? null,
        status: x.status,
        statusReason: x.statusReason ?? null,
        nextCalibrationDue: x.nextCalibrationDue ?? null,
        usable: assetUsable(x, t).ok,
        blockedReason: assetUsable(x, t).reason ?? null,
      })),
    });
  });

  r.post('/assets', need(deps, 'eq', 'A'), async (req, res) => {
    const body = parse(NewAsset, req.body);
    await assertBranch(deps, req, body.branchId);
    try {
      const ins = await db(req).collection('assets').insertOne({ tenantId: req.actor!.tenantId, ...body, status: 'Available', createdAt: new Date() });
      await audit(deps, req, { action: 'eq.asset.create', resource: `asset:${ins.insertedId.toHexString()}`, outcome: 'success', meta: { code: body.code } });
      res.status(201).json({ data: { id: ins.insertedId.toHexString(), code: body.code } });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw Errors.conflict('ASSET_EXISTS', `Equipment ${body.code} already exists`);
      throw e;
    }
  });

  r.post('/assets/:id/out-of-service', need(deps, 'eq', 'E'), async (req, res) => {
    const { reason } = parse(Reason, req.body);
    const x = await asset(req, idParam(req.params.id, 'Equipment'));
    await db(req).collection('assets').updateOne({ _id: x._id }, { $set: { status: 'OutOfService', statusReason: reason, statusAt: new Date(), statusBy: req.actor!.userId } });
    await audit(deps, req, { action: 'eq.out_of_service', resource: `asset:${id(x)}`, outcome: 'success', meta: { reason } });
    res.json({ data: { id: id(x), status: 'OutOfService' } });
  });

  /** Only the biomedical lead returns equipment to service, and not while a repair job is open. */
  r.post('/assets/:id/release', need(deps, 'eq', 'A'), async (req, res) => {
    const { reason } = parse(Reason, req.body);
    const x = await asset(req, idParam(req.params.id, 'Equipment'));
    const open = await db(req).collection('maintenance_jobs').countDocuments({ assetId: x._id, status: 'Open', kind: { $in: ['repair', 'calibration'] } });
    if (open) throw new AppError(409, 'JOB_OPEN', 'Finish the open repair or calibration job first');
    await db(req).collection('assets').updateOne({ _id: x._id }, { $set: { status: 'Available', statusReason: reason, statusAt: new Date(), statusBy: req.actor!.userId } });
    await audit(deps, req, { action: 'eq.release', resource: `asset:${id(x)}`, outcome: 'success' });
    res.json({ data: { id: id(x), status: 'Available' } });
  });

  r.get('/assets/:id/jobs', need(deps, 'eq', 'V'), async (req, res) => {
    const x = await asset(req, idParam(req.params.id, 'Equipment'));
    const list = await db(req).collection('maintenance_jobs').find({ assetId: x._id }).sort({ scheduledFor: -1 }).toArray();
    res.json({ data: list.map(({ _id, tenantId, assetId, ...j }) => ({ id: _id.toHexString(), ...j })) });
  });

  r.post('/assets/:id/jobs', need(deps, 'eq', 'E'), async (req, res) => {
    const body = parse(NewJob, req.body);
    const x = await asset(req, idParam(req.params.id, 'Equipment'));
    const ins = await db(req).collection('maintenance_jobs').insertOne({ tenantId: req.actor!.tenantId, assetId: x._id, ...body, status: 'Open', createdAt: new Date(), createdBy: req.actor!.userId });
    await audit(deps, req, { action: 'eq.job.create', resource: `asset:${id(x)}`, outcome: 'success', meta: { kind: body.kind } });
    res.status(201).json({ data: { id: ins.insertedId.toHexString() } });
  });

  r.post('/jobs/:id/complete', need(deps, 'eq', 'E'), async (req, res) => {
    const body = parse(CompleteJob, req.body);
    const j = await db(req).collection('maintenance_jobs').findOne({ _id: idParam(req.params.id, 'Job'), tenantId: req.actor!.tenantId });
    if (!j) throw Errors.notFound('Job');
    const x = await asset(req, j.assetId);
    if (j.kind === 'calibration' && body.result === 'pass' && !body.nextCalibrationDue) throw Errors.validation([{ path: 'nextCalibrationDue', message: 'A passed calibration sets the next due date' }]);
    const upd = await db(req).collection('maintenance_jobs').updateOne({ _id: j._id, status: 'Open' }, { $set: { status: 'Done', result: body.result, resultNotes: body.notes, doneAt: new Date(), doneBy: req.actor!.userId } });
    if (!upd.modifiedCount) throw Errors.conflict('JOB_DONE', 'This job is already complete');
    const set: Document = {};
    if (body.result === 'fail') Object.assign(set, { status: 'OutOfService', statusReason: `${j.kind} failed: ${body.notes}`, statusAt: new Date() });
    if (j.kind === 'calibration' && body.result === 'pass') Object.assign(set, { lastCalibratedAt: new Date(), nextCalibrationDue: body.nextCalibrationDue });
    if (Object.keys(set).length) await db(req).collection('assets').updateOne({ _id: x._id }, { $set: set });
    await audit(deps, req, { action: 'eq.job.complete', resource: `asset:${id(x)}`, outcome: 'success', meta: { kind: j.kind, result: body.result } });
    res.json({ data: { id: id(j), result: body.result, assetStatus: set.status ?? x.status } });
  });

  return r;
}
