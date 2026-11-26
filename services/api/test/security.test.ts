import { authenticator } from 'otplib';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PW, activate, setupHospital, type Hospital } from './fixtures';
import { Client, startHarness, type Harness } from './helpers';

/**
 * Spec §11.3 / §14.1 "Security" row — an in-house penetration sweep: cross-tenant guessing, injection, mass
 * assignment, MFA bypass, session reuse, cross-branch access, malformed input and transport headers.
 * It does not replace an independent penetration test (spec §11.1); it keeps the known attacks from coming back.
 */
let h: Harness;
let H: Hospital;
const A: Record<string, string> = {};
let bAdmin: Client;
let bDoctor: Client;

beforeAll(async () => {
  h = await startHarness();
  H = await setupHospital(h, [
    { key: 'reception', role: 'reception' },
    { key: 'doctor', role: 'physician' },
    { key: 'cashier', role: 'cashier' },
    { key: 'cashier2', role: 'cashier', branch: 2 },
    { key: 'fd', role: 'finance-director' },
    { key: 'analyst', role: 'analyst' },
  ]);
  // Hospital A ("hiil"): a patient, a visit, a diagnosis, an invoice, a snapshot.
  A.pid = (await H.staff.reception!.c.post('/patients', { branchId: H.branchId, givenName: 'Siraad', familyName: 'Hiil', dob: '1980-01-01' })).body.data.id;
  A.enc = (await H.staff.reception!.c.post('/appointments/walk-in', { patientId: A.pid, providerId: H.staff.doctor!.id, reason: 'Cough' })).body.data.encounterId;
  A.dx = (await H.staff.doctor!.c.post(`/encounters/${A.enc}/diagnoses`, { code: 'CA40', display: 'Pneumonia', certainty: 'confirmed', primary: true })).body.data.id;
  await H.staff.fd!.c.post('/billing/prices', { code: 'CONS-OPD', name: 'Consultation', category: 'consultation', priceMinor: 1_000, currency: 'USD' });
  await H.staff.cashier!.c.post('/billing/charges', { patientId: A.pid, serviceCode: 'CONS-OPD', quantity: 1 });
  A.inv = (await H.staff.cashier!.c.post('/billing/invoices', { patientId: A.pid })).body.data.id;
  A.snap = (await H.staff.analyst!.c.post('/intel/snapshots', { kind: 'operations', period: new Date().toISOString().slice(0, 7) })).body.data.id;

  // Hospital B ("bari"): its own admin and a physician.
  const t = await H.owner.post('/platform/tenants', { slug: 'bari', name: 'Bari Hospital', admin: { email: 'admin@bari.test', name: 'Bari Admin' } });
  expect(t.status, JSON.stringify(t.body)).toBe(201);
  bAdmin = await activate(h, t.body.data.adminInvite.token, 'admin@bari.test', 'bari');
  await bAdmin.completeMfa();
  const br = (await bAdmin.post('/branches', { code: 'BSO', name: 'Bosaso' })).body.data.id;
  const inv = await bAdmin.post('/users', { email: 'doc@bari.test', name: 'Bari Doctor', roles: ['physician'], branchId: br });
  bDoctor = await activate(h, inv.body.data.invite.token, 'doc@bari.test', 'bari');
  await bDoctor.completeMfa();
});
afterAll(async () => {
  await h?.stop();
});

describe('cross-tenant guessing (spec §14.2)', () => {
  it('another hospital gets nothing back for any of our ids, read or write', async () => {
    const probes: [Client, 'get' | 'post' | 'patch', string, object?][] = [
      [bAdmin, 'get', `/patients/${A.pid}`],
      [bDoctor, 'get', `/patients/${A.pid}`],
      [bDoctor, 'get', `/patients/${A.pid}/timeline`],
      [bDoctor, 'get', `/encounters/${A.enc}`],
      [bDoctor, 'post', `/encounters/${A.enc}/diagnoses`, { code: 'BA00', display: 'Essential hypertension', certainty: 'confirmed' }],
      [bDoctor, 'patch', `/encounters/${A.enc}/diagnoses/${A.dx}`, { certainty: 'ruled_out', version: 1 }],
      [bDoctor, 'get', `/lab/orders?encounterId=${A.enc}`],
      [bAdmin, 'get', `/billing/invoices/${A.inv}`],
      [bAdmin, 'post', `/billing/invoices/${A.inv}/void`, { reason: 'cross tenant attempt' }],
      [bAdmin, 'get', `/intel/snapshots/${A.snap}`],
      [bAdmin, 'get', `/intel/h360/${A.snap}`],
    ];
    for (const [c, m, path, body] of probes) {
      const r = await (m === 'get' ? c.get(path) : m === 'post' ? c.post(path, body) : c.patch(path, body));
      expect([401, 403, 404], `${m.toUpperCase()} ${path} → ${r.status}`).toContain(r.status);
      expect(JSON.stringify(r.body)).not.toContain('Siraad');
    }
    // And our record is untouched.
    const enc = (await H.staff.doctor!.c.get(`/encounters/${A.enc}`)).body.data;
    expect(JSON.stringify(enc)).not.toContain('BA00');
  });

  it('a tenant header or body field cannot switch hospitals', async () => {
    const r = await bAdmin.get('/patients').set('x-tenant', 'hiil').set('x-tenant-id', 'hiil');
    expect(JSON.stringify(r.body)).not.toContain('Siraad');
  });
});

