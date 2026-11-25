import { Router, type Request } from 'express';
import type { Document, ObjectId } from 'mongodb';
import { z } from 'zod';
import { can, effectivePermissions, isBranchBound } from '@fahan/policy';
import type { Deps } from '../../context';
import { AppError, Errors } from '../../lib/errors';
import { fromMinutes, localDate, localTime, toMinutes, weekdayOf, zonedToUtc } from '../../lib/time';
import { idParam, objectId, parse } from '../../lib/validate';
import { audit } from '../../middleware/audit';
import { assertBranch, need } from '../../middleware/authorize';
import { loadPatient } from '../patients/access';
import { nextQueueNo, openEncounter } from '../encounters/service';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour)');
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const CreateSchedule = z
  .object({
    providerId: objectId,
    branchId: objectId,
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    start: hhmm,
    end: hhmm,
    slotMinutes: z.number().int().min(5).max(240),
  })
  .refine((s) => toMinutes(s.end) - toMinutes(s.start) >= s.slotMinutes, { message: 'The session must fit at least one slot', path: ['end'] });
const SlotQuery = z.object({ providerId: objectId, date: day });
const ListQuery = z.object({ date: day, providerId: objectId.optional(), branchId: objectId.optional() });
const Book = z.object({ patientId: objectId, providerId: objectId, startsAt: z.string().datetime(), reason: z.string().trim().max(300).optional() });
const WalkIn = z.object({ patientId: objectId, providerId: objectId, reason: z.string().trim().max(300).optional() });
const Cancel = z.object({ reason: z.string().trim().min(3).max(300) });

/** Roles that run their own clinic list. */
const isProvider = (roles: string[]) => {
  const p = effectivePermissions(roles);
  return can(p, 'opd', 'S') || can(p, 'tele', 'S') || can(p, 'mat', 'E');
};


