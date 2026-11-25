import type { Request } from 'express';
import { writeAudit, type AuditInput } from '../audit/audit';
import type { Deps } from '../context';

/** Tenant events go to the tenant's own chain; platform events to the control-plane chain. */
export function auditDb({ data }: Deps, req: Request) {
  return req.actor?.db ?? data.control();
}

export function audit(deps: Deps, req: Request, e: Omit<AuditInput, 'actorId' | 'actorRoles' | 'tenantId' | 'correlationId'>) {
  const a = req.actor;
  return writeAudit(auditDb(deps, req), {
    ...e,
    tenantId: a?.tenantId?.toHexString(),
    actorId: a?.userId.toHexString() ?? null,
    actorRoles: a?.roles,
    correlationId: req.correlationId,
  });
}
