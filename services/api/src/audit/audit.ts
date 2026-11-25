import type { Db } from 'mongodb';
import { canonicalJson, sha256, stripUndefined } from '../lib/crypto';

export type AuditOutcome = 'success' | 'failure' | 'allow' | 'deny';

export interface AuditInput {
  tenantId?: string;
  actorId: string | null;
  actorRoles?: string[];
  action: string;
  resource: string;
  outcome: AuditOutcome;
  correlationId?: string;
  /** Flat, non-sensitive context only. Never put clinical content or secrets here. */
  meta?: Record<string, string | number | boolean | null>;
}

const GENESIS = 'GENESIS';
const COL = 'audit_events';

/**
 * Append-only, hash-chained audit log (spec §11.1). Each event's hash covers the previous hash,
 * so editing or deleting any event breaks verification from that point on. A unique index on
 * `seq` stops two writers from forking the chain; the loser retries on the new head.
 */
export async function writeAudit(db: Db, input: AuditInput): Promise<void> {
  const col = db.collection(COL);
  for (let attempt = 0; attempt < 25; attempt++) {
    const last = await col.find({}, { projection: { seq: 1, hash: 1 } }).sort({ seq: -1 }).limit(1).next();
    const seq = ((last?.seq as number | undefined) ?? 0) + 1;
    const prevHash = (last?.hash as string | undefined) ?? GENESIS;
    const body = stripUndefined({ ...input, meta: input.meta ?? {}, seq, occurredAt: new Date().toISOString() });
    const hash = sha256(prevHash + canonicalJson(body));
    try {
      await col.insertOne({ ...body, occurredAt: new Date(body.occurredAt), prevHash, hash });
      return;
    } catch (e) {
      if ((e as { code?: number }).code === 11000) continue;
      throw e;
    }
  }
  throw new Error('Audit log contention: could not append event');
}

export interface ChainCheck {
  ok: boolean;
  count: number;
  brokenAtSeq?: number;
}

export async function verifyAuditChain(db: Db): Promise<ChainCheck> {
  let prev = GENESIS;
  let expectedSeq = 1;
  let count = 0;
  for await (const doc of db.collection(COL).find({}).sort({ seq: 1 })) {
    const { _id, prevHash, hash, occurredAt, ...rest } = doc;
    const body = { ...rest, occurredAt: (occurredAt as Date).toISOString() };
    const recomputed = sha256(prev + canonicalJson(body));
    if (doc.seq !== expectedSeq || prevHash !== prev || hash !== recomputed) {
      return { ok: false, count, brokenAtSeq: doc.seq as number };
    }
    prev = hash as string;
    expectedSeq++;
    count++;
  }
  return { ok: true, count };
}
