import { Router, type Request } from 'express';
import type { ObjectId } from 'mongodb';
import { z } from 'zod';
import { TENANT_ROLES, canGrantRole, effectiveScope, isBranchBound } from '@hospitalos/policy';
import type { Deps } from '../../context';
import { newToken, sha256 } from '../../lib/crypto';
import { AppError, Errors } from '../../lib/errors';
import { email, idParam, objectId, parse } from '../../lib/validate';
import { audit } from '../../middleware/audit';
import { assertBranch, branchFilter, need } from '../../middleware/authorize';
import { requireRecentMfa } from '../../middleware/session';

const INVITE_TTL_MS = 72 * 3_600_000;
const roleList = z.array(z.string().min(1).max(60)).min(1).max(10).transform((a) => [...new Set(a)]);
const InviteUser = z.object({
  email,
  name: z.string().trim().min(2).max(120),
  roles: roleList,
  branchId: objectId.optional(),
});
const SetRoles = z.object({ roles: roleList, branchId: objectId.optional(), version: z.number().int().positive() });

const PUBLIC = { email: 1, name: 1, roles: 1, status: 1, branchId: 1, createdAt: 1, activatedAt: 1, version: 1, 'mfa.enrolledAt': 1 } as const;
const out = ({ _id, branchId, mfa, ...u }: Record<string, any>) => ({
  id: _id.toHexString(),
  ...u,
  branchId: branchId?.toHexString() ?? null,
  mfaEnrolled: Boolean(mfa?.enrolledAt),
});

/** Spec §5.2 Identity, roles & permissions. Invited → Active → Suspended → Deactivated. */
export function iamRoutes(deps: Deps): Router {
  const r = Router();
  const users = (req: Request) => req.actor!.db!.collection('users');

  function checkCeiling(req: Request, roles: string[]) {
    for (const role of roles) {
      const d = canGrantRole(req.actor!.perms, role);
      if (!d.ok) throw new AppError(403, d.code, d.message);
    }
  }

  async function checkBranch(req: Request, roles: string[], branchId: ObjectId | undefined) {
    if (isBranchBound(effectiveScope(roles)) && !branchId) {
      throw Errors.validation([{ path: 'branchId', message: 'These roles work inside one branch. Choose the branch' }]);
    }
    if (branchId) {
      await assertBranch(deps, req, branchId);
      const b = await req.actor!.db!.collection('branches').findOne({ _id: branchId, tenantId: req.actor!.tenantId });
      if (!b) throw Errors.notFound('Branch');
    } else {
      await assertBranch(deps, req, null);
    }
  }

  async function loadTarget(req: Request) {
    const id = idParam(req.params.id, 'User');
    if (id.equals(req.actor!.userId)) throw Errors.forbidden('You cannot change your own access. Ask another administrator');
    const u = await users(req).findOne({ _id: id, tenantId: req.actor!.tenantId, ...branchFilter(req) });
    if (!u) throw Errors.notFound('User');
    checkCeiling(req, u.roles as string[]); // cannot manage someone more privileged than yourself
    return u;
  }

  r.get('/roles', need(deps, 'iam', 'V'), (_req, res) => {
    res.json({ data: TENANT_ROLES.map(({ id, tier, name, scope, mfa, perms, note, home }) => ({ id, tier, name, scope, mfa, perms, note, home })) });
  });

  r.get('/users', need(deps, 'iam', 'V'), async (req, res) => {
    const list = await users(req)
      .find({ tenantId: req.actor!.tenantId, ...branchFilter(req) }, { projection: PUBLIC })
      .sort({ name: 1 })
      .limit(1000)
      .toArray();
    res.json({ data: list.map(out) });
  });

  r.post('/users', need(deps, 'iam', 'E'), requireRecentMfa(deps), async (req, res) => {
    const body = parse(InviteUser, req.body);
    checkCeiling(req, body.roles);
    await checkBranch(req, body.roles, body.branchId);
    const token = newToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
    const doc = {
      tenantId: req.actor!.tenantId,
      email: body.email,
      name: body.name,
      roles: body.roles,
      branchId: body.branchId,
      status: 'Invited',
      invite: { tokenHash: sha256(token), expiresAt },
      createdAt: now,
      createdBy: req.actor!.userId,
      version: 1,
    };
    try {
      const ins = await users(req).insertOne(doc);
      await audit(deps, req, { action: 'iam.user.invite', resource: `user:${ins.insertedId.toHexString()}`, outcome: 'success', meta: { roles: body.roles.join(',') } });
      res.status(201).json({ data: { user: out({ _id: ins.insertedId, ...doc }), invite: { token, expiresAt: expiresAt.toISOString() } } });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw Errors.conflict('USER_EXISTS', `${body.email} already has an account in this hospital`);
      throw e;
    }
  });

  r.put('/users/:id/roles', need(deps, 'iam', 'E'), requireRecentMfa(deps), async (req, res) => {
    const body = parse(SetRoles, req.body);
    const target = await loadTarget(req);
    checkCeiling(req, body.roles);
    const branchId = body.branchId ?? (target.branchId as ObjectId | undefined);
    await checkBranch(req, body.roles, branchId);
    const upd = await users(req).findOneAndUpdate(
      { _id: target._id, version: body.version },
      { $set: { roles: body.roles, branchId, updatedAt: new Date(), updatedBy: req.actor!.userId }, $inc: { version: 1 } },
      { returnDocument: 'after', projection: PUBLIC },
    );
    if (!upd) throw Errors.conflict('VERSION_CONFLICT', 'This user was changed by someone else. Reload and try again');
    await audit(deps, req, {
      action: 'iam.user.roles',
      resource: `user:${target._id.toHexString()}`,
      outcome: 'success',
      meta: { from: (target.roles as string[]).join(','), to: body.roles.join(',') },
    });
    res.json({ data: out(upd) });
  });

  for (const [path, status] of [
    ['suspend', 'Suspended'],
    ['reactivate', 'Active'],
  ] as const) {
    r.post(`/users/:id/${path}`, need(deps, 'iam', 'E'), requireRecentMfa(deps), async (req, res) => {
      const target = await loadTarget(req);
      const from = status === 'Active' ? 'Suspended' : 'Active';
      const upd = await users(req).findOneAndUpdate(
        { _id: target._id, status: from },
        { $set: { status, updatedAt: new Date(), updatedBy: req.actor!.userId }, $inc: { version: 1 } },
        { returnDocument: 'after', projection: PUBLIC },
      );
      if (!upd) throw Errors.conflict('INVALID_TRANSITION', `User is not ${from.toLowerCase()}`);
      if (status === 'Suspended') await deps.data.control().collection('sessions').deleteMany({ userId: target._id });
      await audit(deps, req, { action: `iam.user.${path}`, resource: `user:${target._id.toHexString()}`, outcome: 'success' });
      res.json({ data: out(upd) });
    });
  }

  return r;
}
