import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import type { Collection, Db, ObjectId } from 'mongodb';
import { z } from 'zod';
import { requiresMfa } from '@fahan/policy';
import { writeAudit } from '../../audit/audit';
import type { Deps, MfaState, SessionDoc } from '../../context';
import { decrypt, encrypt, newToken, sha256 } from '../../lib/crypto';
import { AppError, Errors } from '../../lib/errors';
import { checkPassword, hashPassword, totp } from '../../lib/secrets';
import { email, mfaCode, parse, password, slug } from '../../lib/validate';
import { audit } from '../../middleware/audit';
import { CSRF_COOKIE, SESSION_COOKIE, requireAuth } from '../../middleware/session';

const LoginBody = z.object({ tenant: slug.optional(), email, password: z.string().min(1).max(200) });
const CodeBody = z.object({ code: mfaCode });
const AcceptBody = z.object({ tenant: slug, token: z.string().min(20).max(100), password });

export function authRoutes(deps: Deps): Router {
  const { data, config } = deps;
  const r = Router();

  const limiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: config.env === 'test' ? 10_000 : 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, _res, next) => next(new AppError(429, 'RATE_LIMITED', 'Too many attempts. Wait 15 minutes and try again')),
  });

  const cookieBase = { secure: config.cookieSecure, sameSite: 'strict' as const, path: '/' };
  function setSessionCookies(res: Response, token: string, csrf: string) {
    res.cookie(SESSION_COOKIE, token, { ...cookieBase, httpOnly: true, maxAge: config.sessionTtlMs });
    res.cookie(CSRF_COOKIE, csrf, { ...cookieBase, httpOnly: false, maxAge: config.sessionTtlMs });
  }

  function usersOf(req: Request): Collection {
    return req.actor!.kind === 'platform' ? data.control().collection('platform_users') : req.actor!.db!.collection('users');
  }

  const MAX_CODE_FAILURES = 5;
  /**
   * Accepts a TOTP code once (RFC 6238 §5.2: a used code is refused) and counts failures on the session itself,
   * so rotating IP addresses does not help: after five wrong codes the session is ended.
   */
  async function consumeCode(req: Request, userId: ObjectId, blob: string, code: string, action: string): Promise<void> {
    const step = totp.matchStep(code, decrypt(blob, config.dataKey));
    const fresh = step !== null && (await usersOf(req).updateOne({ _id: userId, $or: [{ 'mfa.lastStep': { $exists: false } }, { 'mfa.lastStep': { $lt: step } }] }, { $set: { 'mfa.lastStep': step } })).modifiedCount === 1;
    if (fresh) return;
    const sessions = data.control().collection<SessionDoc & { mfaFailures?: number }>('sessions');
    const s = await sessions.findOneAndUpdate({ _id: req.session!._id }, { $inc: { mfaFailures: 1 } }, { returnDocument: 'after' });
    await audit(deps, req, { action, resource: 'session', outcome: 'failure', meta: { reused: step !== null } });
    if ((s?.mfaFailures ?? 0) >= MAX_CODE_FAILURES) {
      await sessions.deleteOne({ _id: req.session!._id });
      await audit(deps, req, { action: 'auth.mfa.lockout', resource: 'session', outcome: 'deny', meta: { failures: s?.mfaFailures ?? 0 } });
      throw new AppError(401, 'SESSION_REVOKED', 'Too many wrong codes. Sign in again');
    }
    throw Errors.invalidCode();
  }

  r.post('/login', limiter, async (req, res) => {
    const body = parse(LoginBody, req.body);
    let db: Db = data.control();
    let user: Record<string, any> | null = null;
    let tenant: Record<string, any> | null = null;
    if (body.tenant) {
      tenant = await data.control().collection('tenants').findOne({ slug: body.tenant, status: 'Active' });
      if (tenant) {
        db = data.tenant(tenant.dbName);
        user = await db.collection('users').findOne({ tenantId: tenant._id, email: body.email, status: 'Active' });
      }
    } else {
      user = await data.control().collection('platform_users').findOne({ email: body.email, status: 'Active' });
    }

    const ok = await checkPassword(user?.passwordHash, body.password);
    if (!user || !ok) {
      await writeAudit(db, {
        tenantId: tenant?._id.toHexString(),
        actorId: user?._id.toHexString() ?? null,
        action: 'auth.login',
        resource: 'session',
        outcome: 'failure',
        correlationId: req.correlationId,
        meta: { email: body.email },
      });
      throw Errors.invalidCredentials();
    }

    const enrolled = Boolean(user.mfa?.secret);
    const mfaState: MfaState = enrolled ? 'pending' : !tenant || requiresMfa(user.roles) ? 'enroll' : 'ok';
    const token = newToken();
    const csrf = newToken(16);
    const now = new Date();
    await data.control().collection('sessions').insertOne({
      tokenHash: sha256(token),
      kind: tenant ? 'tenant' : 'platform',
      userId: user._id,
      tenantId: tenant?._id,
      mfaState,
      mfaAt: undefined,
      csrf,
      createdAt: now,
      expiresAt: new Date(now.getTime() + config.sessionTtlMs),
      ip: req.ip,
      userAgent: req.get('user-agent')?.slice(0, 200),
    });
    await writeAudit(db, {
      tenantId: tenant?._id.toHexString(),
      actorId: user._id.toHexString(),
      actorRoles: user.roles,
      action: 'auth.login',
      resource: 'session',
      outcome: 'success',
      correlationId: req.correlationId,
      meta: { mfaState },
    });
    setSessionCookies(res, token, csrf);
    res.json({ data: { mfa: mfaState, kind: tenant ? 'tenant' : 'platform', name: user.name, csrfToken: csrf } });
  });

  r.post('/mfa/enroll', requireAuth({ allowIncompleteMfa: true }), async (req, res) => {
    if (req.session!.mfaState !== 'enroll') throw Errors.conflict('MFA_ALREADY_ENROLLED', 'An authenticator is already set up for this account');
    const secret = totp.newSecret();
    await usersOf(req).updateOne({ _id: req.actor!.userId }, { $set: { 'mfa.pendingSecret': encrypt(secret, config.dataKey) } });
    res.json({ data: { otpauthUri: totp.uri(req.actor!.email, secret), secret } });
  });

  r.post('/mfa/verify', limiter, requireAuth({ allowIncompleteMfa: true }), async (req, res) => {
    const { code } = parse(CodeBody, req.body);
    const s = req.session!;
    const users = usersOf(req);
    const user = await users.findOne({ _id: req.actor!.userId });
    const blob: string | undefined = s.mfaState === 'enroll' ? user?.mfa?.pendingSecret : user?.mfa?.secret;
    if (!blob) throw Errors.invalidCode();
    await consumeCode(req, req.actor!.userId, blob, code, 'auth.mfa.verify');
    if (s.mfaState === 'enroll') {
      await users.updateOne(
        { _id: req.actor!.userId },
        { $set: { 'mfa.secret': blob, 'mfa.enrolledAt': new Date() }, $unset: { 'mfa.pendingSecret': '' } },
      );
    }
    // Rotate the session token whenever the session gains privilege.
    const token = newToken();
    await data
      .control()
      .collection<SessionDoc>('sessions')
      .updateOne({ _id: s._id }, { $set: { tokenHash: sha256(token), mfaState: 'ok', mfaAt: new Date() } });
    await audit(deps, req, { action: 'auth.mfa.verify', resource: 'session', outcome: 'success', meta: { enrolled: s.mfaState === 'enroll' } });
    setSessionCookies(res, token, s.csrf);
    res.json({ data: { mfa: 'ok' } });
  });

  r.post('/reauth', limiter, requireAuth(), async (req, res) => {
    const { code } = parse(CodeBody, req.body);
    const user = await usersOf(req).findOne({ _id: req.actor!.userId });
    const blob: string | undefined = user?.mfa?.secret;
    if (!blob) throw Errors.conflict('MFA_NOT_ENROLLED', 'Set up an authenticator before making sensitive changes');
    await consumeCode(req, req.actor!.userId, blob, code, 'auth.reauth');
    await data.control().collection<SessionDoc>('sessions').updateOne({ _id: req.session!._id }, { $set: { mfaAt: new Date() } });
    await audit(deps, req, { action: 'auth.reauth', resource: 'session', outcome: 'success' });
    res.json({ data: { reauthenticatedAt: new Date().toISOString() } });
  });

  r.post('/logout', requireAuth({ allowIncompleteMfa: true }), async (req, res) => {
    await data.control().collection('sessions').deleteOne({ _id: req.session!._id });
    await audit(deps, req, { action: 'auth.logout', resource: 'session', outcome: 'success' });
    res.clearCookie(SESSION_COOKIE, cookieBase).clearCookie(CSRF_COOKIE, cookieBase).status(204).end();
  });

  r.post('/accept-invite', limiter, async (req, res) => {
    const body = parse(AcceptBody, req.body);
    const tenant = await data.control().collection('tenants').findOne({ slug: body.tenant, status: 'Active' });
    const db = tenant ? data.tenant(tenant.dbName) : null;
    const now = new Date();
    const result = db
      ? await db.collection('users').findOneAndUpdate(
          { tenantId: tenant!._id, status: 'Invited', 'invite.tokenHash': sha256(body.token), 'invite.expiresAt': { $gt: now } },
          { $set: { status: 'Active', passwordHash: await hashPassword(body.password), activatedAt: now }, $unset: { invite: '' }, $inc: { version: 1 } },
        )
      : null;
    if (!result || !db) throw new AppError(400, 'INVITE_INVALID', 'This invitation is invalid or has expired. Ask your administrator for a new one');
    await writeAudit(db, {
      tenantId: tenant!._id.toHexString(),
      actorId: result._id.toHexString(),
      actorRoles: result.roles,
      action: 'auth.invite.accept',
      resource: `user:${result._id.toHexString()}`,
      outcome: 'success',
      correlationId: req.correlationId,
    });
    res.json({ data: { activated: true, email: result.email } });
  });

  r.get('/me', requireAuth({ allowIncompleteMfa: true }), (req, res) => {
    const a = req.actor!;
    res.json({
      data: {
        id: a.userId.toHexString(),
        kind: a.kind,
        name: a.name,
        email: a.email,
        roles: a.roles,
        perms: a.perms,
        scope: a.scope,
        branchId: a.branchId?.toHexString() ?? null,
        patientIds: a.patientIds?.map((p) => p.toHexString()) ?? [],
        disabledModules: a.disabledModules ?? [],
        tenant: a.tenantId ? { id: a.tenantId.toHexString(), slug: a.tenantSlug, name: a.tenantName } : null,
        mfa: req.session!.mfaState,
        csrfToken: req.session!.csrf,
      },
    });
  });

  return r;
}
