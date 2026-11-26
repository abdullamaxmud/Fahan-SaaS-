import { createHash } from 'node:crypto';
import { Router, type Request } from 'express';
import type { Document, ObjectId } from 'mongodb';
import { z } from 'zod';
import type { Deps } from '../../context';
import { AppError, Errors } from '../../lib/errors';
import { idParam, objectId, parse } from '../../lib/validate';
import { audit } from '../../middleware/audit';
import { assertBranch, need } from '../../middleware/authorize';
import { assertRecentMfa } from '../../middleware/session';
import { normalizePhone } from '../patients/access';
import { BLOCK_SCORE, dupInput, findDuplicates } from '../patients/routes';

/**
 * Spec §15 Phase 7 "data migration with verification": legacy patient lists come in as CSV, are validated in a dry run
 * (format, duplicates in the batch, already-imported legacy ids, likely duplicates in the MPI), committed by a second
 * person, reconciled by count and fingerprint, re-verifiable at any time, and rolled back only where nothing has used them.
 */
export const COLUMNS = ['legacy_id', 'given_name', 'middle_name', 'family_name', 'dob', 'sex', 'phone'] as const;
const MAX_ROWS = 50_000;

/** RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let f = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (q) {
      if (ch === '"' && text[i + 1] === '"') {
        f += '"';
        i++;
      } else if (ch === '"') q = false;
      else f += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      row.push(f);
      f = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(f);
      rows.push(row);
      row = [];
      f = '';
    } else f += ch;
  }
  if (f !== '' || row.length) {
    row.push(f);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const SEX: Record<string, string> = { m: 'male', male: 'male', lab: 'male', f: 'female', female: 'female', dhedig: 'female', u: 'unknown', unknown: 'unknown', '': 'unknown' };
const NAME = /^[\p{L}][\p{L}' .-]{0,59}$/u;

function normalise(raw: Record<string, string>, today: string) {
  const errors: string[] = [];
  const v = (k: string) => (raw[k] ?? '').trim().replace(/\s+/g, ' ');
  const legacyId = v('legacy_id');
  const given = v('given_name');
  const middle = v('middle_name');
  const family = v('family_name');
  const dobRaw = v('dob');
  const sexRaw = v('sex').toLowerCase();
  if (!/^[A-Za-z0-9._/-]{1,40}$/.test(legacyId)) errors.push('legacy_id is missing or has unusual characters');
  if (!NAME.test(given)) errors.push('given_name is missing or not a name');
  if (middle && !NAME.test(middle)) errors.push('middle_name is not a name');
  if (!NAME.test(family)) errors.push('family_name is missing or not a name');
  // Accept ISO dates and the common DD/MM/YYYY; never guess between day and month otherwise.
  let dob = dobRaw;
  const dm = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(dobRaw);
  if (dm) dob = `${dm[3]}-${dm[2]!.padStart(2, '0')}-${dm[1]!.padStart(2, '0')}`;
  const d = new Date(`${dob}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== dob) errors.push(`dob "${dobRaw}" is not a real date (use YYYY-MM-DD or DD/MM/YYYY)`);
  else if (dob > today) errors.push('dob is in the future');
  else if (dob < '1890-01-01') errors.push('dob is implausibly old');
  const sex = SEX[sexRaw];
  if (!sex) errors.push(`sex "${v('sex')}" is not M, F or unknown`);
  const phone = v('phone') ? normalizePhone(v('phone')) : undefined;
  if (v('phone') && (!phone || phone.length < 9)) errors.push('phone is not a valid number');
  return { errors, value: { legacyId, givenName: given, middleName: middle || undefined, familyName: family, dob, sexAtBirth: sex ?? 'unknown', phone } };
}

const line = (x: { legacyId: string; givenName: string; middleName?: string; familyName: string; dob: string; sexAtBirth: string }) => [x.legacyId, x.givenName, x.middleName ?? '', x.familyName, x.dob, x.sexAtBirth].join('|');
const fingerprint = (lines: string[]) => createHash('sha256').update([...lines].sort().join('\n')).digest('hex');
const id = (x: Document) => (x._id as ObjectId).toHexString();

export function migrationRoutes(deps: Deps): Router {
  const r = Router();
  const db = (req: Request) => req.actor!.db!;
  const batches = (req: Request) => db(req).collection('migration_batches');
  const rows = (req: Request) => db(req).collection('migration_rows');

  const view = (b: Document) => ({
    id: id(b),
    source: b.source,
    branchId: (b.branchId as ObjectId).toHexString(),
    status: b.status,
    counts: b.counts,
    report: b.report ?? null,
    createdByName: b.createdByName,
    history: ((b.history as Document[]) ?? []).map((h) => ({ at: h.at, action: h.action, byName: h.byName, note: h.note ?? null })),
  });
  const push = (req: Request, action: string, note?: string) => ({ history: { at: new Date(), action, by: req.actor!.userId, byName: req.actor!.name, note } });
  async function counts(req: Request, batchId: ObjectId) {
    const agg = await rows(req).aggregate([{ $match: { batchId } }, { $group: { _id: '$status', n: { $sum: 1 } } }]).toArray();
    const c: Record<string, number> = { total: 0 };
    for (const x of agg) {
      c[x._id as string] = x.n as number;
      c.total! += x.n as number;
    }
    return c;
  }
  async function load(req: Request) {
    const b = await batches(req).findOne({ _id: idParam(req.params.id, 'Batch'), tenantId: req.actor!.tenantId });
    if (!b) throw Errors.notFound('Migration batch');
    return b;
  }

  r.get('/batches', need(deps, 'mpi', 'A'), async (req, res) => {
    const list = await batches(req).find({ tenantId: req.actor!.tenantId }).sort({ createdAt: -1 }).limit(50).toArray();
    res.json({ data: list.map(view) });
  });

  r.get('/batches/:id', need(deps, 'mpi', 'A'), async (req, res) => {
    res.json({ data: view(await load(req)) });
  });

  r.post('/batches', need(deps, 'mpi', 'A'), async (req, res) => {
    const body = parse(z.object({ source: z.string().trim().regex(/^[a-z0-9-]{2,30}$/, 'Use a short code such as legacy-his'), branchId: objectId }), req.body);
    await assertBranch(deps, req, body.branchId);
    const a = req.actor!;
    if (!(await db(req).collection('branches').findOne({ _id: body.branchId, tenantId: a.tenantId }))) throw Errors.notFound('Branch');
    const doc = { tenantId: a.tenantId, ...body, status: 'Draft', counts: { total: 0 }, createdBy: a.userId, createdByName: a.name, createdAt: new Date(), history: [push(req, 'created').history] };
    const ins = await batches(req).insertOne(doc);
    res.status(201).json({ data: view({ _id: ins.insertedId, ...doc }) });
  });

  /** Upload a CSV chunk (header row required) — repeat for large files. */
  r.post('/batches/:id/rows', need(deps, 'mpi', 'A'), async (req, res) => {
    const { csv } = parse(z.object({ csv: z.string().min(10).max(90_000) }), req.body);
    const b = await load(req);
    if (!['Draft', 'Validated'].includes(b.status)) throw Errors.conflict('INVALID_TRANSITION', 'Rows are added before the batch is committed');
    const table = parseCsv(csv);
    const header = (table.shift() ?? []).map((h) => h.trim().toLowerCase());
    const missing = ['legacy_id', 'given_name', 'family_name', 'dob', 'sex'].filter((c) => !header.includes(c));
    if (missing.length) throw Errors.validation([{ path: 'csv', message: `The header row needs ${missing.join(', ')}` }]);
    const unknown = header.filter((h) => !(COLUMNS as readonly string[]).includes(h));
    if (unknown.length) throw Errors.validation([{ path: 'csv', message: `Unknown columns: ${unknown.join(', ')}` }]);
    const start = ((b.counts?.total as number) ?? 0) + 1;
    if (start - 1 + table.length > MAX_ROWS) throw Errors.validation([{ path: 'csv', message: `A batch holds at most ${MAX_ROWS} rows; start another batch` }]);
    if (table.length) {
      await rows(req).insertMany(
        table.map((cells, i) => ({ tenantId: b.tenantId, batchId: b._id, rowNo: start + i, raw: Object.fromEntries(header.map((h, j) => [h, cells[j] ?? ''])), status: 'pending' })),
      );
    }
    const c = await counts(req, b._id);
    await batches(req).updateOne({ _id: b._id }, { $set: { counts: c, status: 'Draft' }, $push: push(req, 'rows-added', `${table.length} rows`) as Document });
    res.status(201).json({ data: { added: table.length, counts: c } });
  });

  /** Dry run: nothing is written to the patient index. */
  r.post('/batches/:id/validate', need(deps, 'mpi', 'A'), async (req, res) => {
    const b = await load(req);
    if (!['Draft', 'Validated'].includes(b.status)) throw Errors.conflict('INVALID_TRANSITION', `Batch is ${String(b.status).toLowerCase()}`);
    const today = new Date().toISOString().slice(0, 10);
    const all = await rows(req).find({ batchId: b._id }).sort({ rowNo: 1 }).toArray();
    const seen = new Map<string, number>();
    const seenPerson = new Map<string, number>();
    for (const row of all) {
      const { errors, value } = normalise(row.raw, today);
      if (value.legacyId) {
        if (seen.has(value.legacyId)) errors.push(`legacy_id repeats row ${seen.get(value.legacyId)}`);
        else seen.set(value.legacyId, row.rowNo);
        if (await db(req).collection('migration_links').findOne({ tenantId: b.tenantId, source: b.source, legacyId: value.legacyId })) errors.push('this legacy_id was already imported');
      }
      let candidates: Document[] = [];
      if (!errors.length) {
        const personKey = `${value.givenName.toLowerCase()}|${value.familyName.toLowerCase()}|${value.dob}`;
        if (seenPerson.has(personKey)) candidates.push({ inBatchRow: seenPerson.get(personKey), score: 1 });
        else seenPerson.set(personKey, row.rowNo);
        candidates.push(...(await findDuplicates(req, dupInput(value))).filter((d) => d.score >= BLOCK_SCORE));
      }
      const status = errors.length ? 'error' : candidates.length ? 'duplicate' : 'ok';
      await rows(req).updateOne({ _id: row._id }, { $set: { normalized: value, errors, candidates, status }, $unset: { resolution: '' } });
    }
    const c = await counts(req, b._id);
    await batches(req).updateOne({ _id: b._id }, { $set: { counts: c, status: 'Validated', validatedAt: new Date() }, $push: push(req, 'validated') as Document });
    await audit(deps, req, { action: 'migration.validate', resource: `migration:${id(b)}`, outcome: 'success', meta: { ok: c.ok ?? 0, errors: c.error ?? 0, duplicates: c.duplicate ?? 0 } });
    res.json({ data: { counts: c } });
  });

  r.get('/batches/:id/rows', need(deps, 'mpi', 'A'), async (req, res) => {
    const q = parse(z.object({ status: z.enum(['pending', 'ok', 'error', 'duplicate', 'imported', 'skipped']).optional() }), req.query);
    const b = await load(req);
    const list = await rows(req).find({ batchId: b._id, ...(q.status ? { status: q.status } : {}) }).sort({ rowNo: 1 }).limit(500).toArray();
    res.json({ data: list.map((x) => ({ id: id(x), rowNo: x.rowNo, raw: x.raw, status: x.status, errors: x.errors ?? [], candidates: x.candidates ?? [], resolution: x.resolution ?? null })) });
  });

  /** A person decides each likely duplicate: create a new record anyway, or skip the row. */
  r.post('/batches/:id/rows/:rowId/resolve', need(deps, 'mpi', 'A'), async (req, res) => {
    const { action } = parse(z.object({ action: z.enum(['create', 'skip']) }), req.body);
    const b = await load(req);
    const upd = await rows(req).updateOne({ _id: idParam(req.params.rowId, 'Row'), batchId: b._id, status: 'duplicate' }, { $set: { resolution: action, resolvedBy: req.actor!.userId } });
    if (!upd.modifiedCount) throw Errors.notFound('Duplicate row');
    res.json({ data: { resolution: action } });
  });

  r.post('/batches/:id/commit', need(deps, 'mpi', 'A'), async (req, res) => {
    const b = await load(req);
    const a = req.actor!;
    if (b.status !== 'Validated') throw Errors.conflict('INVALID_TRANSITION', 'Validate the batch (dry run) before committing');
    if ((b.createdBy as ObjectId).equals(a.userId)) throw new AppError(403, 'FOUR_EYES', 'Someone other than the person who loaded the batch commits it');
    assertRecentMfa(deps, req);
    const open = await rows(req).countDocuments({ batchId: b._id, status: 'duplicate', resolution: { $exists: false } });
    if (open) throw Errors.conflict('UNRESOLVED_DUPLICATES', `${open} likely duplicates still need a decision`);
    const branch = await db(req).collection('branches').findOne({ _id: b.branchId });
    const yy = new Date().getUTCFullYear().toString().slice(2);
    const todo = await rows(req).find({ batchId: b._id, $or: [{ status: 'ok' }, { status: 'duplicate', resolution: 'create' }] }).sort({ rowNo: 1 }).toArray();
    const expected: string[] = [];
    for (const row of todo) {
      const v = row.normalized as { legacyId: string; givenName: string; middleName?: string; familyName: string; dob: string; sexAtBirth: string; phone?: string };
      expected.push(line(v));
      // Idempotent: a crash mid-way and a second commit never create a person twice.
      const link = await db(req).collection('migration_links').findOne({ tenantId: b.tenantId, source: b.source, legacyId: v.legacyId });
      if (link) {
        await rows(req).updateOne({ _id: row._id }, { $set: { status: 'imported', patientId: link.patientId } });
        continue;
      }
      const counter = await db(req).collection<{ _id: string; seq: number }>('counters').findOneAndUpdate({ _id: `mrn:${branch!.code}:${yy}` }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
      const now = new Date();
      const ins = await db(req).collection('patients').insertOne({
        tenantId: b.tenantId,
        branchIds: [b.branchId],
        mrn: `${branch!.code}-${yy}-${String(counter!.seq).padStart(6, '0')}`,
        names: { given: v.givenName, middle: v.middleName, family: v.familyName },
        nameKeys: dupInput(v).keys,
        dob: v.dob,
        sexAtBirth: v.sexAtBirth,
        phone: v.phone,
        identifiers: [{ system: `legacy:${b.source}`, value: v.legacyId }],
        status: 'Provisional',
        careTeam: [],
        migration: { batchId: b._id, legacyId: v.legacyId },
        createdAt: now,
        createdBy: a.userId,
        version: 1,
      });
      try {
        await db(req).collection('migration_links').insertOne({ tenantId: b.tenantId, source: b.source, legacyId: v.legacyId, patientId: ins.insertedId, batchId: b._id });
      } catch (e) {
        if ((e as { code?: number }).code !== 11000) throw e;
        await db(req).collection('patients').deleteOne({ _id: ins.insertedId });
        continue;
      }
      await rows(req).updateOne({ _id: row._id }, { $set: { status: 'imported', patientId: ins.insertedId } });
    }
    await rows(req).updateMany({ batchId: b._id, $or: [{ status: 'duplicate', resolution: 'skip' }] }, { $set: { status: 'skipped' } });
    const c = await counts(req, b._id);
    const report = { expectedRows: expected.length, expectedFingerprint: fingerprint(expected), committedAt: new Date() };
    await batches(req).updateOne({ _id: b._id }, { $set: { status: 'Committed', counts: c, report }, $push: push(req, 'committed', `${c.imported ?? 0} imported`) as Document });
    await audit(deps, req, { action: 'migration.commit', resource: `migration:${id(b)}`, outcome: 'success', meta: { imported: c.imported ?? 0, skipped: c.skipped ?? 0, errors: c.error ?? 0 } });
    res.json({ data: { status: 'Committed', counts: c, ...(await reconcile(req, b._id, report)) } });
  });

  /** Reconciliation (spec "migration with verification"): what is in the patient index now vs what was committed. */
  async function reconcile(req: Request, batchId: ObjectId, report: Document) {
    const pats = await db(req).collection('patients').find({ tenantId: req.actor!.tenantId, 'migration.batchId': batchId }).toArray();
    const actual = pats.map((p) => line({ legacyId: p.migration.legacyId, givenName: p.names.given, middleName: p.names.middle, familyName: p.names.family, dob: p.dob, sexAtBirth: p.sexAtBirth }));
    const actualFingerprint = fingerprint(actual);
    return { verification: { expectedRows: report.expectedRows, actualRows: actual.length, expectedFingerprint: report.expectedFingerprint, actualFingerprint, verified: actual.length === report.expectedRows && actualFingerprint === report.expectedFingerprint } };
  }

  r.get('/batches/:id/verify', need(deps, 'mpi', 'A'), async (req, res) => {
    const b = await load(req);
    if (!b.report) throw Errors.conflict('NOT_COMMITTED', 'Nothing has been committed yet');
    const out = await reconcile(req, b._id, b.report);
    await audit(deps, req, { action: 'migration.verify', resource: `migration:${id(b)}`, outcome: out.verification.verified ? 'success' : 'failure', meta: { actualRows: out.verification.actualRows } });
    res.json({ data: out });
  });

  /** Undo an import, but never remove a record someone has already used (visits, appointments, edits, merges). */
  r.post('/batches/:id/rollback', need(deps, 'mpi', 'A'), async (req, res) => {
    const { reason } = parse(z.object({ reason: z.string().trim().min(5).max(300) }), req.body);
    const b = await load(req);
    assertRecentMfa(deps, req);
    if (b.status !== 'Committed') throw Errors.conflict('INVALID_TRANSITION', 'Only committed batches are rolled back');
    const pats = await db(req).collection('patients').find({ tenantId: b.tenantId, 'migration.batchId': b._id }).toArray();
    const kept: string[] = [];
    let removed = 0;
    for (const p of pats) {
      const used =
        p.version !== 1 ||
        p.mergedInto ||
        (await db(req).collection('encounters').countDocuments({ patientId: p._id }, { limit: 1 })) ||
        (await db(req).collection('appointments').countDocuments({ patientId: p._id }, { limit: 1 })) ||
        (await db(req).collection('invoices').countDocuments({ patientId: p._id }, { limit: 1 })) ||
        (await db(req).collection('merge_requests').countDocuments({ $or: [{ survivorId: p._id }, { duplicateId: p._id }] }, { limit: 1 }));
      if (used) {
        kept.push(p.mrn as string);
        continue;
      }
      await db(req).collection('patients').deleteOne({ _id: p._id, version: 1 });
      await db(req).collection('migration_links').deleteOne({ tenantId: b.tenantId, patientId: p._id });
      await rows(req).updateOne({ batchId: b._id, patientId: p._id }, { $set: { status: 'rolled-back' }, $unset: { patientId: '' } });
      removed++;
    }
    const status = kept.length ? 'PartiallyRolledBack' : 'RolledBack';
    await batches(req).updateOne({ _id: b._id }, { $set: { status, counts: await counts(req, b._id) }, $push: push(req, 'rolled-back', `${reason} (${removed} removed, ${kept.length} kept)`) as Document });
    await audit(deps, req, { action: 'migration.rollback', resource: `migration:${id(b)}`, outcome: 'success', meta: { removed, kept: kept.length } });
    res.json({ data: { status, removed, kept } });
  });

  return r;
}
