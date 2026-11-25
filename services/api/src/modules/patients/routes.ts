import { Router } from 'express';
import { z } from 'zod';
import type { Deps } from '../../context';
import { Errors } from '../../lib/errors';
import { objectId, parse } from '../../lib/validate';
import { audit } from '../../middleware/audit';
import { assertBranch, branchFilter, need } from '../../middleware/authorize';

const CreatePatient = z.object({
  givenName: z.string().trim().min(1).max(80),
  familyName: z.string().trim().min(1).max(80),
  dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
  sexAtBirth: z.enum(['female', 'male', 'unknown']).optional(),
  branchId: objectId,
});

/**
 * Phase 1 slice of spec §5.3 — enough to prove authorization end to end (cashier denied,
 * clinicians limited to their care relationships). Full MPI, duplicates and merges land in Phase 2.
 */
export function patientRoutes(deps: Deps): Router {
  const r = Router();

  r.get('/', need(deps, 'mpi', 'V'), async (req, res) => {
    const a = req.actor!;
    // Patient access is relationship-bound (spec §3.4): care-team members see only their patients.
    const scopeFilter = a.scope === 'assigned-patient' ? { careTeam: a.userId } : branchFilter(req);
    const list = await a
      .db!.collection('patients')
      .find({ tenantId: a.tenantId, ...scopeFilter }, { projection: { mrn: 1, names: 1, dob: 1, sexAtBirth: 1, status: 1, branchId: 1 } })
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();
    res.json({ data: list.map(({ _id, branchId, ...p }) => ({ id: _id.toHexString(), ...p, branchId: branchId.toHexString() })) });
  });

  r.post('/', need(deps, 'mpi', 'E'), async (req, res) => {
    const body = parse(CreatePatient, req.body);
    await assertBranch(deps, req, body.branchId);
    const a = req.actor!;
    const branch = await a.db!.collection('branches').findOne({ _id: body.branchId, tenantId: a.tenantId });
    if (!branch) throw Errors.notFound('Branch');
    const yy = new Date().getUTCFullYear().toString().slice(2);
    const counter = await a
      .db!.collection<{ _id: string; seq: number }>('counters')
      .findOneAndUpdate({ _id: `mrn:${branch.code}:${yy}` }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
    const mrn = `${branch.code}-${yy}-${String(counter!.seq).padStart(6, '0')}`;
    const now = new Date();
    const doc = {
      tenantId: a.tenantId,
      branchId: body.branchId,
      mrn,
      names: { given: body.givenName, family: body.familyName },
      dob: body.dob,
      sexAtBirth: body.sexAtBirth,
      status: 'Provisional',
      careTeam: [],
      createdAt: now,
      createdBy: a.userId,
      version: 1,
    };
    const ins = await a.db!.collection('patients').insertOne(doc);
    await audit(deps, req, { action: 'mpi.patient.create', resource: `patient:${ins.insertedId.toHexString()}`, outcome: 'success', meta: { mrn } });
    res.status(201).json({ data: { id: ins.insertedId.toHexString(), mrn, status: doc.status } });
  });

  return r;
}
