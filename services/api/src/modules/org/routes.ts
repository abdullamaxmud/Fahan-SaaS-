import { Router } from 'express';
import { isBranchBound } from '@fahan/policy';
import { z } from 'zod';
import type { Deps } from '../../context';
import { Errors } from '../../lib/errors';
import { objectId, parse } from '../../lib/validate';
import { audit } from '../../middleware/audit';
import { assertBranch, branchFilter, need } from '../../middleware/authorize';

const zones = new Set(Intl.supportedValuesOf('timeZone'));
const code = z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,12}$/, 'Use 2–12 letters, digits or hyphens');
const CreateBranch = z.object({
  code,
  name: z.string().trim().min(2).max(120),
  timezone: z.string().refine((tz) => zones.has(tz), 'Unknown timezone').default('Africa/Mogadishu'),
});
const CreateDepartment = z.object({ branchId: objectId, code, name: z.string().trim().min(2).max(120) });
const DeptQuery = z.object({ branchId: objectId.optional() });

const out = ({ _id, tenantId, ...rest }: Record<string, any>) => ({ id: _id.toHexString(), ...rest, branchId: rest.branchId?.toHexString?.() ?? rest.branchId });

/** Spec §5.1 Organization & facilities. Lifecycle Draft → Active → Suspended → Archived. */
export function orgRoutes(deps: Deps): Router {
  const r = Router();

  r.get('/branches', need(deps, 'org', 'V'), async (req, res) => {
    const a = req.actor!;
    const filter = isBranchBound(a.scope) ? { tenantId: a.tenantId, _id: { $in: a.branchId ? [a.branchId] : [] } } : { tenantId: a.tenantId };
    const list = await a.db!.collection('branches').find(filter).sort({ code: 1 }).limit(500).toArray();
    res.json({ data: list.map(out) });
  });

  /** Branch names for pickers, for any member of staff (codes and names only). */
  r.get('/lookup/branches', async (req, res) => {
    const a = req.actor!;
    const filter = isBranchBound(a.scope) && a.scope !== 'assigned-patient' ? { tenantId: a.tenantId, _id: { $in: a.branchId ? [a.branchId] : [] } } : { tenantId: a.tenantId, status: { $ne: 'Archived' } };
    const list = await a.db!.collection('branches').find(filter, { projection: { code: 1, name: 1, timezone: 1 } }).sort({ code: 1 }).limit(500).toArray();
    res.json({ data: list.map((b) => ({ id: b._id.toHexString(), code: b.code, name: b.name, timezone: b.timezone })) });
  });

  r.post('/branches', need(deps, 'org', 'E'), async (req, res) => {
    await assertBranch(deps, req, null); // creating a branch is hospital-wide work
    const body = parse(CreateBranch, req.body);
    const a = req.actor!;
    const doc = { tenantId: a.tenantId, ...body, status: 'Active', createdAt: new Date(), createdBy: a.userId, version: 1 };
    try {
      const ins = await a.db!.collection('branches').insertOne(doc);
      await audit(deps, req, { action: 'org.branch.create', resource: `branch:${ins.insertedId.toHexString()}`, outcome: 'success', meta: { code: body.code } });
      res.status(201).json({ data: out({ _id: ins.insertedId, ...doc }) });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw Errors.conflict('BRANCH_EXISTS', `Branch code ${body.code} is already used`);
      throw e;
    }
  });

  r.get('/departments', need(deps, 'org', 'V'), async (req, res) => {
    const q = parse(DeptQuery, req.query);
    const a = req.actor!;
    const filter = { tenantId: a.tenantId, ...(q.branchId ? { branchId: q.branchId } : {}), ...branchFilter(req) };
    const list = await a.db!.collection('departments').find(filter).sort({ code: 1 }).limit(1000).toArray();
    res.json({ data: list.map(out) });
  });

  r.post('/departments', need(deps, 'org', 'E'), async (req, res) => {
    const body = parse(CreateDepartment, req.body);
    await assertBranch(deps, req, body.branchId);
    const a = req.actor!;
    const branch = await a.db!.collection('branches').findOne({ _id: body.branchId, tenantId: a.tenantId });
    if (!branch) throw Errors.notFound('Branch');
    const doc = { tenantId: a.tenantId, ...body, status: 'Active', createdAt: new Date(), createdBy: a.userId, version: 1 };
    try {
      const ins = await a.db!.collection('departments').insertOne(doc);
      await audit(deps, req, { action: 'org.department.create', resource: `department:${ins.insertedId.toHexString()}`, outcome: 'success', meta: { code: body.code } });
      res.status(201).json({ data: out({ _id: ins.insertedId, ...doc }) });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw Errors.conflict('DEPARTMENT_EXISTS', `Department code ${body.code} is already used in this branch`);
      throw e;
    }
  });

  return r;
}
