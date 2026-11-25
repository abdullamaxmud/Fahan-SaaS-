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
import { encLevelOk, loadPatient } from '../patients/access';
import { orderingContext } from '../orders/common';

export const GROUPS = ['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+'] as const;
type Group = (typeof GROUPS)[number];
export const COMPONENTS = ['whole-blood', 'red-cells', 'plasma', 'platelets', 'cryo'] as const;
type Component = (typeof COMPONENTS)[number];

const abo = (g: string) => g.replace(/[+-]$/, '');
const rhNeg = (g: string) => g.endsWith('-');

/**
 * Standard ABO/RhD compatibility (spec §5.18: decisions remain under approved protocols — this table must be
 * signed off by the hospital transfusion committee before go-live).
 */
export function compatible(component: Component, donor: Group, recipient: Group): boolean {
  const d = abo(donor);
  const r = abo(recipient);
  switch (component) {
    case 'whole-blood':
      return d === r && (!rhNeg(recipient) || rhNeg(donor));
    case 'red-cells': {
      const ok: Record<string, string[]> = { O: ['O'], A: ['O', 'A'], B: ['O', 'B'], AB: ['O', 'A', 'B', 'AB'] };
      return ok[r]!.includes(d) && (!rhNeg(recipient) || rhNeg(donor));
    }
    case 'plasma':
    case 'cryo': {
      // Plasma compatibility runs the other way: AB plasma is universal.
      const ok: Record<string, string[]> = { O: ['O', 'A', 'B', 'AB'], A: ['A', 'AB'], B: ['B', 'AB'], AB: ['AB'] };
      return ok[r]!.includes(d);
    }
    case 'platelets':
      return !rhNeg(recipient) || rhNeg(donor);
  }
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const NewUnit = z.object({
  unitNumber: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{5,24}$/),
  group: z.enum(GROUPS),
  component: z.enum(COMPONENTS),
  volumeMl: z.number().int().min(20).max(600),
  collectedOn: day,
  expiry: day,
  donorRef: z.string().trim().max(40).optional(),
});
const Typing = z.object({ patientId: objectId, group: z.enum(GROUPS), sampleRef: z.string().trim().min(3).max(40) });
const NewRequest = z.object({
  encounterId: objectId,
  component: z.enum(COMPONENTS),
  units: z.number().int().min(1).max(10),
  indication: z.string().trim().min(5).max(300),
  urgency: z.enum(['routine', 'urgent', 'emergency']),
});
const Crossmatch = z.object({ unitIds: z.array(objectId).min(1).max(10) });
const Issue = z.object({ unitId: objectId });
const Administer = z.object({ unitId: objectId, checkedBy: objectId, reaction: z.enum(['none', 'mild', 'severe']).default('none'), notes: z.string().trim().max(500).optional() });
const Discard = z.object({ reason: z.string().trim().min(3).max(300) });

const id = (x: { _id: ObjectId }) => x._id.toHexString();

