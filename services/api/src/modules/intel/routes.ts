import { Router, type Request } from 'express';
import type { Document } from 'mongodb';
import { z } from 'zod';
import type { Deps } from '../../context';
import { Errors } from '../../lib/errors';
import { localDate } from '../../lib/time';
import { idParam, parse } from '../../lib/validate';
import { audit } from '../../middleware/audit';
import { deny } from '../../middleware/authorize';
import { CURRENCIES, type Currency } from '../accounting/ledger';
import { METRICS, SUPPRESSION_THRESHOLD, hospitalTz, metricDef } from './metrics';
import { assertKind, canSee, captureSnapshot, snapshotView, verifySnapshot, type SnapshotKind } from './snapshots';

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM');
const Kind = z.enum(['finance', 'disease', 'operations']);
const Capture = z.object({ kind: Kind, period: month, currency: z.enum(CURRENCIES).default('USD') });

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  // Guard spreadsheet formula injection as well as quoting.
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** Spec §5.29 reporting & BI: certified metric definitions and immutable monthly snapshots. */
export function intelRoutes(deps: Deps): Router {
  const r = Router();
  const db = (req: Request) => req.actor!.db!;

  async function anyIntel(req: Request) {
    const p = req.actor!.perms as never;
    if (!(['finance', 'disease', 'operations'] as SnapshotKind[]).some((k) => canSee(p, k))) await deny(deps, req, 'metrics', 'requires reporting or AI intelligence access');
  }

  r.get('/metrics', async (req, res) => {
    await anyIntel(req);
    res.json({ data: { suppressionThreshold: SUPPRESSION_THRESHOLD, metrics: METRICS } });
  });

  r.post('/snapshots', async (req, res) => {
    const body = parse(Capture, req.body);
    await assertKind(deps, req, body.kind, `snapshot:${body.kind}`);
    const tz = await hospitalTz(db(req), req.actor!.tenantId!);
    if (body.period > localDate(deps.config.now(), tz).slice(0, 7)) throw Errors.validation([{ path: 'period', message: 'That month has not started yet' }]);
    const s = await captureSnapshot(deps, req, body.kind, body.period, body.currency as Currency);
    if (!s.reused) await audit(deps, req, { action: 'bi.snapshot.capture', resource: `snapshot:${String(s._id)}`, outcome: 'success', meta: { kind: body.kind, period: body.period, seq: s.seq as number } });
    res.status(s.reused ? 200 : 201).json({ data: { ...snapshotView(s), reused: s.reused } });
  });

  r.get('/snapshots', async (req, res) => {
    const q = parse(z.object({ kind: Kind, period: month.optional() }), req.query);
    await assertKind(deps, req, q.kind, `snapshot:${q.kind}`);
    const f: Document = { tenantId: req.actor!.tenantId, kind: q.kind };
    if (q.period) f.period = q.period;
    const list = await db(req).collection('metric_snapshots').find(f, { projection: { facts: 0 } }).sort({ period: -1, seq: -1 }).limit(120).toArray();
    res.json({ data: list.map((s) => ({ ...snapshotView({ ...s, facts: undefined }), facts: undefined })) });
  });

  async function loadSnapshot(req: Request) {
    const s = await db(req).collection('metric_snapshots').findOne({ _id: idParam(req.params.id, 'Snapshot'), tenantId: req.actor!.tenantId });
    if (!s) throw Errors.notFound('Snapshot');
    await assertKind(deps, req, s.kind, `snapshot:${s._id.toHexString()}`);
    return s;
  }

  r.get('/snapshots/:id', async (req, res) => {
    res.json({ data: snapshotView(await loadSnapshot(req)) });
  });

  r.get('/snapshots/:id/verify', async (req, res) => {
    const s = await loadSnapshot(req);
    res.json({ data: { id: s._id.toHexString(), ...(await verifySnapshot(deps, req, s)) } });
  });

  /** Spec §5.29 "export only for authorized roles": every export is audited. */
  r.get('/snapshots/:id/export.csv', async (req, res) => {
    const s = await loadSnapshot(req);
    const rows: unknown[][] = [];
    if (s.kind === 'disease') {
      rows.push(['icd11', 'condition', 'confirmed_patients', 'confirmed_encounters', 'new_patients', 'suspected_patients', 'metric_version', 'period', 'snapshot_hash']);
      for (const x of s.facts.rows as Document[]) rows.push([x.code, x.display, x.confirmedPatients ?? `<${SUPPRESSION_THRESHOLD}`, x.confirmedEncounters ?? `<${SUPPRESSION_THRESHOLD}`, x.newPatients ?? `<${SUPPRESSION_THRESHOLD}`, x.suspectedPatients ?? `<${SUPPRESSION_THRESHOLD}`, s.metricVersion, s.period, s.hash]);
    } else {
      rows.push(['metric_id', 'label', 'unit', 'value', 'metric_version', 'period', 'currency', 'snapshot_hash']);
      for (const [k, v] of Object.entries(s.facts.metrics as Record<string, number | null>)) {
        const d = metricDef(k);
        rows.push([k, d?.label ?? k, d?.unit ?? '', v ?? 'unavailable', s.metricVersion, s.period, s.currency ?? '', s.hash]);
      }
    }
    await audit(deps, req, { action: 'bi.snapshot.export', resource: `snapshot:${s._id.toHexString()}`, outcome: 'success', meta: { kind: s.kind, period: s.period } });
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="fahan-${s.kind}-${s.period}-v${s.seq}.csv"`);
    res.send(`${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`);
  });

  return r;
}