/** Spec §5.4 Appointments & queues. Confirmed → CheckedIn → Completed / Cancelled / NoShow. */
export function appointmentRoutes(deps: Deps): Router {
  const r = Router();
  const now = () => deps.config.now();

  async function branchOf(req: Request, id: ObjectId) {
    const b = await req.actor!.db!.collection('branches').findOne({ _id: id, tenantId: req.actor!.tenantId });
    if (!b) throw Errors.notFound('Branch');
    return b as Document & { _id: ObjectId; code: string; timezone: string };
  }

  async function provider(req: Request, id: ObjectId) {
    const u = await req.actor!.db!.collection('users').findOne({ _id: id, tenantId: req.actor!.tenantId, status: 'Active' });
    if (!u || !isProvider(u.roles)) throw Errors.validation([{ path: 'providerId', message: 'Choose an active clinician who runs a clinic' }]);
    return u;
  }

  /** Slots of one provider on one local date, with their UTC start and whether they are free. */
  async function slotsFor(req: Request, providerId: ObjectId, date: string) {
    const a = req.actor!;
    const scheds = await a.db!.collection('provider_schedules').find({ tenantId: a.tenantId, providerId, weekday: weekdayOf(date) }).toArray();
    const out: { startsAt: Date; time: string; branchId: ObjectId; minutes: number }[] = [];
    for (const s of scheds) {
      const b = await branchOf(req, s.branchId);
      for (let m = toMinutes(s.start); m + s.slotMinutes <= toMinutes(s.end); m += s.slotMinutes) {
        out.push({ startsAt: zonedToUtc(date, fromMinutes(m), b.timezone), time: fromMinutes(m), branchId: s.branchId, minutes: s.slotMinutes });
      }
    }
    const taken = await a
      .db!.collection('appointments')
      .find({ tenantId: a.tenantId, providerId, slotLock: true, startsAt: { $in: out.map((o) => o.startsAt) } }, { projection: { startsAt: 1 } })
      .toArray();
    const takenSet = new Set(taken.map((t) => (t.startsAt as Date).getTime()));
    return out
      .sort((x, y) => x.startsAt.getTime() - y.startsAt.getTime())
      .map((o) => ({ ...o, free: !takenSet.has(o.startsAt.getTime()) && o.startsAt > now() }));
  }

  // ---- providers & schedules ----

  r.get('/providers', need(deps, 'appt', 'V'), async (req, res) => {
    const a = req.actor!;
    const filter: Document = { tenantId: a.tenantId, status: 'Active' };
    if (isBranchBound(a.scope)) filter.branchId = a.branchId ?? null;
    const users = await a.db!.collection('users').find(filter, { projection: { name: 1, roles: 1, branchId: 1 } }).sort({ name: 1 }).toArray();
    res.json({
      data: users.filter((u) => isProvider(u.roles)).map((u) => ({ id: u._id.toHexString(), name: u.name, roles: u.roles, branchId: u.branchId?.toHexString() ?? null })),
    });
  });

  r.get('/schedules', need(deps, 'appt', 'V'), async (req, res) => {
    const q = parse(z.object({ providerId: objectId.optional() }), req.query);
    const a = req.actor!;
    const list = await a
      .db!.collection('provider_schedules')
      .find({ tenantId: a.tenantId, ...(q.providerId ? { providerId: q.providerId } : {}), ...(isBranchBound(a.scope) ? { branchId: a.branchId ?? null } : {}) })
      .sort({ weekday: 1, start: 1 })
      .toArray();
    res.json({
      data: list.map((s) => ({ id: s._id.toHexString(), providerId: s.providerId.toHexString(), branchId: s.branchId.toHexString(), weekday: s.weekday, start: s.start, end: s.end, slotMinutes: s.slotMinutes })),
    });
  });

  r.post('/schedules', need(deps, 'appt', 'E'), async (req, res) => {
    const body = parse(CreateSchedule, req.body);
    await assertBranch(deps, req, body.branchId);
    await branchOf(req, body.branchId);
    const p = await provider(req, body.providerId);
    if (p.branchId && !p.branchId.equals(body.branchId)) throw Errors.validation([{ path: 'branchId', message: 'This clinician works at another branch' }]);
    const a = req.actor!;
    const col = a.db!.collection('provider_schedules');
    const [s, e] = [body.start, body.end];
    for (const weekday of body.weekdays) {
      const clash = await col.findOne({ tenantId: a.tenantId, providerId: body.providerId, weekday, start: { $lt: e }, end: { $gt: s } });
      if (clash) throw Errors.conflict('SCHEDULE_OVERLAP', `This clinician already has a session from ${clash.start} to ${clash.end} on that day`);
    }
    const docs = body.weekdays.map((weekday) => ({
      tenantId: a.tenantId,
      providerId: body.providerId,
      branchId: body.branchId,
      weekday,
      start: s,
      end: e,
      slotMinutes: body.slotMinutes,
      createdAt: new Date(),
      createdBy: a.userId,
    }));
    await col.insertMany(docs);
    await audit(deps, req, { action: 'appt.schedule.create', resource: `provider:${body.providerId.toHexString()}`, outcome: 'success', meta: { weekdays: body.weekdays.join(','), start: s, end: e } });
    res.status(201).json({ data: { created: docs.length } });
  });

  r.delete('/schedules/:id', need(deps, 'appt', 'E'), async (req, res) => {
    const a = req.actor!;
    const id = idParam(req.params.id, 'Schedule');
    const s = await a.db!.collection('provider_schedules').findOne({ _id: id, tenantId: a.tenantId });
    if (!s) throw Errors.notFound('Schedule');
    await assertBranch(deps, req, s.branchId);
    await a.db!.collection('provider_schedules').deleteOne({ _id: id });
    await audit(deps, req, { action: 'appt.schedule.delete', resource: `schedule:${id.toHexString()}`, outcome: 'success' });
    res.status(204).end();
  });

  r.get('/slots', need(deps, 'appt', 'V'), async (req, res) => {
    const q = parse(SlotQuery, req.query);
    const slots = await slotsFor(req, q.providerId, q.date);
    res.json({ data: slots.map((s) => ({ startsAt: s.startsAt.toISOString(), time: s.time, minutes: s.minutes, free: s.free, branchId: s.branchId.toHexString() })) });
  });

  // ---- appointments ----

  r.get('/', need(deps, 'appt', 'V'), async (req, res) => {
    const q = parse(ListQuery, req.query);
    const a = req.actor!;
    const branchId = isBranchBound(a.scope) ? a.branchId : q.branchId;
    const tz = branchId ? (await branchOf(req, branchId)).timezone : 'Africa/Mogadishu';
    const from = zonedToUtc(q.date, '00:00', tz);
    const to = new Date(from.getTime() + 24 * 3_600_000);
    const filter: Document = { tenantId: a.tenantId, startsAt: { $gte: from, $lt: to } };
    if (branchId) filter.branchId = branchId;
    if (a.scope === 'assigned-patient') filter.providerId = a.userId; // clinicians see their own list
    else if (q.providerId) filter.providerId = q.providerId;
    const list = await a.db!.collection('appointments').find(filter).sort({ startsAt: 1 }).limit(500).toArray();
    const pats = await a.db!.collection('patients').find({ _id: { $in: list.map((x) => x.patientId) } }, { projection: { mrn: 1, names: 1, dob: 1 } }).toArray();
    const provs = await a.db!.collection('users').find({ _id: { $in: list.map((x) => x.providerId) } }, { projection: { name: 1 } }).toArray();
    res.json({
      data: list.map((x) => {
        const p = pats.find((y) => y._id.equals(x.patientId));
        return {
          id: x._id.toHexString(),
          startsAt: x.startsAt,
          time: localTime(x.startsAt, tz),
          minutes: x.minutes,
          status: x.status,
          reason: x.reason ?? null,
          queueNo: x.queueNo ?? null,
          encounterId: x.encounterId?.toHexString() ?? null,
          patient: p ? { id: p._id.toHexString(), mrn: p.mrn, names: p.names, dob: p.dob } : null,
          provider: { id: x.providerId.toHexString(), name: provs.find((y) => y._id.equals(x.providerId))?.name ?? '—' },
        };
      }),
    });
  });

  r.post('/', need(deps, 'appt', 'E'), async (req, res) => {
    const body = parse(Book, req.body);
    const a = req.actor!;
    const patient = await loadPatient(deps, req, body.patientId);
    if (patient.status === 'Merged') throw Errors.conflict('PATIENT_MERGED', 'Book on the surviving record');
    const prov = await provider(req, body.providerId);
    const startsAt = new Date(body.startsAt);
    const branch = prov.branchId ? await branchOf(req, prov.branchId) : null;
    const date = localDate(startsAt, branch?.timezone ?? 'Africa/Mogadishu');
    const slot = (await slotsFor(req, body.providerId, date)).find((s) => s.startsAt.getTime() === startsAt.getTime());
    if (!slot) throw Errors.validation([{ path: 'startsAt', message: 'That time is not one of this clinician’s slots' }]);
    if (startsAt <= now()) throw Errors.validation([{ path: 'startsAt', message: 'That slot has already started' }]);
    await assertBranch(deps, req, slot.branchId);
    try {
      const ins = await a.db!.collection('appointments').insertOne({
        tenantId: a.tenantId,
        branchId: slot.branchId,
        patientId: patient._id,
        providerId: prov._id,
        startsAt,
        minutes: slot.minutes,
        reason: body.reason,
        status: 'Confirmed',
        slotLock: true,
        createdAt: new Date(),
        createdBy: a.userId,
        version: 1,
      });
      // The booked clinician now has a care relationship with the patient (spec §3.4).
      await a.db!.collection('patients').updateOne({ _id: patient._id }, { $addToSet: { careTeam: prov._id } });
      await audit(deps, req, { action: 'appt.book', resource: `appointment:${ins.insertedId.toHexString()}`, outcome: 'success', meta: { startsAt: startsAt.toISOString() } });
      res.status(201).json({ data: { id: ins.insertedId.toHexString(), status: 'Confirmed', startsAt: startsAt.toISOString() } });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw Errors.conflict('SLOT_TAKEN', 'Someone just booked that slot. Choose another time');
      throw e;
    }
  });

  /** Reception checks in a patient without a booking: queue number + visit with the chosen clinician. */
  r.post('/walk-in', need(deps, 'appt', 'E'), async (req, res) => {
    const body = parse(WalkIn, req.body);
    const a = req.actor!;
    const patient = await loadPatient(deps, req, body.patientId);
    if (patient.status === 'Merged') throw Errors.conflict('PATIENT_MERGED', 'Check in the surviving record');
    const prov = await provider(req, body.providerId);
    const branchId = prov.branchId ?? a.branchId;
    if (!branchId) throw Errors.validation([{ path: 'providerId', message: 'This clinician has no branch' }]);
    await assertBranch(deps, req, branchId);
    const branch = await branchOf(req, branchId);
    const queueNo = await nextQueueNo(req, branch.code, localDate(now(), branch.timezone));
    const encounterId = await openEncounter(req, { patientId: patient._id, branchId, clinicianIds: [prov._id], queueNo, reason: body.reason });
    await audit(deps, req, { action: 'appt.walk_in', resource: `encounter:${encounterId.toHexString()}`, outcome: 'success', meta: { queueNo } });
    res.status(201).json({ data: { encounterId: encounterId.toHexString(), queueNo } });
  });

  async function loadAppt(req: Request) {
    const a = req.actor!;
    const id = idParam(req.params.id, 'Appointment');
    const x = await a.db!.collection('appointments').findOne({ _id: id, tenantId: a.tenantId });
    if (!x) throw Errors.notFound('Appointment');
    await assertBranch(deps, req, x.branchId);
    return x;
  }

  r.post('/:id/check-in', need(deps, 'appt', 'E'), async (req, res) => {
    const x = await loadAppt(req);
    if (x.status !== 'Confirmed') throw Errors.conflict('INVALID_TRANSITION', `Appointment is ${String(x.status).toLowerCase()}`);
    const branch = await branchOf(req, x.branchId);
    const today = localDate(now(), branch.timezone);
    if (localDate(x.startsAt, branch.timezone) !== today) {
      throw new AppError(409, 'NOT_TODAY', 'Patients can only be checked in on the day of their appointment');
    }
    const a = req.actor!;
    let encounterId: ObjectId | undefined;
    let queueNo = 0;
    const session = deps.data.client.startSession();
    try {
      await session.withTransaction(async () => {
        queueNo = await nextQueueNo(req, branch.code, today, session);
        const upd = await a.db!.collection('appointments').updateOne(
          { _id: x._id, status: 'Confirmed' },
          { $set: { status: 'CheckedIn', checkedInAt: new Date(), queueNo }, $inc: { version: 1 } },
          { session },
        );
        if (!upd.modifiedCount) throw Errors.conflict('INVALID_TRANSITION', 'Appointment was already checked in');
        encounterId = await openEncounter(req, { patientId: x.patientId, branchId: x.branchId, clinicianIds: [x.providerId], appointmentId: x._id, queueNo, reason: x.reason }, session);
        await a.db!.collection('appointments').updateOne({ _id: x._id }, { $set: { encounterId } }, { session });
      });
    } finally {
      await session.endSession();
    }
    await audit(deps, req, { action: 'appt.check_in', resource: `appointment:${x._id.toHexString()}`, outcome: 'success', meta: { queueNo } });
    res.json({ data: { id: x._id.toHexString(), status: 'CheckedIn', queueNo, encounterId: encounterId!.toHexString() } });
  });

  r.post('/:id/cancel', need(deps, 'appt', 'E'), async (req, res) => {
    const { reason } = parse(Cancel, req.body);
    const x = await loadAppt(req);
    const upd = await req
      .actor!.db!.collection('appointments')
      .updateOne(
        { _id: x._id, status: 'Confirmed' },
        { $set: { status: 'Cancelled', cancelReason: reason, cancelledAt: new Date(), cancelledBy: req.actor!.userId }, $unset: { slotLock: '' }, $inc: { version: 1 } },
      );
    if (!upd.modifiedCount) throw Errors.conflict('INVALID_TRANSITION', `Appointment is ${String(x.status).toLowerCase()}`);
    await audit(deps, req, { action: 'appt.cancel', resource: `appointment:${x._id.toHexString()}`, outcome: 'success' });
    res.json({ data: { id: x._id.toHexString(), status: 'Cancelled' } });
  });

  r.post('/:id/no-show', need(deps, 'appt', 'E'), async (req, res) => {
    const x = await loadAppt(req);
    if (x.startsAt.getTime() + 15 * 60_000 > now().getTime()) {
      throw new AppError(409, 'TOO_EARLY', 'Wait at least 15 minutes after the appointment time before marking a no-show');
    }
    const upd = await req
      .actor!.db!.collection('appointments')
      .updateOne({ _id: x._id, status: 'Confirmed' }, { $set: { status: 'NoShow', noShowAt: new Date() }, $unset: { slotLock: '' }, $inc: { version: 1 } });
    if (!upd.modifiedCount) throw Errors.conflict('INVALID_TRANSITION', `Appointment is ${String(x.status).toLowerCase()}`);
    await audit(deps, req, { action: 'appt.no_show', resource: `appointment:${x._id.toHexString()}`, outcome: 'success' });
    res.json({ data: { id: x._id.toHexString(), status: 'NoShow' } });
  });

  return r;
}

