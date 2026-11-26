import { Router, type Request } from 'express';
import type { Document, ObjectId } from 'mongodb';
import { z } from 'zod';
import { can, effectivePermissions, isBranchBound } from '@fahan/policy';
import type { Deps } from '../../context';
import { AppError, Errors } from '../../lib/errors';
import { localTime, zonedToUtc } from '../../lib/time';
import { idParam, objectId, parse } from '../../lib/validate';
import { audit } from '../../middleware/audit';
import { assertBranch, deny, need } from '../../middleware/authorize';
import { assertRecentMfa } from '../../middleware/session';
import { loadPatient } from '../patients/access';

/** WHO Surgical Safety Checklist (spec §4.2 / §5.16): every item must be confirmed before the next phase. */
export const CHECKLIST = {
  'sign-in': ['identity-confirmed', 'site-marked', 'consent-confirmed', 'anesthesia-check-complete', 'pulse-oximeter-working', 'allergies-known', 'airway-risk-assessed', 'blood-loss-risk-assessed'],
  'time-out': ['team-introduced', 'patient-site-procedure-confirmed', 'antibiotic-prophylaxis-given', 'critical-events-reviewed', 'imaging-displayed'],
  'sign-out': ['procedure-recorded', 'counts-correct', 'specimens-labelled', 'equipment-problems-addressed', 'recovery-concerns-reviewed'],
} as const;
type Phase = keyof typeof CHECKLIST;
const PHASES = Object.keys(CHECKLIST) as Phase[];

const NewTheatre = z.object({ branchId: objectId, code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{1,10}$/), name: z.string().trim().min(2).max(80) });
const TheatreStatus = z.object({ status: z.enum(['Available', 'OutOfService']), reason: z.string().trim().min(3).max(200) });
const NewCase = z.object({
  patientId: objectId,
  procedure: z.string().trim().min(3).max(200),
  side: z.enum(['left', 'right', 'bilateral', 'not-applicable']),
  surgeonId: objectId,
  anesthetistId: objectId.optional(),
  theatreId: objectId,
  startsAt: z.string().datetime(),
  minutes: z.number().int().min(15).max(720),
  admissionId: objectId.optional(),
});
const Consent = z.object({ method: z.enum(['written', 'verbal-witnessed']), signedBy: z.enum(['patient', 'guardian']), witnessName: z.string().trim().min(2).max(80).optional(), risksExplained: z.literal(true) });
const Checklist = z.object({ items: z.record(z.string(), z.boolean()) });
const Advance = z.object({ to: z.enum(['Prepared', 'InProcedure', 'Recovery', 'Completed']) });
const OpNote = z.object({
  text: z.string().trim().min(20).max(20_000),
  findings: z.string().trim().max(2_000).optional(),
  complications: z.string().trim().max(2_000).optional(),
  estimatedBloodLossMl: z.number().int().min(0).max(20_000).optional(),
});
const Cancel = z.object({ reason: z.string().trim().min(3).max(300) });

const id = (x: { _id: ObjectId }) => x._id.toHexString();
const ACTIVE = ['Planned', 'Prepared', 'InProcedure', 'Recovery'];
const NEXT: Record<string, string> = { Planned: 'Prepared', Prepared: 'InProcedure', InProcedure: 'Recovery', Recovery: 'Completed' };

