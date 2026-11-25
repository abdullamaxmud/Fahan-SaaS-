import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyAuditChain } from '../src/audit/audit';
import { AlreadyBootstrappedError, bootstrapOwner } from '../src/modules/platform/bootstrap';
import { Client, startHarness, type Harness } from './helpers';

/**
 * Phase 1 exit criteria (spec §14.2 + roadmap): the security boundaries hold when called
 * directly through the API, not just in the UI.
 */
let h: Harness;
const PW = 'correct-horse-battery-staple';
let owner: Client;
let ownerSecret = '';
const tenants: Record<string, { token: string; email: string }> = {};
let adminA: Client;
let branchA = '';

async function activate(tenant: string, token: string, email: string, password = PW) {
  const c = new Client(h.app);
  const acc = await c.agent.post('/api/v1/auth/accept-invite').send({ tenant, token, password });
  expect(acc.status).toBe(200);
  expect((await c.login(email, password, tenant)).status).toBe(200);
  return c;
}

async function invite(admin: Client, body: object) {
  const res = await admin.post('/users', body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as { user: { id: string; version: number }; invite: { token: string } };
}

beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h?.stop();
});

describe('owner bootstrap', () => {
  it('runs once and refuses a second time', async () => {
    const r = await bootstrapOwner(h.data, h.config, { email: 'owner@hospitalos.test', name: 'Ilhaan Daahir' });
    ownerSecret = r.secret;
    await expect(bootstrapOwner(h.data, h.config, { email: 'other@hospitalos.test', name: 'X' })).rejects.toBeInstanceOf(AlreadyBootstrappedError);
    owner = new Client(h.app);
    expect((await owner.login('owner@hospitalos.test', r.password)).body.data.mfa).toBe('pending');
  });

  it('blocks platform actions until MFA is verified', async () => {
    const res = await owner.get('/platform/tenants');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('MFA_REQUIRED');
    await owner.completeMfa(ownerSecret);
    expect((await owner.get('/platform/tenants')).status).toBe(200);
  });

  it('rejects wrong passwords with a generic error', async () => {
    const c = new Client(h.app);
    const res = await c.login('owner@hospitalos.test', 'wrong-password-123');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(res.body.error.correlationId).toBeTruthy();
  });
});

describe('tenant provisioning', () => {
  it('creates two hospitals, each with its own database and first admin invite', async () => {
    for (const [slug, name] of [
      ['hiil', 'Hiil Medical Group'],
      ['badbaado', 'Badbaado Hospital'],
    ] as const) {
      const res = await owner.post('/platform/tenants', { slug, name, admin: { email: `admin@${slug}.test`, name: `${name} Admin` } });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.data.tenant.isolation).toBe('dedicated-db');
      tenants[slug] = { token: res.body.data.adminInvite.token, email: `admin@${slug}.test` };
    }
    const dbs = (await h.data.client.db().admin().listDatabases()).databases.map((d) => d.name);
    expect(dbs).toEqual(expect.arrayContaining(['hos_t_hiil', 'hos_t_badbaado']));
  });

  it('rejects a duplicate hospital code', async () => {
    const res = await owner.post('/platform/tenants', { slug: 'hiil', name: 'Copy', admin: { email: 'x@y.test', name: 'X Y' } });
    expect(res.status).toBe(409);
  });

  it('platform owner cannot open hospital patient data', async () => {
    const res = await owner.get('/patients');
    expect(res.status).toBe(403);
  });

  it('invite tokens work once', async () => {
    const { token, email } = tenants.hiil!;
    adminA = await activate('hiil', token, email);
    const again = await new Client(h.app).agent.post('/api/v1/auth/accept-invite').send({ tenant: 'hiil', token, password: PW });
    expect(again.status).toBe(400);
  });

  it('super admin must enrol MFA before doing anything', async () => {
    expect((await adminA.get('/users')).body.error.code).toBe('MFA_REQUIRED');
    await adminA.completeMfa();
    expect((await adminA.get('/users')).status).toBe(200);
  });
});

