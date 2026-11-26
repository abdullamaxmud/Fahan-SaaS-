import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateBundle, validateResource } from '../src/modules/fhir/validate';
import { setupHospital, type Hospital } from './fixtures';
import { startHarness, type Harness } from './helpers';

/** Spec §12.1 / §12.2 / §5.34: FHIR R4 read facade, scoped client credentials, lifecycle, conformance, isolation. */
let h: Harness;
let H: Hospital;
const ids: Record<string, string> = {};
const creds: Record<string, { id: string; clientId: string; secret: string }> = {};
const F = (path: string) => `/api/v1/fhir/hiil${path}`;
const api = () => supertest(h.app);

async function token(c: { clientId: string; secret: string }, scope?: string) {
  return api().post(F('/auth/token')).type('form').send({ grant_type: 'client_credentials', client_id: c.clientId, client_secret: c.secret, ...(scope ? { scope } : {}) });
}
const get = (path: string, tok: string) => api().get(F(path)).set('authorization', `Bearer ${tok}`);

beforeAll(async () => {
  h = await startHarness();
  H = await setupHospital(h, [
    { key: 'reception', role: 'reception' },
    { key: 'reception2', role: 'reception', branch: 2 },
    { key: 'doctor', role: 'physician' },
    { key: 'tech', role: 'lab-tech' },
    { key: 'path', role: 'pathologist' },
  ]);
  const rc = H.staff.reception!.c;
  const doc = H.staff.doctor!.c;
  ids.p1 = (await rc.post('/patients', { branchId: H.branchId, givenName: 'Faadumo', familyName: 'Fhir', dob: '1984-05-06', sexAtBirth: 'female', phone: '0615551234' })).body.data.id;
  ids.p2 = (await H.staff.reception2!.c.post('/patients', { branchId: H.branch2Id, givenName: 'Cali', familyName: 'Hodan', dob: '1977-02-03', sexAtBirth: 'male' })).body.data.id;
  ids.mrn = (await rc.get(`/patients/${ids.p1}`)).body.data.mrn;
  ids.enc = (await rc.post('/appointments/walk-in', { patientId: ids.p1, providerId: H.staff.doctor!.id, reason: 'Fever' })).body.data.encounterId;
  await doc.post(`/encounters/${ids.enc}/observations`, { code: 'temperature', value: 38.9 });
  await doc.post(`/encounters/${ids.enc}/diagnoses`, { code: '1F40', display: 'Malaria due to Plasmodium falciparum', certainty: 'confirmed', primary: true });
  await doc.post(`/encounters/${ids.enc}/diagnoses`, { code: 'CA40', display: 'Pneumonia', certainty: 'ruled_out' });
  const cbc = (await H.staff.path!.c.post('/lab/tests', { code: 'CBC', name: 'Full blood count', specimen: 'blood', turnaroundMinutes: 90, analytes: [{ code: 'HB', name: 'Haemoglobin', unit: 'g/dL', refLow: 12, refHigh: 16 }, { code: 'WBC', name: 'White cells', unit: '10^9/L', refLow: 4, refHigh: 11 }] })).body.data.id;
  const [order, pending] = (await doc.post('/lab/orders', { encounterId: ids.enc, testIds: [cbc], priority: 'urgent' })).body.data.concat((await doc.post('/lab/orders', { encounterId: ids.enc, testIds: [cbc], priority: 'routine' })).body.data);
  ids.lab = order;
  ids.pending = pending;
  await H.staff.tech!.c.post(`/lab/orders/${order}/collect`);
  await H.staff.tech!.c.post(`/lab/orders/${order}/receive`);
  await H.staff.tech!.c.post(`/lab/orders/${order}/results`, { results: [{ analyteCode: 'HB', value: 10.4 }, { analyteCode: 'WBC', value: 7.2 }] });
  expect((await H.staff.path!.c.post(`/lab/orders/${order}/verify`)).status).toBe(200);
  expect((await H.staff.path!.c.post(`/lab/orders/${order}/release`)).status).toBe(200);

  for (const [key, body] of [
    ['hie', { name: 'Regional health information exchange', scopes: ['system/*.read'] }],
    ['gateway', { name: 'Branch 2 lab gateway', scopes: ['system/Patient.read', 'system/Observation.read'], branchIds: [H.branch2Id] }],
  ] as const) {
    const r = await H.admin.post('/integrations/clients', body);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    creds[key] = { id: r.body.data.id, clientId: r.body.data.clientId, secret: r.body.data.clientSecret };
  }
});
afterAll(async () => {
  await h?.stop();
});

