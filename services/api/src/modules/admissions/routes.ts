import { Router, type Request } from 'express';
import type { ClientSession, Document, ObjectId } from 'mongodb';
import { z } from 'zod';
import { can, effectivePermissions, isBranchBound } from '@fahan/policy';
import type { Deps } from '../../context';
import { AppError, Errors } from '../../lib/errors';
import { idParam, objectId, parse } from '../../lib/validate';
import { audit } from '../../middleware/audit';
import { assertBranch, deny, need } from '../../middleware/authorize';
import { assertRecentMfa } from '../../middleware/session';
import { encLevelOk, hasClinicalAccess, loadPatient } from '../patients/access';
import { openEncounter } from '../encounters/service';

const code = z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{1,12}$/, 'Use letters, digits or hyphens');
const NewWard = z.object({
  branchId: objectId,
  code,
  name: z.string().trim().min(2).max(80),
  kind: z.enum(['general', 'surgical', 'maternity', 'pediatric', 'icu', 'nicu', 'picu', 'isolation']),
});
const NewBeds = z.object({ count: z.number().int().min(1).max(60), room: z.string().trim().max(20).optional(), startAt: z.number().int().min(1).max(999).default(1) });
const BedStatus = z.object({ status: z.enum(['Available', 'OutOfService']), reason: z.string().trim().max(200).optional() });
const Admit = z.object({
  patientId: objectId,
  attendingId: objectId,
  reason: z.string().trim().min(3).max(300),
  source: z.enum(['OPD', 'ER', 'direct', 'referral']),
  fromEncounterId: objectId.optional(),
  wardId: objectId.optional(),
});
const AssignBed = z.object({ bedId: objectId });
const Transfer = z.object({ bedId: objectId, reason: z.string().trim().min(3).max(300) });
const Discharge = z.object({
  disposition: z.enum(['home', 'referred', 'transferred-out', 'against-advice', 'deceased']),
  summary: z.string().trim().min(20, 'Write a discharge summary of at least 20 characters').max(20_000),
  followUp: z.string().trim().max(300).optional(),
});
const ListQuery = z.object({ status: z.enum(['active', 'discharged', 'all']).default('active') });

const id = (x: { _id: ObjectId }) => x._id.toHexString();
const ACTIVE = ['Requested', 'Admitted'];

