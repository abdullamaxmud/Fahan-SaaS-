import { Router } from 'express';
import { z } from 'zod';
import { verifyAuditChain, writeAudit } from '../../audit/audit';
import type { Deps } from '../../context';
import { tenantDbName } from '../../db/mongo';
import { newToken, sha256 } from '../../lib/crypto';
import { Errors } from '../../lib/errors';
import { email, idParam, parse, slug } from '../../lib/validate';
import { audit } from '../../middleware/audit';
import { need } from '../../middleware/authorize';
import { requireRecentMfa } from '../../middleware/session';

const INVITE_TTL_MS = 72 * 3_600_000;

const CreateTenant = z.object({
  slug,
  name: z.string().trim().min(2).max(120),
  admin: z.object({ email, name: z.string().trim().min(2).max(120) }),
});
const TenantStatus = z.object({ status: z.enum(['Active', 'Suspended']) });
const OversightInvite = z.object({ email, name: z.string().trim().min(2).max(120), role: z.enum(['security-auditor', 'dpo']) });

/** Platform console (spec §3.1). Tenant metadata only — the control plane carries no clinical data. */
export function platformRoutes(deps: Deps): Router {
  const { data } = deps;
  const r = Router();
  const tenants = () => data.control().collection('tenants');

  r.get('/tenants', need(deps, 'plat', 'V'), async (_req, res) => {
    const list = await tenants()
      .find({}, { projection: { slug: 1, name: 1, status: 1, isolation: 1, createdAt: 1 } })
      .sort({ createdAt: -1 })
      .limit(500)
      .toArray();
    res.json({ data: list.map(({ _id, ...t }) => ({ id: _id.toHexString(), ...t })) });
  });

  r.post('/tenants', need(deps, 'plat', 'A'), requireRecentMfa(deps), async (req, res) => {
    const body = parse(CreateTenant, req.body);
    const now = new Date();
    const dbName = tenantDbName(body.slug);
    let tenantId;
    try {
      const ins = await tenants().insertOne({
        slug: body.slug,
        name: body.name,
        dbName,
        isolation: 'dedicated-db',
        status: 'Active',
        createdAt: now,
        createdBy: req.actor!.userId,
        version: 1,
      });
      tenantId = ins.insertedId;
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw Errors.conflict('TENANT_EXISTS', `A hospital with code "${body.slug}" already exists`);
      throw e;
    }

    const tdb = data.tenant(dbName);
    await data.ensureTenantIndexes(tdb);
    const inviteToken = newToken();
    const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
    const admin = await tdb.collection('users').insertOne({
      tenantId,
      email: body.admin.email,
      name: body.admin.name,
      roles: ['super-admin'],
      status: 'Invited',
      invite: { tokenHash: sha256(inviteToken), expiresAt },
      createdAt: now,
      createdBy: req.actor!.userId,
      version: 1,
    });

    await audit(deps, req, { action: 'platform.tenant.create', resource: `tenant:${tenantId.toHexString()}`, outcome: 'success', meta: { slug: body.slug } });
    await writeAudit(tdb, {
      tenantId: tenantId.toHexString(),
      actorId: req.actor!.userId.toHexString(),
      actorRoles: req.actor!.roles,
      action: 'tenant.provisioned',
      resource: `user:${admin.insertedId.toHexString()}`,
      outcome: 'success',
      correlationId: req.correlationId,
      meta: { firstAdmin: body.admin.email },
    });

    res.status(201).json({
      data: {
        tenant: { id: tenantId.toHexString(), slug: body.slug, name: body.name, isolation: 'dedicated-db' },
        // Shown once. In production this is delivered by email, never stored in plain text.
        adminInvite: { email: body.admin.email, token: inviteToken, expiresAt: expiresAt.toISOString() },
      },
    });
  });

  r.patch('/tenants/:id/status', need(deps, 'plat', 'A'), requireRecentMfa(deps), async (req, res) => {
    const id = idParam(req.params.id, 'Tenant');
    const { status } = parse(TenantStatus, req.body);
    const t = await tenants().findOneAndUpdate({ _id: id }, { $set: { status, updatedAt: new Date() }, $inc: { version: 1 } }, { returnDocument: 'after' });
    if (!t) throw Errors.notFound('Tenant');
    if (status === 'Suspended') await data.control().collection('sessions').deleteMany({ tenantId: id });
    await audit(deps, req, { action: 'platform.tenant.status', resource: `tenant:${id.toHexString()}`, outcome: 'success', meta: { status } });
    res.json({ data: { id: id.toHexString(), status: t.status } });
  });

  /**
   * Independent oversight (spec §3.3 audit explorer "independent oversight", §11): the people who
   * review a hospital's administrators are appointed from outside that hospital, by the platform owner.
   */
  r.post('/tenants/:id/oversight-invite', need(deps, 'plat', 'A'), requireRecentMfa(deps), async (req, res) => {
    const id = idParam(req.params.id, 'Tenant');
    const body = parse(OversightInvite, req.body);
    const t = await tenants().findOne({ _id: id, status: 'Active' });
    if (!t) throw Errors.notFound('Tenant');
    const tdb = data.tenant(t.dbName);
    const token = newToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
    try {
      const ins = await tdb.collection('users').insertOne({
        tenantId: id,
        email: body.email,
        name: body.name,
        roles: [body.role],
        status: 'Invited',
        invite: { tokenHash: sha256(token), expiresAt },
        appointedBy: 'platform',
        createdAt: now,
        createdBy: req.actor!.userId,
        version: 1,
      });
      await audit(deps, req, { action: 'platform.oversight.appoint', resource: `tenant:${id.toHexString()}`, outcome: 'success', meta: { role: body.role } });
      await writeAudit(tdb, {
        tenantId: id.toHexString(),
        actorId: req.actor!.userId.toHexString(),
        actorRoles: req.actor!.roles,
        action: 'iam.oversight.appointed',
        resource: `user:${ins.insertedId.toHexString()}`,
        outcome: 'success',
        correlationId: req.correlationId,
        meta: { role: body.role },
      });
      res.status(201).json({ data: { user: { id: ins.insertedId.toHexString(), version: 1 }, invite: { token, expiresAt: expiresAt.toISOString() } } });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw Errors.conflict('USER_EXISTS', `${body.email} already has an account in this hospital`);
      throw e;
    }
  });

  r.get('/audit/verify', need(deps, 'sec', 'V'), async (_req, res) => {
    res.json({ data: await verifyAuditChain(data.control()) });
  });

  return r;
}
