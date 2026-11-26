import { Router, type Request } from 'express';
import type { Document, ObjectId, WithId } from 'mongodb';
import { z } from 'zod';
import { can } from '@fahan/policy';
import type { Deps } from '../../context';
import { AppError, Errors } from '../../lib/errors';
import { localDate } from '../../lib/time';
import { idParam, objectId, parse } from '../../lib/validate';
import { audit } from '../../middleware/audit';
import { deny, need } from '../../middleware/authorize';

/**
 * Spec §5.28 Quality, infection control & incidents.
 *  - Any member of staff can report an incident; reports are confidential to quality roles (and to the reporter).
 *  - Incidents move Reported → Triaged → Investigating → Closed, every step kept in the history.
 *  - Infection cases move Suspected → Confirmed / RuledOut → Closed and feed the infection-rate trend.
 */
export const CATEGORIES = ['fall', 'medication', 'procedure', 'infection', 'equipment', 'patient-identification', 'pressure-injury', 'documentation', 'behaviour', 'other'] as const;
export const SEVERITIES = ['near-miss', 'no-harm', 'minor', 'moderate', 'severe', 'death'] as const;
export const SITES = ['bloodstream', 'urinary', 'surgical-site', 'respiratory', 'skin', 'gastro-intestinal', 'other'] as const;
const PORTAL_ROLES = ['patient', 'caregiver', 'referring-provider'];

