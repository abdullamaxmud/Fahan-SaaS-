import { ADMIN_MODULES, MODULE_KEYS, type ModuleKey } from './modules';
import { LEVELS, ROLE_BY_ID, SCOPES, levelRank, type Level, type Permissions, type RoleDef, type Scope } from './roles';

export * from './modules';
export * from './roles';

/** Union of all role grants: the strongest level per module wins. Unknown role ids grant nothing. */
export function effectivePermissions(roleIds: readonly string[]): Permissions {
  const out: Permissions = {};
  for (const id of roleIds) {
    const role = ROLE_BY_ID[id];
    if (!role) continue;
    for (const [k, l] of Object.entries(role.perms) as [ModuleKey, Level][]) {
      if (levelRank(l) > levelRank(out[k])) out[k] = l;
    }
  }
  return out;
}

/** Widest scope across the roles (deny-by-default: no roles → narrowest scope). */
export function effectiveScope(roleIds: readonly string[]): Scope {
  let best = SCOPES.length - 1;
  for (const id of roleIds) {
    const role = ROLE_BY_ID[id];
    if (role) best = Math.min(best, SCOPES.indexOf(role.scope));
  }
  return SCOPES[best] as Scope;
}

export function requiresMfa(roleIds: readonly string[]): boolean {
  return roleIds.some((id) => ROLE_BY_ID[id]?.mfa);
}

/** Deny by default: true only when the granted level is at least the required level. */
export function can(perms: Permissions, module: ModuleKey, level: Level): boolean {
  return levelRank(perms[module]) >= levelRank(level);
}

export type GrantDecision = { ok: true } | { ok: false; code: 'NON_DELEGABLE' | 'UNKNOWN_ROLE' | 'GRANT_CEILING'; message: string };

/**
 * Spec §3.4 grant ceiling: platform-tier roles are never grantable inside a tenant, and a granter
 * cannot hand out a level on a system-administration module that is higher than their own.
 */
export function canGrantRole(granter: Permissions, roleId: string): GrantDecision {
  const role: RoleDef | undefined = ROLE_BY_ID[roleId];
  if (!role) return { ok: false, code: 'UNKNOWN_ROLE', message: `Unknown role "${roleId}"` };
  if (role.tier === 1) return { ok: false, code: 'NON_DELEGABLE', message: 'Platform owner privilege cannot be granted' };
  for (const mod of ADMIN_MODULES) {
    if (levelRank(role.perms[mod]) > levelRank(granter[mod])) {
      return {
        ok: false,
        code: 'GRANT_CEILING',
        message: `Role "${role.name}" carries ${mod}:${role.perms[mod]}, above your own level`,
      };
    }
  }
  return { ok: true };
}

export { LEVELS, MODULE_KEYS };
