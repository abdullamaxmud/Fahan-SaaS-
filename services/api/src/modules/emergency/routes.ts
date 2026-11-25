import { Router, type Request } from 'express';
import type { Document, ObjectId } from 'mongodb';
import { z } from 'zod';
import { can, effectivePermissions, isBranchBound } from '@fahan/policy';
import { nameKeys } from '@fahan/terminology';
import type { Deps } from '../../context';
import { AppError, Errors } from '../../lib/errors';
import { idParam, objectId, parse } from '../../lib/validate';
import { audit } from '../../middleware/audit';
import { assertBranch, need } from '../../middleware/authorize';
import { assertRecentMfa } from '../../middleware/session';
import { openEncounter } from '../encounters/service';

const Arrival = z
  .object({
    patientId: objectId.optional(),
    unknown: z
      .object({
        sexAtBirth: z.enum(['female', 'male', 'unknown']),
        estimatedAge: z.number().int().min(0).max(120),
        description: z.string().trim().min(3).max(300),
      })
      .optional(),
    mode: z.enum(['walk-in', 'ambulance', 'police', 'referral']),
    complaint: z.string().trim().min(2).max(300),
  })
  .refine((x) => Boolean(x.patientId) !== Boolean(x.unknown), { message: 'Choose a registered patient or describe an unidentified one', path: ['patientId'] });
const Triage = z.object({ esi: z.number().int().min(1).max(5), note: z.string().trim().max(500).optional(), overrideReason: z.string().trim().min(5).max(300).optional() });
const Disposition = z
  .object({
    disposition: z.enum(['discharged', 'admitted', 'transferred', 'left-without-being-seen', 'deceased']),
    note: z.string().trim().min(10, 'Write at least 10 characters').max(10_000),
    admission: z.object({ attendingId: objectId, reason: z.string().trim().min(3).max(300) }).optional(),
  })
  .refine((x) => x.disposition !== 'admitted' || x.admission, { message: 'Choose the admitting doctor', path: ['admission'] });

const id = (x: { _id: ObjectId }) => x._id.toHexString();
const ACTIVE = ['Arrived', 'Triaged', 'Treating'];

