import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { effectivePermissions, effectiveScope, requiresMfa } from '@fahan/policy';
import type { Actor, Deps, SessionDoc } from '../context';
import { sha256 } from '../lib/crypto';
import { Errors } from '../lib/errors';

export const SESSION_COOKIE = 'fahan_sid';
export const CSRF_COOKIE = 'fahan_csrf';
export const CSRF_HEADER = 'x-csrf-token';

/**
 * Loads the session and rebuilds the actor from current database state. Suspended users,
 * suspended tenants and revoked roles take effect on the very next request.
 */
export function loadSession({ data }: Deps): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const raw = req.cookies?.[SESSION_COOKIE] as string | undefined;
    if (!raw) return next();
    const control = data.control();
    const session = await control
      .collection<SessionDoc>('sessions')
      .findOne({ tokenHash: sha256(raw), expiresAt: { $gt: new Date() } });
    if (!session) return next();

    const built = await buildActor(data, session);
    if (!built) {
      await control.collection('sessions').deleteOne({ _id: session._id });
      return next();
    }
    const { actor, mfaEnrolled } = built;
    // A role that now requires MFA steps down a session that never completed MFA.
    if (session.mfaState === 'ok' && !session.mfaAt && requiresMfa(actor.roles)) {
      session.mfaState = mfaEnrolled ? 'pending' : 'enroll';
      await control.collection('sessions').updateOne({ _id: session._id }, { $set: { mfaState: session.mfaState } });
    }
    req.session = session;
    req.actor = actor;
    next();
  };
}

async function buildActor(data: Deps['data'], s: SessionDoc): Promise<{ actor: Actor; mfaEnrolled: boolean } | null> {
  if (s.kind === 'platform') {
    const u = await data.control().collection('platform_users').findOne({ _id: s.userId, status: 'Active' });
    if (!u) return null;
    const roles = u.roles as string[];
    return {
      actor: { kind: 'platform', userId: u._id, email: u.email, name: u.name, roles, perms: effectivePermissions(roles), scope: 'platform' },
      mfaEnrolled: Boolean(u.mfa?.secret),
    };
  }
  const tenant = await data.control().collection('tenants').findOne({ _id: s.tenantId, status: 'Active' });
  if (!tenant) return null;
  const db = data.tenant(tenant.dbName as string);
  const u = await db.collection('users').findOne({ _id: s.userId, tenantId: tenant._id, status: 'Active' });
  if (!u) return null;
  const roles = u.roles as string[];
  const actor: Actor = {
    kind: 'tenant',
    userId: u._id,
    email: u.email,
    name: u.name,
    roles,
    perms: effectivePermissions(roles),
    scope: effectiveScope(roles),
    tenantId: tenant._id,
    tenantSlug: tenant.slug,
    tenantName: tenant.name,
    db,
    branchId: u.branchId ?? undefined,
  };
  return { actor, mfaEnrolled: Boolean(u.mfa?.secret) };
}

/** Double-submit CSRF check for state-changing requests made with a session cookie. */
export const csrfGuard: RequestHandler = (req, _res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || !req.session) return next();
  const header = req.get(CSRF_HEADER);
  if (!header || header !== req.session.csrf) return next(Errors.csrf());
  next();
};

/** Requires a signed-in actor. MFA must be complete unless the route is part of the MFA flow itself. */
export function requireAuth(opts: { allowIncompleteMfa?: boolean } = {}): RequestHandler {
  return (req, _res, next) => {
    if (!req.actor || !req.session) return next(Errors.unauthenticated());
    if (req.session.mfaState !== 'ok' && !opts.allowIncompleteMfa) return next(Errors.mfaRequired());
    next();
  };
}

export const requireTenant: RequestHandler = (req, _res, next) => {
  if (req.actor?.kind !== 'tenant' || !req.actor.db) return next(Errors.forbidden('This action belongs to a hospital workspace'));
  next();
};

export const requirePlatform: RequestHandler = (req, _res, next) => {
  if (req.actor?.kind !== 'platform') return next(Errors.forbidden('Only the platform console can do this'));
  next();
};

/** Spec §3.4: re-authentication for security-sensitive changes. */
export function requireRecentMfa(deps: Deps): RequestHandler {
  return (req, _res, next) => {
    try {
      assertRecentMfa(deps, req);
      next();
    } catch (e) {
      next(e);
    }
  };
}

/** Same check, for handlers that must first confirm the caller is allowed at all (403 before 401). */
export function assertRecentMfa({ config }: Deps, req: Request): void {
  const at = req.session?.mfaAt?.getTime() ?? 0;
  if (Date.now() - at > config.reauthWindowMs) throw Errors.reauthRequired();
}
