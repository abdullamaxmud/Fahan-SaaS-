import { Router, type Request } from 'express';
import type { Document, ObjectId, WithId } from 'mongodb';
import { z } from 'zod';
import { can, effectivePermissions, isBranchBound } from '@fahan/policy';
import type { Deps } from '../../context';
import { newToken } from '../../lib/crypto';
import { AppError, Errors } from '../../lib/errors';
import { localDate, zonedToUtc } from '../../lib/time';
import { idParam, objectId, parse } from '../../lib/validate';
import { audit } from '../../middleware/audit';
import { deny } from '../../middleware/authorize';
import { openEncounter } from '../encounters/service';
import { addToCareTeam, loadPatient } from '../patients/access';

/**
 * Spec §5.27 Telemedicine: Scheduled → Connected → Completed (or Cancelled / NoShow).
 *  - A video visit cannot start until the patient's consent to a video consultation is recorded.
 *  - Calls are never recorded by Fahan; a recording consent is only stored as the patient's answer.
 *  - Starting the visit opens an outpatient visit, so the notes join the patient's record.
 */
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const NewSession = z.object({
  patientId: objectId,
  clinicianId: objectId,
  date: day,
  time: z.string().regex(/^\d{2}:\d{2}$/),
  minutes: z.number().int().min(10).max(60).default(20),
  reason: z.string().trim().min(3).max(300),
});
const Consent = z.object({ video: z.literal(true), recording: z.boolean().default(false), method: z.enum(['verbal', 'written', 'portal']) });
const Complete = z.object({ summary: z.string().trim().max(2_000).optional() });
const Reason = z.object({ reason: z.string().trim().min(3).max(300) });

const id = (x: { _id: ObjectId }) => x._id.toHexString();
export const OPEN_TELE = ['Scheduled', 'Connected'];

export function teleView(x: WithId<Document>, patient?: Document | null) {
  return {
    id: id(x),
    status: x.status,
    startsAt: x.startsAt,
    minutes: x.minutes,
    reason: x.reason,
    clinician: { id: (x.clinicianId as ObjectId).toHexString(), name: x.clinicianName },
    patient: patient ? { id: patient._id.toHexString(), mrn: patient.mrn, names: patient.names } : null,
    consent: x.consent ? { video: x.consent.video, recording: x.consent.recording, method: x.consent.method, at: x.consent.at } : null,
    encounterId: x.encounterId?.toHexString() ?? null,
    connectedAt: x.connectedAt ?? null,
    completedAt: x.completedAt ?? null,
    summary: x.summary ?? null,
    cancelReason: x.cancelReason ?? null,
  };
}

