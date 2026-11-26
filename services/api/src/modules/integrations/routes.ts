import { Router, type Request } from 'express';
import type { Document, ObjectId } from 'mongodb';
import { z } from 'zod';
import type { Deps } from '../../context';
import { newToken, sha256 } from '../../lib/crypto';
import { Errors } from '../../lib/errors';
import { idParam, objectId, parse } from '../../lib/validate';
import { audit } from '../../middleware/audit';
import { need } from '../../middleware/authorize';
import { assertRecentMfa } from '../../middleware/session';
import * as M from '../fhir/map';
import { RESOURCE_TYPES, scopeAllows } from '../fhir/routes';
import { validateResource } from '../fhir/validate';

/**
 * Spec §5.34 integrations & developer API, lifecycle Configured → Tested → Enabled → Suspended (§12.2):
 * credentials are shown once and stored hashed; a client can be enabled only after its conformance run passes.
 */
const Scope = z.string().refine((s) => s === 'system/*.read' || RESOURCE_TYPES.some((t) => s === `system/${t}.read`), 'Use system/<Type>.read or system/*.read');
const NewClient = z.object({ name: z.string().trim().min(3).max(80), scopes: z.array(Scope).min(1).max(12), branchIds: z.array(objectId).max(20).default([]) });
const id = (x: Document) => (x._id as ObjectId).toHexString();