describe('injection and mass assignment', () => {
  it('query operators in bodies and query strings are refused, never executed', async () => {
    const login = await supertest(h.app).post('/api/v1/auth/login').send({ email: { $ne: null }, password: { $ne: null }, tenant: 'hiil' });
    expect(login.status).toBe(400);
    const op = await H.staff.cashier!.c.post('/billing/invoices', { patientId: { $gt: '' } });
    expect(op.status).toBe(400);
    for (const q of ['/patients?q[$regex]=.*', '/billing/invoices?status[$ne]=Paid', '/patients?q=%7B%22%24gt%22%3A%22%22%7D']) {
      const r = await H.staff.reception!.c.get(q);
      expect([200, 400], q).toContain(r.status);
    }
  });

  it('fields a client should not control are ignored on create', async () => {
    const r = await H.staff.reception!.c.post('/patients', { branchId: H.branchId, givenName: 'Ayaan', familyName: 'Mass', dob: '1990-01-01', tenantId: '000000000000000000000000', mrn: 'HACK-1', status: 'Merged', careTeam: [H.staff.reception!.id], _id: '0123456789abcdef01234567' });
    expect(r.status).toBe(201);
    const p = await h.data.tenant('fahan_t_hiil').collection('patients').findOne({ 'names.given': 'Ayaan' });
    expect(p!.mrn).not.toBe('HACK-1');
    expect(p!.status).toBe('Provisional'); // not the injected 'Merged'
    expect(p!.careTeam).toEqual([]); // not the injected care team
    expect(p!._id.toHexString()).not.toBe('0123456789abcdef01234567');
    expect(String(p!.tenantId)).not.toBe('000000000000000000000000');
  });

  it('a cashier cannot raise their own price or role through extra fields', async () => {
    expect((await H.staff.cashier!.c.post('/billing/prices', { code: 'CONS-OPD', name: 'x', category: 'consultation', priceMinor: 1, currency: 'USD' })).status).toBe(403);
    expect((await H.staff.cashier!.c.patch(`/users/${H.staff.cashier!.id}`, { roles: ['super-admin'] })).status).toBeGreaterThanOrEqual(403);
  });
});