describe('discovery and client lifecycle (spec §12.2)', () => {
  it('publishes a CapabilityStatement without a token', async () => {
    const r = await api().get(F('/metadata'));
    expect(r.headers['content-type']).toContain('application/fhir+json');
    expect(r.body).toMatchObject({ resourceType: 'CapabilityStatement', fhirVersion: '4.0.1', kind: 'instance' });
    expect(r.body.rest[0].resource.map((x: { type: string }) => x.type)).toContain('DiagnosticReport');
  });

  it('only integration administrators register clients; the secret is shown once and never listed', async () => {
    expect((await H.staff.doctor!.c.post('/integrations/clients', { name: 'Rogue client', scopes: ['system/*.read'] })).status).toBe(403);
    expect((await H.admin.post('/integrations/clients', { name: 'Bad scope', scopes: ['user/*.write'] })).status).toBe(400);
    const list = await H.admin.get('/integrations/clients');
    expect(JSON.stringify(list.body)).not.toContain(creds.hie!.secret);
    expect(list.body.data.every((c: { status: string }) => c.status === 'Configured')).toBe(true);
  });

  it('a client is enabled only after its conformance run passes on this hospital’s data', async () => {
    expect((await token(creds.hie!)).status).toBe(401);
    expect((await H.admin.post(`/integrations/clients/${creds.hie!.id}/enable`)).body.error.code).toBe('NOT_TESTED');
    for (const k of ['hie', 'gateway']) {
      const t = await H.admin.post(`/integrations/clients/${creds[k]!.id}/test`);
      expect(t.body.data, JSON.stringify(t.body.data.errors)).toMatchObject({ status: 'Tested', passed: true });
      expect(t.body.data.checked).toBeGreaterThan(0);
      expect((await H.admin.post(`/integrations/clients/${creds[k]!.id}/enable`)).body.data.status).toBe('Enabled');
    }
  });
});

describe('tokens', () => {
  it('client credentials give a 15-minute bearer token with only allowed scopes', async () => {
    expect((await token({ ...creds.hie!, secret: 'wrong-secret' })).body.error).toBe('invalid_client');
    expect((await api().post(F('/auth/token')).type('form').send({ grant_type: 'password', client_id: creds.hie!.clientId, client_secret: creds.hie!.secret })).body.error).toBe('unsupported_grant_type');
    expect((await token(creds.gateway!, 'system/Condition.read')).body.error).toBe('invalid_scope');
    const ok = await token(creds.hie!);
    expect(ok.body).toMatchObject({ token_type: 'Bearer', expires_in: 900, scope: 'system/*.read' });
    expect(ok.headers['cache-control']).toBe('no-store');
    ids.hieToken = ok.body.access_token;
    ids.gwToken = (await token(creds.gateway!)).body.access_token;
  });

  it('without a valid token nothing is returned', async () => {
    const r = await api().get(F(`/Patient/${ids.p1}`));
    expect(r.status).toBe(401);
    expect(r.body.resourceType).toBe('OperationOutcome');
    expect((await get(`/Patient/${ids.p1}`, 'forged-token')).status).toBe(401);
  });
});

