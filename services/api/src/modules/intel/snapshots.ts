import type { Request } from 'express';
import type { Db, Document, ObjectId } from 'mongodb';
import { can } from '@fahan/policy';
import type { Deps } from '../../context';
import { Errors } from '../../lib/errors';
import { deny } from '../../middleware/authorize';
import type { Currency } from '../accounting/ledger';
import { computeDisease, computeFinance, computeOperations, factsHash, hospitalTz } from './metrics';

export type SnapshotKind = 'finance' | 'disease' | 'operations';
export const METRIC_VERSION: Record<SnapshotKind, string> = { finance: 'finance-v1', disease: 'disease-v1', operations: 'operations-v1' };

/** Who may see (and therefore capture) each kind of snapshot. Snapshots are aggregates; they hold no patient identifiers. */
export function canSee(perms: Record<string, string>, kind: SnapshotKind): boolean {
  // Raw snapshots stay with their own domain; the Hospital 360 report has its own gate and carries only what it needs.
  if (kind === 'finance') return can(perms as never, 'aifin', 'V') || can(perms as never, 'acct', 'V');
  if (kind === 'disease') return can(perms as never, 'aidis', 'V');
  return can(perms as never, 'bi', 'V') || can(perms as never, 'ai360', 'V');
}

export async function assertKind(deps: Deps, req: Request, kind: SnapshotKind, what: string) {
  if (!canSee(req.actor!.perms as never, kind)) await deny(deps, req, what, `no access to ${kind} metrics`);
}

async function compute(deps: Deps, db: Db, tenantId: ObjectId, kind: SnapshotKind, period: string, currency: Currency) {
  const tz = await hospitalTz(db, tenantId);
  if (kind === 'finance') return { tz, facts: (await computeFinance(db, tenantId, period, currency)) as unknown as Document };
  if (kind === 'disease') return { tz, facts: (await computeDisease(db, tenantId, period, tz)) as unknown as Document };
  return { tz, facts: (await computeOperations(db, tenantId, period, tz, deps.config.now())) as unknown as Document };
}

/**
 * Captures an immutable snapshot (spec §9.6 "capture immutable metric snapshot"). If nothing changed since the
 * latest snapshot for the same month, that snapshot is returned; late corrections create a new version.
 */
export async function captureSnapshot(deps: Deps, req: Request, kind: SnapshotKind, period: string, currency: Currency): Promise<Document & { reused: boolean }> {
  const a = req.actor!;
  const db = a.db!;
  const cur = kind === 'finance' ? currency : null;
  const { tz, facts } = await compute(deps, db, a.tenantId!, kind, period, currency);
  const body = { kind, period, currency: cur, metricVersion: METRIC_VERSION[kind], timezone: tz, facts };
  const hash = factsHash(body);
  for (let attempt = 0; attempt < 3; attempt++) {
    const latest = await db.collection('metric_snapshots').findOne({ tenantId: a.tenantId, kind, period, currency: cur }, { sort: { seq: -1 } });
    if (latest?.hash === hash) return { ...latest, reused: true };
    const doc = { tenantId: a.tenantId, ...body, hash, seq: ((latest?.seq as number) ?? 0) + 1, supersedes: latest?._id ?? null, capturedAt: new Date(), capturedBy: a.userId, capturedByName: a.name };
    try {
      const ins = await db.collection('metric_snapshots').insertOne(doc);
      return { _id: ins.insertedId, ...doc, reused: false };
    } catch (e) {
      if ((e as { code?: number }).code !== 11000) throw e;
    }
  }
  throw Errors.conflict('SNAPSHOT_BUSY', 'Someone else is capturing this month right now; try again');
}

/** Recomputes the hash of what is stored (integrity) and of the live data (has anything been corrected since?). */
export async function verifySnapshot(deps: Deps, req: Request, s: Document) {
  const a = req.actor!;
  const stored = factsHash({ kind: s.kind, period: s.period, currency: s.currency, metricVersion: s.metricVersion, timezone: s.timezone, facts: s.facts });
  const { tz, facts } = await compute(deps, a.db!, a.tenantId!, s.kind, s.period, (s.currency ?? 'USD') as Currency);
  const live = factsHash({ kind: s.kind, period: s.period, currency: s.currency, metricVersion: s.metricVersion, timezone: tz, facts });
  return { intact: stored === s.hash, matchesLiveData: live === s.hash };
}

export const snapshotView = (s: Document) => ({
  id: (s._id as ObjectId).toHexString(),
  kind: s.kind,
  period: s.period,
  currency: s.currency,
  metricVersion: s.metricVersion,
  timezone: s.timezone,
  seq: s.seq,
  hash: s.hash,
  supersedes: s.supersedes ? (s.supersedes as ObjectId).toHexString() : null,
  capturedAt: s.capturedAt,
  capturedByName: s.capturedByName,
  facts: s.facts,
});
