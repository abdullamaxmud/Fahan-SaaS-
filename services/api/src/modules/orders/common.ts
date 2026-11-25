import type { Request } from 'express';
import type { Document, ObjectId } from 'mongodb';
import type { Deps } from '../../context';
import { Errors } from '../../lib/errors';
import { deny } from '../../middleware/authorize';
import { encLevelOk, loadPatient } from '../patients/access';

/**
 * Spec §4.2: every clinical order records ordering clinician, patient, encounter, priority and status.
 * Ordering needs a signing-level clinician on that visit (not a nurse or technician).
 */
export async function orderingContext(deps: Deps, req: Request, encounterId: ObjectId): Promise<{ e: Document; patient: Document }> {
  const a = req.actor!;
  const e = await a.db!.collection('encounters').findOne({ _id: encounterId, tenantId: a.tenantId });
  if (!e) throw Errors.notFound('Visit');
  const patient = await loadPatient(deps, req, e.patientId, { clinical: true });
  if (!encLevelOk(a.perms, e.type, 'S')) await deny(deps, req, `encounter:${e._id.toHexString()}`, 'ordering needs a clinician who signs on this visit');
  if (e.status === 'Closed') throw Errors.conflict('ENCOUNTER_CLOSED', 'This visit is closed. Open a new visit to order');
  return { e, patient };
}

/** Next number in a per-branch daily sequence, e.g. ACC-300107-00012. */
export async function nextNumber(req: Request, prefix: string, branchCode: string, day: string): Promise<string> {
  const c = await req
    .actor!.db!.collection<{ _id: string; seq: number }>('counters')
    .findOneAndUpdate({ _id: `${prefix}:${branchCode}:${day}` }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
  return `${prefix}-${branchCode}-${day.replace(/-/g, '').slice(2)}-${String(c!.seq).padStart(5, '0')}`;
}

export const PRIORITIES = ['routine', 'urgent', 'stat'] as const;
