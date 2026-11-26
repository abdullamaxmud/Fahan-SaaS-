import { expect } from 'vitest';
import { bootstrapOwner } from '../src/modules/platform/bootstrap';
import { Client, type Harness } from './helpers';

export const PW = 'correct-horse-battery-staple';

export interface Staff {
  c: Client;
  id: string;
}

export interface Hospital {
  /** The platform owner (signed in, MFA done) — for creating a second hospital in isolation tests. */
  owner: Client;
  admin: Client;
  branchId: string;
  branch2Id: string;
  staff: Record<string, Staff>;
}

/** Owner → hospital "hiil" with branches MGD and HDN → one signed-in user per requested role (MFA done where needed). */
export async function setupHospital(h: Harness, roles: { key: string; role: string; branch?: 1 | 2 }[]): Promise<Hospital> {
  const boot = await bootstrapOwner(h.data, h.config, { email: 'owner@fahan.test', name: 'Owner' });
  const owner = new Client(h.app);
  await owner.login('owner@fahan.test', boot.password);
  await owner.completeMfa(boot.secret);
  const t = await owner.post('/platform/tenants', { slug: 'hiil', name: 'Hiil Medical Group', admin: { email: 'admin@hiil.test', name: 'Mustafe Xirsi' } });
  expect(t.status).toBe(201);
  const admin = await activate(h, t.body.data.adminInvite.token, 'admin@hiil.test');
  await admin.completeMfa();
  const b1 = await admin.post('/branches', { code: 'MGD', name: 'Mogadishu Central' });
  const b2 = await admin.post('/branches', { code: 'HDN', name: 'Hodan' });
  const branchId = b1.body.data.id as string;
  const branch2Id = b2.body.data.id as string;

  const staff: Record<string, Staff> = {};
  for (const { key, role, branch } of roles) {
    const email = `${key}@hiil.test`;
    // Oversight roles are appointed by the platform owner, not by the hospital's own admins.
    const oversight = role === 'security-auditor' || role === 'dpo';
    const inv = oversight
      ? await owner.post(`/platform/tenants/${t.body.data.tenant.id}/oversight-invite`, { email, name: key, role })
      : await admin.post('/users', { email, name: key, roles: [role], branchId: branch === 2 ? branch2Id : branchId });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    const c = await activate(h, inv.body.data.invite.token, email);
    const me = await c.get('/auth/me');
    if (me.body.data.mfa !== 'ok') await c.completeMfa();
    staff[key] = { c, id: inv.body.data.user.id };
  }
  return { owner, admin, branchId, branch2Id, staff };
}

export async function activate(h: Harness, token: string, email: string, tenant = 'hiil'): Promise<Client> {
  const c = new Client(h.app);
  const acc = await c.agent.post('/api/v1/auth/accept-invite').send({ tenant, token, password: PW });
  expect(acc.status, JSON.stringify(acc.body)).toBe(200);
  expect((await c.login(email, PW, tenant)).status).toBe(200);
  return c;
}