describe('resources (conformance, spec §12.1)', () => {
  it('Patient: identifiers carry the hospital MRN system; no phone leaves the hospital', async () => {
    const r = await get(`/Patient/${ids.p1}`, ids.hieToken!);
    expect(r.status).toBe(200);
    expect(validateResource(r.body)).toEqual([]);
    expect(r.body).toMatchObject({ resourceType: 'Patient', gender: 'female', birthDate: '1984-05-06', identifier: [{ system: 'urn:fahan:hiil:mrn', value: ids.mrn }] });
    expect(JSON.stringify(r.body)).not.toMatch(/0615551234|telecom|address/);
    const s = await get(`/Patient?identifier=urn:fahan:hiil:mrn|${ids.mrn}`, ids.hieToken!);
    expect(validateBundle(s.body)).toEqual([]);
    expect(s.body.total).toBe(1);
  });

  it('Encounter, Condition and vital-sign Observations validate; a ruled-out condition is refuted with no clinical status', async () => {
    for (const path of [`/Encounter?patient=Patient/${ids.p1}`, `/Condition?patient=${ids.p1}`, `/Observation?patient=${ids.p1}&category=vital-signs`]) {
      const b = (await get(path, ids.hieToken!)).body;
      expect(validateBundle(b), path).toEqual([]);
      expect(b.total, path).toBeGreaterThan(0);
    }
    const enc = (await get(`/Encounter/${ids.enc}`, ids.hieToken!)).body;
    expect(enc.class).toMatchObject({ code: 'AMB' });
    const conds = (await get(`/Condition?patient=${ids.p1}`, ids.hieToken!)).body.entry.map((e: { resource: Record<string, unknown> }) => e.resource);
    const refuted = conds.find((c: { code: { coding: { code: string }[] } }) => c.code.coding[0]!.code === 'CA40');
    expect(refuted.verificationStatus.coding[0].code).toBe('refuted');
    expect(refuted.clinicalStatus).toBeUndefined();
    const temp = (await get(`/Observation?patient=${ids.p1}&category=vital-signs`, ids.hieToken!)).body.entry[0].resource;
    expect(temp.code.coding[0]).toMatchObject({ system: 'http://loinc.org', code: '8310-5' });
    expect(temp.valueQuantity).toMatchObject({ value: 38.9, system: 'http://unitsofmeasure.org', code: 'Cel' });
  });

  it('lab results: only released results leave; the report’s result references resolve', async () => {
    const obs = (await get(`/Observation?patient=${ids.p1}&category=laboratory`, ids.hieToken!)).body;
    expect(validateBundle(obs)).toEqual([]);
    expect(obs.total).toBe(2); // HB and WBC of the released order; the pending order shows nothing
    const hb = obs.entry.map((e: { resource: { code: { coding: { code: string }[] } } }) => e.resource).find((r: { code: { coding: { code: string }[] } }) => r.code.coding[0]!.code === 'HB');
    expect(hb.interpretation[0].coding[0].code).toBe('L');
    const rep = (await get(`/DiagnosticReport?patient=${ids.p1}`, ids.hieToken!)).body;
    expect(validateBundle(rep)).toEqual([]);
    for (const ref of rep.entry[0].resource.result as { reference: string }[]) expect((await get(`/${ref.reference}`, ids.hieToken!)).status).toBe(200);
    const sr = (await get(`/ServiceRequest?patient=${ids.p1}`, ids.hieToken!)).body;
    expect(validateBundle(sr)).toEqual([]);
    expect(sr.entry.map((e: { resource: { status: string } }) => e.resource.status).sort()).toEqual(['active', 'completed']);
    const prac = await get(`/Practitioner/${H.staff.doctor!.id}`, ids.hieToken!);
    expect(validateResource(prac.body)).toEqual([]);
  });

  it('searches need a patient the client may see; unknown types are refused', async () => {
    expect((await get('/Condition', ids.hieToken!)).status).toBe(400);
    expect((await get(`/Condition?patient=${'0'.repeat(24)}`, ids.hieToken!)).status).toBe(400);
    expect((await get(`/Basic?patient=${ids.p1}`, ids.hieToken!)).status).toBe(404);
  });
});

describe('scope, branch and hospital isolation', () => {
  it('a client reads only its resource types and its branches', async () => {
    expect((await get(`/Condition?patient=${ids.p2}`, ids.gwToken!)).status).toBe(403);
    expect((await get(`/Patient/${ids.p1}`, ids.gwToken!)).status).toBe(404);
    expect((await get(`/Patient/${ids.p2}`, ids.gwToken!)).status).toBe(200);
    expect((await get(`/Observation?patient=${ids.p1}`, ids.gwToken!)).status).toBe(400);
  });

  it('a token from one hospital opens nothing at another', async () => {
    const t = await H.owner.post('/platform/tenants', { slug: 'bari', name: 'Bari Hospital', admin: { email: 'admin@bari.test', name: 'Bari Admin' } });
    expect(t.status).toBe(201);
    expect((await supertest(h.app).get(`/api/v1/fhir/bari/Patient/${ids.p1}`).set('authorization', `Bearer ${ids.hieToken}`)).status).toBe(401);
    expect((await supertest(h.app).get('/api/v1/fhir/nowhere/metadata')).status).toBe(404);
  });

  it('every read is audited under the client; suspending a client revokes its tokens at once', async () => {
    const ev = (await H.admin.get('/audit/events?limit=100')).body.data as { action: string; actorRoles: string[] }[];
    expect(ev.some((e) => e.action === 'fhir.search' && e.actorRoles?.[0] === `api-client:${creds.hie!.clientId}`)).toBe(true);
    const s = await H.admin.post(`/integrations/clients/${creds.hie!.id}/suspend`, { reason: 'Partner contract paused' });
    expect(s.body.data).toMatchObject({ status: 'Suspended' });
    expect(s.body.data.revokedTokens).toBeGreaterThan(0);
    expect((await get(`/Patient/${ids.p1}`, ids.hieToken!)).status).toBe(401);
    expect((await token(creds.hie!)).status).toBe(401);
  });
});
