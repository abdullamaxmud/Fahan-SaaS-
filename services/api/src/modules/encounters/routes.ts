import { Router, type Request } from 'express';
import type { Document, ObjectId } from 'mongodb';
import { z } from 'zod';
import { can, isBranchBound } from '@fahan/policy';
import { VITAL_BY_CODE, isIcd11Code } from '@fahan/terminology';
import type { Deps } from '../../context';
import { AppError, Errors } from '../../lib/errors';
import { localDate } from '../../lib/time';
import { idParam, objectId, parse } from '../../lib/validate';
import { audit } from '../../middleware/audit';
import { deny, need } from '../../middleware/authorize';
import { requireRecentMfa } from '../../middleware/session';
import { linkedPatientIds, loadPatient } from '../patients/access';
import { nextQueueNo, openEncounter } from './service';

const Walkin = z.object({ patientId: objectId, reason: z.string().trim().max(300).optional() });
const ListQuery = z.object({ status: z.enum(['active', 'closed', 'all']).default('active') });
const AddTeam = z.object({ userId: objectId });
const Obs = z.object({
  code: z.string().refine((c) => c in VITAL_BY_CODE, 'Unknown vital sign'),
  value: z.number().finite(),
  unit: z.string().optional(),
  effectiveAt: z.string().datetime().optional(),
  source: z.enum(['manual', 'device']).default('manual'),
});
const Correct = z.object({ value: z.number().finite(), reason: z.string().trim().min(3).max(300) });
const NoteKind = z.enum(['history', 'examination', 'assessment', 'plan', 'progress']);
const NewNote = z.object({ kind: NoteKind, text: z.string().trim().min(1).max(20_000) });
const EditNote = z.object({ text: z.string().trim().min(1).max(20_000), version: z.number().int().positive() });
const Amend = z.object({ text: z.string().trim().min(1).max(20_000), reason: z.string().trim().min(3).max(300) });
const Certainty = z.enum(['suspected', 'confirmed', 'ruled_out']);
const NewDx = z.object({
  code: z.string().trim().toUpperCase().refine(isIcd11Code, 'Enter an ICD-11 code such as BA00'),
  display: z.string().trim().min(2).max(200),
  certainty: Certainty,
  primary: z.boolean().default(false),
});
const EditDx = z.object({ certainty: Certainty.optional(), primary: z.boolean().optional(), version: z.number().int().positive() });

const id = (x: { _id: ObjectId }) => x._id.toHexString();

