import { Router, type Request } from 'express';
import type { Document, ObjectId } from 'mongodb';
import { z } from 'zod';
import { can, isBranchBound } from '@fahan/policy';
import type { Deps } from '../../context';
import { AppError, Errors } from '../../lib/errors';
import { localDate } from '../../lib/time';
import { idParam, objectId, parse } from '../../lib/validate';
import { audit } from '../../middleware/audit';
import { assertBranch, deny, need } from '../../middleware/authorize';
import { encLevelOk, loadPatient } from '../patients/access';
import { PRIORITIES, nextNumber, orderingContext } from '../orders/common';
import { chargeEvent } from '../billing/service';

const Analyte = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{1,16}$/),
  name: z.string().trim().min(1).max(80),
  kind: z.enum(['numeric', 'text']).default('numeric'),
  unit: z.string().trim().max(20).optional(),
  refLow: z.number().optional(),
  refHigh: z.number().optional(),
  criticalLow: z.number().optional(),
  criticalHigh: z.number().optional(),
});
const NewTest = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{1,16}$/, 'Use 1–16 letters, digits or hyphens'),
  name: z.string().trim().min(2).max(120),
  specimen: z.enum(['blood', 'serum', 'plasma', 'urine', 'stool', 'swab', 'csf', 'sputum', 'other']),
  turnaroundMinutes: z.number().int().min(5).max(20_160),
  analytes: z.array(Analyte).min(1).max(40),
});
const NewOrder = z.object({ encounterId: objectId, testIds: z.array(objectId).min(1).max(20), priority: z.enum(PRIORITIES).default('routine'), clinicalNote: z.string().trim().max(500).optional() });
const Results = z.object({ results: z.array(z.object({ analyteCode: z.string().trim().toUpperCase(), value: z.union([z.number().finite(), z.string().trim().min(1).max(200)]) })).min(1).max(40) });
const Amend = Results.extend({ reason: z.string().trim().min(5).max(300) });
const Qc = z.object({ testId: objectId, analyteCode: z.string().trim().toUpperCase(), level: z.enum(['L1', 'L2', 'L3']), value: z.number().finite(), mean: z.number().finite(), sd: z.number().positive() });
const Cancel = z.object({ reason: z.string().trim().min(3).max(300) });

const id = (x: { _id: ObjectId }) => x._id.toHexString();

type AnalyteDef = z.infer<typeof Analyte>;
/** N normal · L/H outside reference · LL/HH critical · A abnormal text (spec §4.2 critical values). */
export function flagFor(a: AnalyteDef, v: number | string): 'N' | 'L' | 'H' | 'LL' | 'HH' | 'A' {
  if (typeof v !== 'number') return 'N';
  if (a.criticalLow !== undefined && v <= a.criticalLow) return 'LL';
  if (a.criticalHigh !== undefined && v >= a.criticalHigh) return 'HH';
  if (a.refLow !== undefined && v < a.refLow) return 'L';
  if (a.refHigh !== undefined && v > a.refHigh) return 'H';
  return 'N';
}