/** Spec §5.16 surgery & operating theatre: Planned → Prepared → InProcedure → Recovery → Completed. */
export function surgeryRoutes(deps: Deps): Router {
  const r = Router();
  const db = (req: Request) => req.actor!.db!;
  const now = () => deps.config.now();

  async function theatre(req: Request, theatreId: ObjectId) {
    const t = await db(req).collection('theatres').findOne({ _id: theatreId, tenantId: req.actor!.tenantId });
    if (!t) throw Errors.notFound('Theatre');
    await assertBranch(deps, req, t.branchId);
    return t;
  }

  async function member(req: Request, userId: ObjectId, check: (p: ReturnType<typeof effectivePermissions>) => boolean, label: string) {
    const u = await db(req).collection('users').findOne({ _id: userId, tenantId: req.actor!.tenantId, status: 'Active' });
    if (!u || !check(effectivePermissions(u.roles))) throw Errors.validation([{ path: label, message: `Choose an active ${label === 'surgeonId' ? 'surgeon' : 'anesthetist'}` }]);
    return u;
  }

  /** Surgeons and anaesthetists who can be put on a case (same rules as booking). */
  r.get('/team', need(deps, 'sx', 'V'), async (req, res) => {
    const users = await db(req).collection('users').find({ tenantId: req.actor!.tenantId, status: 'Active' }, { projection: { name: 1, roles: 1 } }).sort({ name: 1 }).toArray();
    const p = (u: Document) => effectivePermissions(u.roles as string[]);
    res.json({
      data: {
        surgeons: users.filter((u) => can(p(u), 'sx', 'S') && !can(p(u), 'icu', 'E')).map((u) => ({ id: id(u), name: u.name })),
        anesthetists: users.filter((u) => can(p(u), 'sx', 'S') && can(p(u), 'icu', 'E')).map((u) => ({ id: id(u), name: u.name })),
      },
    });
  });

  r.get('/theatres', need(deps, 'sx', 'V'), async (req, res) => {
    const a = req.actor!;
    const f: Document = { tenantId: a.tenantId };
    if (isBranchBound(a.scope)) f.branchId = a.branchId ?? null;
    const list = await db(req).collection('theatres').find(f).sort({ code: 1 }).toArray();
    res.json({ data: list.map((t) => ({ id: id(t), code: t.code, name: t.name, status: t.status, statusReason: t.statusReason ?? null })) });
  });

  r.post('/theatres', need(deps, 'org', 'E'), async (req, res) => {
    const body = parse(NewTheatre, req.body);
    await assertBranch(deps, req, body.branchId);
    try {
      const ins = await db(req).collection('theatres').insertOne({ tenantId: req.actor!.tenantId, ...body, status: 'Available', lockSeq: 0, createdAt: new Date() });
      await audit(deps, req, { action: 'sx.theatre.create', resource: `theatre:${ins.insertedId.toHexString()}`, outcome: 'success' });
      res.status(201).json({ data: { id: ins.insertedId.toHexString(), code: body.code } });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw Errors.conflict('THEATRE_EXISTS', `Theatre ${body.code} already exists`);
      throw e;
    }
  });

  /** Spec §5.24: a theatre out of service cannot be booked. */
  r.post('/theatres/:id/status', need(deps, 'eq', 'E'), async (req, res) => {
    const body = parse(TheatreStatus, req.body);
    const t = await theatre(req, idParam(req.params.id, 'Theatre'));
    await db(req).collection('theatres').updateOne({ _id: t._id }, { $set: { status: body.status, statusReason: body.reason, statusAt: new Date() } });
    await audit(deps, req, { action: 'sx.theatre.status', resource: `theatre:${id(t)}`, outcome: 'success', meta: { status: body.status } });
    res.json({ data: { id: id(t), status: body.status } });
  });

  r.get('/schedule', need(deps, 'sx', 'V'), async (req, res) => {
    const q = parse(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }), req.query);
    const a = req.actor!;
    const tf: Document = { tenantId: a.tenantId };
    if (isBranchBound(a.scope)) tf.branchId = a.branchId ?? null;
    const theatres = await db(req).collection('theatres').find(tf).sort({ code: 1 }).toArray();
    const branch = theatres[0] ? await db(req).collection('branches').findOne({ _id: theatres[0].branchId }) : null;
    const tz = branch?.timezone ?? 'Africa/Mogadishu';
    const from = zonedToUtc(q.date, '00:00', tz);
    const to = new Date(from.getTime() + 24 * 3_600_000);
    const cases = await db(req)
      .collection('surgery_cases')
      .find({ tenantId: a.tenantId, theatreId: { $in: theatres.map((t) => t._id) }, startsAt: { $lt: to }, endsAt: { $gt: from }, status: { $ne: 'Cancelled' } })
      .sort({ startsAt: 1 })
      .toArray();
    const pats = await db(req).collection('patients').find({ _id: { $in: cases.map((c) => c.patientId) } }, { projection: { names: 1, mrn: 1 } }).toArray();
    res.json({
      data: theatres.map((t) => ({
        id: id(t),
        code: t.code,
        name: t.name,
        status: t.status,
        statusReason: t.statusReason ?? null,
        cases: cases
          .filter((c) => c.theatreId.equals(t._id))
          .map((c) => {
            const p = pats.find((x) => x._id.equals(c.patientId));
            return { id: id(c), procedure: c.procedure, status: c.status, start: localTime(c.startsAt, tz), end: localTime(c.endsAt, tz), surgeonName: c.surgeonName, patient: p ? { mrn: p.mrn, names: p.names } : null };
          }),
      })),
    });
  });

  r.post('/cases', need(deps, 'sx', 'E'), async (req, res) => {
    const body = parse(NewCase, req.body);
    const p = await loadPatient(deps, req, body.patientId, { clinical: true });
    const t = await theatre(req, body.theatreId);
    if (t.status !== 'Available') throw new AppError(409, 'THEATRE_UNAVAILABLE', `Theatre ${t.code} is out of service${t.statusReason ? `: ${t.statusReason}` : ''}`);
    const surgeon = await member(req, body.surgeonId, (x) => can(x, 'sx', 'S') && !can(x, 'icu', 'E'), 'surgeonId');
    const anest = body.anesthetistId ? await member(req, body.anesthetistId, (x) => can(x, 'sx', 'S') && can(x, 'icu', 'E'), 'anesthetistId') : null;
    const startsAt = new Date(body.startsAt);
    if (startsAt <= now()) throw Errors.validation([{ path: 'startsAt', message: 'Choose a time in the future' }]);
    const endsAt = new Date(startsAt.getTime() + body.minutes * 60_000);
    const a = req.actor!;
    const s = deps.data.client.startSession();
    let caseId: ObjectId | undefined;
    try {
      await s.withTransaction(async () => {
        // Touching the theatre document makes concurrent bookings of the same theatre conflict and retry.
        await db(req).collection('theatres').updateOne({ _id: t._id }, { $inc: { lockSeq: 1 } }, { session: s });
        const clash = await db(req)
          .collection('surgery_cases')
          .findOne({ tenantId: a.tenantId, status: { $in: ACTIVE }, startsAt: { $lt: endsAt }, endsAt: { $gt: startsAt }, $or: [{ theatreId: t._id }, { surgeonId: surgeon._id }] }, { session: s });
        if (clash) {
          throw new AppError(409, 'THEATRE_CONFLICT', clash.theatreId.equals(t._id) ? `${t.code} is already booked at that time` : 'The surgeon is already operating at that time');
        }
        const ins = await db(req).collection('surgery_cases').insertOne(
          {
            tenantId: a.tenantId,
            branchId: t.branchId,
            patientId: p._id,
            admissionId: body.admissionId,
            procedure: body.procedure,
            side: body.side,
            surgeonId: surgeon._id,
            surgeonName: surgeon.name,
            anesthetistId: anest?._id,
            theatreId: t._id,
            startsAt,
            endsAt,
            status: 'Planned',
            checklist: {},
            timeline: [{ status: 'Planned', at: new Date(), by: a.userId }],
            createdAt: new Date(),
            createdBy: a.userId,
            version: 1,
          },
          { session: s },
        );
        caseId = ins.insertedId;
        await db(req).collection('patients').updateOne({ _id: p._id }, { $addToSet: { careTeam: { $each: [surgeon._id, ...(anest ? [anest._id] : [])] } } }, { session: s });
      });
    } finally {
      await s.endSession();
    }
    await audit(deps, req, { action: 'sx.case.plan', resource: `surgery:${caseId!.toHexString()}`, outcome: 'success', meta: { theatre: t.code } });
    res.status(201).json({ data: { id: caseId!.toHexString(), status: 'Planned' } });
  });

  async function loadCase(req: Request) {
    const c = await db(req).collection('surgery_cases').findOne({ _id: idParam(req.params.id, 'Surgery case'), tenantId: req.actor!.tenantId });
    if (!c) throw Errors.notFound('Surgery case');
    await loadPatient(deps, req, c.patientId, { clinical: true });
    return c;
  }

  r.get('/cases/:id', need(deps, 'sx', 'V'), async (req, res) => {
    const c = await loadCase(req);
    const p = await db(req).collection('patients').findOne({ _id: c.patientId }, { projection: { names: 1, mrn: 1, dob: 1, sexAtBirth: 1 } });
    const allergies = await db(req).collection('allergies').find({ patientId: c.patientId, status: 'active' }, { projection: { substance: 1, severity: 1 } }).toArray();
    res.json({
      data: {
        id: id(c),
        status: c.status,
        procedure: c.procedure,
        side: c.side,
        startsAt: c.startsAt,
        endsAt: c.endsAt,
        surgeon: { id: c.surgeonId.toHexString(), name: c.surgeonName },
        anesthetistId: c.anesthetistId?.toHexString() ?? null,
        patient: p ? { id: id(p), mrn: p.mrn, names: p.names, dob: p.dob, sexAtBirth: p.sexAtBirth ?? null } : null,
        allergies: allergies.map((x) => ({ substance: x.substance, severity: x.severity })),
        consent: c.consent ?? null,
        checklist: Object.fromEntries(PHASES.map((ph) => [ph, c.checklist?.[ph] ? { at: c.checklist[ph].at, byName: c.checklist[ph].byName } : null])),
        checklistItems: CHECKLIST,
        operativeNote: c.operativeNote ? { ...c.operativeNote, signedBy: undefined } : null,
        timeline: c.timeline,
        version: c.version,
      },
    });
  });

  r.post('/cases/:id/consent', need(deps, 'sx', 'S'), async (req, res) => {
    const body = parse(Consent, req.body);
    const c = await loadCase(req);
    if (!['Planned', 'Prepared'].includes(c.status)) throw Errors.conflict('INVALID_TRANSITION', 'Consent is recorded before the procedure');
    if (body.method === 'verbal-witnessed' && !body.witnessName) throw Errors.validation([{ path: 'witnessName', message: 'Verbal consent needs a witness' }]);
    const a = req.actor!;
    await db(req).collection('surgery_cases').updateOne({ _id: c._id }, { $set: { consent: { ...body, recordedBy: a.userId, recordedByName: a.name, at: new Date() } }, $inc: { version: 1 } });
    await audit(deps, req, { action: 'sx.consent', resource: `surgery:${id(c)}`, outcome: 'success', meta: { method: body.method } });
    res.json({ data: { id: id(c), consent: true } });
  });

  r.post('/cases/:id/checklist/:phase', need(deps, 'sx', 'E'), async (req, res) => {
    const phase = req.params.phase as Phase;
    if (!PHASES.includes(phase)) throw Errors.notFound('Checklist phase');
    const body = parse(Checklist, req.body);
    const c = await loadCase(req);
    if (c.checklist?.[phase]) throw Errors.conflict('CHECKLIST_DONE', `The ${phase} checklist is already complete`);
    const prev = PHASES[PHASES.indexOf(phase) - 1];
    if (prev && !c.checklist?.[prev]) throw new AppError(409, 'CHECKLIST_ORDER', `Complete ${prev} first`);
    const allowed: Record<Phase, string[]> = { 'sign-in': ['Planned', 'Prepared'], 'time-out': ['Prepared'], 'sign-out': ['InProcedure'] };
    if (!allowed[phase].includes(c.status)) throw new AppError(409, 'CHECKLIST_ORDER', `${phase} is done while the case is ${allowed[phase].join(' or ')}`);
    const missing = CHECKLIST[phase].filter((k) => body.items[k] !== true);
    if (missing.length) throw new AppError(409, 'CHECKLIST_INCOMPLETE', 'Every item must be confirmed', missing.map((k) => ({ path: k, message: 'Not confirmed' })));
    if (phase === 'sign-in' && !c.consent) throw new AppError(409, 'NO_CONSENT', 'Record consent before sign-in');
    const a = req.actor!;
    await db(req).collection('surgery_cases').updateOne({ _id: c._id }, { $set: { [`checklist.${phase}`]: { at: new Date(), by: a.userId, byName: a.name } }, $inc: { version: 1 } });
    await audit(deps, req, { action: `sx.checklist.${phase}`, resource: `surgery:${id(c)}`, outcome: 'success' });
    res.json({ data: { id: id(c), phase, complete: true } });
  });

  r.post('/cases/:id/operative-note', need(deps, 'sx', 'S'), async (req, res) => {
    const body = parse(OpNote, req.body);
    const c = await loadCase(req);
    if (!c.surgeonId.equals(req.actor!.userId)) throw Errors.forbidden('Only the operating surgeon signs the operative note');
    assertRecentMfa(deps, req);
    if (c.status !== 'InProcedure') throw Errors.conflict('INVALID_TRANSITION', 'Write the operative note while the case is in procedure');
    if (c.operativeNote) throw Errors.conflict('NOTE_SIGNED', 'The operative note is already signed');
    const a = req.actor!;
    await db(req).collection('surgery_cases').updateOne({ _id: c._id }, { $set: { operativeNote: { ...body, signedBy: a.userId, signedByName: a.name, signedAt: new Date() } }, $inc: { version: 1 } });
    await audit(deps, req, { action: 'sx.operative_note.sign', resource: `surgery:${id(c)}`, outcome: 'success' });
    res.json({ data: { id: id(c), signed: true } });
  });

  r.post('/cases/:id/advance', need(deps, 'sx', 'S'), async (req, res) => {
    const { to } = parse(Advance, req.body);
    const c = await loadCase(req);
    if (NEXT[c.status] !== to) throw Errors.conflict('INVALID_TRANSITION', `A ${c.status} case moves to ${NEXT[c.status] ?? 'nothing'}`);
    const gates: Record<string, [boolean, string][]> = {
      Prepared: [
        [Boolean(c.consent), 'Record consent'],
        [Boolean(c.checklist?.['sign-in']), 'Complete the sign-in checklist'],
      ],
      InProcedure: [[Boolean(c.checklist?.['time-out']), 'Complete the time-out checklist']],
      Recovery: [
        [Boolean(c.operativeNote), 'Sign the operative note'],
        [Boolean(c.checklist?.['sign-out']), 'Complete the sign-out checklist'],
      ],
      Completed: [],
    };
    const missing = gates[to]!.filter(([ok]) => !ok).map(([, m]) => ({ message: m }));
    if (missing.length) throw new AppError(409, 'SAFETY_GATE', 'This step is not safe yet', missing);
    const a = req.actor!;
    const set: Document = { status: to };
    if (to === 'InProcedure') set.startedAt = new Date();
    if (to === 'Recovery') set.endedAt = new Date();
    const upd = await db(req)
      .collection('surgery_cases')
      .updateOne({ _id: c._id, status: c.status }, { $set: set, $push: { timeline: { status: to, at: new Date(), by: a.userId } } as Document, $inc: { version: 1 } });
    if (!upd.modifiedCount) throw Errors.conflict('INVALID_TRANSITION', 'The case changed. Reload and try again');
    await audit(deps, req, { action: 'sx.case.advance', resource: `surgery:${id(c)}`, outcome: 'success', meta: { to } });
    res.json({ data: { id: id(c), status: to } });
  });

  r.post('/cases/:id/cancel', need(deps, 'sx', 'E'), async (req, res) => {
    const { reason } = parse(Cancel, req.body);
    const c = await loadCase(req);
    if (!['Planned', 'Prepared'].includes(c.status)) {
      if (!can(req.actor!.perms, 'sx', 'S')) await deny(deps, req, `surgery:${id(c)}`, 'only planned cases can be cancelled');
      throw Errors.conflict('INVALID_TRANSITION', 'A case that has started cannot be cancelled');
    }
    await db(req)
      .collection('surgery_cases')
      .updateOne({ _id: c._id }, { $set: { status: 'Cancelled', cancelReason: reason }, $push: { timeline: { status: 'Cancelled', at: new Date(), by: req.actor!.userId } } as Document, $inc: { version: 1 } });
    await audit(deps, req, { action: 'sx.case.cancel', resource: `surgery:${id(c)}`, outcome: 'success' });
    res.json({ data: { id: id(c), status: 'Cancelled' } });
  });

  return r;
}
