import { Router, type Request } from 'express';
import type { Document, ObjectId } from 'mongodb';
import { z } from 'zod';
import { can, isBranchBound } from '@fahan/policy';
import { nameKeys } from '@fahan/terminology';
import type { Deps } from '../../context';
import { AppError, Errors } from '../../lib/errors';
import { idParam, objectId, parse } from '../../lib/validate';
import { audit } from '../../middleware/audit';
import { assertBranch, deny, need } from '../../middleware/authorize';
import { requireRecentMfa } from '../../middleware/session';
import { loadPatient, maskPhone, normalizePhone, patientScopeFilter, publicPatient, type Patient } from './access';

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((s) => !Number.isNaN(Date.parse(s)) && s <= new Date().toISOString().slice(0, 10), 'Date of birth cannot be in the future');
const name = z.string().trim().min(1).max(80);
const Identifier = z.object({ system: z.enum(['national-id', 'passport', 'insurance', 'other']), value: z.string().trim().min(3).max(40) });
const Contact = z.object({ name, relation: z.string().trim().min(2).max(40), phone: z.string().trim().min(6).max(20) });
const Demographics = z.object({
  givenName: name,
  middleName: name.optional(),
  familyName: name,
  dob: isoDate,
  sexAtBirth: z.enum(['female', 'male', 'unknown']).optional(),
  phone: z.string().trim().min(6).max(20).optional(),
  identifiers: z.array(Identifier).max(5).default([]),
  contacts: z.array(Contact).max(5).default([]),
});
const CreatePatient = Demographics.extend({ branchId: objectId, confirmNotDuplicate: z.boolean().default(false) });
const UpdatePatient = Demographics.partial().extend({ version: z.number().int().positive() });
const Search = z.object({ q: z.string().trim().max(80).optional(), limit: z.coerce.number().int().min(1).max(100).default(25) });
const MergeBody = z.object({ survivorId: objectId, duplicateId: objectId, reason: z.string().trim().min(5).max(500) });
const MergeList = z.object({ status: z.enum(['Pending', 'Approved', 'Rejected', 'Reversed']).optional() });
const ConsentBody = z.object({
  type: z.enum(['treatment', 'data-sharing', 'telehealth', 'research', 'sms-reminders']),
  status: z.enum(['granted', 'withdrawn']),
  method: z.enum(['verbal', 'written', 'electronic']),
  note: z.string().trim().max(500).optional(),
});

/** Above this score a new registration is blocked until staff confirm it is a different person. */
const BLOCK_SCORE = 0.85;
const SHOW_SCORE = 0.6;

type DupInput = { keys: string[]; dob?: string; phone?: string; identifiers: { value: string }[] };

function score(input: DupInput, p: Document): number {
  const ids = new Set((p.identifiers ?? []).map((i: { value: string }) => i.value.toLowerCase()));
  if (input.identifiers.some((i) => ids.has(i.value.toLowerCase()))) return 1;
  const pk = new Set<string>(p.nameKeys ?? []);
  const inter = input.keys.filter((k) => pk.has(k)).length;
  const union = new Set([...input.keys, ...pk]).size || 1;
  let s = (inter / union) * 0.45;
  if (input.dob && input.dob === p.dob) s += 0.4;
  if (input.phone && input.phone === p.phone) s += 0.25;
  return Math.min(1, Math.round(s * 100) / 100);
}

/** Spec §4.1: deterministic + fuzzy candidate matching across the whole hospital (not just one branch). */
async function findDuplicates(req: Request, input: DupInput, excludeId?: ObjectId) {
  const a = req.actor!;
  const or: Document[] = [{ nameKeys: { $in: input.keys } }];
  if (input.phone) or.push({ phone: input.phone });
  if (input.dob) or.push({ dob: input.dob });
  if (input.identifiers.length) or.push({ 'identifiers.value': { $in: input.identifiers.map((i) => i.value) } });
  const cands = await a
    .db!.collection('patients')
    .find({ tenantId: a.tenantId, status: { $ne: 'Merged' }, ...(excludeId ? { _id: { $ne: excludeId } } : {}), $or: or })
    .limit(300)
    .toArray();
  const branches = await a.db!.collection('branches').find({ tenantId: a.tenantId }, { projection: { code: 1 } }).toArray();
  const code = (id: ObjectId) => branches.find((b) => b._id.equals(id))?.code ?? '?';
  return cands
    .map((p) => ({ p, s: score(input, p) }))
    .filter((x) => x.s >= SHOW_SCORE)
    .sort((x, y) => y.s - x.s)
    .slice(0, 5)
    .map(({ p, s }) => ({
      id: p._id.toHexString(),
      mrn: p.mrn,
      names: p.names,
      dob: p.dob,
      phone: maskPhone(p.phone),
      branches: (p.branchIds as ObjectId[]).map(code),
      score: s,
    }));
}

