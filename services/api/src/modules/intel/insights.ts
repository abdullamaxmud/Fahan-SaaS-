import { Router, type Request } from 'express';
import type { Document, ObjectId } from 'mongodb';
import { z } from 'zod';
import { can, type Level, type ModuleKey } from '@fahan/policy';
import type { Deps } from '../../context';
import { AppError, Errors } from '../../lib/errors';
import { idParam, objectId, parse } from '../../lib/validate';
import { audit } from '../../middleware/audit';
import { deny } from '../../middleware/authorize';
import { assertRecentMfa } from '../../middleware/session';
import { factsHash } from './metrics';
import { checkNarrative, diseaseFacts, financeFacts, templateProvider, type Fact, type NarrativeProvider } from './narrative';
import { assertKind } from './snapshots';

type InsightKind = 'finance' | 'disease';
interface Step {
  from: string;
  to: string;
  perm: [ModuleKey, Level];
  /** A different person from whoever took the previous step. */
  distinct?: boolean;
  mfa?: boolean;
}
/** Spec §5.30 (Queued → Generated → Reviewed → Published) and §5.31 (Computed → Validated → Reviewed). */
export const FLOW: Record<InsightKind, { generate: [ModuleKey, Level]; steps: Step[]; final: string }> = {
  finance: {
    generate: ['aifin', 'V'],
    steps: [
      { from: 'Generated', to: 'Reviewed', perm: ['acct', 'S'] },
      { from: 'Reviewed', to: 'Published', perm: ['acct', 'S'], distinct: true, mfa: true },
    ],
    final: 'Published',
  },
  disease: {
    generate: ['aidis', 'V'],
    steps: [
      { from: 'Generated', to: 'Validated', perm: ['aidis', 'S'] },
      { from: 'Validated', to: 'Reviewed', perm: ['aidis', 'A'], distinct: true, mfa: true },
    ],
    final: 'Reviewed',
  },
};
export const AI_DISCLOSURE = 'Written by AI from certified metric snapshots. Every figure is listed with its metric id; a person reviewed it before release.';

const id = (x: Document) => (x._id as ObjectId).toHexString();

/** The intact-check used before every step: the snapshot must still hash to what the insight was written from. */
export async function snapshotIntact(req: Request, snapshotId: ObjectId, expected: string) {
  const s = await req.actor!.db!.collection('metric_snapshots').findOne({ _id: snapshotId });
  return Boolean(s && s.hash === expected && factsHash({ kind: s.kind, period: s.period, currency: s.currency, metricVersion: s.metricVersion, timezone: s.timezone, facts: s.facts }) === expected);
}

/** Writes and checks a narrative for one snapshot. Exported for the Hospital 360 report. */
export async function writeInsight(req: Request, snap: Document, provider: NarrativeProvider = templateProvider) {
  const db = req.actor!.db!;
  let facts: Fact[];
  let identifiers: string[] = [];
  if (snap.kind === 'finance') {
    const [y, m] = (snap.period as string).split('-').map(Number);
    const prevKey = new Date(Date.UTC(y!, m! - 2, 1)).toISOString().slice(0, 7);
    const prev = await db.collection('metric_snapshots').findOne({ tenantId: snap.tenantId, kind: 'finance', period: prevKey, currency: snap.currency }, { sort: { seq: -1 } });
    facts = financeFacts(snap, prev);
  } else {
    ({ facts, identifiers } = diseaseFacts(snap));
  }
  const narrative = await provider.write(snap.kind, { period: snap.period, facts, identifiers });
  const check = checkNarrative(narrative, facts, snap.period, identifiers);
  const cited = new Set(narrative.sections.flatMap((s) => s.sentences.flatMap((x) => x.cites)));
  return { narrative, check, citedFacts: facts.filter((f) => cited.has(f.id)) };
}