/** Spec §5.6 emergency department: Arrived → Triaged → Treating → Dispositioned. */
export function emergencyRoutes(deps: Deps): Router {
  const r = Router();
  const db = (req: Request) => req.actor!.db!;
  const now = () => deps.config.now();

  async function branch(req: Request) {
    const a = req.actor!;
    if (!a.branchId) throw Errors.validation([{ message: 'Your account is not assigned to a branch' }]);
    const b = await db(req).collection('branches').findOne({ _id: a.branchId, tenantId: a.tenantId });
    if (!b) throw Errors.notFound('Branch');
    return b;
  }

  async function loadVisit(req: Request) {
    const e = await db(req).collection('encounters').findOne({ _id: idParam(req.params.id, 'Emergency visit'), tenantId: req.actor!.tenantId, type: 'ER' });
    if (!e) throw Errors.notFound('Emergency visit');
    await assertBranch(deps, req, e.branchId);
    return e;
  }

  r.get('/board', need(deps, 'er', 'V'), async (req, res) => {
    const a = req.actor!;
    const f: Document = { tenantId: a.tenantId, type: 'ER', 'ed.state': { $in: ACTIVE } };
    if (isBranchBound(a.scope)) f.branchId = a.branchId ?? null;
    const list = await db(req).collection('encounters').find(f).toArray();
    const pats = await db(req).collection('patients').find({ _id: { $in: list.map((e) => e.patientId) } }, { projection: { names: 1, mrn: 1, dob: 1, sexAtBirth: 1, unidentified: 1 } }).toArray();
    const t = now().getTime();
    const rows = list
      .map((e) => {
        const p = pats.find((x) => x._id.equals(e.patientId));
        return {
          id: id(e),
          state: e.ed.state,
          esi: e.ed.esi ?? null,
          mode: e.ed.mode,
          complaint: e.ed.complaint,
          arrivedAt: e.ed.arrivedAt,
          waitingMinutes: Math.round((t - new Date(e.ed.arrivedAt).getTime()) / 60_000),
          seenAt: e.ed.seenAt ?? null,
          patient: p ? { id: id(p), mrn: p.mrn, names: p.names, dob: p.dob, sexAtBirth: p.sexAtBirth ?? null, unidentified: Boolean(p.unidentified) } : null,
        };
      })
      .sort((x, y) => (x.esi ?? 9) - (y.esi ?? 9) || new Date(x.arrivedAt).getTime() - new Date(y.arrivedAt).getTime());
    res.json({
      data: rows,
      meta: { total: rows.length, byEsi: [1, 2, 3, 4, 5].map((n) => rows.filter((x) => x.esi === n).length), untriaged: rows.filter((x) => !x.esi).length },
    });
  });

  r.post('/arrivals', need(deps, 'er', 'E'), async (req, res) => {
    const body = parse(Arrival, req.body);
    const a = req.actor!;
    const b = await branch(req);
    let patientId: ObjectId;
    if (body.patientId) {
      const p = await db(req).collection('patients').findOne({ _id: body.patientId, tenantId: a.tenantId, status: { $ne: 'Merged' } });
      if (!p) throw Errors.notFound('Patient');
      patientId = p._id;
      // Presence in this emergency department links the record to this branch.
      await db(req).collection('patients').updateOne({ _id: p._id }, { $addToSet: { branchIds: b._id } });
    } else {
      const u = body.unknown!;
      const yy = now().getUTCFullYear().toString().slice(2);
      const counter = await db(req)
        .collection<{ _id: string; seq: number }>('counters')
        .findOneAndUpdate({ _id: `mrn:${b.code}:${yy}` }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
      const tag = await db(req)
        .collection<{ _id: string; seq: number }>('counters')
        .findOneAndUpdate({ _id: `unknown:${b.code}` }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
      const names = { given: 'Unknown', family: `${u.sexAtBirth === 'female' ? 'Female' : u.sexAtBirth === 'male' ? 'Male' : 'Person'} ${tag!.seq}` };
      const ins = await db(req).collection('patients').insertOne({
        tenantId: a.tenantId,
        branchIds: [b._id],
        mrn: `${b.code}-${yy}-${String(counter!.seq).padStart(6, '0')}`,
        names,
        nameKeys: nameKeys(names.given, names.family),
        dob: `${now().getUTCFullYear() - u.estimatedAge}-01-01`,
        dobEstimated: true,
        sexAtBirth: u.sexAtBirth,
        identifiers: [],
        contacts: [],
        status: 'Provisional',
        unidentified: true,
        description: u.description,
        careTeam: [],
        createdAt: new Date(),
        createdBy: a.userId,
        version: 1,
      });
      patientId = ins.insertedId;
    }
    const encounterId = await openEncounter(req, {
      type: 'ER',
      patientId,
      branchId: b._id,
      clinicianIds: [a.userId],
      reason: body.complaint,
      extra: { ed: { state: 'Arrived', mode: body.mode, complaint: body.complaint, arrivedAt: now(), triageHistory: [] } },
    });
    await audit(deps, req, { action: 'er.arrival', resource: `encounter:${encounterId.toHexString()}`, outcome: 'success', meta: { mode: body.mode, unidentified: !body.patientId } });
    res.status(201).json({ data: { id: encounterId.toHexString(), patientId: patientId.toHexString(), state: 'Arrived' } });
  });

  /** Spec §5.6: triage follows hospital-approved rules; every change after the first is an audited override. */
  r.post('/:id/triage', need(deps, 'er', 'E'), async (req, res) => {
    const body = parse(Triage, req.body);
    const e = await loadVisit(req);
    if (!ACTIVE.includes(e.ed.state)) throw Errors.conflict('INVALID_TRANSITION', 'This emergency visit has ended');
    const prev = e.ed.esi as number | undefined;
    if (prev && prev !== body.esi && !body.overrideReason) {
      throw Errors.validation([{ path: 'overrideReason', message: `Explain why the triage level changes from ESI ${prev} to ESI ${body.esi}` }]);
    }
    const entry = { esi: body.esi, note: body.note, reason: body.overrideReason, at: now(), by: req.actor!.userId };
    await db(req).collection('encounters').updateOne(
      { _id: e._id },
      {
        $set: { 'ed.esi': body.esi, 'ed.triagedAt': e.ed.triagedAt ?? now(), 'ed.state': e.ed.state === 'Arrived' ? 'Triaged' : e.ed.state, status: 'InProgress' },
        $push: { 'ed.triageHistory': entry } as Document,
        $inc: { version: 1 },
      },
    );
    await audit(deps, req, {
      action: prev && prev !== body.esi ? 'er.triage.override' : 'er.triage',
      resource: `encounter:${id(e)}`,
      outcome: 'success',
      meta: { esi: body.esi, from: prev ?? null },
    });
    res.json({ data: { id: id(e), esi: body.esi, state: e.ed.state === 'Arrived' ? 'Triaged' : e.ed.state } });
  });

  r.post('/:id/take', need(deps, 'er', 'S'), async (req, res) => {
    const e = await loadVisit(req);
    if (!['Arrived', 'Triaged'].includes(e.ed.state)) throw Errors.conflict('INVALID_TRANSITION', 'A clinician is already treating this patient');
    const a = req.actor!;
    await db(req).collection('encounters').updateOne(
      { _id: e._id, 'ed.state': e.ed.state },
      { $set: { 'ed.state': 'Treating', 'ed.seenAt': now(), 'ed.seenBy': a.userId, status: 'InProgress' }, $addToSet: { clinicianIds: a.userId }, $inc: { version: 1 } },
    );
    await db(req).collection('patients').updateOne({ _id: e.patientId }, { $addToSet: { careTeam: a.userId } });
    const minutes = Math.round((now().getTime() - new Date(e.ed.arrivedAt).getTime()) / 60_000);
    await audit(deps, req, { action: 'er.take', resource: `encounter:${id(e)}`, outcome: 'success', meta: { doorToDoctorMinutes: minutes } });
    res.json({ data: { id: id(e), state: 'Treating', doorToDoctorMinutes: minutes } });
  });

  r.post('/:id/disposition', need(deps, 'er', 'S'), async (req, res) => {
    const body = parse(Disposition, req.body);
    const e = await loadVisit(req);
    assertRecentMfa(deps, req);
    if (!ACTIVE.includes(e.ed.state)) throw Errors.conflict('INVALID_TRANSITION', 'This emergency visit has already ended');
    if (body.disposition !== 'left-without-being-seen' && e.ed.state !== 'Treating') {
      throw new AppError(409, 'NOT_SEEN', 'A clinician must take the patient before a disposition, unless they left without being seen');
    }
    const a = req.actor!;
    const t = new Date();
    let admissionId: ObjectId | undefined;
    const s = deps.data.client.startSession();
    try {
      await s.withTransaction(async () => {
        if (body.admission) {
          const doc = await db(req).collection('users').findOne({ _id: body.admission.attendingId, tenantId: a.tenantId, status: 'Active' }, { session: s });
          const p = doc ? effectivePermissions(doc.roles) : {};
          if (!doc || !(can(p, 'opd', 'S') || can(p, 'icu', 'S') || can(p, 'mat', 'S'))) {
            throw Errors.validation([{ path: 'admission.attendingId', message: 'Choose an active doctor who can sign inpatient notes' }]);
          }
          const ins = await db(req).collection('admissions').insertOne(
            {
              tenantId: a.tenantId,
              branchId: e.branchId,
              patientId: e.patientId,
              attendingId: doc._id,
              reason: body.admission.reason,
              source: 'ER',
              fromEncounterId: e._id,
              status: 'Requested',
              activeLock: true,
              transfers: [],
              createdAt: t,
              createdBy: a.userId,
              version: 1,
            },
            { session: s },
          );
          admissionId = ins.insertedId;
          await db(req).collection('patients').updateOne({ _id: e.patientId }, { $addToSet: { careTeam: doc._id } }, { session: s });
        }
        await db(req).collection('clinical_notes').insertOne(
          { tenantId: a.tenantId, encounterId: e._id, patientId: e.patientId, kind: 'disposition', text: body.note, status: 'Signed', authorId: a.userId, authorName: a.name, createdAt: t, signedAt: t, signedBy: a.userId, version: 1 },
          { session: s },
        );
        const upd = await db(req).collection('encounters').updateOne(
          { _id: e._id, 'ed.state': { $in: ACTIVE } },
          { $set: { 'ed.state': 'Dispositioned', 'ed.disposition': body.disposition, 'ed.dispositionAt': t, 'ed.admissionId': admissionId, status: 'Closed', endedAt: t, closedBy: a.userId }, $inc: { version: 1 } },
          { session: s },
        );
        if (!upd.modifiedCount) throw Errors.conflict('INVALID_TRANSITION', 'This emergency visit changed. Reload and try again');
      });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw Errors.conflict('ALREADY_ADMITTED', 'This patient already has an active admission');
      throw err;
    } finally {
      await s.endSession();
    }
    await audit(deps, req, { action: 'er.disposition', resource: `encounter:${id(e)}`, outcome: 'success', meta: { disposition: body.disposition } });
    res.json({ data: { id: id(e), state: 'Dispositioned', disposition: body.disposition, admissionId: admissionId?.toHexString() ?? null } });
  });

  return r;
}
