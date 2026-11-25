import { Router, type Request } from 'express';
import type { Document, ObjectId } from 'mongodb';
import { z } from 'zod';
import { can, isBranchBound } from '@fahan/policy';
import type { Deps } from '../../context';
import { Errors } from '../../lib/errors';
import { idParam, objectId, parse } from '../../lib/validate';
import { audit } from '../../middleware/audit';
import { assertBranch, deny, need } from '../../middleware/authorize';
import { loadPatient } from '../patients/access';

const NewReferral = z
  .object({
    direction: z.enum(['inbound', 'outbound']),
    branchId: objectId,
    patientId: objectId.optional(),
    patientSummary: z.string().trim().min(5).max(500),
    fromFacility: z.string().trim().min(2).max(120),
    toFacility: z.string().trim().min(2).max(120),
    reason: z.string().trim().min(3).max(500),
    priority: z.enum(['routine', 'urgent', 'emergency']),
  })
  .refine((x) => x.direction === 'inbound' || x.patientId, { message: 'Outbound referrals need the patient record', path: ['patientId'] });
const NewVehicle = z.object({ branchId: objectId, code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,12}$/), kind: z.enum(['basic', 'advanced', 'neonatal']) });
const VehicleStatus = z.object({ status: z.enum(['Available', 'OutOfService']), reason: z.string().trim().max(200).optional() });
const Dispatch = z.object({ vehicleId: objectId, crew: z.array(z.string().trim().min(2).max(80)).min(1).max(6), pickup: z.string().trim().min(3).max(200) });
const Handover = z.object({ encounterId: objectId, note: z.string().trim().max(1_000).optional() });
const Cancel = z.object({ reason: z.string().trim().min(3).max(300) });

const id = (x: { _id: ObjectId }) => x._id.toHexString();
const ACTIVE = ['Requested', 'Dispatched', 'Arrived'];