const NewIncident = z.object({
  category: z.enum(CATEGORIES),
  severity: z.enum(SEVERITIES),
  occurredAt: z.coerce.date(),
  location: z.string().trim().min(2).max(120),
  description: z.string().trim().min(10).max(2_000),
  immediateAction: z.string().trim().max(1_000).optional(),
  patientMrn: z.string().trim().max(40).optional(),
});
const Triage = z.object({
  severity: z.enum(SEVERITIES),
  category: z.enum(CATEGORIES),
  investigatorId: objectId.optional(),
  note: z.string().trim().max(1_000).optional(),
});
const Note = z.object({ note: z.string().trim().min(3).max(2_000) });
const Action = z.object({ text: z.string().trim().min(3).max(500), owner: z.string().trim().min(2).max(120), dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
const Close = z.object({ rootCause: z.string().trim().min(3).max(2_000), outcome: z.string().trim().min(3).max(2_000) });

const NewIpc = z.object({
  patientMrn: z.string().trim().min(3).max(40),
  organism: z.string().trim().min(2).max(120),
  site: z.enum(SITES),
  onsetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  hospitalAcquired: z.boolean(),
  isolation: z.enum(['none', 'contact', 'droplet', 'airborne']),
  ward: z.string().trim().max(60).optional(),
  note: z.string().trim().max(1_000).optional(),
});
const IpcStep = z.object({ note: z.string().trim().min(3).max(1_000) });

const id = (x: { _id: ObjectId }) => x._id.toHexString();

export function qualityRoutes(deps: Deps): Router {
  const r = Router();
  const db = (req: Request) => req.actor!.db!;
  const zone = 'Africa/Mogadishu';
  const step = (req: Request, action: string, note?: string) => ({ at: new Date(), action, by: req.actor!.userId, byName: req.actor!.name, note: note ?? null });

  function staffOnly(req: Request) {
    if (req.actor!.roles.every((x) => PORTAL_ROLES.includes(x))) throw Errors.forbidden('Incident reporting is for hospital staff');
  }

  async function nextNumber(req: Request, prefix: string): Promise<string> {
    const yy = localDate(deps.config.now(), zone).slice(2, 4);
    const c = await db(req)
      .collection<{ _id: string; seq: number }>('counters')
      .findOneAndUpdate({ _id: `${prefix}:${yy}` }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
    return `${prefix}-${yy}-${String(c!.seq).padStart(5, '0')}`;
  }

  /** Reporters see their own reports; quality roles see all. Names of reporters are only shown to quality leads. */
  function incidentView(x: WithId<Document>, req: Request) {
    const a = req.actor!;
    const lead = can(a.perms, 'qual', 'A');
    const team = can(a.perms, 'qual', 'E');
    const own = (x.reportedBy as ObjectId).equals(a.userId);
    return {
      id: id(x),
      number: x.number,
      category: x.category,
      severity: x.severity,
      serious: x.serious,
      status: x.status,
      occurredAt: x.occurredAt,
      reportedAt: x.reportedAt,
      location: x.location,
      description: team || own ? x.description : null,
      immediateAction: team || own ? (x.immediateAction ?? null) : null,
      patient: team ? (x.patient ?? null) : null,
      reporter: lead || own ? x.reportedByName : null,
      investigator: x.investigatorName ?? null,
      rootCause: team || own ? (x.rootCause ?? null) : null,
      outcome: x.outcome ?? null,
      actions: team ? (x.actions ?? []) : [],
      history: team ? (x.history ?? []).map((h: Document) => ({ at: h.at, action: h.action, byName: h.byName, note: h.note })) : [],
      closedAt: x.closedAt ?? null,
    };
  }

  async function incident(req: Request) {
    const x = await db(req).collection('quality_incidents').findOne({ _id: idParam(req.params.id, 'Incident'), tenantId: req.actor!.tenantId });
    if (!x) throw Errors.notFound('Incident');
    return x;
  }

  // ---- incidents ----
  r.post('/incidents', async (req, res) => {
    staffOnly(req);
    const body = parse(NewIncident, req.body);
    const a = req.actor!;
    if (body.occurredAt.getTime() > deps.config.now().getTime() + 5 * 60_000) throw Errors.validation([{ path: 'occurredAt', message: 'An incident cannot be in the future' }]);
    let patient: Document | undefined;
    if (body.patientMrn) {
      const p = await db(req).collection('patients').findOne({ tenantId: a.tenantId, mrn: body.patientMrn.toUpperCase() }, { projection: { mrn: 1, names: 1 } });
      if (!p) throw Errors.validation([{ path: 'patientMrn', message: 'No patient has this MRN' }]);
      patient = { id: p._id.toHexString(), mrn: p.mrn, name: [p.names?.given, p.names?.middle, p.names?.family].filter(Boolean).join(' ') };
    }
    const number = await nextNumber(req, 'INC');
    const serious = body.severity === 'severe' || body.severity === 'death';
    const doc = {
      tenantId: a.tenantId,
      branchId: a.branchId ?? null,
      number,
      category: body.category,
      severity: body.severity,
      serious,
      occurredAt: body.occurredAt,
      location: body.location,
      description: body.description,
      immediateAction: body.immediateAction,
      patient,
      status: 'Reported',
      reportedBy: a.userId,
      reportedByName: a.name,
      reportedAt: new Date(),
      actions: [],
      history: [step(req, 'reported')],
    };
    const ins = await db(req).collection('quality_incidents').insertOne(doc);
    await audit(deps, req, { action: 'qual.incident.report', resource: `incident:${ins.insertedId.toHexString()}`, outcome: 'success', meta: { category: body.category, severity: body.severity } });
    res.status(201).json({ data: { id: ins.insertedId.toHexString(), number, status: 'Reported', serious } });
  });

  r.get('/incidents/mine', async (req, res) => {
    const list = await db(req).collection('quality_incidents').find({ tenantId: req.actor!.tenantId, reportedBy: req.actor!.userId }).sort({ reportedAt: -1 }).limit(100).toArray();
    res.json({ data: list.map((x) => incidentView(x, req)) });
  });

  r.get('/incidents', need(deps, 'qual', 'V'), async (req, res) => {
    const q = parse(z.object({ status: z.enum(['open', 'closed', 'all']).default('open') }), req.query);
    const f: Document = { tenantId: req.actor!.tenantId };
    if (q.status === 'open') f.status = { $ne: 'Closed' };
    if (q.status === 'closed') f.status = 'Closed';
    const list = await db(req).collection('quality_incidents').find(f).sort({ serious: -1, reportedAt: -1 }).limit(300).toArray();
    res.json({ data: list.map((x) => incidentView(x, req)) });
  });

  r.get('/incidents/:id', async (req, res) => {
    const x = await incident(req);
    const a = req.actor!;
    if (!can(a.perms, 'qual', 'V') && !(x.reportedBy as ObjectId).equals(a.userId)) await deny(deps, req, `incident:${id(x)}`, 'incidents are confidential');
    res.json({ data: incidentView(x, req) });
  });

  /** Staff who can be named as investigator (names only). */
  r.get('/staff', need(deps, 'qual', 'E'), async (req, res) => {
    const list = await db(req)
      .collection('users')
      .find({ tenantId: req.actor!.tenantId, status: 'Active', roles: { $nin: PORTAL_ROLES } }, { projection: { name: 1 } })
      .sort({ name: 1 })
      .limit(1000)
      .toArray();
    res.json({ data: list.map((u) => ({ id: id(u), name: u.name })) });
  });

  r.post('/incidents/:id/triage', need(deps, 'qual', 'E'), async (req, res) => {
    const body = parse(Triage, req.body);
    const x = await incident(req);
    let investigatorName: string | undefined;
    if (body.investigatorId) {
      const u = await db(req).collection('users').findOne({ _id: body.investigatorId, tenantId: req.actor!.tenantId, status: 'Active' });
      if (!u) throw Errors.validation([{ path: 'investigatorId', message: 'Choose an active member of staff' }]);
      investigatorName = u.name as string;
    }
    const upd = await db(req)
      .collection('quality_incidents')
      .updateOne(
        { _id: x._id, status: 'Reported' },
        {
          $set: { status: 'Triaged', severity: body.severity, category: body.category, serious: body.severity === 'severe' || body.severity === 'death', investigatorId: body.investigatorId, investigatorName, triagedAt: new Date() },
          $push: { history: step(req, 'triaged', body.note) } as Document,
        },
      );
    if (!upd.modifiedCount) throw Errors.conflict('INVALID_TRANSITION', `Incident is ${String(x.status).toLowerCase()}`);
    await audit(deps, req, { action: 'qual.incident.triage', resource: `incident:${id(x)}`, outcome: 'success', meta: { severity: body.severity } });
    res.json({ data: { id: id(x), status: 'Triaged' } });
  });

  r.post('/incidents/:id/investigate', need(deps, 'qual', 'E'), async (req, res) => {
    const { note } = parse(Note, req.body);
    const x = await incident(req);
    const upd = await db(req)
      .collection('quality_incidents')
      .updateOne({ _id: x._id, status: { $in: ['Triaged', 'Investigating'] } }, { $set: { status: 'Investigating' }, $push: { history: step(req, 'finding', note) } as Document });
    if (!upd.modifiedCount) throw Errors.conflict('INVALID_TRANSITION', 'Triage the incident first');
    await audit(deps, req, { action: 'qual.incident.finding', resource: `incident:${id(x)}`, outcome: 'success' });
    res.json({ data: { id: id(x), status: 'Investigating' } });
  });

  r.post('/incidents/:id/actions', need(deps, 'qual', 'E'), async (req, res) => {
    const body = parse(Action, req.body);
    const x = await incident(req);
    if (x.status === 'Closed') throw Errors.conflict('INCIDENT_CLOSED', 'This incident is closed');
    await db(req)
      .collection('quality_incidents')
      .updateOne({ _id: x._id }, { $push: { actions: { ...body, addedAt: new Date(), addedByName: req.actor!.name }, history: step(req, 'action-added', body.text) } as Document });
    await audit(deps, req, { action: 'qual.incident.action', resource: `incident:${id(x)}`, outcome: 'success' });
    res.status(201).json({ data: { id: id(x) } });
  });

  /** A quality lead closes with the root cause and outcome. Serious incidents need at least one corrective action. */
  r.post('/incidents/:id/close', need(deps, 'qual', 'A'), async (req, res) => {
    const body = parse(Close, req.body);
    const x = await incident(req);
    if (x.status !== 'Investigating') throw Errors.conflict('INVALID_TRANSITION', 'Only an incident under investigation can be closed');
    if (x.serious && !(x.actions as unknown[] | undefined)?.length) throw new AppError(409, 'ACTION_REQUIRED', 'A serious incident needs at least one corrective action before it is closed');
    if ((x.reportedBy as ObjectId).equals(req.actor!.userId)) throw new AppError(403, 'FOUR_EYES', 'The person who reported an incident cannot close it');
    await db(req)
      .collection('quality_incidents')
      .updateOne({ _id: x._id, status: 'Investigating' }, { $set: { status: 'Closed', rootCause: body.rootCause, outcome: body.outcome, closedAt: new Date(), closedBy: req.actor!.userId }, $push: { history: step(req, 'closed') } as Document });
    await audit(deps, req, { action: 'qual.incident.close', resource: `incident:${id(x)}`, outcome: 'success' });
    res.json({ data: { id: id(x), status: 'Closed' } });
  });

  // ---- infection prevention & control ----
  function ipcView(x: WithId<Document>, req: Request) {
    const team = can(req.actor!.perms, 'qual', 'E');
    return {
      id: id(x),
      number: x.number,
      patient: team ? x.patient : null,
      organism: x.organism,
      site: x.site,
      onsetDate: x.onsetDate,
      hospitalAcquired: x.hospitalAcquired,
      isolation: x.isolation,
      ward: x.ward ?? null,
      status: x.status,
      history: team ? (x.history ?? []).map((h: Document) => ({ at: h.at, action: h.action, byName: h.byName, note: h.note })) : [],
    };
  }

  r.get('/ipc', need(deps, 'qual', 'V'), async (req, res) => {
    const q = parse(z.object({ status: z.enum(['open', 'all']).default('open') }), req.query);
    const f: Document = { tenantId: req.actor!.tenantId };
    if (q.status === 'open') f.status = { $in: ['Suspected', 'Confirmed'] };
    const list = await db(req).collection('ipc_cases').find(f).sort({ onsetDate: -1 }).limit(300).toArray();
    res.json({ data: list.map((x) => ipcView(x, req)) });
  });

  r.post('/ipc', need(deps, 'qual', 'E'), async (req, res) => {
    const body = parse(NewIpc, req.body);
    const a = req.actor!;
    const p = await db(req).collection('patients').findOne({ tenantId: a.tenantId, mrn: body.patientMrn.toUpperCase() }, { projection: { mrn: 1, names: 1 } });
    if (!p) throw Errors.validation([{ path: 'patientMrn', message: 'No patient has this MRN' }]);
    if (body.onsetDate > localDate(deps.config.now(), zone)) throw Errors.validation([{ path: 'onsetDate', message: 'Onset cannot be in the future' }]);
    const number = await nextNumber(req, 'IPC');
    const { patientMrn: _mrn, note, ...rest } = body;
    const patientId = p._id;
    const ins = await db(req)
      .collection('ipc_cases')
      .insertOne({
        tenantId: a.tenantId,
        number,
        patientId,
        patient: { id: patientId.toHexString(), mrn: p.mrn, name: [p.names?.given, p.names?.middle, p.names?.family].filter(Boolean).join(' ') },
        ...rest,
        status: 'Suspected',
        createdAt: new Date(),
        createdBy: a.userId,
        history: [step(req, 'suspected', note)],
      });
    await audit(deps, req, { action: 'qual.ipc.create', resource: `ipc:${ins.insertedId.toHexString()}`, outcome: 'success', meta: { site: body.site, hai: body.hospitalAcquired } });
    res.status(201).json({ data: { id: ins.insertedId.toHexString(), number, status: 'Suspected' } });
  });

  for (const [path, from, to] of [
    ['confirm', ['Suspected'], 'Confirmed'],
    ['rule-out', ['Suspected'], 'RuledOut'],
    ['close', ['Confirmed'], 'Closed'],
  ] as const) {
    r.post(`/ipc/:id/${path}`, need(deps, 'qual', 'E'), async (req, res) => {
      const { note } = parse(IpcStep, req.body);
      const x = await db(req).collection('ipc_cases').findOne({ _id: idParam(req.params.id, 'Case'), tenantId: req.actor!.tenantId });
      if (!x) throw Errors.notFound('Case');
      const upd = await db(req)
        .collection('ipc_cases')
        .updateOne({ _id: x._id, status: { $in: [...from] } }, { $set: { status: to, [`${path}At`]: new Date() }, $push: { history: step(req, path, note) } as Document });
      if (!upd.modifiedCount) throw Errors.conflict('INVALID_TRANSITION', `Case is ${String(x.status).toLowerCase()}`);
      await audit(deps, req, { action: `qual.ipc.${path}`, resource: `ipc:${id(x)}`, outcome: 'success' });
      res.json({ data: { id: id(x), status: to } });
    });
  }

  // ---- dashboard ----
  /** Spec §9.5 quality section: aggregated counts only, no patient detail. */
  r.get('/summary', need(deps, 'qual', 'V'), async (req, res) => {
    const q = parse(z.object({ months: z.coerce.number().int().min(1).max(24).default(6) }), req.query);
    const a = req.actor!;
    const now = deps.config.now();
    const today = localDate(now, zone);
    const months: string[] = [];
    for (let i = q.months - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1 - i, 1));
      months.push(d.toISOString().slice(0, 7));
    }
    const since = new Date(`${months[0]}-01T00:00:00Z`);
    const inc = await db(req).collection('quality_incidents').find({ tenantId: a.tenantId, reportedAt: { $gte: since } }, { projection: { category: 1, severity: 1, status: 1, reportedAt: 1, closedAt: 1 } }).toArray();
    const ipc = await db(req).collection('ipc_cases').find({ tenantId: a.tenantId, onsetDate: { $gte: `${months[0]}-01` } }, { projection: { site: 1, status: 1, onsetDate: 1, hospitalAcquired: 1 } }).toArray();
    const crit = await db(req).collection('lab_orders').find({ tenantId: a.tenantId, critical: { $ne: null }, 'critical.raisedAt': { $gte: since } }, { projection: { critical: 1 } }).toArray();
    const month = (d: Date | string) => localDate(new Date(d), zone).slice(0, 7);
    const closed = inc.filter((x) => x.closedAt);
    const ackMinutes = crit.filter((c) => c.critical?.acknowledgedAt && c.critical?.raisedAt).map((c) => (new Date(c.critical.acknowledgedAt).getTime() - new Date(c.critical.raisedAt).getTime()) / 60_000);
    const median = (xs: number[]) => {
      if (!xs.length) return null;
      const s = [...xs].sort((x, y) => x - y);
      return Math.round(s[Math.floor(s.length / 2)]!);
    };
    res.json({
      data: {
        months,
        incidents: {
          open: inc.filter((x) => x.status !== 'Closed').length,
          serious: inc.filter((x) => x.severity === 'severe' || x.severity === 'death').length,
          byMonth: months.map((m) => inc.filter((x) => month(x.reportedAt) === m).length),
          byCategory: Object.fromEntries(CATEGORIES.map((c) => [c, inc.filter((x) => x.category === c).length]).filter(([, n]) => n)),
          bySeverity: Object.fromEntries(SEVERITIES.map((s) => [s, inc.filter((x) => x.severity === s).length])),
          medianDaysToClose: median(closed.map((x) => (new Date(x.closedAt).getTime() - new Date(x.reportedAt).getTime()) / 86_400_000)),
        },
        infections: {
          open: ipc.filter((x) => x.status === 'Suspected' || x.status === 'Confirmed').length,
          haiByMonth: months.map((m) => ipc.filter((x) => x.hospitalAcquired && x.status !== 'RuledOut' && String(x.onsetDate).slice(0, 7) === m).length),
          bySite: Object.fromEntries(SITES.map((s) => [s, ipc.filter((x) => x.site === s && x.status !== 'RuledOut').length]).filter(([, n]) => n)),
        },
        criticalResults: {
          raised: crit.length,
          acknowledged: ackMinutes.length,
          medianMinutesToAcknowledge: median(ackMinutes),
        },
      },
    });
  });

  return r;
}
