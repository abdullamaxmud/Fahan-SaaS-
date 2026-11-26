import { Router, type Request, type RequestHandler } from 'express';
import type { Document, ObjectId, WithId } from 'mongodb';
import { z } from 'zod';
import { can, effectivePermissions } from '@fahan/policy';
import type { Deps } from '../../context';
import { newToken, sha256 } from '../../lib/crypto';
import { AppError, Errors } from '../../lib/errors';
import { fromMinutes, localDate, toMinutes, weekdayOf, zonedToUtc } from '../../lib/time';
import { email, idParam, objectId, parse } from '../../lib/validate';
import { audit } from '../../middleware/audit';
import { deny, need } from '../../middleware/authorize';
import { encLevelOk, loadPatient } from '../patients/access';
import { OPEN_TELE } from '../telemedicine/routes';

/**
 * Spec §5.26 Patient portal & communications.
 *  - Staff invite a patient (or a caregiver acting for them). Caregiver access needs a records officer's approval.
 *  - Portal accounts only ever reach the records linked to them (their own, or their dependants').
 *  - Results appear only after a clinician on the visit chooses to share them.
 *  - Secure messages go to the hospital's front desk and back.
 */
export const PORTAL_ROLES = ['patient', 'caregiver'];
export const isPortalActor = (roles: string[]) => roles.length > 0 && roles.every((r) => PORTAL_ROLES.includes(r));
const INVITE_TTL_MS = 7 * 86_400_000;
const zone = 'Africa/Mogadishu';
const id = (x: { _id: ObjectId }) => x._id.toHexString();

/** Portal users may only use the portal and their own session; everything else in the hospital API is refused. */
export function portalFence(deps: Deps): RequestHandler {
  return async (req, _res, next) => {
    const a = req.actor;
    if (a && isPortalActor(a.roles) && !req.path.startsWith('/portal/')) {
      try {
        await deny(deps, req, 'staff-api', 'portal accounts use the portal only');
      } catch (e) {
        return next(e);
      }
    }
    next();
  };
}

const Invite = z.object({
  patientId: objectId,
  email,
  name: z.string().trim().min(2).max(120),
  relationship: z.enum(['self', 'parent', 'guardian', 'spouse', 'child', 'other']),
});
const Book = z.object({ providerId: objectId, startsAt: z.string().datetime(), reason: z.string().trim().max(300).optional() });
const NewThread = z.object({ subject: z.string().trim().min(3).max(120), text: z.string().trim().min(2).max(2_000) });
const Reply = z.object({ text: z.string().trim().min(1).max(2_000) });
const Consent = z.object({ recording: z.boolean().default(false) });

const nameOf = (p: Document) => [p.names?.given, p.names?.middle, p.names?.family].filter(Boolean).join(' ');

function isProvider(roles: string[]) {
  const p = effectivePermissions(roles);
  return can(p, 'opd', 'S') || can(p, 'tele', 'S') || can(p, 'mat', 'E');
}