export function integrationRoutes(deps: Deps): Router {
  const r = Router();
  const db = (req: Request) => req.actor!.db!;
  const col = (req: Request) => db(req).collection('api_clients');

  const view = (c: Document) => ({
    id: id(c),
    clientId: c.clientId,
    name: c.name,
    scopes: c.scopes,
    branchIds: ((c.branchIds as ObjectId[]) ?? []).map((b) => b.toHexString()),
    status: c.status,
    testReport: c.testReport ?? null,
    lastTokenAt: c.lastTokenAt ?? null,
    history: ((c.history as Document[]) ?? []).map((h) => ({ at: h.at, action: h.action, byName: h.byName, note: h.note ?? null })),
  });
  const push = (req: Request, action: string, note?: string) => ({ history: { at: new Date(), action, by: req.actor!.userId, byName: req.actor!.name, note } });

  async function load(req: Request) {
    const c = await col(req).findOne({ _id: idParam(req.params.id, 'Client'), tenantId: req.actor!.tenantId });
    if (!c) throw Errors.notFound('API client');
    return c;
  }

  /** Branch names for limiting a client; integration engineers do not otherwise read organisation settings. */
  r.get('/branches', need(deps, 'intg', 'V'), async (req, res) => {
    const list = await db(req).collection('branches').find({ tenantId: req.actor!.tenantId }, { projection: { code: 1, name: 1 } }).sort({ code: 1 }).toArray();
    res.json({ data: list.map((b) => ({ id: id(b), code: b.code, name: b.name })) });
  });

  r.get('/clients', need(deps, 'intg', 'V'), async (req, res) => {
    const list = await col(req).find({ tenantId: req.actor!.tenantId }).sort({ name: 1 }).toArray();
    res.json({ data: list.map(view) });
  });

  r.post('/clients', need(deps, 'intg', 'A'), async (req, res) => {
    const body = parse(NewClient, req.body);
    assertRecentMfa(deps, req);
    const a = req.actor!;
    if (body.branchIds.length && (await db(req).collection('branches').countDocuments({ tenantId: a.tenantId, _id: { $in: body.branchIds } })) !== body.branchIds.length) throw Errors.validation([{ path: 'branchIds', message: 'Unknown branch' }]);
    const clientId = `fc_${newToken(18)}`;
    const secret = newToken(32);
    const doc = { tenantId: a.tenantId, clientId, secretHash: sha256(secret), ...body, status: 'Configured', createdBy: a.userId, createdAt: new Date(), history: [push(req, 'configured').history] };
    const ins = await col(req).insertOne(doc);
    await audit(deps, req, { action: 'intg.client.create', resource: `api_client:${clientId}`, outcome: 'success', meta: { scopes: body.scopes.join(' ') } });
    res.status(201).json({ data: { ...view({ _id: ins.insertedId, ...doc }), clientSecret: secret } });
  });

  /** Conformance run on this hospital's own data, for exactly what the client may read (spec §12.2). */
  r.post('/clients/:id/test', need(deps, 'intg', 'A'), async (req, res) => {
    const c = await load(req);
    if (!['Configured', 'Tested', 'Suspended'].includes(c.status)) throw Errors.conflict('INVALID_TRANSITION', `Client is ${String(c.status).toLowerCase()}`);
    const t = { tenantId: req.actor!.tenantId };
    const slug = req.actor!.tenantSlug ?? 'hospital';
    const sample = 25;
    const built: Record<string, Record<string, unknown>[]> = {
      Patient: (await db(req).collection('patients').find(t).limit(sample).toArray()).map((p) => M.patient(p, slug)),
      Encounter: (await db(req).collection('encounters').find(t).limit(sample).toArray()).map(M.encounter),
      Condition: (await db(req).collection('diagnoses').find(t).limit(sample).toArray()).map(M.condition),
      Observation: [...(await db(req).collection('observations').find(t).limit(sample).toArray()).map(M.vitalObservation), ...(await db(req).collection('lab_orders').find({ ...t, status: 'Released' }).limit(sample).toArray()).flatMap(M.labObservations)],
      DiagnosticReport: [...(await db(req).collection('lab_orders').find({ ...t, status: 'Released' }).limit(sample).toArray()).map(M.labReport), ...(await db(req).collection('imaging_orders').find({ ...t, status: 'Final' }).limit(sample).toArray()).map(M.imagingReport)],
      ServiceRequest: (await db(req).collection('lab_orders').find(t).limit(sample).toArray()).map((o) => M.serviceRequest(o, 'lab')),
      MedicationRequest: (await db(req).collection('prescriptions').find({ ...t, status: { $ne: 'Draft' } }).limit(sample).toArray()).map(M.medicationRequest),
      Appointment: (await db(req).collection('appointments').find(t).limit(sample).toArray()).map(M.appointment),
      Practitioner: (await db(req).collection('users').find(t).limit(sample).toArray()).map(M.practitioner),
    };
    let checked = 0;
    const errors: string[] = [];
    for (const type of RESOURCE_TYPES) {
      if (!scopeAllows(c.scopes as string[], type)) continue;
      for (const resource of built[type] ?? []) {
        checked++;
        errors.push(...validateResource(resource).map((e) => `${type}/${String(resource.id)}: ${e}`));
      }
    }
    const passed = errors.length === 0 && checked > 0;
    const report = { at: new Date(), checked, passed, errors: errors.slice(0, 50) };
    await col(req).updateOne({ _id: c._id }, { $set: { testReport: report, ...(passed && c.status === 'Configured' ? { status: 'Tested' } : {}) }, $push: push(req, passed ? 'conformance-passed' : 'conformance-failed', `${checked} resources`) as Document });
    await audit(deps, req, { action: 'intg.client.test', resource: `api_client:${c.clientId}`, outcome: passed ? 'success' : 'failure', meta: { checked, errors: errors.length } });
    res.json({ data: { status: passed && c.status === 'Configured' ? 'Tested' : c.status, ...report } });
  });

  r.post('/clients/:id/enable', need(deps, 'intg', 'A'), async (req, res) => {
    const c = await load(req);
    assertRecentMfa(deps, req);
    if (!c.testReport?.passed) throw Errors.conflict('NOT_TESTED', 'Run the conformance test before enabling this client');
    const upd = await col(req).updateOne({ _id: c._id, status: { $in: ['Tested', 'Suspended'] } }, { $set: { status: 'Enabled', enabledAt: new Date() }, $push: push(req, 'enabled') as Document });
    if (!upd.modifiedCount) throw Errors.conflict('INVALID_TRANSITION', `Client is ${String(c.status).toLowerCase()}`);
    await audit(deps, req, { action: 'intg.client.enable', resource: `api_client:${c.clientId}`, outcome: 'success' });
    res.json({ data: { id: id(c), status: 'Enabled' } });
  });

  r.post('/clients/:id/suspend', need(deps, 'intg', 'A'), async (req, res) => {
    const { reason } = parse(z.object({ reason: z.string().trim().min(5).max(300) }), req.body);
    const c = await load(req);
    await col(req).updateOne({ _id: c._id }, { $set: { status: 'Suspended' }, $push: push(req, 'suspended', reason) as Document });
    const revoked = (await db(req).collection('api_tokens').deleteMany({ clientId: c.clientId })).deletedCount;
    await audit(deps, req, { action: 'intg.client.suspend', resource: `api_client:${c.clientId}`, outcome: 'success', meta: { revokedTokens: revoked } });
    res.json({ data: { id: id(c), status: 'Suspended', revokedTokens: revoked } });
  });

  r.post('/clients/:id/rotate', need(deps, 'intg', 'A'), async (req, res) => {
    const c = await load(req);
    assertRecentMfa(deps, req);
    const secret = newToken(32);
    await col(req).updateOne({ _id: c._id }, { $set: { secretHash: sha256(secret) }, $push: push(req, 'secret-rotated') as Document });
    await db(req).collection('api_tokens').deleteMany({ clientId: c.clientId });
    await audit(deps, req, { action: 'intg.client.rotate', resource: `api_client:${c.clientId}`, outcome: 'success' });
    res.json({ data: { id: id(c), clientSecret: secret } });
  });

  return r;
}
