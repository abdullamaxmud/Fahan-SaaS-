import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tenantDbName } from '../src/db/mongo';
import { activate, setupHospital, type Hospital } from './fixtures';
import { startHarness, type Harness } from './helpers';

/** Spec §3.3 Super Admin console: hospital profile, module switchboard, MFA reset with dual control, re-invitation. */
let h: Harness;
let H: Hospital;

beforeAll(async () => {
  h = await startHarness();
  H = await setupHospital(h, [
    { key: 'ha', role: 'hospital-admin' },
    { key: 'bb', role: 'bloodbank' },
    { key: 'nurse', role: 'nurse' },
    { key: 'rec', role: 'reception' },
  ]);
});
afterAll(async () => {
  await h?.stop();
});

describe('hospital settings', () => {
  it('administrators set the hospital profile; every member of staff can read it', async () => {
    expect((await H.staff.rec!.c.put('/settings/profile', { displayName: 'Hiil', currency: 'USD' })).status).toBe(403);
    expect((await H.admin.put('/settings/profile', { displayName: 'Hiil Medical Group', phone: '+252 61 000 0000', currency: 'SOS' })).status).toBe(200);
    expect((await H.staff.rec!.c.get('/settings')).body.data.profile).toMatchObject({ displayName: 'Hiil Medical Group', currency: 'SOS' });
  });

  it('a switched-off module is refused by the API at once, even for its own staff', async () => {
    expect((await H.staff.bb!.c.get('/bloodbank/units')).status).toBe(200);
    expect((await H.staff.ha!.c.put('/settings/features', { disabled: ['bb'], reason: 'No blood bank yet' })).status).toBe(403);
    expect((await H.admin.put('/settings/features', { disabled: ['iam'], reason: 'Try to lock out' })).status).toBe(400);
    expect((await H.admin.put('/settings/features', { disabled: ['bb'], reason: 'Blood bank not opened yet' })).status).toBe(200);
    expect((await H.staff.bb!.c.get('/bloodbank/units')).status).toBe(403);
    expect((await H.staff.bb!.c.get('/auth/me')).body.data.disabledModules).toEqual(['bb']);
    await H.admin.put('/settings/features', { disabled: [], reason: 'Blood bank open' });
    expect((await H.staff.bb!.c.get('/bloodbank/units')).status).toBe(200);
  });
});

describe('identity governance', () => {
  it('an authenticator reset needs a second administrator and ends the person’s sessions', async () => {
    const nurse = H.staff.nurse!;
    const users = (await H.admin.get('/users')).body.data as { id: string; email: string; mfaEnrolled: boolean }[];
    const target = users.find((u) => u.email === 'nurse@hiil.test')!;
    // Nurses do not need MFA by policy; give this one an authenticator so there is something to reset.
    await h.data.tenant(tenantDbName('hiil')).collection('users').updateOne({ email: 'nurse@hiil.test' }, { $set: { mfa: { secret: 'x', enrolledAt: new Date() } } });
    expect((await H.admin.post(`/users/${target.id}/mfa-reset`, { reason: 'Lost phone' })).status).toBe(201);
    expect((await H.admin.post(`/users/${target.id}/mfa-reset/approve`)).body.error.code).toBe('FOUR_EYES');
    expect((await nurse.c.get('/auth/me')).status).toBe(200);
    expect((await H.staff.ha!.c.post(`/users/${target.id}/mfa-reset/approve`)).status).toBe(200);
    expect((await nurse.c.get('/auth/me')).status).toBe(401);
  });

  it('a new invitation replaces the old code', async () => {
    const inv = await H.admin.post('/users', { email: 'late@hiil.test', name: 'Late Starter', roles: ['cashier'], branchId: H.branchId });
    const again = await H.admin.post(`/users/${inv.body.data.user.id}/reinvite`);
    expect(again.status).toBe(200);
    const old = await supertest(h.app).post('/api/v1/auth/accept-invite').send({ tenant: 'hiil', token: inv.body.data.invite.token, password: 'correct-horse-battery-staple' });
    expect(old.status).toBe(400);
    await activate(h, again.body.data.invite.token, 'late@hiil.test');
  });
});
