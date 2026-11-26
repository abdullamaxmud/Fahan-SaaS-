import { Router, type Request } from 'express';
import type { Document, ObjectId } from 'mongodb';
import { z } from 'zod';
import { MODULES, can, type Level, type ModuleKey } from '@fahan/policy';
import type { Deps } from '../../context';
import { AppError, Errors } from '../../lib/errors';
import { idParam, objectId, parse } from '../../lib/validate';
import { audit } from '../../middleware/audit';
import { deny, need } from '../../middleware/authorize';
import { assertRecentMfa } from '../../middleware/session';
import { loadPatient } from '../patients/access';

/**
 * Spec §5.33 no-code forms & workflow studio: Draft → Tested → Approved → Published → Retired.
 * Forms are data, never code: a fixed set of field types and rule types, validated on the server. Every submission
 * keeps the version it was made on, so old submissions are always read with their own fields.
 */
const RESERVED = new Set(['__proto__', 'constructor', 'prototype', 'tostring', 'valueof', 'hasownproperty', '_id', 'id']);
const moduleKeys = MODULES.map((m) => m.key) as [ModuleKey, ...ModuleKey[]];
const fieldKey = z
  .string()
  .regex(/^[a-z][a-z0-9_]{1,39}$/, 'Use lower-case letters, digits and _')
  .refine((k) => !RESERVED.has(k), 'That name is reserved');
const Field = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), key: fieldKey, label: z.string().trim().min(1).max(120), labelSo: z.string().trim().max(120).optional(), required: z.boolean().default(false), maxLength: z.number().int().min(1).max(2000).default(200) }),
  z.object({ type: z.literal('longtext'), key: fieldKey, label: z.string().trim().min(1).max(120), labelSo: z.string().trim().max(120).optional(), required: z.boolean().default(false), maxLength: z.number().int().min(1).max(10000).default(2000) }),
  z.object({ type: z.literal('number'), key: fieldKey, label: z.string().trim().min(1).max(120), labelSo: z.string().trim().max(120).optional(), required: z.boolean().default(false), min: z.number().optional(), max: z.number().optional(), integer: z.boolean().default(false) }),
  z.object({ type: z.literal('date'), key: fieldKey, label: z.string().trim().min(1).max(120), labelSo: z.string().trim().max(120).optional(), required: z.boolean().default(false) }),
  z.object({ type: z.literal('checkbox'), key: fieldKey, label: z.string().trim().min(1).max(120), labelSo: z.string().trim().max(120).optional(), required: z.boolean().default(false) }),
  z.object({ type: z.literal('select'), key: fieldKey, label: z.string().trim().min(1).max(120), labelSo: z.string().trim().max(120).optional(), required: z.boolean().default(false), options: z.array(z.string().trim().min(1).max(60)).min(2).max(30) }),
]);
type FieldDef = z.infer<typeof Field>;
const Definition = z
  .object({
    name: z.string().trim().min(3).max(120),
    module: z.enum(moduleKeys),
    highRisk: z.boolean().default(false),
    fields: z.array(Field).min(1).max(60),
    approval: z.object({ module: z.enum(moduleKeys), level: z.enum(['E', 'S', 'A']) }).nullable().default(null),
  })
  .superRefine((d, ctx) => {
    const seen = new Set<string>();
    d.fields.forEach((f, i) => {
      if (seen.has(f.key)) ctx.addIssue({ code: 'custom', path: ['fields', i, 'key'], message: `Field ${f.key} appears twice` });
      seen.add(f.key);
      if (f.type === 'number' && f.min !== undefined && f.max !== undefined && f.min > f.max) ctx.addIssue({ code: 'custom', path: ['fields', i, 'min'], message: 'Minimum is above maximum' });
      if (f.type === 'select' && new Set(f.options).size !== f.options.length) ctx.addIssue({ code: 'custom', path: ['fields', i, 'options'], message: 'Options repeat' });
    });
  });