describe('authentication and sessions', () => {
  it('a password alone (no MFA yet) opens nothing clinical or financial', async () => {
    const inv = await H.admin.post('/users', { email: 'newdoc@hiil.test', name: 'New Doctor', roles: ['physician'], branchId: H.branchId });
    const c = await activate(h, inv.body.data.invite.token, 'newdoc@hiil.test');
    for (const p of ['/patients', `/encounters/${A.enc}`, '/billing/invoices', '/intel/metrics']) {
      const r = await c.get(p);
      expect([401, 403], p).toContain(r.status);
    }
  });

  it('a session cookie stops working after sign-out, even if it was copied', async () => {
    const res = await supertest(h.app).post('/api/v1/auth/login').send({ email: 'reception@hiil.test', password: PW, tenant: 'hiil' });
    const cookies = (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
    const csrf = res.body.data.csrfToken;
    expect((await supertest(h.app).get('/api/v1/auth/me').set('cookie', cookies)).status).toBe(200);
    await supertest(h.app).post('/api/v1/auth/logout').set('cookie', cookies).set('x-csrf-token', csrf);
    expect((await supertest(h.app).get('/api/v1/auth/me').set('cookie', cookies)).status).toBe(401);
  });

  it('session cookies are HttpOnly and SameSite=Strict; the CSRF cookie is readable only by our page', async () => {
    const res = await supertest(h.app).post('/api/v1/auth/login').send({ email: 'reception@hiil.test', password: PW, tenant: 'hiil' });
    const set = (res.headers['set-cookie'] as unknown as string[]).join('\n');
    expect(set).toMatch(/fahan_sid=[^;]+;.*HttpOnly/i);
    expect(set).toMatch(/fahan_sid=[^;]+;.*SameSite=Strict/i);
    expect(set).toMatch(/fahan_csrf=[^;]+;.*SameSite=Strict/i);
  });

  it('an authenticator code works once; replaying it is refused', async () => {
    const inv = await H.admin.post('/users', { email: 'replay@hiil.test', name: 'Replay Test', roles: ['physician'], branchId: H.branchId });
    const c = await activate(h, inv.body.data.invite.token, 'replay@hiil.test');
    const secret = (await c.post('/auth/mfa/enroll')).body.data.secret as string;
    const code = authenticator.generate(secret);
    expect((await c.post('/auth/mfa/verify', { code })).status).toBe(200);
    const again = await c.post('/auth/reauth', { code });
    expect(again.status).toBe(401);
    expect(again.body.error.code).toBe('INVALID_MFA_CODE');
  });

  it('five wrong codes end the session, whatever address they come from', async () => {
    const c = new Client(h.app);
    await c.login('doctor@hiil.test', PW, 'hiil');
    for (let i = 0; i < 4; i++) expect((await c.post('/auth/mfa/verify', { code: '000000' })).body.error.code).toBe('INVALID_MFA_CODE');
    const fifth = await c.post('/auth/mfa/verify', { code: '000000' });
    expect(fifth.body.error.code).toBe('SESSION_REVOKED');
    expect((await c.get('/auth/me')).status).toBe(401);
  });

  it('wrong passwords and unknown users get the same answer (no account discovery)', async () => {
    const a = await supertest(h.app).post('/api/v1/auth/login').send({ email: 'reception@hiil.test', password: 'wrong-password-123', tenant: 'hiil' });
    const b = await supertest(h.app).post('/api/v1/auth/login').send({ email: 'nobody@hiil.test', password: 'wrong-password-123', tenant: 'hiil' });
    expect(a.status).toBe(b.status);
    expect(a.body.error.code).toBe(b.body.error.code);
    expect(a.body.error.message).toBe(b.body.error.message);
  });
});

describe('within one hospital', () => {
  it('a cashier at another branch cannot open this branch’s invoice', async () => {
    expect((await H.staff.cashier2!.c.get(`/billing/invoices/${A.inv}`)).status).toBe(403);
  });

  it('a doctor outside the care team cannot read or code the visit', async () => {
    const inv = await H.admin.post('/users', { email: 'other@hiil.test', name: 'Other Doctor', roles: ['physician'], branchId: H.branchId });
    const other = await activate(h, inv.body.data.invite.token, 'other@hiil.test');
    await other.completeMfa();
    expect((await other.get(`/encounters/${A.enc}`)).status).toBe(403);
    expect((await other.post(`/encounters/${A.enc}/diagnoses`, { code: 'BA00', display: 'Essential hypertension', certainty: 'confirmed' })).status).toBe(403);
  });
});

describe('transport and input hygiene', () => {
  it('security headers are set and the framework is not advertised', async () => {
    const r = await supertest(h.app).get('/health');
    expect(r.headers['x-powered-by']).toBeUndefined();
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'self'");
    expect(r.headers['strict-transport-security']).toBeTruthy();
  });

  it('oversized and malformed bodies get a clean error envelope without internals', async () => {
    const big = await H.staff.reception!.c.post('/patients', { branchId: H.branchId, givenName: 'x'.repeat(200_000), familyName: 'y', dob: '1990-01-01' });
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBeTruthy();
    const bad = await supertest(h.app).post('/api/v1/auth/login').set('content-type', 'application/json').send('{"email": "a@b.c",');
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).not.toMatch(/at .*\.(ts|js):\d+|node_modules|SyntaxError/);
  });

  it('unknown routes and malformed ids answer with the standard envelope', async () => {
    const r = await H.staff.reception!.c.get('/patients/not-an-id');
    expect([400, 404]).toContain(r.status);
    expect(r.body.error).toMatchObject({ code: expect.any(String), message: expect.any(String), correlationId: expect.any(String) });
    expect((await H.staff.reception!.c.get('/no/such/route')).body.error.code).toBe('NOT_FOUND');
  });
});