/** Spec §5.7 admissions & discharge and §5.8 wards, rooms & beds. */
export function admissionRoutes(deps: Deps): Router {
  const r = Router();
  const db = (req: Request) => req.actor!.db!;
  const canBeds = (req: Request) => can(req.actor!.perms, 'bed', 'E') || can(req.actor!.perms, 'adm', 'E');
  /** Names on the bed board only for staff who work with admissions or clinical care; others see initials. */
  const seesNames = (req: Request) => hasClinicalAccess(req) || can(req.actor!.perms, 'adm', 'V');

  async function ward(req: Request, wardId: ObjectId) {
    const w = await db(req).collection('wards').findOne({ _id: wardId, tenantId: req.actor!.tenantId });
    if (!w) throw Errors.notFound('Ward');
    await assertBranch(deps, req, w.branchId);
    return w;
  }

  // ---- wards & beds ----

  /** The bed board: ward staff, nurses and admitting staff all need it to place and find patients. */
  r.get('/wards', async (req, res) => {
    const a = req.actor!;
    const sees = (m: 'bed' | 'adm' | 'nur') => can(a.perms, m, 'V') && !a.disabledModules?.includes(m);
    if (!sees('bed') && !sees('adm') && !sees('nur')) await deny(deps, req, 'bed', 'requires bed, admissions or nursing');
    const wf: Document = { tenantId: a.tenantId };
    if (isBranchBound(a.scope)) wf.branchId = a.branchId ?? null;
    const wards = await db(req).collection('wards').find(wf).sort({ code: 1 }).toArray();
    const beds = await db(req).collection('beds').find({ tenantId: a.tenantId, wardId: { $in: wards.map((w) => w._id) } }).sort({ code: 1 }).toArray();
    const asg = await db(req).collection('bed_assignments').find({ tenantId: a.tenantId, bedId: { $in: beds.map((b) => b._id) }, active: true }).toArray();
    const pats = await db(req).collection('patients').find({ _id: { $in: asg.map((x) => x.patientId) } }, { projection: { names: 1, mrn: 1, dob: 1, sexAtBirth: 1 } }).toArray();
    const admEnc = await db(req).collection('admissions').find({ _id: { $in: asg.map((x) => x.admissionId) } }, { projection: { encounterId: 1 } }).toArray();
    const named = seesNames(req);
    res.json({
      data: wards.map((w) => ({
        id: id(w),
        code: w.code,
        name: w.name,
        kind: w.kind,
        branchId: w.branchId.toHexString(),
        beds: beds
          .filter((b) => b.wardId.equals(w._id))
          .map((b) => {
            const x = asg.find((y) => y.bedId.equals(b._id));
            const p = x ? pats.find((y) => y._id.equals(x.patientId)) : null;
            return {
              id: id(b),
              code: b.code,
              room: b.room ?? null,
              status: b.status,
              admissionId: x?.admissionId.toHexString() ?? null,
              encounterId: (x && named ? admEnc.find((y) => y._id.equals(x.admissionId))?.encounterId?.toHexString() : null) ?? null,
              patient: p
                ? named
                  ? { id: id(p), mrn: p.mrn, names: p.names, dob: p.dob, sexAtBirth: p.sexAtBirth ?? null }
                  : { initials: `${p.names.given[0]}.${p.names.family[0]}.` }
                : null,
            };
          }),
      })),
    });
  });

  r.post('/wards', need(deps, 'bed', 'A'), async (req, res) => {
    const body = parse(NewWard, req.body);
    await assertBranch(deps, req, body.branchId);
    const b = await db(req).collection('branches').findOne({ _id: body.branchId, tenantId: req.actor!.tenantId });
    if (!b) throw Errors.notFound('Branch');
    try {
      const ins = await db(req).collection('wards').insertOne({ tenantId: req.actor!.tenantId, ...body, status: 'Active', createdAt: new Date(), createdBy: req.actor!.userId });
      await audit(deps, req, { action: 'bed.ward.create', resource: `ward:${ins.insertedId.toHexString()}`, outcome: 'success', meta: { code: body.code } });
      res.status(201).json({ data: { id: ins.insertedId.toHexString(), code: body.code } });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw Errors.conflict('WARD_EXISTS', `Ward ${body.code} already exists in this branch`);
      throw e;
    }
  });

  r.post('/wards/:id/beds', need(deps, 'bed', 'A'), async (req, res) => {
    const body = parse(NewBeds, req.body);
    const w = await ward(req, idParam(req.params.id, 'Ward'));
    const docs = Array.from({ length: body.count }, (_, i) => ({
      tenantId: req.actor!.tenantId,
      wardId: w._id,
      branchId: w.branchId,
      code: `${w.code}-${String(body.startAt + i).padStart(2, '0')}`,
      room: body.room,
      status: 'Available',
      createdAt: new Date(),
      version: 1,
    }));
    try {
      await db(req).collection('beds').insertMany(docs, { ordered: true });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw Errors.conflict('BED_EXISTS', 'Some of these bed numbers already exist. Choose a different start number');
      throw e;
    }
    await audit(deps, req, { action: 'bed.create', resource: `ward:${id(w)}`, outcome: 'success', meta: { count: body.count } });
    res.status(201).json({ data: { created: docs.length, codes: docs.map((d) => d.code) } });
  });

  r.post('/beds/:id/status', async (req, res) => {
    const body = parse(BedStatus, req.body);
    // Cleaning → Available is routine ward work; taking a bed out of service is a manager decision.
    const needed = body.status === 'OutOfService' ? 'A' : 'E';
    if (!can(req.actor!.perms, 'bed', needed)) await deny(deps, req, 'bed', `requires bed:${needed}`);
    const bedId = idParam(req.params.id, 'Bed');
    const b = await db(req).collection('beds').findOne({ _id: bedId, tenantId: req.actor!.tenantId });
    if (!b) throw Errors.notFound('Bed');
    await assertBranch(deps, req, b.branchId);
    const from = body.status === 'Available' ? ['Cleaning', 'OutOfService'] : ['Available', 'Cleaning'];
    const upd = await db(req).collection('beds').updateOne({ _id: bedId, status: { $in: from } }, { $set: { status: body.status, statusReason: body.reason, statusAt: new Date() }, $inc: { version: 1 } });
    if (!upd.modifiedCount) throw Errors.conflict('INVALID_TRANSITION', `Bed is ${String(b.status).toLowerCase()}`);
    await audit(deps, req, { action: 'bed.status', resource: `bed:${id(b)}`, outcome: 'success', meta: { from: b.status, to: body.status } });
    res.json({ data: { id: id(b), status: body.status } });
  });

  // ---- admissions ----

  async function attending(req: Request, userId: ObjectId) {
    const u = await db(req).collection('users').findOne({ _id: userId, tenantId: req.actor!.tenantId, status: 'Active' });
    const p = u ? effectivePermissions(u.roles) : {};
    if (!u || !(can(p, 'opd', 'S') || can(p, 'icu', 'S') || can(p, 'mat', 'S'))) {
      throw Errors.validation([{ path: 'attendingId', message: 'Choose an active doctor who can sign inpatient notes' }]);
    }
    return u;
  }

  r.get('/admissions', need(deps, 'adm', 'V'), async (req, res) => {
    const q = parse(ListQuery, req.query);
    const a = req.actor!;
    const f: Document = { tenantId: a.tenantId };
    if (q.status === 'active') f.status = { $in: ACTIVE };
    if (q.status === 'discharged') f.status = 'Discharged';
    if (a.scope === 'assigned-patient') f.attendingId = a.userId;
    else if (isBranchBound(a.scope)) f.branchId = a.branchId ?? null;
    const list = await db(req).collection('admissions').find(f).sort({ createdAt: -1 }).limit(300).toArray();
    const pats = await db(req).collection('patients').find({ _id: { $in: list.map((x) => x.patientId) } }, { projection: { names: 1, mrn: 1, dob: 1, sexAtBirth: 1 } }).toArray();
    const beds = await db(req).collection('beds').find({ _id: { $in: list.map((x) => x.bedId).filter(Boolean) } }, { projection: { code: 1 } }).toArray();
    const docs = await db(req).collection('users').find({ _id: { $in: list.map((x) => x.attendingId) } }, { projection: { name: 1 } }).toArray();
    res.json({
      data: list.map((x) => {
        const p = pats.find((y) => y._id.equals(x.patientId));
        return {
          id: id(x),
          status: x.status,
          source: x.source,
          reason: x.reason,
          encounterId: x.encounterId?.toHexString() ?? null,
          bed: x.bedId ? (beds.find((b) => b._id.equals(x.bedId))?.code ?? null) : null,
          attending: docs.find((d) => d._id.equals(x.attendingId))?.name ?? '—',
          patient: p ? { id: id(p), mrn: p.mrn, names: p.names, dob: p.dob, sexAtBirth: p.sexAtBirth ?? null } : null,
          createdAt: x.createdAt,
          admittedAt: x.admittedAt ?? null,
          dischargedAt: x.discharge?.at ?? null,
          transfers: (x.transfers ?? []).length,
          version: x.version,
        };
      }),
    });
  });

  /** Doctors who can take an inpatient as attending (same rule as admission). */
  r.get('/admissions/attendings', need(deps, 'adm', 'V'), async (req, res) => {
    const a = req.actor!;
    const users = await db(req).collection('users').find({ tenantId: a.tenantId, status: 'Active' }, { projection: { name: 1, roles: 1, branchId: 1 } }).sort({ name: 1 }).toArray();
    const ok = (roles: string[]) => {
      const p = effectivePermissions(roles);
      return can(p, 'opd', 'S') || can(p, 'icu', 'S') || can(p, 'mat', 'S');
    };
    res.json({ data: users.filter((u) => ok(u.roles as string[]) && (!isBranchBound(a.scope) || !u.branchId || u.branchId.equals(a.branchId ?? null))).map((u) => ({ id: id(u), name: u.name })) });
  });

  r.post('/admissions', need(deps, 'adm', 'E'), async (req, res) => {
    const body = parse(Admit, req.body);
    const p = await loadPatient(deps, req, body.patientId);
    if (p.status === 'Merged') throw Errors.conflict('PATIENT_MERGED', 'Admit the surviving record');
    const doc = await attending(req, body.attendingId);
    const branchId = doc.branchId ?? req.actor!.branchId ?? (p.branchIds as ObjectId[])[0];
    await assertBranch(deps, req, branchId);
    if (body.wardId) await ward(req, body.wardId);
    const a = req.actor!;
    try {
      const ins = await db(req).collection('admissions').insertOne({
        tenantId: a.tenantId,
        branchId,
        patientId: p._id,
        attendingId: doc._id,
        reason: body.reason,
        source: body.source,
        fromEncounterId: body.fromEncounterId,
        wardId: body.wardId,
        status: 'Requested',
        activeLock: true,
        transfers: [],
        createdAt: new Date(),
        createdBy: a.userId,
        version: 1,
      });
      await db(req).collection('patients').updateOne({ _id: p._id }, { $addToSet: { careTeam: doc._id } });
      await audit(deps, req, { action: 'adm.request', resource: `admission:${ins.insertedId.toHexString()}`, outcome: 'success', meta: { source: body.source } });
      res.status(201).json({ data: { id: ins.insertedId.toHexString(), status: 'Requested' } });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw Errors.conflict('ALREADY_ADMITTED', 'This patient already has an active admission');
      throw e;
    }
  });

  async function loadAdmission(req: Request) {
    const x = await db(req).collection('admissions').findOne({ _id: idParam(req.params.id, 'Admission'), tenantId: req.actor!.tenantId });
    if (!x) throw Errors.notFound('Admission');
    await assertBranch(deps, req, x.branchId);
    return x;
  }

  /** Occupies a bed for an admission inside the caller's transaction. Throws BED_ALREADY_OCCUPIED on any race. */
  async function occupy(req: Request, s: ClientSession, bedId: ObjectId, adm: Document) {
    const a = req.actor!;
    const bed = await db(req).collection('beds').findOneAndUpdate(
      { _id: bedId, tenantId: a.tenantId, branchId: adm.branchId, $or: [{ status: 'Available' }, { status: 'Reserved', reservedFor: adm._id }] },
      { $set: { status: 'Occupied', statusAt: new Date() }, $unset: { reservedFor: '' }, $inc: { version: 1 } },
      { session: s, returnDocument: 'after' },
    );
    if (!bed) throw new AppError(409, 'BED_ALREADY_OCCUPIED', 'Bed is not available');
    await db(req).collection('bed_assignments').insertOne({ tenantId: a.tenantId, bedId, admissionId: adm._id, patientId: adm.patientId, startedAt: new Date(), active: true, by: a.userId }, { session: s });
    return bed;
  }

  async function release(req: Request, s: ClientSession, adm: Document) {
    const asg = await db(req).collection('bed_assignments').findOneAndUpdate(
      { tenantId: req.actor!.tenantId, admissionId: adm._id, active: true },
      { $set: { endedAt: new Date() }, $unset: { active: '' } },
      { session: s },
    );
    if (asg) await db(req).collection('beds').updateOne({ _id: asg.bedId }, { $set: { status: 'Cleaning', statusAt: new Date() }, $inc: { version: 1 } }, { session: s });
    return asg;
  }

  async function txn<T>(fn: (s: ClientSession) => Promise<T>): Promise<T> {
    const s = deps.data.client.startSession();
    try {
      let out: T | undefined;
      await s.withTransaction(async () => {
        out = await fn(s);
      });
      return out as T;
    } catch (e) {
      // A concurrent writer won the bed: report the business error, not a database one.
      if ((e as { code?: number }).code === 11000 || (e as { codeName?: string }).codeName === 'WriteConflict') {
        throw new AppError(409, 'BED_ALREADY_OCCUPIED', 'Bed is not available');
      }
      throw e;
    } finally {
      await s.endSession();
    }
  }

  r.post('/admissions/:id/assign-bed', async (req, res) => {
    if (!canBeds(req)) await deny(deps, req, 'bed', 'requires bed:E or adm:E');
    const { bedId } = parse(AssignBed, req.body);
    const adm = await loadAdmission(req);
    if (adm.bedId?.equals(bedId) && adm.status === 'Admitted') {
      return res.json({ data: { id: id(adm), status: 'Admitted', encounterId: adm.encounterId.toHexString(), replay: true } });
    }
    if (adm.status !== 'Requested') throw Errors.conflict('INVALID_TRANSITION', adm.status === 'Admitted' ? 'Already in a bed. Use transfer to move the patient' : `Admission is ${String(adm.status).toLowerCase()}`);
    const out = await txn(async (s) => {
      const bed = await occupy(req, s, bedId, adm);
      const encounterId = await openEncounter(req, { type: 'IP', patientId: adm.patientId, branchId: adm.branchId, clinicianIds: [adm.attendingId], reason: adm.reason, extra: { admissionId: adm._id } }, s);
      const upd = await db(req).collection('admissions').updateOne(
        { _id: adm._id, status: 'Requested' },
        { $set: { status: 'Admitted', bedId, wardId: bed.wardId, encounterId, admittedAt: new Date(), admittedBy: req.actor!.userId }, $inc: { version: 1 } },
        { session: s },
      );
      if (!upd.modifiedCount) throw Errors.conflict('INVALID_TRANSITION', 'Admission changed while assigning the bed');
      return { encounterId, bedCode: bed.code };
    });
    await audit(deps, req, { action: 'bed.assign', resource: `admission:${id(adm)}`, outcome: 'success', meta: { bed: out.bedCode } });
    res.json({ data: { id: id(adm), status: 'Admitted', bed: out.bedCode, encounterId: out.encounterId.toHexString() } });
  });

  r.post('/admissions/:id/transfer', async (req, res) => {
    if (!canBeds(req)) await deny(deps, req, 'bed', 'requires bed:E or adm:E');
    const body = parse(Transfer, req.body);
    const adm = await loadAdmission(req);
    if (adm.status !== 'Admitted') throw Errors.conflict('INVALID_TRANSITION', 'Only admitted patients can be transferred');
    if (adm.bedId?.equals(body.bedId)) throw Errors.validation([{ path: 'bedId', message: 'The patient is already in this bed' }]);
    const bed = await txn(async (s) => {
      await release(req, s, adm);
      const b = await occupy(req, s, body.bedId, adm);
      await db(req).collection('admissions').updateOne(
        { _id: adm._id },
        { $set: { bedId: body.bedId, wardId: b.wardId }, $push: { transfers: { fromBedId: adm.bedId, toBedId: body.bedId, reason: body.reason, at: new Date(), by: req.actor!.userId } } as Document, $inc: { version: 1 } },
        { session: s },
      );
      return b;
    });
    await audit(deps, req, { action: 'adm.transfer', resource: `admission:${id(adm)}`, outcome: 'success', meta: { to: bed.code } });
    res.json({ data: { id: id(adm), bed: bed.code } });
  });

  r.post('/admissions/:id/discharge', async (req, res) => {
    const body = parse(Discharge, req.body);
    const adm = await loadAdmission(req);
    if (!encLevelOk(req.actor!.perms, 'IP', 'S')) await deny(deps, req, `admission:${id(adm)}`, 'discharge needs a doctor who signs inpatient notes');
    await loadPatient(deps, req, adm.patientId, { clinical: true });
    assertRecentMfa(deps, req);
    if (adm.status !== 'Admitted') throw Errors.conflict('INVALID_TRANSITION', `Admission is ${String(adm.status).toLowerCase()}`);
    const drafts = await db(req).collection('clinical_notes').countDocuments({ encounterId: adm.encounterId, status: 'Draft' });
    if (drafts) throw new AppError(409, 'DISCHARGE_INCOMPLETE', 'Sign or discard draft notes before discharge', [{ path: 'notes', message: `${drafts} draft note(s) open` }]);
    const a = req.actor!;
    const now = new Date();
    await txn(async (s) => {
      const note = await db(req).collection('clinical_notes').insertOne(
        { tenantId: a.tenantId, encounterId: adm.encounterId, patientId: adm.patientId, kind: 'discharge', text: body.summary, status: 'Signed', authorId: a.userId, authorName: a.name, createdAt: now, signedAt: now, signedBy: a.userId, version: 1 },
        { session: s },
      );
      await release(req, s, adm);
      await db(req).collection('encounters').updateOne({ _id: adm.encounterId }, { $set: { status: 'Closed', endedAt: now, closedBy: a.userId }, $inc: { version: 1 } }, { session: s });
      const upd = await db(req).collection('admissions').updateOne(
        { _id: adm._id, status: 'Admitted' },
        { $set: { status: 'Discharged', discharge: { at: now, by: a.userId, disposition: body.disposition, followUp: body.followUp, summaryNoteId: note.insertedId } }, $unset: { activeLock: '' }, $inc: { version: 1 } },
        { session: s },
      );
      if (!upd.modifiedCount) throw Errors.conflict('INVALID_TRANSITION', 'Admission changed during discharge');
    });
    await audit(deps, req, { action: 'adm.discharge', resource: `admission:${id(adm)}`, outcome: 'success', meta: { disposition: body.disposition } });
    res.json({ data: { id: id(adm), status: 'Discharged' } });
  });

  r.post('/admissions/:id/cancel', need(deps, 'adm', 'E'), async (req, res) => {
    const adm = await loadAdmission(req);
    const upd = await db(req)
      .collection('admissions')
      .updateOne({ _id: adm._id, status: 'Requested' }, { $set: { status: 'Cancelled', cancelledAt: new Date(), cancelledBy: req.actor!.userId }, $unset: { activeLock: '' }, $inc: { version: 1 } });
    if (!upd.modifiedCount) throw Errors.conflict('INVALID_TRANSITION', 'Only requested admissions can be cancelled. Discharge admitted patients');
    await audit(deps, req, { action: 'adm.cancel', resource: `admission:${id(adm)}`, outcome: 'success' });
    res.json({ data: { id: id(adm), status: 'Cancelled' } });
  });

  return r;
}