const NewForm = Definition.and(z.object({ key: z.string().regex(/^[a-z][a-z0-9-]{2,39}$/, 'Use lower-case letters, digits and -') }));

/** Validates a submission against one version's fields. Unknown keys are refused; nothing is evaluated. */
export function validateData(fields: FieldDef[], data: Record<string, unknown>): { clean: Record<string, unknown>; errors: { path: string; message: string }[] } {
  const errors: { path: string; message: string }[] = [];
  const clean: Record<string, unknown> = {};
  for (const k of Object.keys(data)) if (!fields.some((f) => f.key === k)) errors.push({ path: k, message: 'This field is not on the form' });
  for (const f of fields) {
    const v = Object.prototype.hasOwnProperty.call(data, f.key) ? data[f.key] : undefined;
    const empty = v === undefined || v === null || v === '' || (f.type === 'checkbox' && v === false && f.required);
    if (empty) {
      if (f.required) errors.push({ path: f.key, message: f.type === 'checkbox' ? `${f.label} must be confirmed` : `${f.label} is required` });
      continue;
    }
    switch (f.type) {
      case 'text':
      case 'longtext':
        if (typeof v !== 'string') errors.push({ path: f.key, message: `${f.label} must be text` });
        else if (v.length > f.maxLength) errors.push({ path: f.key, message: `${f.label} is longer than ${f.maxLength} characters` });
        else clean[f.key] = v.trim();
        break;
      case 'number':
        if (typeof v !== 'number' || !Number.isFinite(v)) errors.push({ path: f.key, message: `${f.label} must be a number` });
        else if (f.integer && !Number.isInteger(v)) errors.push({ path: f.key, message: `${f.label} must be a whole number` });
        else if (f.min !== undefined && v < f.min) errors.push({ path: f.key, message: `${f.label} must be at least ${f.min}` });
        else if (f.max !== undefined && v > f.max) errors.push({ path: f.key, message: `${f.label} must be at most ${f.max}` });
        else clean[f.key] = v;
        break;
      case 'date':
        if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) errors.push({ path: f.key, message: `${f.label} must be a date (YYYY-MM-DD)` });
        else clean[f.key] = v;
        break;
      case 'checkbox':
        if (typeof v !== 'boolean') errors.push({ path: f.key, message: `${f.label} must be yes or no` });
        else clean[f.key] = v;
        break;
      case 'select':
        if (typeof v !== 'string' || !f.options.includes(v)) errors.push({ path: f.key, message: `${f.label} must be one of: ${f.options.join(', ')}` });
        else clean[f.key] = v;
        break;
    }
  }
  return { clean, errors };
}

const id = (x: Document) => (x._id as ObjectId).toHexString();

