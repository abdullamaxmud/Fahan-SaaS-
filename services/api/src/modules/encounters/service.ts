import type { Request } from 'express';
import type { ClientSession, ObjectId } from 'mongodb';

export type EncounterStatus = 'Open' | 'InProgress' | 'Signed' | 'Closed';

/** Opens an OPD encounter (spec §5.5). Used by walk-ins and by appointment check-in. */
export async function openEncounter(
  req: Request,
  e: { patientId: ObjectId; branchId: ObjectId; clinicianIds: ObjectId[]; appointmentId?: ObjectId; queueNo?: number; reason?: string },
  session?: ClientSession,
): Promise<ObjectId> {
  const a = req.actor!;
  const now = new Date();
  const ins = await a.db!.collection('encounters').insertOne(
    {
      tenantId: a.tenantId,
      type: 'OPD',
      status: 'Open' as EncounterStatus,
      patientId: e.patientId,
      branchId: e.branchId,
      appointmentId: e.appointmentId,
      clinicianIds: e.clinicianIds,
      queueNo: e.queueNo,
      reason: e.reason,
      startedAt: now,
      createdAt: now,
      createdBy: a.userId,
      version: 1,
    },
    { session },
  );
  await a.db!.collection('patients').updateOne(
    { _id: e.patientId, tenantId: a.tenantId },
    { $addToSet: { careTeam: { $each: e.clinicianIds } } },
    { session },
  );
  return ins.insertedId;
}

/** Daily queue ticket per branch (resets each local day). */
export async function nextQueueNo(req: Request, branchCode: string, localDay: string, session?: ClientSession): Promise<number> {
  const c = await req
    .actor!.db!.collection<{ _id: string; seq: number }>('counters')
    .findOneAndUpdate({ _id: `queue:${branchCode}:${localDay}` }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after', session });
  return c!.seq;
}
