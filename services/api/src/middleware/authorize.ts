import type { Request, RequestHandler } from 'express';
import type { ObjectId } from 'mongodb';
import { can, isBranchBound, type Level, type ModuleKey } from '@hospitalos/policy';
import { writeAudit } from '../audit/audit';
import type { Deps } from '../context';
import { Errors } from '../lib/errors';
import { auditDb } from './audit';

async function deny(deps: Deps, req: Request, resource: string, reason: string): Promise<never> {
  const a = req.actor;
  await writeAudit(auditDb(deps, req), {
    tenantId: a?.tenantId?.toHexString(),
    actorId: a?.userId.toHexString() ?? null,
    actorRoles: a?.roles,
    action: `${req.method} ${req.baseUrl}${req.route?.path ?? ''}`,
    resource,
    outcome: 'deny',
    correlationId: req.correlationId,
    meta: { reason },
  });
  throw Errors.forbidden();
}

/**
 * Spec §3.2: permission(action, resource) checked on the server for every request.
 * Hidden menus are never the control — this is.
 */
export function need(deps: Deps, module: ModuleKey, level: Level): RequestHandler {
  return async (req, _res, next) => {
    const a = req.actor;
    if (!a) return next(Errors.unauthenticated());
    if (!can(a.perms, module, level)) {
      await deny(deps, req, module, `requires ${module}:${level}`);
    }
    next();
  };
}

/** Branch-bound actors may only touch records in their own branch. */
export async function assertBranch(deps: Deps, req: Request, branchId: ObjectId | undefined | null): Promise<void> {
  const a = req.actor!;
  if (!isBranchBound(a.scope)) return;
  if (!branchId || !a.branchId || !a.branchId.equals(branchId)) {
    await deny(deps, req, 'branch', 'outside assigned branch');
  }
}

/** Mongo filter that limits a branch-bound actor to their own branch. */
export function branchFilter(req: Request): Record<string, unknown> {
  const a = req.actor!;
  return isBranchBound(a.scope) ? { branchId: a.branchId ?? null } : {};
}