export function studioRoutes(deps: Deps): Router {
  const r = Router();
  const db = (req: Request) => req.actor!.db!;
  const col = (req: Request) => db(req).collection('form_definitions');

  const view = (f: Document) => ({
    id: id(f),
    key: f.key,
    version: f.version,
    name: f.name,
    module: f.module,
    highRisk: f.highRisk,
    fields: f.fields,
    approval: f.approval,
    status: f.status,
    safetySignoff: f.safetySignoff ? { byName: f.safetySignoff.byName, at: f.safetySignoff.at } : null,
    history: (f.history as Document[]).map((h) => ({ at: h.at, action: h.action, byName: h.byName, note: h.note ?? null })),
  });

  async function load(req: Request) {
    const f = await col(req).findOne({ _id: idParam(req.params.id, 'Form'), tenantId: req.actor!.tenantId });
    if (!f) throw Errors.notFound('Form');
    return f;
  }
  const push = (req: Request, action: string, note?: string) => ({ history: { at: new Date(), action, by: req.actor!.userId, byName: req.actor!.name, note } });

  // ---- designing ----
  r.get('/forms', need(deps, 'studio', 'V'), async (req, res) => {
    const list = await col(req).find({ tenantId: req.actor!.tenantId }).sort({ key: 1, version: -1 }).toArray();
    res.json({ data: list.map(view) });
  });

  r.get('/forms/:id', need(deps, 'studio', 'V'), async (req, res) => {
    res.json({ data: view(await load(req)) });
  });

  r.post('/forms', need(deps, 'studio', 'E'), async (req, res) => {
    const body = parse(NewForm, req.body);
    const a = req.actor!;
    try {
      const doc = { tenantId: a.tenantId, ...body, version: 1, status: 'Draft', createdBy: a.userId, createdAt: new Date(), ...{ history: [push(req, 'created').history] } };
      const ins = await col(req).insertOne(doc);
      await audit(deps, req, { action: 'studio.form.create', resource: `form:${body.key}`, outcome: 'success', meta: { version: 1 } });
      res.status(201).json({ data: view({ _id: ins.insertedId, ...doc }) });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw Errors.conflict('FORM_EXISTS', `A form called ${body.key} already exists; add a new version instead`);
      throw e;
    }
  });

  r.put('/forms/:id', need(deps, 'studio', 'E'), async (req, res) => {
    const body = parse(Definition, req.body);
    const f = await load(req);
    // Any change after testing sends the form back to Draft: what is approved is exactly what was tested.
    const upd = await col(req).updateOne({ _id: f._id, status: { $in: ['Draft', 'Tested'] } }, { $set: { ...body, status: 'Draft', safetySignoff: null }, $push: push(req, 'edited') as Document });
    if (!upd.modifiedCount) throw Errors.conflict('NOT_EDITABLE', 'Approved and published versions are not edited; add a new version');
    res.json({ data: view({ ...f, ...body, status: 'Draft' }) });
  });

  r.post('/forms/:id/test', need(deps, 'studio', 'E'), async (req, res) => {
    const { sample } = parse(z.object({ sample: z.record(z.string(), z.unknown()) }), req.body);
    const f = await load(req);
    if (!['Draft', 'Tested'].includes(f.status)) throw Errors.conflict('INVALID_TRANSITION', `Form is ${String(f.status).toLowerCase()}`);
    const { errors } = validateData(f.fields, sample);
    if (errors.length) throw new AppError(400, 'VALIDATION_FAILED', 'The sample does not pass the form', errors);
    await col(req).updateOne({ _id: f._id, status: f.status }, { $set: { status: 'Tested', testedAt: new Date() }, $push: push(req, 'tested') as Document });
    res.json({ data: { id: id(f), status: 'Tested' } });
  });

  /** High-risk (clinical) forms need the clinical safety officer before approval. */
  r.post('/forms/:id/safety-signoff', need(deps, 'qual', 'A'), async (req, res) => {
    const { note } = parse(z.object({ note: z.string().trim().max(500).optional() }), req.body);
    if (!can(req.actor!.perms, 'studio', 'V')) await deny(deps, req, 'studio', 'safety sign-off needs studio access');
    const f = await load(req);
    if (!f.highRisk) throw Errors.conflict('NOT_HIGH_RISK', 'This form does not need a safety sign-off');
    if (f.status !== 'Tested') throw Errors.conflict('INVALID_TRANSITION', 'Safety sign-off is given on a tested form');
    await col(req).updateOne({ _id: f._id, status: 'Tested' }, { $set: { safetySignoff: { by: req.actor!.userId, byName: req.actor!.name, at: new Date() } }, $push: push(req, 'safety-signed', note) as Document });
    await audit(deps, req, { action: 'studio.form.safety_signoff', resource: `form:${f.key}`, outcome: 'success', meta: { version: f.version as number } });
    res.json({ data: { id: id(f), safetySigned: true } });
  });

  r.post('/forms/:id/approve', need(deps, 'studio', 'A'), async (req, res) => {
    const f = await load(req);
    const a = req.actor!;
    if (f.createdBy.equals(a.userId)) throw new AppError(403, 'FOUR_EYES', 'Someone other than the designer approves the form');
    if (f.status !== 'Tested') throw Errors.conflict('INVALID_TRANSITION', 'Test the form before approving it');
    if (f.highRisk && !f.safetySignoff) throw Errors.conflict('SAFETY_SIGNOFF_REQUIRED', 'The clinical safety officer signs off high-risk forms first');
    await col(req).updateOne({ _id: f._id, status: 'Tested' }, { $set: { status: 'Approved', approvedBy: a.userId }, $push: push(req, 'approved') as Document });
    await audit(deps, req, { action: 'studio.form.approve', resource: `form:${f.key}`, outcome: 'success', meta: { version: f.version as number } });
    res.json({ data: { id: id(f), status: 'Approved' } });
  });

  /** Publishing makes this version current; the previous one retires. Publishing a retired version rolls back. */
  r.post('/forms/:id/publish', need(deps, 'studio', 'A'), async (req, res) => {
    const f = await load(req);
    assertRecentMfa(deps, req);
    if (!['Approved', 'Retired'].includes(f.status)) throw Errors.conflict('INVALID_TRANSITION', 'Only approved (or previously published) versions are published');
    if (f.status === 'Retired' && !f.publishedAt) throw Errors.conflict('INVALID_TRANSITION', 'This version was never published');
    const s = deps.data.client.startSession();
    try {
      await s.withTransaction(async () => {
        await col(req).updateMany({ tenantId: f.tenantId, key: f.key, status: 'Published' }, { $set: { status: 'Retired', retiredAt: new Date() }, $push: push(req, 'retired') as Document }, { session: s });
        await col(req).updateOne({ _id: f._id }, { $set: { status: 'Published', publishedAt: f.publishedAt ?? new Date() }, $push: push(req, f.status === 'Retired' ? 'republished' : 'published') as Document }, { session: s });
      });
    } finally {
      await s.endSession();
    }
    await audit(deps, req, { action: f.status === 'Retired' ? 'studio.form.rollback' : 'studio.form.publish', resource: `form:${f.key}`, outcome: 'success', meta: { version: f.version as number } });
    res.json({ data: { id: id(f), status: 'Published', version: f.version } });
  });

  r.post('/forms/:id/versions', need(deps, 'studio', 'E'), async (req, res) => {
    const f = await load(req);
    const a = req.actor!;
    const latest = await col(req).findOne({ tenantId: a.tenantId, key: f.key }, { sort: { version: -1 } });
    if (latest!.status === 'Draft' || latest!.status === 'Tested') throw Errors.conflict('DRAFT_EXISTS', `Version ${latest!.version} is still being designed`);
    const doc = { tenantId: a.tenantId, key: f.key, name: latest!.name, module: latest!.module, highRisk: latest!.highRisk, fields: latest!.fields, approval: latest!.approval, version: (latest!.version as number) + 1, status: 'Draft', createdBy: a.userId, createdAt: new Date(), history: [push(req, `created from version ${latest!.version}`).history] };
    const ins = await col(req).insertOne(doc);
    res.status(201).json({ data: view({ _id: ins.insertedId, ...doc }) });
  });

  // ---- using published forms ----
  async function current(req: Request, key: string) {
    const f = await col(req).findOne({ tenantId: req.actor!.tenantId, key, status: 'Published' });
    if (!f) throw Errors.notFound('Published form');
    return f;
  }

  r.get('/published', async (req, res) => {
    const list = await col(req).find({ tenantId: req.actor!.tenantId, status: 'Published' }).sort({ name: 1 }).toArray();
    res.json({ data: list.filter((f) => can(req.actor!.perms, f.module, 'E')).map(view) });
  });

  r.post('/forms/by-key/:key/submissions', async (req, res) => {
    const body = parse(z.object({ patientId: objectId.optional(), data: z.record(z.string(), z.unknown()) }), req.body);
    const f = await current(req, String(req.params.key));
    const a = req.actor!;
    if (!can(a.perms, f.module, 'E')) await deny(deps, req, `form:${f.key}`, `submitting needs ${f.module}:E`);
    if (body.patientId) await loadPatient(deps, req, body.patientId, { clinical: true });
    const { clean, errors } = validateData(f.fields, body.data);
    if (errors.length) throw new AppError(400, 'VALIDATION_FAILED', 'Some answers are not valid', errors);
    const status = f.approval ? 'Pending' : 'Recorded';
    const ins = await db(req).collection('form_submissions').insertOne({ tenantId: a.tenantId, formId: f._id, formKey: f.key, formVersion: f.version, patientId: body.patientId, data: clean, status, submittedBy: a.userId, submittedByName: a.name, submittedAt: new Date() });
    await audit(deps, req, { action: 'studio.submission.create', resource: `form:${f.key}`, outcome: 'success', meta: { version: f.version as number, status } });
    res.status(201).json({ data: { id: ins.insertedId.toHexString(), formVersion: f.version, status } });
  });

  /** Historical submissions are shown with the fields of the version they were made on. */
  r.get('/forms/by-key/:key/submissions', async (req, res) => {
    const key = String(req.params.key);
    const versions = await col(req).find({ tenantId: req.actor!.tenantId, key }).toArray();
    if (!versions.length) throw Errors.notFound('Form');
    const mod = versions.find((v) => v.status === 'Published')?.module ?? versions[0]!.module;
    if (!can(req.actor!.perms, mod, 'V')) await deny(deps, req, `form:${key}`, `reading needs ${mod}:V`);
    const subs = await db(req).collection('form_submissions').find({ tenantId: req.actor!.tenantId, formKey: key }).sort({ submittedAt: -1 }).limit(300).toArray();
    res.json({
      data: subs.map((s) => {
        const v = versions.find((x) => x.version === s.formVersion)!;
        return { id: id(s), formVersion: s.formVersion, status: s.status, submittedByName: s.submittedByName, submittedAt: s.submittedAt, answers: (v.fields as FieldDef[]).filter((fd) => fd.key in s.data).map((fd) => ({ key: fd.key, label: fd.label, value: s.data[fd.key] })) };
      }),
    });
  });

  r.post('/submissions/:id/decide', async (req, res) => {
    const body = parse(z.object({ decision: z.enum(['approve', 'reject']), note: z.string().trim().max(500).optional() }), req.body);
    const s = await db(req).collection('form_submissions').findOne({ _id: idParam(req.params.id, 'Submission'), tenantId: req.actor!.tenantId });
    if (!s) throw Errors.notFound('Submission');
    const f = await col(req).findOne({ _id: s.formId });
    const rule = f!.approval as { module: ModuleKey; level: Level } | null;
    if (!rule) throw Errors.conflict('NO_APPROVAL_RULE', 'This form does not need approval');
    const a = req.actor!;
    if (!can(a.perms, rule.module, rule.level)) await deny(deps, req, `submission:${id(s)}`, `approval needs ${rule.module}:${rule.level}`);
    if ((s.submittedBy as ObjectId).equals(a.userId)) throw new AppError(403, 'FOUR_EYES', 'Someone else approves your submission');
    const status = body.decision === 'approve' ? 'Approved' : 'Rejected';
    const upd = await db(req).collection('form_submissions').updateOne({ _id: s._id, status: 'Pending' }, { $set: { status, decidedBy: a.userId, decidedByName: a.name, decidedAt: new Date(), decisionNote: body.note } });
    if (!upd.modifiedCount) throw Errors.conflict('INVALID_TRANSITION', 'Already decided');
    await audit(deps, req, { action: `studio.submission.${body.decision}`, resource: `submission:${id(s)}`, outcome: 'success' });
    res.json({ data: { id: id(s), status } });
  });

  return r;
}