const dupInput = (b: { givenName: string; middleName?: string; familyName: string; dob?: string; phone?: string; identifiers?: { value: string }[] }): DupInput => ({
  keys: nameKeys(b.givenName, b.middleName, b.familyName),
  dob: b.dob,
  phone: normalizePhone(b.phone),
  identifiers: b.identifiers ?? [],
});

/** Spec §5.3 Registration & Master Patient Index. Provisional → Verified → Archived (+ Merged by link). */
export function patientRoutes(deps: Deps): Router {
  const r = Router();
  const col = (req: Request) => req.actor!.db!.collection('patients');

  r.get('/', need(deps, 'mpi', 'V'), async (req, res) => {
    const q = parse(Search, req.query);
    const a = req.actor!;
    const filter: Document = { tenantId: a.tenantId, status: { $ne: 'Merged' }, ...patientScopeFilter(req) };
    if (q.q) {
      const term = q.q;
      const digits = term.replace(/\D/g, '');
      if (/^[A-Z0-9]{2,12}-\d{2}-\d{6}$/i.test(term)) filter.mrn = term.toUpperCase();
      else if (digits.length >= 6 && digits.length === term.replace(/[\s+()-]/g, '').length) filter.phone = normalizePhone(term);
      else {
        const keys = nameKeys(term);
        if (!keys.length) return res.json({ data: [] });
        filter.nameKeys = { $all: keys };
      }
    }
    const list = await col(req).find(filter).sort({ createdAt: -1 }).limit(q.limit).toArray();
    res.json({ data: list.map(publicPatient) });
  });

  r.post('/duplicates', need(deps, 'mpi', 'E'), async (req, res) => {
    const b = parse(Demographics.partial({ dob: true, sexAtBirth: true, identifiers: true, contacts: true }), req.body);
    res.json({ data: await findDuplicates(req, dupInput(b)) });
  });

  r.post('/', need(deps, 'mpi', 'E'), async (req, res) => {
    const body = parse(CreatePatient, req.body);
    await assertBranch(deps, req, body.branchId);
    const a = req.actor!;
    const branch = await a.db!.collection('branches').findOne({ _id: body.branchId, tenantId: a.tenantId });
    if (!branch) throw Errors.notFound('Branch');

    const input = dupInput(body);
    const dups = await findDuplicates(req, input);
    const blocking = dups.filter((d) => d.score >= BLOCK_SCORE);
    if (blocking.length && !body.confirmNotDuplicate) {
      throw new AppError(409, 'POSSIBLE_DUPLICATE', 'This person may already be registered. Check the matches before creating a new record', [], {
        candidates: blocking,
      });
    }

    const yy = new Date().getUTCFullYear().toString().slice(2);
    const counter = await a
      .db!.collection<{ _id: string; seq: number }>('counters')
      .findOneAndUpdate({ _id: `mrn:${branch.code}:${yy}` }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
    const mrn = `${branch.code}-${yy}-${String(counter!.seq).padStart(6, '0')}`;
    const now = new Date();
    const doc = {
      tenantId: a.tenantId,
      branchIds: [body.branchId],
      mrn,
      names: { given: body.givenName, middle: body.middleName, family: body.familyName },
      nameKeys: input.keys,
      dob: body.dob,
      sexAtBirth: body.sexAtBirth,
      phone: input.phone,
      identifiers: body.identifiers,
      contacts: body.contacts,
      status: 'Provisional',
      careTeam: [] as ObjectId[],
      duplicateOverride: blocking.length ? { by: a.userId, at: now, candidates: blocking.map((d) => d.id) } : undefined,
      createdAt: now,
      createdBy: a.userId,
      version: 1,
    };
    const ins = await col(req).insertOne(doc);
    await audit(deps, req, {
      action: 'mpi.patient.create',
      resource: `patient:${ins.insertedId.toHexString()}`,
      outcome: 'success',
      meta: { mrn, duplicateOverride: blocking.length > 0 },
    });
    res.status(201).json({ data: publicPatient({ _id: ins.insertedId, ...doc }) });
  });

  // ---- merge requests (registered before /:id so the path is not read as an id) ----

  r.get('/merge-requests', need(deps, 'mpi', 'E'), async (req, res) => {
    const q = parse(MergeList, req.query);
    const a = req.actor!;
    const list = await a
      .db!.collection('merge_requests')
      .find({ tenantId: a.tenantId, ...(q.status ? { status: q.status } : {}) })
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray();
    const ids = list.flatMap((m) => [m.survivorId, m.duplicateId]);
    const pats = await col(req).find({ _id: { $in: ids } }).toArray();
    const brief = (id: ObjectId) => {
      const p = pats.find((x) => x._id.equals(id));
      return p ? { id: id.toHexString(), mrn: p.mrn, names: p.names, dob: p.dob, status: p.status } : null;
    };
    res.json({
      data: list.map((m) => ({
        id: m._id.toHexString(),
        status: m.status,
        reason: m.reason,
        survivor: brief(m.survivorId),
        duplicate: brief(m.duplicateId),
        requestedBy: m.requestedBy.toHexString(),
        createdAt: m.createdAt,
        decidedAt: m.decidedAt ?? null,
      })),
    });
  });

  r.post('/merge-requests', need(deps, 'mpi', 'E'), async (req, res) => {
    const b = parse(MergeBody, req.body);
    if (b.survivorId.equals(b.duplicateId)) throw Errors.validation([{ path: 'duplicateId', message: 'Choose two different records' }]);
    const [s, d] = [await loadPatient(deps, req, b.survivorId), await loadPatient(deps, req, b.duplicateId)];
    if (s.status === 'Merged' || d.status === 'Merged') throw Errors.conflict('ALREADY_MERGED', 'One of these records is already merged');
    const a = req.actor!;
    const doc = { tenantId: a.tenantId, survivorId: s._id, duplicateId: d._id, reason: b.reason, status: 'Pending', requestedBy: a.userId, createdAt: new Date() };
    const ins = await a.db!.collection('merge_requests').insertOne(doc);
    await audit(deps, req, { action: 'mpi.merge.request', resource: `merge_request:${ins.insertedId.toHexString()}`, outcome: 'success', meta: { survivor: s.mrn, duplicate: d.mrn } });
    res.status(201).json({ data: { id: ins.insertedId.toHexString(), status: 'Pending' } });
  });

  async function loadRequest(req: Request) {
    const a = req.actor!;
    const id = idParam(req.params.id, 'Merge request');
    const m = await a.db!.collection('merge_requests').findOne({ _id: id, tenantId: a.tenantId });
    if (!m) throw Errors.notFound('Merge request');
    return m;
  }

  r.post('/merge-requests/:id/approve', need(deps, 'mpi', 'A'), requireRecentMfa(deps), async (req, res) => {
    const m = await loadRequest(req);
    const a = req.actor!;
    if (m.status !== 'Pending') throw Errors.conflict('INVALID_TRANSITION', `Request is ${m.status.toLowerCase()}`);
    if (m.requestedBy.equals(a.userId)) {
      throw new AppError(403, 'FOUR_EYES', 'A merge must be approved by someone other than the person who requested it');
    }
    const pats = a.db!.collection('patients');
    const session = deps.data.client.startSession();
    try {
      await session.withTransaction(async () => {
        const s = await pats.findOne({ _id: m.survivorId, tenantId: a.tenantId }, { session });
        const d = await pats.findOne({ _id: m.duplicateId, tenantId: a.tenantId, status: { $ne: 'Merged' } }, { session });
        if (!s || !d || s.status === 'Merged') throw Errors.conflict('ALREADY_MERGED', 'One of these records changed. Reject this request and raise a new one');
        const has = (arr: ObjectId[] | undefined, id: ObjectId) => (arr ?? []).some((x) => x.equals(id));
        const addedBranches = (d.branchIds as ObjectId[]).filter((b) => !has(s.branchIds, b));
        const addedCare = ((d.careTeam as ObjectId[]) ?? []).filter((u) => !has(s.careTeam, u));
        await pats.updateOne(
          { _id: d._id },
          { $set: { status: 'Merged', mergedInto: s._id, statusBeforeMerge: d.status, updatedAt: new Date() }, $inc: { version: 1 } },
          { session },
        );
        await pats.updateOne(
          { _id: s._id },
          {
            $addToSet: { identifiers: { system: 'mrn-alias', value: d.mrn }, branchIds: { $each: addedBranches }, careTeam: { $each: addedCare } },
            $inc: { version: 1 },
          },
          { session },
        );
        await a.db!.collection('merge_requests').updateOne(
          { _id: m._id, status: 'Pending' },
          { $set: { status: 'Approved', decidedBy: a.userId, decidedAt: new Date(), added: { branchIds: addedBranches, careTeam: addedCare }, aliasMrn: d.mrn } },
          { session },
        );
      });
    } finally {
      await session.endSession();
    }
    await audit(deps, req, { action: 'mpi.merge.approve', resource: `merge_request:${m._id.toHexString()}`, outcome: 'success' });
    res.json({ data: { id: m._id.toHexString(), status: 'Approved' } });
  });

  r.post('/merge-requests/:id/reject', need(deps, 'mpi', 'A'), async (req, res) => {
    const m = await loadRequest(req);
    const a = req.actor!;
    const upd = await a.db!.collection('merge_requests').updateOne({ _id: m._id, status: 'Pending' }, { $set: { status: 'Rejected', decidedBy: a.userId, decidedAt: new Date() } });
    if (!upd.modifiedCount) throw Errors.conflict('INVALID_TRANSITION', `Request is ${m.status.toLowerCase()}`);
    await audit(deps, req, { action: 'mpi.merge.reject', resource: `merge_request:${m._id.toHexString()}`, outcome: 'success' });
    res.json({ data: { id: m._id.toHexString(), status: 'Rejected' } });
  });

  r.post('/merge-requests/:id/reverse', need(deps, 'mpi', 'A'), requireRecentMfa(deps), async (req, res) => {
    const m = await loadRequest(req);
    const a = req.actor!;
    if (m.status !== 'Approved') throw Errors.conflict('INVALID_TRANSITION', 'Only approved merges can be reversed');
    const pats = a.db!.collection('patients');
    const session = deps.data.client.startSession();
    try {
      await session.withTransaction(async () => {
        const d = await pats.findOne({ _id: m.duplicateId, mergedInto: m.survivorId }, { session });
        if (!d) throw Errors.conflict('MERGE_CHANGED', 'The duplicate record is no longer linked to this survivor');
        await pats.updateOne(
          { _id: d._id },
          { $set: { status: d.statusBeforeMerge ?? 'Provisional', updatedAt: new Date() }, $unset: { mergedInto: '', statusBeforeMerge: '' }, $inc: { version: 1 } },
          { session },
        );
        await pats.updateOne(
          { _id: m.survivorId },
          {
            $pull: {
              identifiers: { system: 'mrn-alias', value: m.aliasMrn },
              branchIds: { $in: m.added?.branchIds ?? [] },
              careTeam: { $in: m.added?.careTeam ?? [] },
            } as Document,
            $inc: { version: 1 },
          },
          { session },
        );
        await a.db!.collection('merge_requests').updateOne({ _id: m._id }, { $set: { status: 'Reversed', reversedBy: a.userId, reversedAt: new Date() } }, { session });
      });
    } finally {
      await session.endSession();
    }
    await audit(deps, req, { action: 'mpi.merge.reverse', resource: `merge_request:${m._id.toHexString()}`, outcome: 'success' });
    res.json({ data: { id: m._id.toHexString(), status: 'Reversed' } });
  });

  // ---- single patient ----

  r.get('/:id', need(deps, 'mpi', 'V'), async (req, res) => {
    const p = await loadPatient(deps, req, idParam(req.params.id, 'Patient'));
    res.json({ data: publicPatient(p) });
  });

  r.patch('/:id', need(deps, 'mpi', 'E'), async (req, res) => {
    const body = parse(UpdatePatient, req.body);
    const p = await loadPatient(deps, req, idParam(req.params.id, 'Patient'));
    if (p.status === 'Merged') throw Errors.conflict('PATIENT_MERGED', 'This record was merged. Edit the surviving record instead');
    const names = {
      given: body.givenName ?? p.names.given,
      middle: body.middleName ?? p.names.middle,
      family: body.familyName ?? p.names.family,
    };
    const set: Document = {
      names,
      nameKeys: nameKeys(names.given, names.middle, names.family),
      updatedAt: new Date(),
      updatedBy: req.actor!.userId,
    };
    for (const k of ['dob', 'sexAtBirth', 'identifiers', 'contacts'] as const) if (body[k] !== undefined) set[k] = body[k];
    if (body.phone !== undefined) set.phone = normalizePhone(body.phone);
    const upd = await col(req).findOneAndUpdate({ _id: p._id, version: body.version }, { $set: set, $inc: { version: 1 } }, { returnDocument: 'after' });
    if (!upd) throw Errors.conflict('VERSION_CONFLICT', 'This record was changed by someone else. Reload and try again');
    await audit(deps, req, { action: 'mpi.patient.update', resource: `patient:${p._id.toHexString()}`, outcome: 'success', meta: { fields: Object.keys(body).filter((k) => k !== 'version').join(',') } });
    res.json({ data: publicPatient(upd) });
  });

  r.post('/:id/verify', need(deps, 'mpi', 'E'), async (req, res) => {
    const p = await loadPatient(deps, req, idParam(req.params.id, 'Patient'));
    const upd = await col(req).findOneAndUpdate(
      { _id: p._id, status: 'Provisional' },
      { $set: { status: 'Verified', verifiedBy: req.actor!.userId, verifiedAt: new Date() }, $inc: { version: 1 } },
      { returnDocument: 'after' },
    );
    if (!upd) throw Errors.conflict('INVALID_TRANSITION', `Patient is ${String(p.status).toLowerCase()}`);
    await audit(deps, req, { action: 'mpi.patient.verify', resource: `patient:${p._id.toHexString()}`, outcome: 'success' });
    res.json({ data: publicPatient(upd) });
  });

  /** A patient registered at another branch of the same hospital starts being seen here. */
  r.post('/:id/link-branch', need(deps, 'mpi', 'E'), async (req, res) => {
    const a = req.actor!;
    const id = idParam(req.params.id, 'Patient');
    if (!isBranchBound(a.scope) || !a.branchId) throw Errors.validation([{ message: 'Only branch staff link records to their branch' }]);
    const upd = await col(req).findOneAndUpdate(
      { _id: id, tenantId: a.tenantId, status: { $ne: 'Merged' } },
      { $addToSet: { branchIds: a.branchId }, $inc: { version: 1 } },
      { returnDocument: 'after' },
    );
    if (!upd) throw Errors.notFound('Patient');
    await audit(deps, req, { action: 'mpi.patient.link_branch', resource: `patient:${id.toHexString()}`, outcome: 'success' });
    res.json({ data: publicPatient(upd) });
  });

  r.get('/:id/consents', need(deps, 'mpi', 'V'), async (req, res) => {
    const p = await loadPatient(deps, req, idParam(req.params.id, 'Patient'));
    const list = await req.actor!.db!.collection('consents').find({ tenantId: req.actor!.tenantId, patientId: p._id }).sort({ recordedAt: -1 }).toArray();
    res.json({ data: list.map(({ _id, tenantId, patientId, recordedBy, ...c }) => ({ id: _id.toHexString(), ...c, recordedBy: recordedBy.toHexString() })) });
  });

  /** Spec §4.1: consent is recorded as an append-only history; the latest entry per type wins. */
  r.post('/:id/consents', async (req, res) => {
    const perms = req.actor!.perms;
    if (!can(perms, 'mpi', 'E') && !can(perms, 'opd', 'E')) await deny(deps, req, 'consents', 'requires mpi:E or opd:E');
    const body = parse(ConsentBody, req.body);
    const p = await loadPatient(deps, req, idParam(req.params.id, 'Patient'));
    const doc = { tenantId: req.actor!.tenantId, patientId: p._id, ...body, recordedBy: req.actor!.userId, recordedAt: new Date() };
    const ins = await req.actor!.db!.collection('consents').insertOne(doc);
    await audit(deps, req, { action: `consent.${body.status}`, resource: `patient:${p._id.toHexString()}`, outcome: 'success', meta: { type: body.type } });
    res.status(201).json({ data: { id: ins.insertedId.toHexString(), ...body, recordedAt: doc.recordedAt } });
  });

  return r;
}

export type { Patient };