describe('hospital administration', () => {
  it('creates branches and departments', async () => {
    const b = await adminA.post('/branches', { code: 'MGD', name: 'Mogadishu Central', timezone: 'Africa/Mogadishu' });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    branchA = b.body.data.id;
    const d = await adminA.post('/departments', { branchId: branchA, code: 'OPD', name: 'Outpatients' });
    expect(d.status).toBe(201);
    expect((await adminA.post('/branches', { code: 'MGD', name: 'Dup' })).status).toBe(409);
  });

  it('validates input with field-level details', async () => {
    const res = await adminA.post('/branches', { code: '!', name: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d: { path: string }) => d.path)).toEqual(expect.arrayContaining(['code', 'name']));
  });

  it('rejects state changes without the CSRF header', async () => {
    const res = await adminA.agent.post('/api/v1/branches').send({ code: 'NOC', name: 'No CSRF' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_REJECTED');
  });

  it('requires branch for branch-bound roles and enforces the grant ceiling', async () => {
    const noBranch = await adminA.post('/users', { email: 'cashier@hiil.test', name: 'Hamdi Yuusuf', roles: ['cashier'] });
    expect(noBranch.status).toBe(400);
    const owner = await adminA.post('/users', { email: 'evil@hiil.test', name: 'Evil', roles: ['platform-owner'] });
    expect(owner.body.error.code).toBe('NON_DELEGABLE');
  });
});

describe('Phase 1 exit criteria', () => {
  let cashier: Client;
  let physician: Client;
  let reception: Client;
  let hAdmin: Client;
  let cashierId = '';
  let cashierVersion = 1;

  beforeAll(async () => {
    const c = await invite(adminA, { email: 'cashier@hiil.test', name: 'Hamdi Yuusuf', roles: ['cashier'], branchId: branchA });
    cashierId = c.user.id;
    cashierVersion = c.user.version;
    cashier = await activate('hiil', c.invite.token, 'cashier@hiil.test');
    const p = await invite(adminA, { email: 'dr.hodan@hiil.test', name: 'Dr. Hodan Warsame', roles: ['physician'], branchId: branchA });
    physician = await activate('hiil', p.invite.token, 'dr.hodan@hiil.test');
    await physician.completeMfa();
    const r = await invite(adminA, { email: 'reception@hiil.test', name: 'Ifrah Muxumed', roles: ['reception'], branchId: branchA });
    reception = await activate('hiil', r.invite.token, 'reception@hiil.test');
    const ha = await invite(adminA, { email: 'hadmin@hiil.test', name: 'Nimco Barre', roles: ['hospital-admin'] });
    hAdmin = await activate('hiil', ha.invite.token, 'hadmin@hiil.test');
    await hAdmin.completeMfa();
  });

  it('cashier cannot read clinical data or manage users via direct API calls', async () => {
    expect((await cashier.get('/auth/me')).body.data.mfa).toBe('ok'); // cashier role has no MFA requirement
    // Cashiers may look up who they bill (demographics, mpi:V) — but never clinical fields.
    const patients = await cashier.get('/patients');
    expect(patients.status).toBe(200);
    for (const p of patients.body.data) expect(Object.keys(p).sort()).toEqual(['branchId', 'dob', 'id', 'mrn', 'names', 'sexAtBirth', 'status']);
    const audit = await cashier.get('/audit/events');
    expect(audit.status).toBe(403);
    expect(audit.body.error.code).toBe('PERMISSION_DENIED');
    expect((await cashier.get('/users')).status).toBe(403);
    expect((await cashier.post('/users', { email: 'x@hiil.test', name: 'X', roles: ['super-admin'] })).status).toBe(403);
  });

  it('records every denial in the tenant audit trail', async () => {
    const res = await adminA.get('/audit/events?limit=100');
    const denies = res.body.data.filter((e: { outcome: string; actorId: string }) => e.outcome === 'deny' && e.actorId === cashierId);
    expect(denies.length).toBeGreaterThanOrEqual(2);
  });

  it('reception registers a patient; physician sees only patients in their care', async () => {
    const created = await reception.post('/patients', { givenName: 'Faadumo', familyName: 'Cali Xasan', dob: '1992-03-14', sexAtBirth: 'female', branchId: branchA });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data.mrn).toMatch(/^MGD-\d{2}-000001$/);
    expect((await reception.get('/patients')).body.data).toHaveLength(1);
    const mine = await physician.get('/patients');
    expect(mine.status).toBe(200);
    expect(mine.body.data).toHaveLength(0);
  });

  it('a hospital admin cannot reach another hospital with guessed ids', async () => {
    const b = await activate('badbaado', tenants.badbaado!.token, tenants.badbaado!.email);
    await b.completeMfa();
    expect((await b.get('/branches')).body.data).toHaveLength(0);
    expect((await b.get(`/departments?branchId=${branchA}`)).body.data).toHaveLength(0);
    const res = await b.put(`/users/${cashierId}/roles`, { roles: ['reception'], version: 1 });
    expect(res.status).toBe(404);
    // Supplying another tenant in the body or headers changes nothing: tenant comes from the session.
    const spoof = await b.agent.get('/api/v1/users').set('x-tenant-id', 'hiil');
    expect(spoof.body.data.every((u: { email: string }) => u.email.endsWith('@badbaado.test'))).toBe(true);
  });

  it('hospital admin cannot grant super admin (grant ceiling) or change their own roles', async () => {
    const up = await hAdmin.post('/users', { email: 'x2@hiil.test', name: 'X Two', roles: ['super-admin'] });
    expect(up.body.error.code).toBe('GRANT_CEILING');
    const me = (await hAdmin.get('/auth/me')).body.data.id;
    const self = await hAdmin.put(`/users/${me}/roles`, { roles: ['hospital-admin'], version: 2 });
    expect(self.status).toBe(403);
  });

  it('role changes apply to live sessions on the next request', async () => {
    const res = await adminA.put(`/users/${cashierId}/roles`, { roles: ['branch-manager'], version: cashierVersion + 1 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // The new role needs MFA, so the existing password-only session is stepped down until MFA is done.
    expect((await cashier.get('/users')).body.error.code).toBe('MFA_REQUIRED');
    await cashier.completeMfa();
    expect((await cashier.get('/users')).status).toBe(200);
    const stale = await adminA.put(`/users/${cashierId}/roles`, { roles: ['cashier'], version: cashierVersion + 1 });
    expect(stale.status).toBe(409);
  });

  it('suspension revokes access immediately', async () => {
    expect((await adminA.post(`/users/${cashierId}/suspend`)).status).toBe(200);
    expect((await cashier.get('/auth/me')).status).toBe(401);
    expect((await cashier.login('cashier@hiil.test', PW, 'hiil')).status).toBe(401);
  });

  it('sensitive changes need a fresh MFA confirmation', async () => {
    const session = await h.data.control().collection('sessions').findOne({ tokenHash: { $exists: true }, kind: 'tenant', userId: { $exists: true } });
    expect(session).toBeTruthy();
    await h.data.control().collection('sessions').updateMany({ kind: 'tenant' }, { $set: { mfaAt: new Date(Date.now() - 3_600_000) } });
    const res = await adminA.post(`/users/${cashierId}/reactivate`);
    expect(res.body.error.code).toBe('REAUTH_REQUIRED');
  });
});

describe('audit integrity', () => {
  it('the hash chain verifies, and tampering is detected', async () => {
    const db = h.data.tenant('hos_t_hiil');
    const ok = await verifyAuditChain(db);
    expect(ok.ok).toBe(true);
    expect(ok.count).toBeGreaterThan(10);
    await db.collection('audit_events').updateOne({ seq: 3 }, { $set: { outcome: 'success', action: 'nothing.to.see' } });
    const broken = await verifyAuditChain(db);
    expect(broken).toMatchObject({ ok: false, brokenAtSeq: 3 });
    expect((await verifyAuditChain(h.data.control())).ok).toBe(true);
  });
});