/** Spec §5.18 blood bank & transfusion: Requested → Matched → Issued → Administered, unit-level traceability. */
export function bloodBankRoutes(deps: Deps): Router {
  const r = Router();
  const db = (req: Request) => req.actor!.db!;
  const now = () => deps.config.now();
  const today = () => localDate(now(), 'Africa/Mogadishu');

  const history = (event: string, req: Request, extra: Document = {}) => ({ event, at: now(), by: req.actor!.userId, byName: req.actor!.name, ...extra });

  async function confirmedGroup(req: Request, patientId: ObjectId): Promise<Group | null> {
    // Two typings from different samples by different people must agree (wrong-blood-in-tube protection).
    const t = await db(req).collection('blood_typings').find({ tenantId: req.actor!.tenantId, patientId }).sort({ at: -1 }).limit(10).toArray();
    for (const a of t) for (const b of t) if (a !== b && a.group === b.group && a.sampleRef !== b.sampleRef && !a.by.equals(b.by)) return a.group as Group;
    return null;
  }

  r.post('/units', need(deps, 'bb', 'S'), async (req, res) => {
    const body = parse(NewUnit, req.body);
    const a = req.actor!;
    if (!a.branchId) throw Errors.validation([{ message: 'Your account is not assigned to a branch' }]);
    if (body.expiry <= today()) throw Errors.validation([{ path: 'expiry', message: 'This unit has expired' }]);
    try {
      const ins = await db(req).collection('blood_units').insertOne({ tenantId: a.tenantId, branchId: a.branchId, ...body, status: 'Available', history: [history('received', req)], createdAt: now() });
      await audit(deps, req, { action: 'bb.unit.receive', resource: `blood_unit:${ins.insertedId.toHexString()}`, outcome: 'success', meta: { unit: body.unitNumber, group: body.group } });
      res.status(201).json({ data: { id: ins.insertedId.toHexString(), unitNumber: body.unitNumber } });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw Errors.conflict('UNIT_EXISTS', `Unit ${body.unitNumber} is already registered`);
      throw e;
    }
  });

  r.get('/units', need(deps, 'bb', 'V'), async (req, res) => {
    const q = parse(z.object({ group: z.enum(GROUPS).optional(), component: z.enum(COMPONENTS).optional(), status: z.string().optional() }), req.query);
    const a = req.actor!;
    const f: Document = { tenantId: a.tenantId };
    if (isBranchBound(a.scope)) f.branchId = a.branchId ?? null;
    for (const k of ['group', 'component', 'status'] as const) if (q[k]) f[k] = q[k];
    const list = await db(req).collection('blood_units').find(f).sort({ expiry: 1 }).limit(500).toArray();
    const t = today();
    res.json({ data: list.map((u) => ({ id: id(u), unitNumber: u.unitNumber, group: u.group, component: u.component, volumeMl: u.volumeMl, expiry: u.expiry, status: u.status, expired: u.expiry <= t })) });
  });

  r.post('/typing', need(deps, 'bb', 'S'), async (req, res) => {
    const body = parse(Typing, req.body);
    await loadPatient(deps, req, body.patientId);
    await db(req).collection('blood_typings').insertOne({ tenantId: req.actor!.tenantId, ...body, at: now(), by: req.actor!.userId });
    const confirmed = await confirmedGroup(req, body.patientId);
    await audit(deps, req, { action: 'bb.typing', resource: `patient:${body.patientId.toHexString()}`, outcome: 'success', meta: { group: body.group, confirmed } });
    res.status(201).json({ data: { confirmedGroup: confirmed } });
  });

  r.post('/requests', need(deps, 'bb', 'E'), async (req, res) => {
    const body = parse(NewRequest, req.body);
    const { e } = await orderingContext(deps, req, body.encounterId);
    const a = req.actor!;
    const ins = await db(req).collection('transfusion_requests').insertOne({
      ...body,
      tenantId: a.tenantId,
      branchId: e.branchId,
      encounterId: e._id,
      patientId: e.patientId,
      status: 'Requested',
      unitIds: [],
      requestedBy: a.userId,
      requestedByName: a.name,
      requestedAt: now(),
    });
    await audit(deps, req, { action: 'bb.request', resource: `encounter:${e._id.toHexString()}`, outcome: 'success', meta: { component: body.component, units: body.units, urgency: body.urgency } });
    res.status(201).json({ data: { id: ins.insertedId.toHexString(), status: 'Requested' } });
  });

  async function loadRequest(req: Request) {
    const x = await db(req).collection('transfusion_requests').findOne({ _id: idParam(req.params.id, 'Transfusion request'), tenantId: req.actor!.tenantId });
    if (!x) throw Errors.notFound('Transfusion request');
    return x;
  }

  r.get('/requests', async (req, res) => {
    const a = req.actor!;
    const q = parse(z.object({ encounterId: objectId.optional() }), req.query);
    const f: Document = { tenantId: a.tenantId };
    if (q.encounterId) {
      const e = await db(req).collection('encounters').findOne({ _id: q.encounterId, tenantId: a.tenantId });
      if (!e) throw Errors.notFound('Visit');
      await loadPatient(deps, req, e.patientId, { clinical: true });
      f.encounterId = e._id;
    } else {
      if (!can(a.perms, 'bb', 'S')) await deny(deps, req, 'transfusion requests', 'the request list is for the blood bank');
      f.status = { $in: ['Requested', 'Matched', 'Issued'] };
      if (isBranchBound(a.scope)) f.branchId = a.branchId ?? null;
    }
    const list = await db(req).collection('transfusion_requests').find(f).sort({ requestedAt: 1 }).limit(300).toArray();
    res.json({ data: list.map(({ _id, tenantId, ...x }) => ({ id: _id.toHexString(), ...x })) });
  });

  /** Crossmatch: patient's group must be confirmed twice; every unit must be available, in date and compatible. */
  r.post('/requests/:id/crossmatch', need(deps, 'bb', 'S'), async (req, res) => {
    const body = parse(Crossmatch, req.body);
    const x = await loadRequest(req);
    await assertBranch(deps, req, x.branchId);
    if (!['Requested', 'Matched'].includes(x.status)) throw Errors.conflict('INVALID_TRANSITION', `Request is ${String(x.status).toLowerCase()}`);
    if (body.unitIds.length > x.units) throw Errors.validation([{ path: 'unitIds', message: `Only ${x.units} unit(s) were requested` }]);
    const group = await confirmedGroup(req, x.patientId);
    if (!group) throw new AppError(409, 'GROUP_NOT_CONFIRMED', 'Confirm the patient’s blood group with a second, independent sample first');
    const units = await db(req).collection('blood_units').find({ _id: { $in: body.unitIds }, tenantId: req.actor!.tenantId, branchId: x.branchId }).toArray();
    const problems: { path: string; message: string }[] = [];
    for (const uid of body.unitIds) {
      const u = units.find((y) => y._id.equals(uid));
      if (!u) problems.push({ path: uid.toHexString(), message: 'Unit not found in this blood bank' });
      else if (u.component !== x.component) problems.push({ path: u.unitNumber, message: `Unit is ${u.component}, request is ${x.component}` });
      else if (u.expiry <= today()) problems.push({ path: u.unitNumber, message: 'Expired' });
      else if (u.status !== 'Available') problems.push({ path: u.unitNumber, message: `Unit is ${String(u.status).toLowerCase()}` });
      else if (!compatible(x.component, u.group, group)) problems.push({ path: u.unitNumber, message: `${u.group} ${x.component} is not compatible with recipient ${group}` });
    }
    if (problems.length) throw new AppError(409, 'INCOMPATIBLE_OR_UNAVAILABLE', 'Crossmatch refused', problems);
    const s = deps.data.client.startSession();
    try {
      await s.withTransaction(async () => {
        for (const u of units) {
          const upd = await db(req)
            .collection('blood_units')
            .updateOne({ _id: u._id, status: 'Available' }, { $set: { status: 'Reserved', reservedFor: x._id }, $push: { history: history('reserved', req, { requestId: x._id }) } as Document }, { session: s });
          if (!upd.modifiedCount) throw new AppError(409, 'INCOMPATIBLE_OR_UNAVAILABLE', `${u.unitNumber} was just taken`);
        }
        await db(req).collection('transfusion_requests').updateOne({ _id: x._id }, { $set: { status: 'Matched', recipientGroup: group, matchedAt: now() }, $addToSet: { unitIds: { $each: units.map((u) => u._id) } } }, { session: s });
      });
    } finally {
      await s.endSession();
    }
    await audit(deps, req, { action: 'bb.crossmatch', resource: `transfusion_request:${id(x)}`, outcome: 'success', meta: { units: units.map((u) => u.unitNumber).join(','), recipient: group } });
    res.json({ data: { id: id(x), status: 'Matched', recipientGroup: group, units: units.map((u) => u.unitNumber) } });
  });

  r.post('/requests/:id/issue', need(deps, 'bb', 'S'), async (req, res) => {
    const body = parse(Issue, req.body);
    const x = await loadRequest(req);
    await assertBranch(deps, req, x.branchId);
    const u = await db(req).collection('blood_units').findOne({ _id: body.unitId, reservedFor: x._id, status: 'Reserved' });
    if (!u) throw Errors.conflict('NOT_RESERVED', 'This unit is not reserved for this request');
    if (u.expiry <= today()) throw Errors.conflict('EXPIRED', 'This unit has expired');
    await db(req).collection('blood_units').updateOne({ _id: u._id }, { $set: { status: 'Issued', issuedAt: now() }, $push: { history: history('issued', req, { requestId: x._id }) } as Document });
    await db(req).collection('transfusion_requests').updateOne({ _id: x._id }, { $set: { status: 'Issued' } });
    await audit(deps, req, { action: 'bb.issue', resource: `blood_unit:${id(u)}`, outcome: 'success', meta: { unit: u.unitNumber } });
    res.json({ data: { unit: u.unitNumber, status: 'Issued' } });
  });

  /** Bedside: the administering clinician and an independent second checker confirm patient and unit. */
  r.post('/requests/:id/administer', async (req, res) => {
    const body = parse(Administer, req.body);
    const x = await loadRequest(req);
    const e = await db(req).collection('encounters').findOne({ _id: x.encounterId });
    await loadPatient(deps, req, x.patientId, { clinical: true });
    const a = req.actor!;
    if (!encLevelOk(a.perms, e!.type, 'E')) await deny(deps, req, `transfusion_request:${id(x)}`, 'administration needs clinical access to the visit');
    if (body.checkedBy.equals(a.userId)) throw new AppError(403, 'FOUR_EYES', 'A second, independent person must check the unit at the bedside');
    const checker = await db(req).collection('users').findOne({ _id: body.checkedBy, tenantId: a.tenantId, status: 'Active' });
    if (!checker) throw Errors.validation([{ path: 'checkedBy', message: 'Choose an active colleague as the second checker' }]);
    const u = await db(req).collection('blood_units').findOne({ _id: body.unitId, reservedFor: x._id, status: 'Issued' });
    if (!u) throw Errors.conflict('NOT_ISSUED', 'This unit has not been issued for this patient');
    await db(req).collection('blood_units').updateOne(
      { _id: u._id, status: 'Issued' },
      { $set: { status: 'Transfused', transfusedAt: now(), recipientId: x.patientId, reaction: body.reaction }, $push: { history: history('transfused', req, { checkedByName: checker.name, reaction: body.reaction }) } as Document },
    );
    const remaining = await db(req).collection('blood_units').countDocuments({ reservedFor: x._id, status: { $in: ['Reserved', 'Issued'] } });
    if (!remaining) await db(req).collection('transfusion_requests').updateOne({ _id: x._id }, { $set: { status: 'Administered', completedAt: now() } });
    await audit(deps, req, { action: body.reaction === 'severe' ? 'bb.reaction.severe' : 'bb.administer', resource: `blood_unit:${id(u)}`, outcome: 'success', meta: { unit: u.unitNumber, reaction: body.reaction } });
    res.json({ data: { unit: u.unitNumber, status: 'Transfused', reaction: body.reaction } });
  });

  r.post('/units/:id/discard', need(deps, 'bb', 'S'), async (req, res) => {
    const { reason } = parse(Discard, req.body);
    const u = await db(req).collection('blood_units').findOne({ _id: idParam(req.params.id, 'Unit'), tenantId: req.actor!.tenantId });
    if (!u) throw Errors.notFound('Unit');
    await assertBranch(deps, req, u.branchId);
    const upd = await db(req)
      .collection('blood_units')
      .updateOne({ _id: u._id, status: { $in: ['Available', 'Reserved', 'Quarantined'] } }, { $set: { status: 'Discarded' }, $unset: { reservedFor: '' }, $push: { history: history('discarded', req, { reason }) } as Document });
    if (!upd.modifiedCount) throw Errors.conflict('INVALID_TRANSITION', `Unit is ${String(u.status).toLowerCase()}`);
    await audit(deps, req, { action: 'bb.discard', resource: `blood_unit:${id(u)}`, outcome: 'success', meta: { reason } });
    res.json({ data: { unit: u.unitNumber, status: 'Discarded' } });
  });

  /** Recall traceability: who received a unit and every step it went through. */
  r.get('/units/trace/:unitNumber', need(deps, 'bb', 'V'), async (req, res) => {
    const u = await db(req).collection('blood_units').findOne({ tenantId: req.actor!.tenantId, unitNumber: String(req.params.unitNumber).toUpperCase() });
    if (!u) throw Errors.notFound('Unit');
    const recipient = u.recipientId ? await db(req).collection('patients').findOne({ _id: u.recipientId }, { projection: { mrn: 1, names: 1 } }) : null;
    await audit(deps, req, { action: 'bb.trace', resource: `blood_unit:${id(u)}`, outcome: 'allow' });
    res.json({ data: { unitNumber: u.unitNumber, group: u.group, component: u.component, status: u.status, donorRef: u.donorRef ?? null, recipient, history: u.history } });
  });

  return r;
}