export function insightRoutes(deps: Deps): Router {
  const r = Router();
  const db = (req: Request) => req.actor!.db!;

  const view = (x: Document) => ({
    id: id(x as { _id: ObjectId }),
    kind: x.kind,
    period: x.period,
    currency: x.currency,
    status: x.status,
    snapshotId: (x.snapshotId as ObjectId).toHexString(),
    snapshotSeq: x.snapshotSeq,
    snapshotHash: x.snapshotHash,
    provider: x.provider,
    template: x.template,
    disclosure: AI_DISCLOSURE,
    sections: x.sections,
    citedFacts: x.citedFacts,
    check: x.check,
    history: (x.history as Document[]).map((h) => ({ at: h.at, action: h.action, byName: h.byName, note: h.note ?? null })),
    createdAt: x.createdAt,
  });

  async function load(req: Request) {
    const x = await db(req).collection('ai_insights').findOne({ _id: idParam(req.params.id, 'Insight'), tenantId: req.actor!.tenantId });
    if (!x) throw Errors.notFound('Insight');
    await assertKind(deps, req, x.kind, `insight:${id(x)}`);
    return x;
  }

  r.post('/', async (req, res) => {
    const { snapshotId } = parse(z.object({ snapshotId: objectId }), req.body);
    const a = req.actor!;
    const snap = await db(req).collection('metric_snapshots').findOne({ _id: snapshotId, tenantId: a.tenantId });
    if (!snap) throw Errors.notFound('Snapshot');
    if (snap.kind !== 'finance' && snap.kind !== 'disease') throw Errors.validation([{ path: 'snapshotId', message: 'AI summaries are written for finance and disease snapshots' }]);
    const flow = FLOW[snap.kind as InsightKind];
    if (!can(a.perms, flow.generate[0], flow.generate[1])) await deny(deps, req, `snapshot:${id(snap)}`, `requires ${flow.generate.join(':')}`);
    if (!(await snapshotIntact(req, snap._id, snap.hash))) throw new AppError(409, 'SNAPSHOT_TAMPERED', 'This snapshot no longer matches its fingerprint; capture a new one');
    const { narrative, check, citedFacts } = await writeInsight(req, snap);
    const doc = {
      tenantId: a.tenantId,
      kind: snap.kind,
      period: snap.period,
      currency: snap.currency,
      snapshotId: snap._id,
      snapshotSeq: snap.seq,
      snapshotHash: snap.hash,
      provider: narrative.provider,
      template: narrative.template,
      sections: narrative.sections,
      citedFacts,
      check,
      // A draft whose numbers do not match the snapshot never goes to review.
      status: check.ok ? 'Generated' : 'Failed',
      history: [{ at: new Date(), action: check.ok ? 'generated' : 'failed-check', by: a.userId, byName: a.name }],
      createdBy: a.userId,
      createdAt: new Date(),
    };
    const ins = await db(req).collection('ai_insights').insertOne(doc);
    await audit(deps, req, { action: `ai.${snap.kind}.generate`, resource: `insight:${ins.insertedId.toHexString()}`, outcome: 'success', meta: { period: snap.period as string, checkOk: check.ok, template: narrative.template } });
    res.status(201).json({ data: view({ _id: ins.insertedId, ...doc }) });
  });

  r.get('/', async (req, res) => {
    const q = parse(z.object({ kind: z.enum(['finance', 'disease']) }), req.query);
    await assertKind(deps, req, q.kind, `insights:${q.kind}`);
    const list = await db(req).collection('ai_insights').find({ tenantId: req.actor!.tenantId, kind: q.kind }).sort({ createdAt: -1 }).limit(100).toArray();
    res.json({ data: list.map(view) });
  });

  r.get('/:id', async (req, res) => {
    res.json({ data: view(await load(req)) });
  });

  async function step(req: Request, x: Document) {
    const flow = FLOW[x.kind as InsightKind];
    const s = flow.steps.find((st) => st.from === x.status);
    if (!s) throw Errors.conflict('INVALID_TRANSITION', x.status === flow.final ? 'Released insights cannot be changed; generate a new one' : `Insight is ${String(x.status).toLowerCase()}`);
    if (!can(req.actor!.perms, s.perm[0], s.perm[1])) await deny(deps, req, `insight:${id(x as { _id: ObjectId })}`, `moving to ${s.to} requires ${s.perm.join(':')}`);
    return s;
  }

  r.post('/:id/advance', async (req, res) => {
    const { note } = parse(z.object({ note: z.string().trim().max(500).optional() }), req.body);
    const x = await load(req);
    const s = await step(req, x);
    const a = req.actor!;
    const last = (x.history as Document[]).at(-1)!;
    if (s.distinct && (last.by as ObjectId).equals(a.userId)) throw new AppError(403, 'FOUR_EYES', 'A different person takes this step');
    if (s.mfa) assertRecentMfa(deps, req);
    if (!(await snapshotIntact(req, x.snapshotId, x.snapshotHash))) throw new AppError(409, 'SNAPSHOT_TAMPERED', 'The source snapshot changed after this summary was written; it cannot be released');
    const upd = await db(req).collection('ai_insights').updateOne({ _id: x._id, status: s.from }, { $set: { status: s.to }, $push: { history: { at: new Date(), action: s.to.toLowerCase(), by: a.userId, byName: a.name, note } } as Document });
    if (!upd.modifiedCount) throw Errors.conflict('INVALID_TRANSITION', 'Someone else moved this insight meanwhile');
    await audit(deps, req, { action: `ai.${x.kind}.${s.to.toLowerCase()}`, resource: `insight:${id(x)}`, outcome: 'success', meta: { period: x.period as string } });
    res.json({ data: { id: id(x), status: s.to } });
  });

  r.post('/:id/reject', async (req, res) => {
    const { note } = parse(z.object({ note: z.string().trim().min(5).max(500) }), req.body);
    const x = await load(req);
    await step(req, x);
    const a = req.actor!;
    const upd = await db(req).collection('ai_insights').updateOne({ _id: x._id, status: x.status }, { $set: { status: 'Rejected' }, $push: { history: { at: new Date(), action: 'rejected', by: a.userId, byName: a.name, note } } as Document });
    if (!upd.modifiedCount) throw Errors.conflict('INVALID_TRANSITION', 'Someone else moved this insight meanwhile');
    await audit(deps, req, { action: `ai.${x.kind}.reject`, resource: `insight:${id(x)}`, outcome: 'success', meta: { period: x.period as string } });
    res.json({ data: { id: id(x), status: 'Rejected' } });
  });

  return r;
}
