import { describe, expect, it } from 'vitest';
import { ROLES, TENANT_ROLES, can, canGrantRole, effectivePermissions, effectiveScope, requiresMfa } from '../src';

describe('role catalogue', () => {
  it('has 55 roles with unique ids across 10 tiers', () => {
    expect(ROLES).toHaveLength(55);
    expect(new Set(ROLES.map((r) => r.id)).size).toBe(55);
    expect(new Set(ROLES.map((r) => r.tier)).size).toBe(10);
    expect(TENANT_ROLES.some((r) => r.id === 'platform-owner')).toBe(false);
  });
});

describe('effective permissions', () => {
  it('denies by default', () => {
    const p = effectivePermissions([]);
    expect(can(p, 'mpi', 'V')).toBe(false);
  });
  it('cashier cannot reach clinical modules', () => {
    const p = effectivePermissions(['cashier']);
    expect(can(p, 'bill', 'E')).toBe(true);
    for (const m of ['opd', 'lab', 'rad', 'rx', 'nur'] as const) expect(can(p, m, 'V')).toBe(false);
  });
  it('takes the strongest level across roles', () => {
    const p = effectivePermissions(['lab-tech', 'pathologist']);
    expect(p.lab).toBe('A');
    expect(can(p, 'lab', 'S')).toBe(true);
  });
  it('ignores unknown role ids', () => {
    expect(effectivePermissions(['root', 'admin'])).toEqual({});
  });
  it('picks the widest scope and MFA requirement', () => {
    expect(effectiveScope(['nurse', 'ward-manager'])).toBe('department');
    expect(requiresMfa(['cashier'])).toBe(false);
    expect(requiresMfa(['cashier', 'accountant'])).toBe(true);
  });
});

describe('grant ceiling', () => {
  const superAdmin = effectivePermissions(['super-admin']);
  const hospitalAdmin = effectivePermissions(['hospital-admin']);
  it('nobody can grant the platform owner role', () => {
    expect(canGrantRole(superAdmin, 'platform-owner')).toMatchObject({ ok: false, code: 'NON_DELEGABLE' });
  });
  it('hospital admin cannot grant super admin', () => {
    expect(canGrantRole(hospitalAdmin, 'super-admin')).toMatchObject({ ok: false, code: 'GRANT_CEILING' });
  });
  it('super admin can grant clinical and finance roles', () => {
    expect(canGrantRole(superAdmin, 'physician')).toEqual({ ok: true });
    expect(canGrantRole(superAdmin, 'cashier')).toEqual({ ok: true });
  });
  it('rejects unknown roles', () => {
    expect(canGrantRole(superAdmin, 'god-mode')).toMatchObject({ ok: false, code: 'UNKNOWN_ROLE' });
  });
});
