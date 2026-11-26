import { timingSafeEqual } from 'node:crypto';
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { ObjectId, type Db, type Document } from 'mongodb';
import { writeAudit } from '../../audit/audit';
import type { Deps } from '../../context';
import { newToken, sha256 } from '../../lib/crypto';
import * as M from './map';

/**
 * FHIR R4 read-only facade (spec §12.1, §5.34): /api/v1/fhir/<hospital>/... Outside the cookie session and CSRF guard;
 * callers are registered API clients using OAuth2 client credentials and short-lived bearer tokens with SMART-style
 * system scopes (system/Patient.read, system/*.read). Every read is audited under the client's identity.
 */
export const RESOURCE_TYPES = ['Patient', 'Encounter', 'Condition', 'Observation', 'DiagnosticReport', 'ServiceRequest', 'MedicationRequest', 'Appointment', 'Practitioner'] as const;
export type FhirType = (typeof RESOURCE_TYPES)[number];
export const TOKEN_TTL_SECONDS = 900;
const MAX_COUNT = 200;
const CLINICAL_ROLES = /physician|surgeon|anesthetist|obstetrician|nurse|midwife|radiologist|pathologist|pharmacist|er-|ward-|clinician/;

interface FhirCtx {
  db: Db;
  tenantId: ObjectId;
  slug: string;
  client: Document;
  scopes: string[];
  base: string;
}
declare module 'express-serve-static-core' {
  interface Request {
    fhir?: FhirCtx;
  }
}

const fhirJson = (res: Response, status: number, body: unknown) => res.status(status).type('application/fhir+json').send(JSON.stringify(body));
const outcome = (res: Response, status: number, code: string, msg: string) => fhirJson(res, status, M.operationOutcome(code, msg));
const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
export const scopeAllows = (scopes: string[], type: string) => scopes.includes(`system/${type}.read`) || scopes.includes('system/*.read');