export function portalRoutes(deps: Deps): Router {
  const r = Router();
  const db = (req: Request) => req.actor!.db!;
  const now = () => deps.config.now();

  // =====================================================================
  // Staff side: portal accounts, shared results and the message inbox
  // =====================================================================
  const accountView = (u: WithId<Document>, patientId: ObjectId) => ({
    id: id(u),
    name: u.name,
    email: u.email,
    role: (u.roles as string[])[0],
    relationship: (u.portalLinks as Document[] | undefined)?.find((l) => (l.patientId as ObjectId).equals(patientId))?.relationship ?? 'self',
    status: u.status,
    approved: !(u.portalLinks as Document[] | undefined)?.some((l) => (l.patientId as ObjectId).equals(patientId) && l.approvedAt === null),
  });

  r.get('/portal-accounts', need(deps, 'mpi', 'V'), async (req, res) => {
    const q = parse(z.object({ patientId: objectId }), req.query);
    const p = await loadPatient(deps, req, q.patientId);
    const list = await db(req)
      .collection('users')
      .find({ tenantId: req.actor!.tenantId, $or: [{ patientIds: p._id }, { 'portalLinks.patientId': p._id }] }, { projection: { name: 1, email: 1, roles: 1, status: 1, portalLinks: 1 } })
      .toArray();
    res.json({ data: list.map((u) => accountView(u, p._id)) });
  });

  /** Invites a patient (self) at once; a caregiver waits for a records officer's approval before the invitation works. */
  r.post('/portal-accounts', need(deps, 'mpi', 'E'), async (req, res) => {
    const body = parse(Invite, req.body);
    const a = req.actor!;
    const p = await loadPatient(deps, req, body.patientId);
    if (p.status === 'Merged') throw Errors.conflict('PATIENT_MERGED', 'Invite on the surviving record');
    const self = body.relationship === 'self';
    const role = self ? 'patient' : 'caregiver';
    const users = db(req).collection('users');
    const existing = await users.findOne({ tenantId: a.tenantId, email: body.email });
    const link = { patientId: p._id, relationship: body.relationship, invitedBy: a.userId, invitedAt: new Date(), approvedAt: self ? new Date() : null, approvedBy: self ? a.userId : null };
    if (existing) {
      if (!isPortalActor(existing.roles as string[])) throw Errors.conflict('USER_EXISTS', `${body.email} is a staff account. Use a different email for the portal`);
      if ((existing.portalLinks as Document[] | undefined)?.some((l) => (l.patientId as ObjectId).equals(p._id))) throw Errors.conflict('ALREADY_LINKED', 'This account already has access to this patient');
      if (self && existing.roles.includes('patient')) throw Errors.conflict('ALREADY_PATIENT', 'This account already belongs to another patient');
      await users.updateOne(
        { _id: existing._id },
        { $push: { portalLinks: link } as Document, ...(self ? { $addToSet: { patientIds: p._id, roles: 'patient' } } : { $addToSet: { roles: 'caregiver' } }), $inc: { version: 1 } },
      );
      await audit(deps, req, { action: 'portal.account.link', resource: `user:${id(existing)}`, outcome: 'success', meta: { relationship: body.relationship } });
      return res.status(201).json({ data: { id: id(existing), status: existing.status, needsApproval: !self, invite: null } });
    }
    const token = newToken();
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    const ins = await users.insertOne({
      tenantId: a.tenantId,
      email: body.email,
      name: body.name,
      roles: [role],
      patientIds: self ? [p._id] : [],
      portalLinks: [link],
      status: 'Invited',
      invite: self ? { tokenHash: sha256(token), expiresAt } : undefined,
      pendingInvite: self ? undefined : true,
      createdAt: new Date(),
      createdBy: a.userId,
      version: 1,
    });
    await audit(deps, req, { action: 'portal.account.invite', resource: `user:${ins.insertedId.toHexString()}`, outcome: 'success', meta: { relationship: body.relationship } });
    res.status(201).json({ data: { id: ins.insertedId.toHexString(), status: 'Invited', needsApproval: !self, invite: self ? { token, expiresAt: expiresAt.toISOString() } : null } });
  });

  /** Spec §5.17 / §5.26: caregiver (proxy) access is reviewed by a records officer other than the one who asked. */
  r.post('/portal-accounts/:id/approve', need(deps, 'mpi', 'A'), async (req, res) => {
    const q = parse(z.object({ patientId: objectId }), req.body);
    const a = req.actor!;
    const p = await loadPatient(deps, req, q.patientId);
    const u = await db(req).collection('users').findOne({ _id: idParam(req.params.id, 'Account'), tenantId: a.tenantId });
    const l = (u?.portalLinks as Document[] | undefined)?.find((x) => (x.patientId as ObjectId).equals(p._id));
    if (!u || !l) throw Errors.notFound('Account');
    if (l.approvedAt) throw Errors.conflict('ALREADY_APPROVED', 'This access is already approved');
    if ((l.invitedBy as ObjectId).equals(a.userId)) throw new AppError(403, 'FOUR_EYES', 'Someone other than the person who asked must approve caregiver access');
    const set: Document = { 'portalLinks.$[l].approvedAt': new Date(), 'portalLinks.$[l].approvedBy': a.userId };
    let invite: { token: string; expiresAt: string } | null = null;
    if (u.status === 'Invited' && u.pendingInvite) {
      const token = newToken();
      const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
      set.invite = { tokenHash: sha256(token), expiresAt };
      invite = { token, expiresAt: expiresAt.toISOString() };
    }
    await db(req)
      .collection('users')
      .updateOne({ _id: u._id }, { $set: set, $addToSet: { patientIds: p._id }, $unset: { pendingInvite: '' }, $inc: { version: 1 } }, { arrayFilters: [{ 'l.patientId': p._id }] });
    await audit(deps, req, { action: 'portal.proxy.approve', resource: `user:${id(u)}`, outcome: 'success', meta: { patient: id(p) } });
    res.json({ data: { id: id(u), approved: true, invite } });
  });

  r.post('/portal-accounts/:id/revoke', need(deps, 'mpi', 'E'), async (req, res) => {
    const q = parse(z.object({ patientId: objectId }), req.body);
    const a = req.actor!;
    const p = await loadPatient(deps, req, q.patientId);
    const u = await db(req).collection('users').findOne({ _id: idParam(req.params.id, 'Account'), tenantId: a.tenantId, roles: { $in: PORTAL_ROLES } });
    if (!u) throw Errors.notFound('Account');
    await db(req).collection('users').updateOne({ _id: u._id }, { $pull: { patientIds: p._id, portalLinks: { patientId: p._id } } as Document, $inc: { version: 1 } });
    const left = await db(req).collection('users').findOne({ _id: u._id });
    if (!(left?.portalLinks as unknown[] | undefined)?.length) {
      await db(req).collection('users').updateOne({ _id: u._id }, { $set: { status: 'Suspended' } });
      await deps.data.control().collection('sessions').deleteMany({ userId: u._id });
    }
    await audit(deps, req, { action: 'portal.account.revoke', resource: `user:${id(u)}`, outcome: 'success', meta: { patient: id(p) } });
    res.json({ data: { id: id(u), revoked: true } });
  });

  /** A clinician on the visit shares a released lab result or a final imaging report with the patient. */
  for (const [kind, col, ready] of [
    ['lab', 'lab_orders', 'Released'],
    ['imaging', 'imaging_orders', 'Final'],
    ['diagnostics', 'diagnostic_orders', 'Final'],
  ] as const) {
    r.post(`/portal-share/${kind}/:id`, async (req, res) => {
      const o = await db(req).collection(col).findOne({ _id: idParam(req.params.id, 'Result'), tenantId: req.actor!.tenantId });
      if (!o) throw Errors.notFound('Result');
      const e = await db(req).collection('encounters').findOne({ _id: o.encounterId });
      await loadPatient(deps, req, o.patientId, { clinical: true });
      if (!e || !encLevelOk(req.actor!.perms, e.type, 'S')) await deny(deps, req, `${col}:${id(o)}`, 'only a clinician on the visit shares results');
      if (o.status !== ready) throw Errors.conflict('NOT_FINAL', 'Only a final result can be shared');
      await db(req).collection(col).updateOne({ _id: o._id }, { $set: { sharedWithPatient: { at: now(), by: req.actor!.userId, byName: req.actor!.name } } });
      await audit(deps, req, { action: `portal.share.${kind}`, resource: `${col}:${id(o)}`, outcome: 'success' });
      res.json({ data: { id: id(o), shared: true } });
    });
  }

  const threadView = (t: WithId<Document>, patient?: Document | null) => ({
    id: id(t),
    subject: t.subject,
    status: t.status,
    awaiting: t.awaiting,
    lastAt: t.lastAt,
    patient: patient ? { id: id(patient as WithId<Document>), mrn: patient.mrn, name: nameOf(patient) } : null,
    messages: (t.messages as Document[]).map((m) => ({ from: m.from, byName: m.byName, at: m.at, text: m.text })),
  });

  r.get('/portal-inbox', need(deps, 'portal', 'E'), async (req, res) => {
    const q = parse(z.object({ status: z.enum(['open', 'all']).default('open') }), req.query);
    const f: Document = { tenantId: req.actor!.tenantId };
    if (q.status === 'open') f.status = 'Open';
    const list = await db(req).collection('portal_threads').find(f).sort({ awaiting: -1, lastAt: -1 }).limit(200).toArray();
    const pats = await db(req).collection('patients').find({ _id: { $in: list.map((x) => x.patientId) } }, { projection: { mrn: 1, names: 1 } }).toArray();
    res.json({ data: list.map((t) => threadView(t, pats.find((p) => p._id.equals(t.patientId)))) });
  });

  r.post('/portal-inbox/:id/reply', need(deps, 'portal', 'E'), async (req, res) => {
    const { text } = parse(Reply, req.body);
    const t = await db(req).collection('portal_threads').findOne({ _id: idParam(req.params.id, 'Conversation'), tenantId: req.actor!.tenantId });
    if (!t) throw Errors.notFound('Conversation');
    await db(req)
      .collection('portal_threads')
      .updateOne({ _id: t._id }, { $push: { messages: { from: 'staff', by: req.actor!.userId, byName: req.actor!.name, at: now(), text } } as Document, $set: { awaiting: 'patient', status: 'Open', lastAt: now() } });
    await audit(deps, req, { action: 'portal.message.reply', resource: `thread:${id(t)}`, outcome: 'success' });
    res.status(201).json({ data: { id: id(t) } });
  });

  r.post('/portal-inbox/:id/close', need(deps, 'portal', 'E'), async (req, res) => {
    const t = await db(req).collection('portal_threads').findOne({ _id: idParam(req.params.id, 'Conversation'), tenantId: req.actor!.tenantId });
    if (!t) throw Errors.notFound('Conversation');
    await db(req).collection('portal_threads').updateOne({ _id: t._id }, { $set: { status: 'Closed', awaiting: null, closedAt: now() } });
    await audit(deps, req, { action: 'portal.message.close', resource: `thread:${id(t)}`, outcome: 'success' });
    res.json({ data: { id: id(t), status: 'Closed' } });
  });

  // =====================================================================
  // Patient side: everything is limited to the records linked to the account
  // =====================================================================
  const portal = Router();
  portal.use((req, _res, next) => {
    const a = req.actor!;
    if (!isPortalActor(a.roles)) return next(Errors.forbidden('The patient portal is for patients and caregivers'));
    next();
  });

  /** Spec §5.26 acceptance: a patient can never see another patient's data. */
  async function own(req: Request): Promise<WithId<Document>> {
    const pid = idParam(req.params.pid, 'Patient');
    const a = req.actor!;
    if (!a.patientIds?.some((x) => x.equals(pid))) await deny(deps, req, `patient:${pid.toHexString()}`, 'not linked to this portal account');
    const p = await db(req).collection('patients').findOne({ _id: pid, tenantId: a.tenantId });
    if (!p) throw Errors.notFound('Patient');
    return p;
  }

  portal.get('/me', async (req, res) => {
    const a = req.actor!;
    const u = await db(req).collection('users').findOne({ _id: a.userId });
    const pats = await db(req).collection('patients').find({ _id: { $in: a.patientIds ?? [] }, tenantId: a.tenantId }, { projection: { mrn: 1, names: 1, dob: 1, sexAtBirth: 1 } }).toArray();
    res.json({
      data: {
        name: a.name,
        patients: pats.map((p) => ({
          id: id(p),
          mrn: p.mrn,
          name: nameOf(p),
          dob: p.dob,
          relationship: (u?.portalLinks as Document[] | undefined)?.find((l) => (l.patientId as ObjectId).equals(p._id))?.relationship ?? 'self',
        })),
      },
    });
  });

  portal.get('/:pid/summary', async (req, res) => {
    const p = await own(req);
    const t = now();
    const [next, video, results, invoices, unread] = await Promise.all([
      db(req).collection('appointments').find({ tenantId: req.actor!.tenantId, patientId: p._id, startsAt: { $gte: t }, status: { $in: ['Confirmed', 'CheckedIn'] } }).sort({ startsAt: 1 }).limit(1).toArray(),
      db(req).collection('telehealth_sessions').find({ tenantId: req.actor!.tenantId, patientId: p._id, status: { $in: OPEN_TELE }, endsAt: { $gte: new Date(t.getTime() - 3_600_000) } }).sort({ startsAt: 1 }).limit(1).toArray(),
      db(req).collection('lab_orders').countDocuments({ tenantId: req.actor!.tenantId, patientId: p._id, sharedWithPatient: { $exists: true } }),
      db(req).collection('invoices').find({ tenantId: req.actor!.tenantId, patientId: p._id, status: { $in: ['Issued', 'PartiallyPaid'] } }, { projection: { balanceMinor: 1, insuranceHoldMinor: 1, currency: 1 } }).toArray(),
      db(req).collection('portal_threads').countDocuments({ tenantId: req.actor!.tenantId, patientId: p._id, status: 'Open', awaiting: 'patient' }),
    ]);
    const providers = next[0] ? await db(req).collection('users').findOne({ _id: next[0].providerId }, { projection: { name: 1 } }) : null;
    const due = invoices.reduce((s, i) => s + Math.max(0, (i.balanceMinor ?? 0) - (i.insuranceHoldMinor ?? 0)), 0);
    res.json({
      data: {
        nextAppointment: next[0] ? { id: id(next[0]), startsAt: next[0].startsAt, clinician: providers?.name ?? null, status: next[0].status } : null,
        videoVisit: video[0] ? { id: id(video[0]), startsAt: video[0].startsAt, clinician: video[0].clinicianName, status: video[0].status, consent: Boolean(video[0].consent?.video) } : null,
        sharedResults: results,
        amountDueMinor: due,
        currency: invoices[0]?.currency ?? 'USD',
        repliesWaiting: unread,
      },
    });
  });

  // ---- appointments ----
  portal.get('/:pid/appointments', async (req, res) => {
    const p = await own(req);
    const since = new Date(now().getTime() - 180 * 86_400_000);
    const list = await db(req).collection('appointments').find({ tenantId: req.actor!.tenantId, patientId: p._id, startsAt: { $gte: since } }).sort({ startsAt: -1 }).limit(100).toArray();
    const docs = await db(req).collection('users').find({ _id: { $in: list.map((x) => x.providerId) } }, { projection: { name: 1 } }).toArray();
    res.json({
      data: list.map((x) => ({ id: id(x), startsAt: x.startsAt, minutes: x.minutes, status: x.status, reason: x.reason ?? null, clinician: docs.find((d) => d._id.equals(x.providerId))?.name ?? null, canCancel: x.status === 'Confirmed' && x.startsAt >= new Date(now().getTime() + 2 * 3_600_000) })),
    });
  });

  portal.get('/:pid/clinicians', async (req, res) => {
    await own(req);
    const a = req.actor!;
    const withSchedule = await db(req).collection('provider_schedules').distinct('providerId', { tenantId: a.tenantId });
    const users = await db(req).collection('users').find({ _id: { $in: withSchedule }, tenantId: a.tenantId, status: 'Active' }, { projection: { name: 1, roles: 1 } }).sort({ name: 1 }).toArray();
    res.json({ data: users.filter((u) => isProvider(u.roles as string[])).map((u) => ({ id: id(u), name: u.name })) });
  });

  async function slots(req: Request, providerId: ObjectId, date: string) {
    const a = req.actor!;
    const scheds = await db(req).collection('provider_schedules').find({ tenantId: a.tenantId, providerId, weekday: weekdayOf(date) }).toArray();
    const out: { startsAt: Date; time: string; branchId: ObjectId; minutes: number }[] = [];
    for (const s of scheds) {
      const b = await db(req).collection('branches').findOne({ _id: s.branchId, tenantId: a.tenantId });
      for (let m = toMinutes(s.start); m + s.slotMinutes <= toMinutes(s.end); m += s.slotMinutes) {
        out.push({ startsAt: zonedToUtc(date, fromMinutes(m), (b?.timezone as string) ?? zone), time: fromMinutes(m), branchId: s.branchId, minutes: s.slotMinutes });
      }
    }
    const taken = await db(req).collection('appointments').find({ tenantId: a.tenantId, providerId, slotLock: true, startsAt: { $in: out.map((o) => o.startsAt) } }, { projection: { startsAt: 1 } }).toArray();
    const set = new Set(taken.map((t) => (t.startsAt as Date).getTime()));
    // Patients book at least an hour ahead so the clinic can prepare.
    const earliest = now().getTime() + 3_600_000;
    return out.filter((o) => !set.has(o.startsAt.getTime()) && o.startsAt.getTime() >= earliest).sort((x, y) => x.startsAt.getTime() - y.startsAt.getTime());
  }

  portal.get('/:pid/slots', async (req, res) => {
    await own(req);
    const q = parse(z.object({ providerId: objectId, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }), req.query);
    const list = await slots(req, q.providerId, q.date);
    res.json({ data: list.map((s) => ({ startsAt: s.startsAt.toISOString(), time: s.time, minutes: s.minutes })) });
  });

  portal.post('/:pid/appointments', async (req, res) => {
    const p = await own(req);
    const body = parse(Book, req.body);
    const a = req.actor!;
    const startsAt = new Date(body.startsAt);
    const doc = await db(req).collection('users').findOne({ _id: body.providerId, tenantId: a.tenantId, status: 'Active' });
    if (!doc || !isProvider(doc.roles as string[])) throw Errors.validation([{ path: 'providerId', message: 'Choose a clinician' }]);
    const slot = (await slots(req, body.providerId, localDate(startsAt, zone))).find((s) => s.startsAt.getTime() === startsAt.getTime());
    if (!slot) throw new AppError(409, 'SLOT_TAKEN', 'That time is no longer free. Choose another time');
    const upcoming = await db(req).collection('appointments').countDocuments({ tenantId: a.tenantId, patientId: p._id, status: 'Confirmed', startsAt: { $gte: now() }, source: 'portal' });
    if (upcoming >= 3) throw new AppError(409, 'TOO_MANY_BOOKINGS', 'You already have three appointments booked online. Cancel one or call the hospital');
    try {
      const ins = await db(req).collection('appointments').insertOne({
        tenantId: a.tenantId,
        branchId: slot.branchId,
        patientId: p._id,
        providerId: doc._id,
        startsAt,
        minutes: slot.minutes,
        reason: body.reason,
        status: 'Confirmed',
        slotLock: true,
        source: 'portal',
        createdAt: new Date(),
        createdBy: a.userId,
        version: 1,
      });
      await db(req).collection('patients').updateOne({ _id: p._id }, { $addToSet: { careTeam: doc._id } });
      await audit(deps, req, { action: 'portal.appt.book', resource: `appointment:${ins.insertedId.toHexString()}`, outcome: 'success' });
      res.status(201).json({ data: { id: ins.insertedId.toHexString(), startsAt: startsAt.toISOString(), status: 'Confirmed' } });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw new AppError(409, 'SLOT_TAKEN', 'Someone just booked that time. Choose another');
      throw e;
    }
  });

  portal.post('/:pid/appointments/:id/cancel', async (req, res) => {
    const p = await own(req);
    const x = await db(req).collection('appointments').findOne({ _id: idParam(req.params.id, 'Appointment'), tenantId: req.actor!.tenantId, patientId: p._id });
    if (!x) throw Errors.notFound('Appointment');
    if (x.status !== 'Confirmed' || x.startsAt < new Date(now().getTime() + 2 * 3_600_000)) throw Errors.conflict('TOO_LATE', 'This appointment can no longer be cancelled online. Please call the hospital');
    await db(req).collection('appointments').updateOne({ _id: x._id, status: 'Confirmed' }, { $set: { status: 'Cancelled', cancelReason: 'Cancelled by patient online', cancelledAt: new Date() }, $unset: { slotLock: '' }, $inc: { version: 1 } });
    await audit(deps, req, { action: 'portal.appt.cancel', resource: `appointment:${id(x)}`, outcome: 'success' });
    res.json({ data: { id: id(x), status: 'Cancelled' } });
  });

  // ---- results (only those a clinician shared) ----
  portal.get('/:pid/results', async (req, res) => {
    const p = await own(req);
    const f = { tenantId: req.actor!.tenantId, patientId: p._id, sharedWithPatient: { $exists: true } };
    const [lab, img, dx] = await Promise.all([
      db(req).collection('lab_orders').find(f).sort({ releasedAt: -1 }).limit(100).toArray(),
      db(req).collection('imaging_orders').find(f).sort({ signedAt: -1 }).limit(50).toArray(),
      db(req).collection('diagnostic_orders').find(f).sort({ signedAt: -1 }).limit(50).toArray(),
    ]);
    res.json({
      data: [
        ...lab.map((o) => ({ id: id(o), kind: 'lab', name: o.testName, at: o.releasedAt, sharedBy: o.sharedWithPatient.byName, results: (o.results ?? []).map((x: Document) => ({ name: x.name, value: x.value, unit: x.unit ?? null, flag: x.flag ?? null, range: x.refLow !== undefined && x.refHigh !== undefined ? `${x.refLow}–${x.refHigh}` : null })), report: null })),
        ...[...img, ...dx].map((o) => ({ id: id(o), kind: 'imaging', name: o.examination, at: o.signedAt, sharedBy: o.sharedWithPatient.byName, results: [], report: o.report ? { impression: o.report.impression, findings: o.report.findings } : null })),
      ].sort((x, y) => new Date(y.at).getTime() - new Date(x.at).getTime()),
    });
  });

  // ---- bills ----
  portal.get('/:pid/invoices', async (req, res) => {
    const p = await own(req);
    const list = await db(req).collection('invoices').find({ tenantId: req.actor!.tenantId, patientId: p._id, status: { $in: ['Issued', 'PartiallyPaid', 'Paid'] } }).sort({ issuedOn: -1 }).limit(60).toArray();
    res.json({
      data: list.map((i) => ({
        id: id(i),
        number: i.invoiceNumber,
        issuedOn: i.issuedOn ?? null,
        currency: i.currency,
        totalMinor: i.totalMinor,
        paidMinor: i.paidMinor ?? 0,
        insuranceMinor: i.insuranceHoldMinor ?? 0,
        dueMinor: Math.max(0, (i.balanceMinor ?? 0) - (i.insuranceHoldMinor ?? 0)),
        status: i.status,
        lines: (i.lines as Document[] | undefined)?.map((l) => ({ description: l.description, qty: l.quantity ?? 1, amountMinor: l.amountMinor ?? 0 })) ?? [],
      })),
    });
  });

  // ---- consents ----
  portal.get('/:pid/consents', async (req, res) => {
    const p = await own(req);
    const list = await db(req).collection('consents').find({ tenantId: req.actor!.tenantId, patientId: p._id }).sort({ recordedAt: -1 }).limit(50).toArray();
    res.json({ data: list.map((c) => ({ id: id(c), type: c.type, status: c.status, method: c.method, recordedAt: c.recordedAt })) });
  });

  // ---- video visits ----
  portal.get('/:pid/video-visits', async (req, res) => {
    const p = await own(req);
    const list = await db(req)
      .collection('telehealth_sessions')
      .find({ tenantId: req.actor!.tenantId, patientId: p._id, startsAt: { $gte: new Date(now().getTime() - 30 * 86_400_000) } })
      .sort({ startsAt: -1 })
      .limit(30)
      .toArray();
    res.json({ data: list.map((x) => ({ id: id(x), startsAt: x.startsAt, minutes: x.minutes, clinician: x.clinicianName, reason: x.reason, status: x.status, consent: Boolean(x.consent?.video), canJoin: x.status === 'Connected' })) });
  });

  /** The patient agrees to the video consultation themselves (recorded as given through the portal). */
  portal.post('/:pid/video-visits/:id/consent', async (req, res) => {
    const p = await own(req);
    const body = parse(Consent, req.body);
    const x = await db(req).collection('telehealth_sessions').findOne({ _id: idParam(req.params.id, 'Video visit'), tenantId: req.actor!.tenantId, patientId: p._id });
    if (!x) throw Errors.notFound('Video visit');
    if (!OPEN_TELE.includes(x.status)) throw Errors.conflict('INVALID_TRANSITION', 'This visit is over');
    await db(req).collection('telehealth_sessions').updateOne({ _id: x._id }, { $set: { consent: { video: true, recording: body.recording, method: 'portal', at: new Date(), by: req.actor!.userId } } });
    await audit(deps, req, { action: 'portal.tele.consent', resource: `tele:${id(x)}`, outcome: 'success', meta: { recording: body.recording } });
    res.json({ data: { id: id(x), consent: true } });
  });

  portal.get('/:pid/video-visits/:id/join', async (req, res) => {
    const p = await own(req);
    const x = await db(req).collection('telehealth_sessions').findOne({ _id: idParam(req.params.id, 'Video visit'), tenantId: req.actor!.tenantId, patientId: p._id });
    if (!x) throw Errors.notFound('Video visit');
    if (x.status !== 'Connected') throw Errors.conflict('NOT_STARTED', 'Your clinician has not started the call yet. Please wait on this page');
    await audit(deps, req, { action: 'portal.tele.join', resource: `tele:${id(x)}`, outcome: 'success' });
    res.json({ data: { url: `${deps.config.teleBaseUrl}/${x.room}` } });
  });

  // ---- messages ----
  portal.get('/:pid/messages', async (req, res) => {
    const p = await own(req);
    const list = await db(req).collection('portal_threads').find({ tenantId: req.actor!.tenantId, patientId: p._id }).sort({ lastAt: -1 }).limit(50).toArray();
    res.json({ data: list.map((t) => threadView(t)) });
  });

  portal.post('/:pid/messages', async (req, res) => {
    const p = await own(req);
    const body = parse(NewThread, req.body);
    const open = await db(req).collection('portal_threads').countDocuments({ tenantId: req.actor!.tenantId, patientId: p._id, status: 'Open' });
    if (open >= 5) throw new AppError(409, 'TOO_MANY_OPEN', 'You have five open conversations. Wait for a reply or continue an existing one');
    const ins = await db(req)
      .collection('portal_threads')
      .insertOne({ tenantId: req.actor!.tenantId, patientId: p._id, subject: body.subject, status: 'Open', awaiting: 'staff', createdAt: now(), lastAt: now(), createdBy: req.actor!.userId, messages: [{ from: 'patient', by: req.actor!.userId, byName: req.actor!.name, at: now(), text: body.text }] });
    await audit(deps, req, { action: 'portal.message.new', resource: `thread:${ins.insertedId.toHexString()}`, outcome: 'success' });
    res.status(201).json({ data: { id: ins.insertedId.toHexString() } });
  });

  portal.post('/:pid/messages/:id/reply', async (req, res) => {
    const p = await own(req);
    const { text } = parse(Reply, req.body);
    const t = await db(req).collection('portal_threads').findOne({ _id: idParam(req.params.id, 'Conversation'), tenantId: req.actor!.tenantId, patientId: p._id });
    if (!t) throw Errors.notFound('Conversation');
    await db(req)
      .collection('portal_threads')
      .updateOne({ _id: t._id }, { $push: { messages: { from: 'patient', by: req.actor!.userId, byName: req.actor!.name, at: now(), text } } as Document, $set: { status: 'Open', awaiting: 'staff', lastAt: now() } });
    await audit(deps, req, { action: 'portal.message.reply', resource: `thread:${id(t)}`, outcome: 'success' });
    res.status(201).json({ data: { id: id(t) } });
  });

  r.use('/portal', portal);
  return r;
}