export function teleRoutes(deps: Deps): Router {
  const r = Router();
  const db = (req: Request) => req.actor!.db!;
  const zone = 'Africa/Mogadishu';

  /** Booking is for receptionists (appointments) and for video clinicians themselves. */
  async function canBook(req: Request) {
    const p = req.actor!.perms;
    if (!can(p, 'appt', 'E') && !can(p, 'tele', 'S')) await deny(deps, req, 'telemedicine', 'booking needs appointments or telemedicine');
  }

  async function session(req: Request) {
    const x = await db(req).collection('telehealth_sessions').findOne({ _id: idParam(req.params.id, 'Video visit'), tenantId: req.actor!.tenantId });
    if (!x) throw Errors.notFound('Video visit');
    const a = req.actor!;
    if (isBranchBound(a.scope) && a.scope !== 'assigned-patient' && !(x.branchId as ObjectId | null)?.equals(a.branchId ?? null)) await deny(deps, req, `tele:${id(x)}`, 'outside assigned branch');
    return x;
  }

  /** Only the clinician of the visit runs it. */
  async function ownSession(req: Request) {
    const x = await session(req);
    if (!can(req.actor!.perms, 'tele', 'S') || !(x.clinicianId as ObjectId).equals(req.actor!.userId)) await deny(deps, req, `tele:${id(x)}`, 'only the clinician of this video visit');
    return x;
  }

  r.get('/clinicians', async (req, res) => {
    await canBook(req);
    const a = req.actor!;
    const users = await db(req).collection('users').find({ tenantId: a.tenantId, status: 'Active' }, { projection: { name: 1, roles: 1, branchId: 1 } }).sort({ name: 1 }).toArray();
    res.json({ data: users.filter((u) => can(effectivePermissions(u.roles as string[]), 'tele', 'S')).map((u) => ({ id: id(u), name: u.name })) });
  });

  r.get('/sessions', async (req, res) => {
    const a = req.actor!;
    if (!can(a.perms, 'tele', 'V') && !can(a.perms, 'appt', 'V')) await deny(deps, req, 'telemedicine', 'no telemedicine access');
    const q = parse(z.object({ date: day.optional() }), req.query);
    const date = q.date ?? localDate(deps.config.now(), zone);
    const from = zonedToUtc(date, '00:00', zone);
    const f: Document = { tenantId: a.tenantId, startsAt: { $gte: from, $lt: new Date(from.getTime() + 86_400_000) } };
    if (a.scope === 'assigned-patient') f.clinicianId = a.userId;
    else if (isBranchBound(a.scope)) f.branchId = a.branchId ?? null;
    const list = await db(req).collection('telehealth_sessions').find(f).sort({ startsAt: 1 }).limit(300).toArray();
    const pats = await db(req).collection('patients').find({ _id: { $in: list.map((x) => x.patientId) } }, { projection: { mrn: 1, names: 1 } }).toArray();
    res.json({ data: list.map((x) => teleView(x, pats.find((p) => p._id.equals(x.patientId)))) });
  });

  r.post('/sessions', async (req, res) => {
    await canBook(req);
    const body = parse(NewSession, req.body);
    const a = req.actor!;
    const p = await loadPatient(deps, req, body.patientId);
    if (p.status === 'Merged') throw Errors.conflict('PATIENT_MERGED', 'Book on the surviving record');
    const doc = await db(req).collection('users').findOne({ _id: body.clinicianId, tenantId: a.tenantId, status: 'Active' });
    if (!doc || !can(effectivePermissions(doc.roles as string[]), 'tele', 'S')) throw Errors.validation([{ path: 'clinicianId', message: 'Choose a clinician who runs video visits' }]);
    if (can(a.perms, 'tele', 'S') && !can(a.perms, 'appt', 'E') && !doc._id.equals(a.userId)) throw Errors.forbidden('You can book video visits only for yourself');
    const startsAt = zonedToUtc(body.date, body.time, zone);
    if (startsAt.getTime() < deps.config.now().getTime() - 5 * 60_000) throw Errors.validation([{ path: 'time', message: 'Choose a time that has not passed' }]);
    const endsAt = new Date(startsAt.getTime() + body.minutes * 60_000);
    const clash = await db(req)
      .collection('telehealth_sessions')
      .findOne({ tenantId: a.tenantId, clinicianId: doc._id, status: { $in: OPEN_TELE }, startsAt: { $lt: endsAt }, endsAt: { $gt: startsAt } });
    const appt = await db(req)
      .collection('appointments')
      .findOne({ tenantId: a.tenantId, providerId: doc._id, slotLock: true, startsAt: { $gte: new Date(startsAt.getTime() - 60 * 60_000), $lt: endsAt } });
    const apptEnd = appt ? new Date(new Date(appt.startsAt).getTime() + (appt.minutes ?? 20) * 60_000) : null;
    if (clash || (appt && apptEnd! > startsAt)) throw new AppError(409, 'SLOT_TAKEN', `${doc.name} is already booked at that time`);
    const branchId = a.branchId ?? doc.branchId ?? (p.branchIds as ObjectId[])[0] ?? null;
    const ins = await db(req).collection('telehealth_sessions').insertOne({
      tenantId: a.tenantId,
      branchId,
      patientId: p._id,
      clinicianId: doc._id,
      clinicianName: doc.name,
      startsAt,
      endsAt,
      minutes: body.minutes,
      reason: body.reason,
      room: `fahan-${newToken(18).replace(/[^A-Za-z0-9]/g, '')}`,
      status: 'Scheduled',
      createdAt: new Date(),
      createdBy: a.userId,
    });
    await addToCareTeam(req, p._id, [doc._id]);
    await audit(deps, req, { action: 'tele.session.book', resource: `tele:${ins.insertedId.toHexString()}`, outcome: 'success' });
    res.status(201).json({ data: { id: ins.insertedId.toHexString(), status: 'Scheduled', startsAt } });
  });

  r.post('/sessions/:id/consent', async (req, res) => {
    const body = parse(Consent, req.body);
    const x = await ownSession(req);
    if (!OPEN_TELE.includes(x.status)) throw Errors.conflict('INVALID_TRANSITION', `Visit is ${String(x.status).toLowerCase()}`);
    await db(req).collection('telehealth_sessions').updateOne({ _id: x._id }, { $set: { consent: { ...body, at: new Date(), by: req.actor!.userId } } });
    await audit(deps, req, { action: 'tele.consent', resource: `tele:${id(x)}`, outcome: 'success', meta: { recording: body.recording, method: body.method } });
    res.json({ data: { id: id(x), consent: body } });
  });

  /** Starts the call and opens the outpatient visit the clinician documents in. */
  r.post('/sessions/:id/start', async (req, res) => {
    const x = await ownSession(req);
    if (x.status !== 'Scheduled' && x.status !== 'Connected') throw Errors.conflict('INVALID_TRANSITION', `Visit is ${String(x.status).toLowerCase()}`);
    if (!x.consent?.video) throw new AppError(409, 'CONSENT_REQUIRED', 'Record the patient’s consent to a video consultation first');
    let encounterId = x.encounterId as ObjectId | undefined;
    if (!encounterId) {
      const branchId = (x.branchId as ObjectId | null) ?? req.actor!.branchId;
      if (!branchId) throw Errors.validation([{ message: 'This visit has no branch' }]);
      encounterId = await openEncounter(req, { patientId: x.patientId, branchId, clinicianIds: [x.clinicianId], reason: x.reason, extra: { channel: 'video', telehealthId: x._id } });
    }
    await db(req).collection('telehealth_sessions').updateOne({ _id: x._id }, { $set: { status: 'Connected', connectedAt: x.connectedAt ?? new Date(), encounterId } });
    await audit(deps, req, { action: 'tele.start', resource: `tele:${id(x)}`, outcome: 'success' });
    res.json({ data: { id: id(x), status: 'Connected', encounterId: encounterId.toHexString(), url: `${deps.config.teleBaseUrl}/${x.room}` } });
  });

  r.get('/sessions/:id/join', async (req, res) => {
    const x = await ownSession(req);
    if (x.status !== 'Connected') throw Errors.conflict('NOT_STARTED', 'Start the visit first');
    res.json({ data: { url: `${deps.config.teleBaseUrl}/${x.room}` } });
  });

  r.post('/sessions/:id/complete', async (req, res) => {
    const body = parse(Complete, req.body);
    const x = await ownSession(req);
    const upd = await db(req).collection('telehealth_sessions').updateOne({ _id: x._id, status: 'Connected' }, { $set: { status: 'Completed', completedAt: new Date(), summary: body.summary } });
    if (!upd.modifiedCount) throw Errors.conflict('INVALID_TRANSITION', 'Only a connected visit can be completed');
    await audit(deps, req, { action: 'tele.complete', resource: `tele:${id(x)}`, outcome: 'success' });
    res.json({ data: { id: id(x), status: 'Completed', encounterId: x.encounterId?.toHexString() ?? null } });
  });

  r.post('/sessions/:id/no-show', async (req, res) => {
    const x = await ownSession(req);
    const upd = await db(req).collection('telehealth_sessions').updateOne({ _id: x._id, status: 'Scheduled' }, { $set: { status: 'NoShow', closedAt: new Date() } });
    if (!upd.modifiedCount) throw Errors.conflict('INVALID_TRANSITION', 'Only a scheduled visit can be marked as no-show');
    await audit(deps, req, { action: 'tele.no_show', resource: `tele:${id(x)}`, outcome: 'success' });
    res.json({ data: { id: id(x), status: 'NoShow' } });
  });

  r.post('/sessions/:id/cancel', async (req, res) => {
    const { reason } = parse(Reason, req.body);
    await canBook(req);
    const x = await session(req);
    if (can(req.actor!.perms, 'tele', 'S') && !can(req.actor!.perms, 'appt', 'E') && !(x.clinicianId as ObjectId).equals(req.actor!.userId)) await deny(deps, req, `tele:${id(x)}`, 'not your visit');
    const upd = await db(req).collection('telehealth_sessions').updateOne({ _id: x._id, status: 'Scheduled' }, { $set: { status: 'Cancelled', cancelReason: reason, closedAt: new Date() } });
    if (!upd.modifiedCount) throw Errors.conflict('INVALID_TRANSITION', 'Only a scheduled visit can be cancelled');
    await audit(deps, req, { action: 'tele.cancel', resource: `tele:${id(x)}`, outcome: 'success' });
    res.json({ data: { id: id(x), status: 'Cancelled' } });
  });

  return r;
}