/** Spec §5.5 OPD encounters: Open → InProgress → Signed → Closed. Signed entries change only by amendment. */
export function encounterRoutes(deps: Deps): Router {
  const r = Router();
  const db = (req: Request) => req.actor!.db!;

  async function loadEncounter(req: Request, opts: { writable?: boolean } = {}) {
    const a = req.actor!;
    const e = await db(req).collection('encounters').findOne({ _id: idParam(req.params.id, 'Encounter'), tenantId: a.tenantId });
    if (!e) throw Errors.notFound('Encounter');
    const patient = await loadPatient(deps, req, e.patientId, { clinical: true });
    if (opts.writable && e.status === 'Closed') throw Errors.conflict('ENCOUNTER_CLOSED', 'This visit is closed. Open a new visit to add information');
    return { e, patient };
  }

  async function touch(req: Request, e: Document) {
    if (e.status === 'Open') await db(req).collection('encounters').updateOne({ _id: e._id, status: 'Open' }, { $set: { status: 'InProgress' } });
  }

  const canWriteObs = (req: Request) => can(req.actor!.perms, 'nur', 'E') || can(req.actor!.perms, 'opd', 'E');

  r.get('/', need(deps, 'opd', 'V'), async (req, res) => {
    const q = parse(ListQuery, req.query);
    const a = req.actor!;
    const filter: Document = { tenantId: a.tenantId };
    if (q.status === 'active') filter.status = { $ne: 'Closed' };
    if (q.status === 'closed') filter.status = 'Closed';
    if (a.scope === 'assigned-patient') filter.clinicianIds = a.userId;
    else if (isBranchBound(a.scope)) filter.branchId = a.branchId ?? null;
    const list = await db(req).collection('encounters').find(filter).sort({ startedAt: -1 }).limit(200).toArray();
    const pats = await db(req).collection('patients').find({ _id: { $in: list.map((e) => e.patientId) } }, { projection: { mrn: 1, names: 1, dob: 1, sexAtBirth: 1 } }).toArray();
    res.json({
      data: list.map((e) => {
        const p = pats.find((x) => x._id.equals(e.patientId));
        return {
          id: id(e),
          status: e.status,
          type: e.type,
          queueNo: e.queueNo ?? null,
          reason: e.reason ?? null,
          startedAt: e.startedAt,
          patient: p ? { id: id(p), mrn: p.mrn, names: p.names, dob: p.dob, sexAtBirth: p.sexAtBirth ?? null } : null,
        };
      }),
    });
  });

  /** Walk-in visit opened by a clinician or nurse at their own branch. */
  r.post('/', need(deps, 'opd', 'E'), async (req, res) => {
    const body = parse(Walkin, req.body);
    const a = req.actor!;
    if (!a.branchId) throw Errors.validation([{ message: 'Your account is not assigned to a branch' }]);
    const branch = await db(req).collection('branches').findOne({ _id: a.branchId, tenantId: a.tenantId });
    if (!branch) throw Errors.notFound('Branch');
    const p = await db(req).collection('patients').findOne({ _id: body.patientId, tenantId: a.tenantId, branchIds: a.branchId, status: { $ne: 'Merged' } });
    if (!p) throw Errors.notFound('Patient');
    const queueNo = await nextQueueNo(req, branch.code, localDate(deps.config.now(), branch.timezone));
    const eid = await openEncounter(req, { patientId: p._id, branchId: a.branchId, clinicianIds: [a.userId], queueNo, reason: body.reason });
    await audit(deps, req, { action: 'opd.encounter.open', resource: `encounter:${eid.toHexString()}`, outcome: 'success', meta: { walkIn: true } });
    res.status(201).json({ data: { id: eid.toHexString(), status: 'Open', queueNo } });
  });

  r.get('/:id', need(deps, 'opd', 'V'), async (req, res) => {
    const { e, patient } = await loadEncounter(req);
    const a = req.actor!;
    const [obs, notes, dx, team] = await Promise.all([
      db(req).collection('observations').find({ encounterId: e._id }).sort({ effectiveAt: -1 }).toArray(),
      db(req)
        .collection('clinical_notes')
        .find({ encounterId: e._id, $or: [{ status: { $ne: 'Draft' } }, { authorId: a.userId }] })
        .sort({ createdAt: 1 })
        .toArray(),
      db(req).collection('diagnoses').find({ encounterId: e._id }).sort({ primary: -1, recordedAt: 1 }).toArray(),
      db(req).collection('users').find({ _id: { $in: e.clinicianIds } }, { projection: { name: 1, roles: 1 } }).toArray(),
    ]);
    const allergies = (patient.allergies as unknown[]) ?? [];
    res.json({
      data: {
        id: id(e),
        status: e.status,
        type: e.type,
        queueNo: e.queueNo ?? null,
        reason: e.reason ?? null,
        startedAt: e.startedAt,
        endedAt: e.endedAt ?? null,
        version: e.version,
        patient: { id: id(patient), mrn: patient.mrn, names: patient.names, dob: patient.dob, sexAtBirth: patient.sexAtBirth ?? null, allergies },
        team: team.map((u) => ({ id: id(u), name: u.name, roles: u.roles })),
        observations: obs.map((o) => ({
          id: id(o),
          code: o.code,
          value: o.value,
          unit: o.unit,
          source: o.source,
          status: o.status,
          effectiveAt: o.effectiveAt,
          recordedBy: o.recordedBy.toHexString(),
          corrects: o.corrects?.toHexString() ?? null,
          correctionReason: o.correctionReason ?? null,
        })),
        notes: notes.map((n) => ({
          id: id(n),
          kind: n.kind,
          text: n.text,
          status: n.status,
          authorId: n.authorId.toHexString(),
          authorName: n.authorName,
          createdAt: n.createdAt,
          signedAt: n.signedAt ?? null,
          amends: n.amends?.toHexString() ?? null,
          amendReason: n.amendReason ?? null,
          supersededBy: n.supersededBy?.toHexString() ?? null,
          version: n.version,
        })),
        diagnoses: dx.map((d) => ({
          id: id(d),
          code: d.code,
          display: d.display,
          codeSystem: d.codeSystem,
          certainty: d.certainty,
          primary: d.primary,
          recordedAt: d.recordedAt,
          authorId: d.authorId.toHexString(),
          history: d.history ?? [],
          version: d.version,
        })),
      },
    });
  });

  r.post('/:id/care-team', need(deps, 'opd', 'E'), async (req, res) => {
    const { userId } = parse(AddTeam, req.body);
    const { e } = await loadEncounter(req, { writable: true });
    const a = req.actor!;
    const u = await db(req).collection('users').findOne({ _id: userId, tenantId: a.tenantId, status: 'Active' });
    if (!u || (u.branchId && !u.branchId.equals(e.branchId))) throw Errors.validation([{ path: 'userId', message: 'Choose an active colleague from this branch' }]);
    await db(req).collection('encounters').updateOne({ _id: e._id }, { $addToSet: { clinicianIds: userId } });
    await db(req).collection('patients').updateOne({ _id: e.patientId }, { $addToSet: { careTeam: userId } });
    await audit(deps, req, { action: 'opd.care_team.add', resource: `encounter:${id(e)}`, outcome: 'success', meta: { userId: userId.toHexString() } });
    res.json({ data: { added: userId.toHexString() } });
  });

  // ---- observations (spec §5.9: timestamp, source and unit required; corrections append) ----

  r.post('/:id/observations', async (req, res) => {
    if (!canWriteObs(req)) await deny(deps, req, 'observations', 'requires nur:E or opd:E');
    const body = parse(Obs, req.body);
    const { e } = await loadEncounter(req, { writable: true });
    const def = VITAL_BY_CODE[body.code]!;
    if (body.unit && body.unit !== def.unit) throw Errors.validation([{ path: 'unit', message: `${def.name} is recorded in ${def.unit}` }]);
    if (body.value < def.min || body.value > def.max) {
      throw Errors.validation([{ path: 'value', message: `${def.name} must be between ${def.min} and ${def.max} ${def.unit}. Check for a typing error` }]);
    }
    const effectiveAt = body.effectiveAt ? new Date(body.effectiveAt) : new Date();
    if (effectiveAt.getTime() > Date.now() + 5 * 60_000) throw Errors.validation([{ path: 'effectiveAt', message: 'Time cannot be in the future' }]);
    const a = req.actor!;
    const doc = {
      tenantId: a.tenantId,
      encounterId: e._id,
      patientId: e.patientId,
      code: body.code,
      value: Number(body.value.toFixed(def.decimals)),
      unit: def.unit,
      source: body.source,
      status: 'Recorded',
      effectiveAt,
      recordedAt: new Date(),
      recordedBy: a.userId,
    };
    const ins = await db(req).collection('observations').insertOne(doc);
    await touch(req, e);
    await audit(deps, req, { action: 'nur.observation.record', resource: `encounter:${id(e)}`, outcome: 'success', meta: { code: body.code } });
    res.status(201).json({ data: { id: ins.insertedId.toHexString(), code: doc.code, value: doc.value, unit: doc.unit, effectiveAt } });
  });

  r.post('/:id/observations/:obsId/correct', async (req, res) => {
    if (!canWriteObs(req)) await deny(deps, req, 'observations', 'requires nur:E or opd:E');
    const body = parse(Correct, req.body);
    const { e } = await loadEncounter(req, { writable: true });
    const obsId = idParam(req.params.obsId, 'Observation');
    const o = await db(req).collection('observations').findOne({ _id: obsId, encounterId: e._id });
    if (!o) throw Errors.notFound('Observation');
    const def = VITAL_BY_CODE[o.code]!;
    if (body.value < def.min || body.value > def.max) throw Errors.validation([{ path: 'value', message: `Must be between ${def.min} and ${def.max} ${def.unit}` }]);
    const upd = await db(req).collection('observations').updateOne({ _id: o._id, status: 'Recorded' }, { $set: { status: 'Corrected' } });
    if (!upd.modifiedCount) throw Errors.conflict('ALREADY_CORRECTED', 'This value was already corrected. Correct the newest value instead');
    const a = req.actor!;
    const ins = await db(req)
      .collection('observations')
      .insertOne({ ...o, _id: undefined, value: Number(body.value.toFixed(def.decimals)), status: 'Recorded', corrects: o._id, correctionReason: body.reason, recordedAt: new Date(), recordedBy: a.userId } as Document);
    await audit(deps, req, { action: 'nur.observation.correct', resource: `observation:${id(o)}`, outcome: 'success' });
    res.status(201).json({ data: { id: ins.insertedId.toHexString(), corrects: id(o) } });
  });

  // ---- notes (spec §4.1: author, signer, version; signed notes are amended, never overwritten) ----

  r.post('/:id/notes', need(deps, 'opd', 'E'), async (req, res) => {
    const body = parse(NewNote, req.body);
    const { e } = await loadEncounter(req, { writable: true });
    const a = req.actor!;
    const doc = { tenantId: a.tenantId, encounterId: e._id, patientId: e.patientId, ...body, status: 'Draft', authorId: a.userId, authorName: a.name, createdAt: new Date(), version: 1 };
    const ins = await db(req).collection('clinical_notes').insertOne(doc);
    await touch(req, e);
    res.status(201).json({ data: { id: ins.insertedId.toHexString(), status: 'Draft', version: 1 } });
  });

  async function loadNote(req: Request, e: Document) {
    const n = await db(req).collection('clinical_notes').findOne({ _id: idParam(req.params.noteId, 'Note'), encounterId: e._id });
    if (!n || (n.status === 'Draft' && !n.authorId.equals(req.actor!.userId))) throw Errors.notFound('Note');
    return n;
  }

  r.patch('/:id/notes/:noteId', need(deps, 'opd', 'E'), async (req, res) => {
    const body = parse(EditNote, req.body);
    const { e } = await loadEncounter(req, { writable: true });
    const n = await loadNote(req, e);
    if (n.status !== 'Draft') throw Errors.conflict('NOTE_SIGNED', 'Signed notes cannot be edited. Add an amendment instead');
    const upd = await db(req)
      .collection('clinical_notes')
      .findOneAndUpdate({ _id: n._id, version: body.version, status: 'Draft' }, { $set: { text: body.text, updatedAt: new Date() }, $inc: { version: 1 } }, { returnDocument: 'after' });
    if (!upd) throw Errors.conflict('VERSION_CONFLICT', 'This draft changed in another window. Reload and try again');
    res.json({ data: { id: id(upd), version: upd.version } });
  });

  /** Authors may discard their own unsigned drafts; signed notes are never deleted. */
  r.delete('/:id/notes/:noteId', need(deps, 'opd', 'E'), async (req, res) => {
    const { e } = await loadEncounter(req, { writable: true });
    const n = await loadNote(req, e);
    if (n.status !== 'Draft' || !n.authorId.equals(req.actor!.userId)) throw Errors.conflict('NOTE_SIGNED', 'Only your own unsigned drafts can be discarded');
    await db(req).collection('clinical_notes').deleteOne({ _id: n._id, status: 'Draft' });
    await audit(deps, req, { action: 'opd.note.discard', resource: `note:${id(n)}`, outcome: 'success' });
    res.status(204).end();
  });

  r.post('/:id/notes/:noteId/sign', need(deps, 'opd', 'S'), requireRecentMfa(deps), async (req, res) => {
    const { e } = await loadEncounter(req, { writable: true });
    const n = await loadNote(req, e);
    if (!n.authorId.equals(req.actor!.userId)) throw Errors.forbidden('Only the author can sign this note');
    const upd = await db(req)
      .collection('clinical_notes')
      .updateOne({ _id: n._id, status: 'Draft' }, { $set: { status: 'Signed', signedAt: new Date(), signedBy: req.actor!.userId }, $inc: { version: 1 } });
    if (!upd.modifiedCount) throw Errors.conflict('NOTE_SIGNED', 'This note is already signed');
    await db(req).collection('encounters').updateOne({ _id: e._id, status: { $in: ['Open', 'InProgress'] } }, { $set: { status: 'Signed' } });
    await audit(deps, req, { action: 'opd.note.sign', resource: `note:${id(n)}`, outcome: 'success', meta: { kind: n.kind } });
    res.json({ data: { id: id(n), status: 'Signed' } });
  });

  r.post('/:id/notes/:noteId/amend', need(deps, 'opd', 'S'), requireRecentMfa(deps), async (req, res) => {
    const body = parse(Amend, req.body);
    const { e } = await loadEncounter(req);
    const n = await loadNote(req, e);
    if (n.status !== 'Signed') throw Errors.conflict('INVALID_TRANSITION', 'Only the current signed version of a note can be amended');
    const a = req.actor!;
    const now = new Date();
    let newId: ObjectId | undefined;
    const session = deps.data.client.startSession();
    try {
      await session.withTransaction(async () => {
        const ins = await db(req).collection('clinical_notes').insertOne(
          {
            tenantId: a.tenantId,
            encounterId: e._id,
            patientId: e.patientId,
            kind: n.kind,
            text: body.text,
            status: 'Signed',
            amends: n._id,
            amendReason: body.reason,
            authorId: a.userId,
            authorName: a.name,
            createdAt: now,
            signedAt: now,
            signedBy: a.userId,
            version: 1,
          },
          { session },
        );
        newId = ins.insertedId;
        const upd = await db(req).collection('clinical_notes').updateOne({ _id: n._id, status: 'Signed' }, { $set: { status: 'Amended', supersededBy: newId } }, { session });
        if (!upd.modifiedCount) throw Errors.conflict('INVALID_TRANSITION', 'This note was amended by someone else. Reload and try again');
      });
    } finally {
      await session.endSession();
    }
    await audit(deps, req, { action: 'opd.note.amend', resource: `note:${id(n)}`, outcome: 'success', meta: { newNote: newId!.toHexString() } });
    res.status(201).json({ data: { id: newId!.toHexString(), amends: id(n), status: 'Signed' } });
  });

  // ---- diagnoses (ICD-11, certainty kept separate for disease metrics, spec §9.3) ----

  r.post('/:id/diagnoses', need(deps, 'opd', 'S'), async (req, res) => {
    const body = parse(NewDx, req.body);
    const { e } = await loadEncounter(req, { writable: true });
    if (body.primary && body.certainty === 'ruled_out') throw Errors.validation([{ path: 'primary', message: 'A ruled-out condition cannot be the primary diagnosis' }]);
    const a = req.actor!;
    if (body.primary) await db(req).collection('diagnoses').updateMany({ encounterId: e._id, primary: true }, { $set: { primary: false }, $inc: { version: 1 } });
    const doc = {
      tenantId: a.tenantId,
      encounterId: e._id,
      patientId: e.patientId,
      branchId: e.branchId,
      codeSystem: 'ICD-11',
      ...body,
      recordedAt: new Date(),
      authorId: a.userId,
      history: [] as Document[],
      version: 1,
    };
    const ins = await db(req).collection('diagnoses').insertOne(doc);
    await touch(req, e);
    await audit(deps, req, { action: 'opd.diagnosis.add', resource: `encounter:${id(e)}`, outcome: 'success', meta: { code: body.code, certainty: body.certainty } });
    res.status(201).json({ data: { id: ins.insertedId.toHexString(), code: body.code, certainty: body.certainty, primary: body.primary } });
  });

  r.patch('/:id/diagnoses/:dxId', need(deps, 'opd', 'S'), async (req, res) => {
    const body = parse(EditDx, req.body);
    const { e } = await loadEncounter(req, { writable: true });
    const d = await db(req).collection('diagnoses').findOne({ _id: idParam(req.params.dxId, 'Diagnosis'), encounterId: e._id });
    if (!d) throw Errors.notFound('Diagnosis');
    const certainty = body.certainty ?? d.certainty;
    const primary = body.primary ?? d.primary;
    if (primary && certainty === 'ruled_out') throw Errors.validation([{ path: 'primary', message: 'A ruled-out condition cannot be the primary diagnosis' }]);
    const a = req.actor!;
    if (primary && !d.primary) await db(req).collection('diagnoses').updateMany({ encounterId: e._id, primary: true }, { $set: { primary: false }, $inc: { version: 1 } });
    const upd = await db(req).collection('diagnoses').findOneAndUpdate(
      { _id: d._id, version: body.version },
      {
        $set: { certainty, primary, updatedAt: new Date() },
        $push: { history: { certainty: d.certainty, primary: d.primary, changedAt: new Date(), changedBy: a.userId } } as Document,
        $inc: { version: 1 },
      },
      { returnDocument: 'after' },
    );
    if (!upd) throw Errors.conflict('VERSION_CONFLICT', 'This diagnosis changed. Reload and try again');
    await audit(deps, req, { action: 'opd.diagnosis.update', resource: `diagnosis:${id(d)}`, outcome: 'success', meta: { from: d.certainty, to: certainty } });
    res.json({ data: { id: id(upd), certainty, primary, version: upd.version } });
  });

  r.post('/:id/close', need(deps, 'opd', 'S'), async (req, res) => {
    const { e } = await loadEncounter(req, { writable: true });
    const signed = await db(req).collection('clinical_notes').countDocuments({ encounterId: e._id, status: 'Signed' });
    const drafts = await db(req).collection('clinical_notes').countDocuments({ encounterId: e._id, status: 'Draft' });
    const primary = await db(req).collection('diagnoses').findOne({ encounterId: e._id, primary: true, certainty: { $ne: 'ruled_out' } });
    const missing: { path: string; message: string }[] = [];
    if (!signed) missing.push({ path: 'notes', message: 'Sign at least one note' });
    if (drafts) missing.push({ path: 'notes', message: `${drafts} draft note(s) are not signed yet` });
    if (!primary) missing.push({ path: 'diagnoses', message: 'Record a primary diagnosis' });
    if (missing.length) throw new AppError(409, 'ENCOUNTER_INCOMPLETE', 'This visit cannot be closed yet', missing);
    const now = new Date();
    await db(req).collection('encounters').updateOne({ _id: e._id }, { $set: { status: 'Closed', endedAt: now, closedBy: req.actor!.userId }, $inc: { version: 1 } });
    if (e.appointmentId) await db(req).collection('appointments').updateOne({ _id: e.appointmentId }, { $set: { status: 'Completed', completedAt: now }, $unset: { slotLock: '' } });
    await audit(deps, req, { action: 'opd.encounter.close', resource: `encounter:${id(e)}`, outcome: 'success', meta: { primary: primary!.code } });
    res.json({ data: { id: id(e), status: 'Closed' } });
  });

  return r;
}