/** Spec §5.11 laboratory: Ordered → Collected → Processing → Verified → Released (+ Cancelled, amendments). */
export function labRoutes(deps: Deps): Router {
  const r = Router();
  const db = (req: Request) => req.actor!.db!;
  const now = () => deps.config.now();

  async function loadOrder(req: Request) {
    const o = await db(req).collection('lab_orders').findOne({ _id: idParam(req.params.id, 'Lab order'), tenantId: req.actor!.tenantId });
    if (!o) throw Errors.notFound('Lab order');
    await assertBranch(deps, req, o.branchId);
    return o;
  }

  const view = (o: Document, showResults: boolean) => ({
    id: id(o as { _id: ObjectId }),
    accessionNumber: o.accessionNumber ?? null,
    testCode: o.testCode,
    testName: o.testName,
    specimen: o.specimen,
    priority: o.priority,
    status: o.status,
    encounterId: o.encounterId.toHexString(),
    patientId: o.patientId.toHexString(),
    orderedByName: o.orderedByName,
    orderedAt: o.orderedAt,
    collectedAt: o.collectedAt ?? null,
    verifiedAt: o.verifiedAt ?? null,
    releasedAt: o.releasedAt ?? null,
    results: showResults ? (o.results ?? []) : [],
    amended: Boolean(o.history?.length),
    critical: o.critical ?? null,
  });

  // ---- catalogue ----
  r.get('/tests', async (req, res) => {
    const list = await db(req).collection('lab_tests').find({ tenantId: req.actor!.tenantId, active: true }).sort({ name: 1 }).toArray();
    res.json({ data: list.map(({ _id, tenantId, ...t }) => ({ id: _id.toHexString(), ...t })) });
  });

  r.post('/tests', need(deps, 'lab', 'A'), async (req, res) => {
    const body = parse(NewTest, req.body);
    try {
      const ins = await db(req).collection('lab_tests').insertOne({ tenantId: req.actor!.tenantId, ...body, active: true, createdAt: new Date(), createdBy: req.actor!.userId });
      await audit(deps, req, { action: 'lab.test.create', resource: `lab_test:${ins.insertedId.toHexString()}`, outcome: 'success', meta: { code: body.code } });
      res.status(201).json({ data: { id: ins.insertedId.toHexString(), code: body.code } });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw Errors.conflict('TEST_EXISTS', `Test ${body.code} already exists`);
      throw e;
    }
  });

  // ---- ordering (clinicians) ----
  r.post('/orders', need(deps, 'lab', 'E'), async (req, res) => {
    const body = parse(NewOrder, req.body);
    const { e } = await orderingContext(deps, req, body.encounterId);
    const found = await db(req).collection('lab_tests').find({ _id: { $in: body.testIds }, tenantId: req.actor!.tenantId, active: true }).toArray();
    // Keep the order the clinician chose.
    const tests = body.testIds.map((tid) => found.find((t) => t._id.equals(tid))).filter((t): t is NonNullable<typeof t> => Boolean(t));
    if (tests.length !== new Set(body.testIds.map(String)).size) throw Errors.validation([{ path: 'testIds', message: 'One or more tests are not in the catalogue' }]);
    const a = req.actor!;
    const at = new Date();
    const docs = tests.map((t) => ({
      tenantId: a.tenantId,
      branchId: e.branchId,
      encounterId: e._id,
      patientId: e.patientId,
      testId: t._id,
      testCode: t.code,
      testName: t.name,
      specimen: t.specimen,
      analytes: t.analytes,
      priority: body.priority,
      clinicalNote: body.clinicalNote,
      status: 'Ordered',
      orderedBy: a.userId,
      orderedByName: a.name,
      orderedAt: at,
      version: 1,
    }));
    const ins = await db(req).collection('lab_orders').insertMany(docs);
    await audit(deps, req, { action: 'lab.order', resource: `encounter:${e._id.toHexString()}`, outcome: 'success', meta: { tests: tests.map((t) => t.code).join(','), priority: body.priority } });
    res.status(201).json({ data: Object.values(ins.insertedIds).map((x) => x.toHexString()) });
  });

  /** Results on a visit: clinicians see only released results; the lab sees work in progress. */
  r.get('/orders', async (req, res) => {
    const q = parse(z.object({ encounterId: objectId }), req.query);
    const e = await db(req).collection('encounters').findOne({ _id: q.encounterId, tenantId: req.actor!.tenantId });
    if (!e) throw Errors.notFound('Visit');
    await loadPatient(deps, req, e.patientId, { clinical: true });
    const lab = can(req.actor!.perms, 'lab', 'A');
    const list = await db(req).collection('lab_orders').find({ encounterId: e._id }).sort({ orderedAt: -1 }).toArray();
    res.json({ data: list.map((o) => view(o, lab || o.status === 'Released')) });
  });

  // ---- laboratory worklist ----
  r.get('/worklist', need(deps, 'lab', 'E'), async (req, res) => {
    const q = parse(z.object({ status: z.enum(['Ordered', 'Collected', 'Processing', 'Verified', 'Released', 'open']).default('open') }), req.query);
    const a = req.actor!;
    // Ordering clinicians (assigned-patient scope) do not get the department worklist.
    if (a.scope === 'assigned-patient') await deny(deps, req, 'lab worklist', 'worklist is for laboratory staff');
    const f: Document = { tenantId: a.tenantId, status: q.status === 'open' ? { $in: ['Ordered', 'Collected', 'Processing', 'Verified'] } : q.status };
    if (isBranchBound(a.scope)) f.branchId = a.branchId ?? null;
    const list = await db(req).collection('lab_orders').find(f).sort({ priority: -1, orderedAt: 1 }).limit(500).toArray();
    const pats = await db(req).collection('patients').find({ _id: { $in: list.map((o) => o.patientId) } }, { projection: { names: 1, mrn: 1 } }).toArray();
    const rank = { stat: 0, urgent: 1, routine: 2 } as Record<string, number>;
    res.json({
      data: list
        .map((o) => ({ ...view(o, true), patient: pats.find((p) => p._id.equals(o.patientId)) ?? null, waitingMinutes: Math.round((now().getTime() - new Date(o.orderedAt).getTime()) / 60_000) }))
        .sort((x, y) => (rank[x.priority] ?? 9) - (rank[y.priority] ?? 9) || new Date(x.orderedAt).getTime() - new Date(y.orderedAt).getTime() || x.id.localeCompare(y.id)),
    });
  });

  r.post('/orders/:id/collect', need(deps, 'lab', 'E'), async (req, res) => {
    const o = await loadOrder(req);
    await loadPatient(deps, req, o.patientId, { clinical: false });
    if (o.status !== 'Ordered') throw Errors.conflict('INVALID_TRANSITION', `Sample already ${String(o.status).toLowerCase()}`);
    const branch = await db(req).collection('branches').findOne({ _id: o.branchId });
    const acc = await nextNumber(req, 'ACC', branch!.code, localDate(now(), branch!.timezone));
    const upd = await db(req).collection('lab_orders').updateOne(
      { _id: o._id, status: 'Ordered' },
      { $set: { status: 'Collected', accessionNumber: acc, collectedAt: now(), collectedBy: req.actor!.userId }, $inc: { version: 1 } },
    );
    if (!upd.modifiedCount) throw Errors.conflict('INVALID_TRANSITION', 'Sample was collected by someone else');
    await audit(deps, req, { action: 'lab.collect', resource: `lab_order:${id(o)}`, outcome: 'success', meta: { accession: acc } });
    res.json({ data: { id: id(o), status: 'Collected', accessionNumber: acc } });
  });

  r.post('/orders/:id/receive', need(deps, 'lab', 'E'), async (req, res) => {
    const o = await loadOrder(req);
    const upd = await db(req).collection('lab_orders').updateOne({ _id: o._id, status: 'Collected' }, { $set: { status: 'Processing', receivedAt: now(), receivedBy: req.actor!.userId }, $inc: { version: 1 } });
    if (!upd.modifiedCount) throw Errors.conflict('INVALID_TRANSITION', `Order is ${String(o.status).toLowerCase()}`);
    await audit(deps, req, { action: 'lab.receive', resource: `lab_order:${id(o)}`, outcome: 'success' });
    res.json({ data: { id: id(o), status: 'Processing' } });
  });

  function buildResults(o: Document, input: z.infer<typeof Results>['results']) {
    const defs = o.analytes as AnalyteDef[];
    const out = input.map((x) => {
      const def = defs.find((d) => d.code === x.analyteCode);
      if (!def) throw Errors.validation([{ path: 'results', message: `${x.analyteCode} is not part of ${o.testCode}` }]);
      if (def.kind === 'numeric' && typeof x.value !== 'number') throw Errors.validation([{ path: 'results', message: `${def.name} needs a number` }]);
      return { analyteCode: def.code, name: def.name, value: x.value, unit: def.unit ?? null, refLow: def.refLow ?? null, refHigh: def.refHigh ?? null, flag: flagFor(def, x.value) };
    });
    const missing = defs.filter((d) => !out.some((x) => x.analyteCode === d.code));
    if (missing.length) throw Errors.validation(missing.map((d) => ({ path: 'results', message: `${d.name} has no result` })));
    return out;
  }

  r.post('/orders/:id/results', need(deps, 'lab', 'E'), async (req, res) => {
    const body = parse(Results, req.body);
    const o = await loadOrder(req);
    if (o.status !== 'Processing') throw Errors.conflict('INVALID_TRANSITION', 'Receive the sample before entering results');
    const results = buildResults(o, body.results);
    await db(req)
      .collection('lab_orders')
      .updateOne({ _id: o._id, status: 'Processing' }, { $set: { results, resultsEnteredBy: req.actor!.userId, resultsEnteredAt: now() }, $inc: { version: 1 } });
    await audit(deps, req, { action: 'lab.results.enter', resource: `lab_order:${id(o)}`, outcome: 'success' });
    res.json({ data: { id: id(o), flags: results.map((x) => `${x.analyteCode}:${x.flag}`) } });
  });

  /** Verification by an authorised second person; blocked while the latest QC for this test has failed. */
  r.post('/orders/:id/verify', need(deps, 'lab', 'A'), async (req, res) => {
    const o = await loadOrder(req);
    if (o.status !== 'Processing' || !o.results) throw Errors.conflict('INVALID_TRANSITION', 'Results must be entered before verification');
    const a = req.actor!;
    if (o.resultsEnteredBy?.equals(a.userId)) throw new AppError(403, 'FOUR_EYES', 'Another person verifies the results you entered');
    const qc = await db(req).collection('lab_qc').find({ tenantId: a.tenantId, testId: o.testId, branchId: o.branchId }).sort({ at: -1 }).limit(1).next();
    if (qc?.outcome === 'fail') throw new AppError(409, 'QC_FAILED', `Quality control for ${o.testCode} failed at ${new Date(qc.at).toISOString()}. Rerun QC before verifying`);
    const crit = (o.results as Document[]).filter((x) => x.flag === 'LL' || x.flag === 'HH');
    const set: Document = { status: 'Verified', verifiedBy: a.userId, verifiedByName: a.name, verifiedAt: now() };
    if (crit.length) set.critical = { analytes: crit.map((x) => `${x.name} ${x.value} ${x.unit ?? ''}`.trim()), raisedAt: now(), acknowledgedAt: null, acknowledgedByName: null };
    await db(req).collection('lab_orders').updateOne({ _id: o._id, status: 'Processing' }, { $set: set, $inc: { version: 1 } });
    await audit(deps, req, { action: crit.length ? 'lab.critical.raise' : 'lab.verify', resource: `lab_order:${id(o)}`, outcome: 'success', meta: { critical: crit.length } });
    res.json({ data: { id: id(o), status: 'Verified', critical: crit.length > 0 } });
  });

  r.post('/orders/:id/release', need(deps, 'lab', 'A'), async (req, res) => {
    const o = await loadOrder(req);
    const upd = await db(req).collection('lab_orders').updateOne({ _id: o._id, status: 'Verified' }, { $set: { status: 'Released', releasedAt: now(), releasedBy: req.actor!.userId }, $inc: { version: 1 } });
    if (!upd.modifiedCount) throw Errors.conflict('NOT_VERIFIED', 'Results cannot be released before verification');
    await audit(deps, req, { action: 'lab.release', resource: `lab_order:${id(o)}`, outcome: 'success' });
    await chargeEvent(req, { branchId: o.branchId, patientId: o.patientId, encounterId: o.encounterId, serviceCode: `LAB-${o.testCode}`, sourceType: 'lab_order', sourceId: o._id, description: o.testName });
    res.json({ data: { id: id(o), status: 'Released' } });
  });

  /** Spec §4.2 / §6: a clinician on the visit acknowledges the critical value; the time to acknowledgement is kept. */
  r.post('/orders/:id/acknowledge', async (req, res) => {
    const o = await db(req).collection('lab_orders').findOne({ _id: idParam(req.params.id, 'Lab order'), tenantId: req.actor!.tenantId });
    if (!o) throw Errors.notFound('Lab order');
    const e = await db(req).collection('encounters').findOne({ _id: o.encounterId });
    await loadPatient(deps, req, o.patientId, { clinical: true });
    if (!encLevelOk(req.actor!.perms, e!.type, 'S')) await deny(deps, req, `lab_order:${id(o)}`, 'only a clinician on the visit acknowledges critical results');
    if (!o.critical || o.critical.acknowledgedAt) throw Errors.conflict('NO_OPEN_CRITICAL', 'There is no open critical value on this result');
    const minutes = Math.round((now().getTime() - new Date(o.critical.raisedAt).getTime()) / 60_000);
    await db(req)
      .collection('lab_orders')
      .updateOne({ _id: o._id }, { $set: { 'critical.acknowledgedAt': now(), 'critical.acknowledgedBy': req.actor!.userId, 'critical.acknowledgedByName': req.actor!.name, 'critical.minutesToAcknowledge': minutes } });
    await audit(deps, req, { action: 'lab.critical.acknowledge', resource: `lab_order:${id(o)}`, outcome: 'success', meta: { minutes } });
    res.json({ data: { id: id(o), minutesToAcknowledge: minutes } });
  });

  r.get('/criticals', async (req, res) => {
    const a = req.actor!;
    const f: Document = { tenantId: a.tenantId, critical: { $ne: null }, 'critical.acknowledgedAt': null };
    if (a.scope === 'assigned-patient') {
      const mine = await db(req).collection('encounters').find({ tenantId: a.tenantId, clinicianIds: a.userId, status: { $ne: 'Closed' } }, { projection: { _id: 1 } }).toArray();
      f.encounterId = { $in: mine.map((x) => x._id) };
    } else if (!can(a.perms, 'lab', 'E')) {
      await deny(deps, req, 'critical values', 'requires laboratory or care-team access');
    } else if (isBranchBound(a.scope)) f.branchId = a.branchId ?? null;
    const list = await db(req).collection('lab_orders').find(f).sort({ 'critical.raisedAt': 1 }).limit(200).toArray();
    res.json({ data: list.map((o) => ({ ...view(o, false), openMinutes: Math.round((now().getTime() - new Date(o.critical.raisedAt).getTime()) / 60_000) })) });
  });

  r.post('/orders/:id/amend', need(deps, 'lab', 'A'), async (req, res) => {
    const body = parse(Amend, req.body);
    const o = await loadOrder(req);
    if (o.status !== 'Released') throw Errors.conflict('INVALID_TRANSITION', 'Only released results are amended; correct earlier results before verification');
    const results = buildResults(o, body.results);
    const a = req.actor!;
    await db(req).collection('lab_orders').updateOne(
      { _id: o._id },
      { $set: { results, amendedAt: now(), amendedBy: a.userId }, $push: { history: { results: o.results, replacedAt: now(), by: a.userId, reason: body.reason } } as Document, $inc: { version: 1 } },
    );
    await audit(deps, req, { action: 'lab.amend', resource: `lab_order:${id(o)}`, outcome: 'success', meta: { reason: body.reason } });
    res.json({ data: { id: id(o), amended: true } });
  });

  r.post('/orders/:id/cancel', async (req, res) => {
    const { reason } = parse(Cancel, req.body);
    const o = await loadOrder(req);
    const a = req.actor!;
    if (!o.orderedBy.equals(a.userId) && !can(a.perms, 'lab', 'A')) await deny(deps, req, `lab_order:${id(o)}`, 'only the orderer or the laboratory cancels');
    const upd = await db(req).collection('lab_orders').updateOne({ _id: o._id, status: { $in: ['Ordered', 'Collected'] } }, { $set: { status: 'Cancelled', cancelReason: reason, cancelledBy: a.userId }, $inc: { version: 1 } });
    if (!upd.modifiedCount) throw Errors.conflict('INVALID_TRANSITION', 'Processing has started; ask the laboratory');
    await audit(deps, req, { action: 'lab.cancel', resource: `lab_order:${id(o)}`, outcome: 'success' });
    res.json({ data: { id: id(o), status: 'Cancelled' } });
  });

  // ---- quality control (Westgard-style 2SD warning, 3SD rejection) ----
  r.post('/qc', need(deps, 'lab', 'E'), async (req, res) => {
    const body = parse(Qc, req.body);
    const a = req.actor!;
    if (!a.branchId) throw Errors.validation([{ message: 'Your account is not assigned to a branch' }]);
    const z2 = Math.abs(body.value - body.mean) / body.sd;
    const outcome = z2 > 3 ? 'fail' : z2 > 2 ? 'warn' : 'pass';
    await db(req).collection('lab_qc').insertOne({ tenantId: a.tenantId, branchId: a.branchId, ...body, z: Math.round(z2 * 100) / 100, outcome, at: now(), by: a.userId });
    await audit(deps, req, { action: 'lab.qc', resource: `lab_test:${body.testId.toHexString()}`, outcome: 'success', meta: { result: outcome } });
    res.status(201).json({ data: { outcome, z: Math.round(z2 * 100) / 100 } });
  });

  return r;
}