export function fhirRoutes(deps: Deps): Router {
  const r = Router({ mergeParams: true });
  r.use(express.urlencoded({ extended: false, limit: '8kb' }));

  /** Resolves the hospital from the URL; unknown hospitals look exactly like unknown resources. */
  async function tenantOf(req: Request) {
    const slug = String(req.params.tenant ?? '');
    if (!/^[a-z0-9-]{3,40}$/.test(slug)) return null;
    const t = await deps.data.control().collection('tenants').findOne({ slug, status: 'Active' });
    return t ? { t, db: deps.data.tenant(t.dbName as string), slug } : null;
  }
  const baseOf = (req: Request, slug: string) => `${req.protocol}://${req.get('host')}/api/v1/fhir/${slug}`;
  const log = (db: Db, tenantId: ObjectId, req: Request, clientId: string | null, action: string, outcomeStr: 'success' | 'deny' | 'failure', meta: Record<string, string | number | boolean | null>) =>
    writeAudit(db, { tenantId: tenantId.toHexString(), actorId: null, actorRoles: [`api-client:${clientId ?? 'unknown'}`], action, resource: `fhir:${req.path}`, outcome: outcomeStr, correlationId: req.correlationId, meta });

  // ---- discovery: no token needed ----
  r.get('/metadata', async (req, res) => {
    const tt = await tenantOf(req);
    if (!tt) return outcome(res, 404, 'not-found', 'Unknown endpoint');
    fhirJson(res, 200, {
      resourceType: 'CapabilityStatement',
      status: 'active',
      date: '2026-11-26',
      kind: 'instance',
      fhirVersion: M.FHIR_VERSION,
      format: ['application/fhir+json'],
      implementation: { description: `Fahan FHIR facade for ${tt.t.name}`, url: baseOf(req, tt.slug) },
      rest: [
        {
          mode: 'server',
          security: { service: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/restful-security-service', code: 'SMART-on-FHIR' }] }], description: 'OAuth2 client credentials at ./auth/token; system/<Type>.read scopes; tokens last 15 minutes.' },
          resource: RESOURCE_TYPES.map((type) => ({ type, interaction: [{ code: 'read' }, { code: 'search-type' }], searchParam: type === 'Patient' ? [{ name: 'identifier', type: 'token' }, { name: 'name', type: 'string' }, { name: 'birthdate', type: 'date' }] : type === 'Practitioner' ? [] : [{ name: 'patient', type: 'reference' }] })),
        },
      ],
    });
  });

  // ---- OAuth2 client credentials ----
  r.post('/auth/token', async (req, res) => {
    const tt = await tenantOf(req);
    const err = (status: number, error: string, desc: string) => res.status(status).json({ error, error_description: desc });
    if (!tt) return err(401, 'invalid_client', 'Unknown client');
    const b = (req.body ?? {}) as Record<string, string>;
    // Basic auth or body credentials (RFC 6749 §2.3.1).
    let id = b.client_id;
    let secret = b.client_secret;
    const auth = req.get('authorization');
    if (auth?.startsWith('Basic ')) [id, secret] = Buffer.from(auth.slice(6), 'base64').toString('utf8').split(':') as [string, string];
    if (b.grant_type !== 'client_credentials') return err(400, 'unsupported_grant_type', 'Only client_credentials is supported');
    const client = typeof id === 'string' && /^fc_[A-Za-z0-9_-]{8,64}$/.test(id) ? await tt.db.collection('api_clients').findOne({ tenantId: tt.t._id, clientId: id }) : null;
    if (!client || typeof secret !== 'string' || !sameSecret(sha256(secret), client.secretHash as string) || client.status !== 'Enabled') {
      await log(tt.db, tt.t._id, req, typeof id === 'string' ? id.slice(0, 70) : null, 'fhir.token', 'deny', { reason: !client ? 'unknown client' : client.status !== 'Enabled' ? `client ${String(client.status).toLowerCase()}` : 'bad secret' });
      return err(401, 'invalid_client', 'Client authentication failed');
    }
    const asked = typeof b.scope === 'string' && b.scope.trim() ? b.scope.trim().split(/\s+/) : (client.scopes as string[]);
    const granted = asked.filter((s) => (client.scopes as string[]).includes(s));
    if (!granted.length) return err(400, 'invalid_scope', 'None of the requested scopes is allowed for this client');
    const token = newToken(32);
    const expiresAt = new Date(Date.now() + TOKEN_TTL_SECONDS * 1000);
    await tt.db.collection('api_tokens').insertOne({ tenantId: tt.t._id, tokenHash: sha256(token), clientId: client.clientId, scopes: granted, expiresAt, issuedAt: new Date() });
    await tt.db.collection('api_clients').updateOne({ _id: client._id }, { $set: { lastTokenAt: new Date() } });
    await log(tt.db, tt.t._id, req, client.clientId, 'fhir.token', 'success', { scopes: granted.join(' ') });
    res.setHeader('cache-control', 'no-store');
    res.json({ access_token: token, token_type: 'Bearer', expires_in: TOKEN_TTL_SECONDS, scope: granted.join(' ') });
  });

  // ---- everything else needs a bearer token ----
  r.use(async (req: Request, res: Response, next: NextFunction) => {
    const tt = await tenantOf(req);
    if (!tt) return outcome(res, 404, 'not-found', 'Unknown endpoint');
    const h = req.get('authorization');
    const tok = h?.startsWith('Bearer ') ? h.slice(7).trim() : '';
    const t = tok ? await tt.db.collection('api_tokens').findOne({ tokenHash: sha256(tok), tenantId: tt.t._id, expiresAt: { $gt: new Date() } }) : null;
    const client = t ? await tt.db.collection('api_clients').findOne({ tenantId: tt.t._id, clientId: t.clientId, status: 'Enabled' }) : null;
    if (!t || !client) {
      await log(tt.db, tt.t._id, req, (t?.clientId as string) ?? null, 'fhir.read', 'deny', { reason: !t ? 'missing or expired token' : 'client not enabled' });
      res.setHeader('www-authenticate', 'Bearer error="invalid_token"');
      return outcome(res, 401, 'login', 'A valid bearer token is required');
    }
    req.fhir = { db: tt.db, tenantId: tt.t._id, slug: tt.slug, client, scopes: t.scopes as string[], base: baseOf(req, tt.slug) };
    next();
  });

  const branchFilter = (c: FhirCtx, field = 'branchId') => ((c.client.branchIds as ObjectId[] | undefined)?.length ? { [field]: { $in: c.client.branchIds } } : {});

  /** Loads the patient if the client may see it (branch scope); null otherwise. */
  async function patientFor(c: FhirCtx, id: string) {
    if (!ObjectId.isValid(id) || !/^[a-f0-9]{24}$/i.test(id)) return null;
    return c.db.collection('patients').findOne({ _id: new ObjectId(id), tenantId: c.tenantId, ...branchFilter(c, 'branchIds') });
  }
  const patientParam = (q: unknown) => String(q ?? '').replace(/^Patient\//, '');

  type Built = Record<string, unknown> & { id: string; resourceType: string };
  /** Builds the resources for one type, either by id or by search. */
  async function find(c: FhirCtx, type: FhirType, q: Record<string, unknown>, id?: string): Promise<Built[] | 'bad-request'> {
    const t = { tenantId: c.tenantId };
    const byId = id ? (ObjectId.isValid(id.split('-')[0]!) ? { _id: new ObjectId(id.split('-')[0]!) } : null) : {};
    if (byId === null) return [];
    const limit = Math.min(Number(q._count ?? 50) || 50, MAX_COUNT);
    // Every clinical search is by patient (no bulk export here), and the patient must be in the client's scope.
    let pid: ObjectId | undefined;
    if (!id && type !== 'Patient' && type !== 'Practitioner') {
      const p = await patientFor(c, patientParam(q.patient ?? q.subject));
      if (!p) return 'bad-request';
      pid = p._id;
    }
    const byPatient = pid ? { patientId: pid } : {};
    const scoped = async (docs: Document[]) => {
      if (!id || type === 'Patient' || type === 'Practitioner') return docs;
      const ok: Document[] = [];
      for (const d of docs) if (await patientFor(c, (d.patientId as ObjectId).toHexString())) ok.push(d);
      return ok;
    };
    switch (type) {
      case 'Patient': {
        const f: Document = { ...t, ...byId, ...branchFilter(c, 'branchIds') };
        if (!id) {
          if (typeof q.identifier === 'string') f.mrn = q.identifier.split('|').pop();
          if (typeof q.birthdate === 'string') f.dob = q.birthdate;
          if (typeof q.name === 'string' && q.name.trim()) f.$or = [{ 'names.given': new RegExp(`^${escape(q.name.trim())}`, 'i') }, { 'names.family': new RegExp(`^${escape(q.name.trim())}`, 'i') }];
          if (!q.identifier && !q.birthdate && !q.name) return 'bad-request';
        }
        return (await c.db.collection('patients').find(f).limit(limit).toArray()).map((p) => M.patient(p, c.slug));
      }
      case 'Encounter':
        return (await scoped(await c.db.collection('encounters').find({ ...t, ...byId, ...byPatient }).sort({ startedAt: -1 }).limit(limit).toArray())).map(M.encounter);
      case 'Condition':
        return (await scoped(await c.db.collection('diagnoses').find({ ...t, ...byId, ...byPatient }).sort({ recordedAt: -1 }).limit(limit).toArray())).map(M.condition);
      case 'Observation': {
        const out: Built[] = [];
        const cat = q.category ? String(q.category).split('|').pop() : undefined;
        if (!cat || cat === 'vital-signs') {
          const obs = await scoped(await c.db.collection('observations').find({ ...t, ...byId, ...byPatient }).sort({ effectiveAt: -1 }).limit(limit).toArray());
          out.push(...obs.map(M.vitalObservation));
        }
        if (!cat || cat === 'laboratory') {
          // Only released results leave the hospital, as only released results reach clinicians.
          const labs = await scoped(await c.db.collection('lab_orders').find({ ...t, ...byId, ...byPatient, status: 'Released' }).sort({ releasedAt: -1 }).limit(limit).toArray());
          out.push(...labs.flatMap(M.labObservations));
        }
        return id ? out.filter((x) => x.id === id) : out.slice(0, limit);
      }
      case 'DiagnosticReport': {
        const labs = await scoped(await c.db.collection('lab_orders').find({ ...t, ...byId, ...byPatient, status: 'Released' }).limit(limit).toArray());
        const rad = await scoped(await c.db.collection('imaging_orders').find({ ...t, ...byId, ...byPatient, status: 'Final' }).limit(limit).toArray());
        const dx = await scoped(await c.db.collection('diagnostic_orders').find({ ...t, ...byId, ...byPatient, status: 'Final' }).limit(limit).toArray());
        return [...labs.map(M.labReport), ...rad.map(M.imagingReport), ...dx.map(M.imagingReport)].slice(0, limit);
      }
      case 'ServiceRequest': {
        const labs = await scoped(await c.db.collection('lab_orders').find({ ...t, ...byId, ...byPatient }).limit(limit).toArray());
        const rad = await scoped(await c.db.collection('imaging_orders').find({ ...t, ...byId, ...byPatient }).limit(limit).toArray());
        return [...labs.map((o) => M.serviceRequest(o, 'lab')), ...rad.map((o) => M.serviceRequest(o, 'imaging'))].slice(0, limit);
      }
      case 'MedicationRequest':
        return (await scoped(await c.db.collection('prescriptions').find({ ...t, ...byId, ...byPatient, status: { $ne: 'Draft' } }).limit(limit).toArray())).map(M.medicationRequest);
      case 'Appointment':
        return (await scoped(await c.db.collection('appointments').find({ ...t, ...byId, ...byPatient }).sort({ startsAt: -1 }).limit(limit).toArray())).map(M.appointment);
      case 'Practitioner': {
        if (!id) return 'bad-request';
        const u = await c.db.collection('users').findOne({ ...t, ...byId });
        return u && (u.roles as string[]).some((x) => CLINICAL_ROLES.test(x)) ? [M.practitioner(u)] : [];
      }
    }
  }

  const typed = (type: string): type is FhirType => (RESOURCE_TYPES as readonly string[]).includes(type);

  r.get('/:type/:id', async (req, res) => {
    const c = req.fhir!;
    const type = String(req.params.type);
    if (!typed(type)) return outcome(res, 404, 'not-supported', `${type} is not served here`);
    if (!scopeAllows(c.scopes, type)) {
      await log(c.db, c.tenantId, req, c.client.clientId, 'fhir.read', 'deny', { type, reason: 'scope' });
      return outcome(res, 403, 'forbidden', `This token does not allow reading ${type}`);
    }
    const found = await find(c, type, {}, String(req.params.id));
    const hit = found === 'bad-request' ? undefined : found.find((x) => x.id === req.params.id);
    await log(c.db, c.tenantId, req, c.client.clientId, 'fhir.read', 'success', { type, found: Boolean(hit) });
    if (!hit) return outcome(res, 404, 'not-found', `${type}/${req.params.id} was not found`);
    fhirJson(res, 200, hit);
  });

  r.get('/:type', async (req, res) => {
    const c = req.fhir!;
    const type = String(req.params.type);
    if (!typed(type)) return outcome(res, 404, 'not-supported', `${type} is not served here`);
    if (!scopeAllows(c.scopes, type)) {
      await log(c.db, c.tenantId, req, c.client.clientId, 'fhir.search', 'deny', { type, reason: 'scope' });
      return outcome(res, 403, 'forbidden', `This token does not allow reading ${type}`);
    }
    const found = await find(c, type, req.query as Record<string, unknown>);
    if (found === 'bad-request') return outcome(res, 400, 'invalid', type === 'Patient' ? 'Search Patient by identifier, name or birthdate' : `Search ${type} by a patient this client may see (patient=Patient/<id>)`);
    await log(c.db, c.tenantId, req, c.client.clientId, 'fhir.search', 'success', { type, count: found.length });
    fhirJson(res, 200, {
      resourceType: 'Bundle',
      type: 'searchset',
      total: found.length,
      link: [{ relation: 'self', url: `${c.base}${req.originalUrl.slice(req.originalUrl.indexOf(`/${type}`))}` }],
      ...(found.length ? { entry: found.map((x) => ({ fullUrl: `${c.base}/${x.resourceType}/${x.id}`, resource: x, search: { mode: 'match' } })) } : {}),
    });
  });

  return r;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