/** GET /patients/:id/timeline — longitudinal record across visits and merged records (spec §4.1). */
export function timelineRoutes(deps: Deps): Router {
  const r = Router();
  r.get('/:id/timeline', need(deps, 'mpi', 'V'), async (req, res) => {
    const p = await loadPatient(deps, req, idParam(req.params.id, 'Patient'), { clinical: true });
    const ids = await linkedPatientIds(req, p._id);
    const a = req.actor!;
    const d = a.db!;
    const f = { tenantId: a.tenantId, patientId: { $in: ids } };
    const [enc, notes, obs, dx, appts] = await Promise.all([
      d.collection('encounters').find(f).sort({ startedAt: -1 }).limit(200).toArray(),
      d.collection('clinical_notes').find({ ...f, status: 'Signed' }).sort({ signedAt: -1 }).limit(200).toArray(),
      d.collection('observations').find({ ...f, status: 'Recorded' }).sort({ effectiveAt: -1 }).limit(500).toArray(),
      d.collection('diagnoses').find(f).sort({ recordedAt: -1 }).limit(200).toArray(),
      d.collection('appointments').find(f).sort({ startsAt: -1 }).limit(100).toArray(),
    ]);
    const items = [
      ...enc.map((e) => ({ kind: 'encounter', at: e.startedAt, id: id(e), encounterId: id(e), title: `${e.type} visit`, status: e.status, detail: e.reason ?? null })),
      ...notes.map((n) => ({ kind: 'note', at: n.signedAt, id: id(n), encounterId: n.encounterId.toHexString(), title: `${n.kind} note · ${n.authorName}`, status: n.amends ? 'Amended' : 'Signed', detail: n.text })),
      ...dx.map((x) => ({ kind: 'diagnosis', at: x.recordedAt, id: id(x), encounterId: x.encounterId.toHexString(), title: `${x.code} ${x.display}`, status: x.certainty, detail: x.primary ? 'primary' : null })),
      ...obs.map((o) => ({ kind: 'observation', at: o.effectiveAt, id: id(o), encounterId: o.encounterId.toHexString(), title: o.code, status: o.source, detail: `${o.value} ${o.unit}` })),
      ...appts.map((x) => ({ kind: 'appointment', at: x.startsAt, id: id(x), encounterId: x.encounterId?.toHexString() ?? null, title: 'Appointment', status: x.status, detail: x.reason ?? null })),
    ].sort((x, y) => new Date(y.at).getTime() - new Date(x.at).getTime());
    // Reading a full clinical history is itself an audited event (spec §11.1 purpose-of-access).
    await audit(deps, req, { action: 'mpi.timeline.read', resource: `patient:${id(p)}`, outcome: 'allow' });
    res.json({ data: { patientId: id(p), linkedIds: ids.map((x) => x.toHexString()), items } });
  });
  return r;
}