/** Spec §5.25 ambulance & referrals: Requested → Dispatched → Arrived → HandedOver (or Cancelled). */
export function referralRoutes(deps: Deps): Router {
  const r = Router();
  const db = (req: Request) => req.actor!.db!;
  const external = (req: Request) => req.actor!.scope === 'own-record';

  // ---- fleet ----

  r.get('/ambulance/vehicles', need(deps, 'amb', 'V'), async (req, res) => {
    const a = req.actor!;
    const f: Document = { tenantId: a.tenantId };
    if (isBranchBound(a.scope)) f.branchId = a.branchId ?? null;
    const list = await db(req).collection('vehicles').find(f).sort({ code: 1 }).toArray();
    res.json({ data: list.map((v) => ({ id: id(v), code: v.code, kind: v.kind, status: v.status, branchId: v.branchId.toHexString() })) });
  });

  r.post('/ambulance/vehicles', need(deps, 'org', 'E'), async (req, res) => {
    const body = parse(NewVehicle, req.body);
    await assertBranch(deps, req, body.branchId);
    try {
      const ins = await db(req).collection('vehicles').insertOne({ tenantId: req.actor!.tenantId, ...body, status: 'Available', createdAt: new Date() });
      res.status(201).json({ data: { id: ins.insertedId.toHexString(), code: body.code } });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw Errors.conflict('VEHICLE_EXISTS', `Vehicle ${body.code} already exists`);
      throw e;
    }
  });

  r.post('/ambulance/vehicles/:id/status', need(deps, 'amb', 'E'), async (req, res) => {
    const body = parse(VehicleStatus, req.body);
    const v = await db(req).collection('vehicles').findOne({ _id: idParam(req.params.id, 'Vehicle'), tenantId: req.actor!.tenantId });
    if (!v) throw Errors.notFound('Vehicle');
    await assertBranch(deps, req, v.branchId);
    const upd = await db(req).collection('vehicles').updateOne({ _id: v._id, status: { $ne: 'OnRun' } }, { $set: { status: body.status, statusReason: body.reason } });
    if (!upd.matchedCount) throw Errors.conflict('VEHICLE_ON_RUN', 'The vehicle is on a run. Finish or cancel the run first');
    res.json({ data: { id: id(v), status: body.status } });
  });

  // ---- referrals ----

  r.get('/referrals', async (req, res) => {
    const a = req.actor!;
    if (!can(a.perms, 'amb', 'V') && !can(a.perms, 'er', 'V')) await deny(deps, req, 'referrals', 'requires amb:V or er:V');
    const q = parse(z.object({ status: z.enum(['active', 'all']).default('active') }), req.query);
    const f: Document = { tenantId: a.tenantId };
    if (q.status === 'active') f.status = { $in: ACTIVE };
    if (external(req)) f.createdBy = a.userId; // referring providers see only what they sent
    else if (isBranchBound(a.scope)) f.branchId = a.branchId ?? null;
    const list = await db(req).collection('referrals').find(f).sort({ priority: 1, createdAt: -1 }).limit(300).toArray();
    const vehicles = await db(req).collection('vehicles').find({ _id: { $in: list.map((x) => x.vehicleId).filter(Boolean) } }, { projection: { code: 1 } }).toArray();
    res.json({
      data: list.map((x) => ({
        id: id(x),
        direction: x.direction,
        status: x.status,
        priority: x.priority,
        fromFacility: x.fromFacility,
        toFacility: x.toFacility,
        // Clinical detail is withheld from external referrers once the referral is accepted (consent-bound sharing).
        patientSummary: external(req) ? undefined : x.patientSummary,
        reason: external(req) ? undefined : x.reason,
        vehicle: x.vehicleId ? (vehicles.find((v) => v._id.equals(x.vehicleId))?.code ?? null) : null,
        dispatchedAt: x.run?.dispatchedAt ?? null,
        arrivedAt: x.run?.arrivedAt ?? null,
        encounterId: external(req) ? undefined : (x.handover?.encounterId?.toHexString() ?? null),
        createdAt: x.createdAt,
      })),
    });
  });

  r.post('/referrals', need(deps, 'amb', 'E'), async (req, res) => {
    const body = parse(NewReferral, req.body);
    const a = req.actor!;
    if (!external(req)) await assertBranch(deps, req, body.branchId);
    const b = await db(req).collection('branches').findOne({ _id: body.branchId, tenantId: a.tenantId });
    if (!b) throw Errors.notFound('Branch');
    if (body.patientId) await loadPatient(deps, req, body.patientId);
    const ins = await db(req).collection('referrals').insertOne({ tenantId: a.tenantId, ...body, status: 'Requested', createdAt: new Date(), createdBy: a.userId, version: 1 });
    await audit(deps, req, { action: 'amb.referral.create', resource: `referral:${ins.insertedId.toHexString()}`, outcome: 'success', meta: { direction: body.direction, priority: body.priority } });
    res.status(201).json({ data: { id: ins.insertedId.toHexString(), status: 'Requested' } });
  });

  async function loadReferral(req: Request) {
    const x = await db(req).collection('referrals').findOne({ _id: idParam(req.params.id, 'Referral'), tenantId: req.actor!.tenantId });
    if (!x) throw Errors.notFound('Referral');
    await assertBranch(deps, req, x.branchId);
    return x;
  }

  r.post('/referrals/:id/dispatch', need(deps, 'amb', 'E'), async (req, res) => {
    const body = parse(Dispatch, req.body);
    const x = await loadReferral(req);
    if (x.status !== 'Requested') throw Errors.conflict('INVALID_TRANSITION', `Referral is ${String(x.status).toLowerCase()}`);
    const s = deps.data.client.startSession();
    let code = '';
    try {
      await s.withTransaction(async () => {
        const v = await db(req).collection('vehicles').findOneAndUpdate(
          { _id: body.vehicleId, tenantId: req.actor!.tenantId, branchId: x.branchId, status: 'Available' },
          { $set: { status: 'OnRun', referralId: x._id } },
          { session: s },
        );
        if (!v) throw Errors.conflict('VEHICLE_UNAVAILABLE', 'That vehicle is not available');
        code = v.code;
        const upd = await db(req).collection('referrals').updateOne(
          { _id: x._id, status: 'Requested' },
          { $set: { status: 'Dispatched', vehicleId: v._id, run: { crew: body.crew, pickup: body.pickup, dispatchedAt: new Date(), dispatchedBy: req.actor!.userId } }, $inc: { version: 1 } },
          { session: s },
        );
        if (!upd.modifiedCount) throw Errors.conflict('INVALID_TRANSITION', 'Referral changed while dispatching');
      });
    } finally {
      await s.endSession();
    }
    await audit(deps, req, { action: 'amb.dispatch', resource: `referral:${id(x)}`, outcome: 'success', meta: { vehicle: code } });
    res.json({ data: { id: id(x), status: 'Dispatched', vehicle: code } });
  });

  r.post('/referrals/:id/arrive', need(deps, 'amb', 'E'), async (req, res) => {
    const x = await loadReferral(req);
    const upd = await db(req).collection('referrals').updateOne({ _id: x._id, status: 'Dispatched' }, { $set: { status: 'Arrived', 'run.arrivedAt': new Date() }, $inc: { version: 1 } });
    if (!upd.modifiedCount) throw Errors.conflict('INVALID_TRANSITION', `Referral is ${String(x.status).toLowerCase()}`);
    await audit(deps, req, { action: 'amb.arrive', resource: `referral:${id(x)}`, outcome: 'success' });
    res.json({ data: { id: id(x), status: 'Arrived' } });
  });

  /** Spec §5.25 acceptance: the transfer is linked to the destination encounter; the handover is audited. */
  r.post('/referrals/:id/handover', need(deps, 'er', 'E'), async (req, res) => {
    const body = parse(Handover, req.body);
    const x = await loadReferral(req);
    if (!['Arrived', 'Requested'].includes(x.status)) throw Errors.conflict('INVALID_TRANSITION', `Referral is ${String(x.status).toLowerCase()}`);
    const e = await db(req).collection('encounters').findOne({ _id: body.encounterId, tenantId: req.actor!.tenantId, branchId: x.branchId });
    if (!e) throw Errors.validation([{ path: 'encounterId', message: 'Choose the receiving visit at this branch' }]);
    if (x.patientId && !x.patientId.equals(e.patientId)) throw Errors.validation([{ path: 'encounterId', message: 'That visit belongs to a different patient' }]);
    const s = deps.data.client.startSession();
    try {
      await s.withTransaction(async () => {
        await db(req).collection('referrals').updateOne(
          { _id: x._id },
          { $set: { status: 'HandedOver', patientId: e.patientId, handover: { encounterId: e._id, note: body.note, at: new Date(), by: req.actor!.userId } }, $inc: { version: 1 } },
          { session: s },
        );
        if (x.vehicleId) await db(req).collection('vehicles').updateOne({ _id: x.vehicleId }, { $set: { status: 'Available' }, $unset: { referralId: '' } }, { session: s });
        await db(req).collection('encounters').updateOne({ _id: e._id }, { $set: { referralId: x._id } }, { session: s });
      });
    } finally {
      await s.endSession();
    }
    await audit(deps, req, { action: 'amb.handover', resource: `referral:${id(x)}`, outcome: 'success', meta: { encounter: id(e) } });
    res.json({ data: { id: id(x), status: 'HandedOver', encounterId: id(e) } });
  });

  r.post('/referrals/:id/cancel', need(deps, 'amb', 'E'), async (req, res) => {
    const { reason } = parse(Cancel, req.body);
    const x = await loadReferral(req);
    if (!['Requested', 'Dispatched'].includes(x.status)) throw Errors.conflict('INVALID_TRANSITION', `Referral is ${String(x.status).toLowerCase()}`);
    await db(req).collection('referrals').updateOne({ _id: x._id }, { $set: { status: 'Cancelled', cancelReason: reason }, $inc: { version: 1 } });
    if (x.vehicleId) await db(req).collection('vehicles').updateOne({ _id: x.vehicleId }, { $set: { status: 'Available' }, $unset: { referralId: '' } });
    await audit(deps, req, { action: 'amb.cancel', resource: `referral:${id(x)}`, outcome: 'success' });
    res.json({ data: { id: id(x), status: 'Cancelled' } });
  });

  return r;
}
