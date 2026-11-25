import type { Request } from 'express';
import type { Document, ObjectId, WithId } from 'mongodb';
import { can, isBranchBound, levelRank, type Level, type ModuleKey, type Permissions } from '@fahan/policy';
import type { Deps } from '../../context';
import { Errors } from '../../lib/errors';
import { deny } from '../../middleware/authorize';

export type Patient = WithId<Document>;

/**
 * Mongo filter for the patients an actor may see (spec §3.4: access is relationship and purpose bound).
 *  - care-team scope (physicians, nurses…): only patients they are assigned to
 *  - branch / department scope: patients linked to their branch
 *  - hospital / tenant scope: all patients of the hospital
 */
export function patientScopeFilter(req: Request): Record<string, unknown> {
  const a = req.actor!;
  if (a.scope === 'assigned-patient' || a.scope === 'own-record') return { careTeam: a.userId };
  if (isBranchBound(a.scope)) return { branchIds: a.branchId ?? null };
  return {};
}

/** Visit types and the modules that govern them. */
export const ENC_TYPES = ['OPD', 'ER', 'IP'] as const;
const ENC_MODULES: Record<string, ModuleKey[]> = { OPD: ['opd', 'tele'], ER: ['er'], IP: ['opd', 'icu', 'mat', 'nur'] };
export const encModules = (type: string): ModuleKey[] => ENC_MODULES[type] ?? ['opd'];
export const encLevelOk = (perms: Permissions, type: string, level: Level): boolean =>
  encModules(type).some((m) => levelRank(perms[m]) >= levelRank(level));

/** An unexpired, self-declared emergency access grant (spec §3.4 break-glass). */
export async function hasBreakGlass(req: Request, patientId: ObjectId): Promise<boolean> {
  const a = req.actor!;
  const g = await a.db!.collection('break_glass').findOne({ tenantId: a.tenantId, userId: a.userId, patientId, expiresAt: { $gt: new Date() } });
  return Boolean(g);
}

/** Clinical content (notes, vitals, diagnoses, timeline) needs a clinical module, not just demographics. */
export function hasClinicalAccess(req: Request): boolean {
  const p = req.actor!.perms;
  return can(p, 'opd', 'V') || can(p, 'nur', 'V') || can(p, 'er', 'V') || can(p, 'icu', 'V') || can(p, 'mat', 'V');
}

/** Loads a patient the actor is allowed to reach, or answers 404/403 (and audits the refusal). */
export async function loadPatient(deps: Deps, req: Request, id: ObjectId, opts: { clinical?: boolean } = {}): Promise<Patient> {
  const a = req.actor!;
  const p = await a.db!.collection('patients').findOne({ _id: id, tenantId: a.tenantId });
  if (!p) throw Errors.notFound('Patient');
  if (opts.clinical && !hasClinicalAccess(req)) await deny(deps, req, `patient:${id.toHexString()}`, 'no clinical module');
  const scope = patientScopeFilter(req);
  if (opts.clinical && (await hasBreakGlass(req, id))) return p;
  if ('careTeam' in scope && !(p.careTeam as ObjectId[] | undefined)?.some((u) => u.equals(a.userId))) {
    await deny(deps, req, `patient:${id.toHexString()}`, 'no care relationship');
  }
  if ('branchIds' in scope && !(p.branchIds as ObjectId[]).some((b) => a.branchId?.equals(b))) {
    await deny(deps, req, `patient:${id.toHexString()}`, 'outside assigned branch');
  }
  return p;
}

/** Ids of this patient plus every record merged into it (merges link, they never move data). */
export async function linkedPatientIds(req: Request, survivorId: ObjectId): Promise<ObjectId[]> {
  const a = req.actor!;
  const merged = await a.db!.collection('patients').find({ tenantId: a.tenantId, mergedInto: survivorId }, { projection: { _id: 1 } }).toArray();
  return [survivorId, ...merged.map((m) => m._id)];
}

export function addToCareTeam(req: Request, patientId: ObjectId, userIds: ObjectId[]) {
  const a = req.actor!;
  return a.db!.collection('patients').updateOne({ _id: patientId, tenantId: a.tenantId }, { $addToSet: { careTeam: { $each: userIds } } });
}

export const normalizePhone = (s: string | undefined): string | undefined => {
  if (!s) return undefined;
  let d = s.replace(/\D/g, '').replace(/^00/, '');
  if (d.startsWith('0')) d = d.slice(1);
  if (d.length === 9) d = `252${d}`; // Somali national number without country code
  return d || undefined;
};

export const maskPhone = (d?: string) => (d ? `+${d.slice(0, 3)} ··· ··${d.slice(-2)}` : null);

export function publicPatient(p: Patient) {
  return {
    id: p._id.toHexString(),
    mrn: p.mrn,
    names: p.names,
    dob: p.dob,
    sexAtBirth: p.sexAtBirth ?? null,
    phone: p.phone ?? null,
    identifiers: p.identifiers ?? [],
    contacts: p.contacts ?? [],
    status: p.status,
    branchIds: (p.branchIds as ObjectId[]).map((b) => b.toHexString()),
    mergedInto: p.mergedInto?.toHexString() ?? null,
    createdAt: p.createdAt,
    version: p.version,
  };
}
