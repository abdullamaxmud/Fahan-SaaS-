import { createHmac } from 'node:crypto';
import { Router, type Request } from 'express';
import type { Document, ObjectId } from 'mongodb';
import { z } from 'zod';
import { can, isBranchBound, type ModuleKey, type Permissions } from '@fahan/policy';
import type { Deps } from '../../context';
import { AppError, Errors } from '../../lib/errors';
import { localDate } from '../../lib/time';
import { idParam, objectId, parse } from '../../lib/validate';
import { audit } from '../../middleware/audit';
import { assertBranch, deny, need } from '../../middleware/authorize';
import { assertRecentMfa } from '../../middleware/session';
import { assetUsable } from '../equipment/routes';
import { encLevelOk, loadPatient } from '../patients/access';
import { PRIORITIES, nextNumber, orderingContext } from '../orders/common';
import { chargeEvent } from '../billing/service';

const IONISING = ['XR', 'CT', 'FL', 'MG'];

interface Kind {
  module: ModuleKey;
  collection: string;
  prefix: string;
  modalities: readonly [string, ...string[]];
  /** Who may sign the final report. */
  canSign: (p: Permissions) => boolean;
  label: string;
}

export const RADIOLOGY: Kind = { module: 'rad', collection: 'imaging_orders', prefix: 'RAD', modalities: ['XR', 'CT', 'MR', 'US', 'MG', 'FL'], canSign: (p) => can(p, 'rad', 'A'), label: 'radiologist' };
export const DIAGNOSTICS: Kind = {
  module: 'dx',
  collection: 'diagnostic_orders',
  prefix: 'DX',
  modalities: ['ECG', 'ECHO', 'ENDO', 'EEG'],
  // Spec §5.13: a specialist approves; technicians perform but do not sign.
  canSign: (p) => can(p, 'dx', 'E') && (can(p, 'opd', 'S') || can(p, 'icu', 'S') || can(p, 'er', 'S')),
  label: 'specialist',
};

const id = (x: { _id: ObjectId }) => x._id.toHexString();

/**
 * Spec §5.12 radiology (Ordered → Scheduled → Acquired → Interpreted → Final) and §5.13 diagnostics
 * (Ordered → Performed → Signed → Final), one engine with different signers.
 */
export function imagingRoutes(deps: Deps, k: Kind): Router {
  const r = Router();
  const db = (req: Request) => req.actor!.db!;
  const col = (req: Request) => db(req).collection(k.collection);
  const now = () => deps.config.now();

  const NewOrder = z.object({
    encounterId: objectId,
    modality: z.enum(k.modalities),
    examination: z.string().trim().min(2).max(120),
    bodySite: z.string().trim().max(60).optional(),
    priority: z.enum(PRIORITIES).default('routine'),
    clinicalQuestion: z.string().trim().min(5, 'Say what question the study should answer').max(500),
    contrast: z.boolean().default(false),
    pregnancyStatus: z.enum(['not-pregnant', 'pregnant', 'unknown', 'not-applicable']).optional(),
    justification: z.string().trim().max(300).optional(),
  });
  const Schedule = z.object({ assetId: objectId, startsAt: z.string().datetime(), minutes: z.number().int().min(5).max(240).default(20) });
  const Acquire = z.object({ studyInstanceUid: z.string().trim().regex(/^[0-9]+(\.[0-9]+)+$/, 'Enter a DICOM StudyInstanceUID').max(64).optional(), note: z.string().trim().max(300).optional() });
  const Report = z.object({ findings: z.string().trim().min(5).max(20_000), impression: z.string().trim().min(3).max(5_000), preliminary: z.boolean().default(false) });
  const Sign = z.object({ criticalFinding: z.string().trim().min(5).max(500).optional() });
  const Addendum = z.object({ text: z.string().trim().min(5).max(5_000) });

  async function loadOrder(req: Request) {
    const o = await col(req).findOne({ _id: idParam(req.params.id, 'Order'), tenantId: req.actor!.tenantId });
    if (!o) throw Errors.notFound('Order');
    await assertBranch(deps, req, o.branchId);
    return o;
  }

  /** Clinicians see final reports, and preliminary ones flagged as such; the department sees everything. */
  const view = (o: Document, dept: boolean) => {
    const visible = dept || o.status === 'Final' || o.report?.preliminary;
    return {
      id: id(o as { _id: ObjectId }),
      accessionNumber: o.accessionNumber,
      modality: o.modality,
      examination: o.examination,
      bodySite: o.bodySite ?? null,
      priority: o.priority,
      status: o.status,
      clinicalQuestion: o.clinicalQuestion,
      encounterId: o.encounterId.toHexString(),
      patientId: o.patientId.toHexString(),
      orderedByName: o.orderedByName,
      orderedAt: o.orderedAt,
      scheduledFor: o.scheduledFor ?? null,
      assetCode: o.assetCode ?? null,
      studyInstanceUid: o.studyInstanceUid ?? null,
      report: visible && o.report ? { findings: o.report.findings, impression: o.report.impression, preliminary: o.status !== 'Final', authorName: o.report.authorName } : null,
      signedByName: o.signedByName ?? null,
      signedAt: o.signedAt ?? null,
      addenda: o.addenda ?? [],
      critical: o.critical ?? null,
      sharedWithPatient: o.sharedWithPatient ? { at: o.sharedWithPatient.at, byName: o.sharedWithPatient.byName } : null,
    };
  };

  r.post('/orders', need(deps, k.module, 'E'), async (req, res) => {
    const body = parse(NewOrder, req.body);
    const { e, patient } = await orderingContext(deps, req, body.encounterId);
    const a = req.actor!;
    // Spec §4.2 safety: ionising studies for people who could be pregnant need an explicit status.
    if (IONISING.includes(body.modality) && patient.sexAtBirth !== 'male') {
      const age = new Date(now()).getUTCFullYear() - Number(String(patient.dob).slice(0, 4));
      if (age >= 10 && age <= 55) {
        if (!body.pregnancyStatus || body.pregnancyStatus === 'not-applicable') throw Errors.validation([{ path: 'pregnancyStatus', message: 'Record pregnancy status before an ionising study' }]);
        if (body.pregnancyStatus !== 'not-pregnant' && !body.justification) throw Errors.validation([{ path: 'justification', message: 'Explain why the study is justified if the patient may be pregnant' }]);
      }
    }
    const branch = await db(req).collection('branches').findOne({ _id: e.branchId });
    const acc = await nextNumber(req, k.prefix, branch!.code, localDate(now(), branch!.timezone));
    const ins = await col(req).insertOne({
      ...body,
      tenantId: a.tenantId,
      branchId: e.branchId,
      encounterId: e._id,
      patientId: e.patientId,
      accessionNumber: acc,
      status: 'Ordered',
      orderedBy: a.userId,
      orderedByName: a.name,
      orderedAt: now(),
      version: 1,
    });
    await audit(deps, req, { action: `${k.module}.order`, resource: `encounter:${e._id.toHexString()}`, outcome: 'success', meta: { modality: body.modality, accession: acc } });
    res.status(201).json({ data: { id: ins.insertedId.toHexString(), accessionNumber: acc } });
  });

  r.get('/orders', async (req, res) => {
    const q = parse(z.object({ encounterId: objectId }), req.query);
    const e = await db(req).collection('encounters').findOne({ _id: q.encounterId, tenantId: req.actor!.tenantId });
    if (!e) throw Errors.notFound('Visit');
    await loadPatient(deps, req, e.patientId, { clinical: true });
    const dept = can(req.actor!.perms, k.module, 'E') && req.actor!.scope !== 'assigned-patient';
    const list = await col(req).find({ encounterId: e._id }).sort({ orderedAt: -1 }).toArray();
    res.json({ data: list.map((o) => view(o, dept)) });
  });

  r.get('/worklist', need(deps, k.module, 'E'), async (req, res) => {
    const a = req.actor!;
    if (a.scope === 'assigned-patient') await deny(deps, req, `${k.module} worklist`, 'worklist is for department staff');
    const q = parse(z.object({ status: z.enum(['open', 'final']).default('open') }), req.query);
    // "final": reports signed in the last 14 days, so an addendum can be added.
    const f: Document =
      q.status === 'final'
        ? { tenantId: a.tenantId, status: 'Final', signedAt: { $gte: new Date(Date.now() - 14 * 86_400_000) } }
        : { tenantId: a.tenantId, status: { $in: ['Ordered', 'Scheduled', 'Acquired', 'Interpreted'] } };
    if (isBranchBound(a.scope)) f.branchId = a.branchId ?? null;
    const list = await col(req).find(f).sort({ orderedAt: 1 }).limit(500).toArray();
    const pats = await db(req).collection('patients').find({ _id: { $in: list.map((o) => o.patientId) } }, { projection: { names: 1, mrn: 1, dob: 1, sexAtBirth: 1 } }).toArray();
    const rank = { stat: 0, urgent: 1, routine: 2 } as Record<string, number>;
    res.json({
      data: list
        .map((o) => ({ ...view(o, true), patient: pats.find((p) => p._id.equals(o.patientId)) ?? null }))
        .sort((x, y) => (rank[x.priority] ?? 9) - (rank[y.priority] ?? 9) || new Date(x.orderedAt).getTime() - new Date(y.orderedAt).getTime() || x.id.localeCompare(y.id)),
    });
  });

  /** Spec §5.24: broken or uncalibrated equipment cannot be scheduled. Bookings on one device never overlap. */
  r.post('/orders/:id/schedule', need(deps, k.module, 'E'), async (req, res) => {
    const body = parse(Schedule, req.body);
    const o = await loadOrder(req);
    if (!['Ordered', 'Scheduled'].includes(o.status)) throw Errors.conflict('INVALID_TRANSITION', `Order is ${String(o.status).toLowerCase()}`);
    const asset = await db(req).collection('assets').findOne({ _id: body.assetId, tenantId: req.actor!.tenantId, branchId: o.branchId });
    if (!asset) throw Errors.notFound('Equipment');
    if (asset.modality !== o.modality) throw Errors.validation([{ path: 'assetId', message: `${asset.code} is ${asset.modality ?? 'not an imaging device'}, the order is ${o.modality}` }]);
    const startsAt = new Date(body.startsAt);
    const usable = assetUsable(asset, localDate(startsAt, 'Africa/Mogadishu'));
    if (!usable.ok) throw new AppError(409, 'EQUIPMENT_UNAVAILABLE', usable.reason!);
    const endsAt = new Date(startsAt.getTime() + body.minutes * 60_000);
    const s = deps.data.client.startSession();
    try {
      await s.withTransaction(async () => {
        await db(req).collection('assets').updateOne({ _id: asset._id }, { $inc: { lockSeq: 1 } }, { session: s });
        const clash = await col(req).findOne({ _id: { $ne: o._id }, assetId: asset._id, status: 'Scheduled', scheduledFor: { $lt: endsAt }, scheduledUntil: { $gt: startsAt } }, { session: s });
        if (clash) throw new AppError(409, 'SLOT_TAKEN', `${asset.code} is booked at that time (${clash.accessionNumber})`);
        await col(req).updateOne({ _id: o._id }, { $set: { status: 'Scheduled', assetId: asset._id, assetCode: asset.code, scheduledFor: startsAt, scheduledUntil: endsAt }, $inc: { version: 1 } }, { session: s });
      });
    } finally {
      await s.endSession();
    }
    await audit(deps, req, { action: `${k.module}.schedule`, resource: `${k.collection}:${id(o)}`, outcome: 'success', meta: { asset: asset.code } });
    res.json({ data: { id: id(o), status: 'Scheduled', asset: asset.code } });
  });

  r.post('/orders/:id/acquire', need(deps, k.module, 'E'), async (req, res) => {
    const body = parse(Acquire, req.body);
    const o = await loadOrder(req);
    if (o.status !== 'Scheduled') throw Errors.conflict('INVALID_TRANSITION', 'Schedule the study on a device first');
    if (k.module === 'rad' && !body.studyInstanceUid) throw Errors.validation([{ path: 'studyInstanceUid', message: 'Link the DICOM study from PACS' }]);
    try {
      await col(req).updateOne(
        { _id: o._id, status: 'Scheduled' },
        { $set: { status: 'Acquired', studyInstanceUid: body.studyInstanceUid, acquiredAt: now(), acquiredBy: req.actor!.userId, acquisitionNote: body.note }, $inc: { version: 1 } },
      );
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw Errors.conflict('STUDY_LINKED', 'That study is already linked to another order');
      throw e;
    }
    await audit(deps, req, { action: `${k.module}.acquire`, resource: `${k.collection}:${id(o)}`, outcome: 'success' });
    res.json({ data: { id: id(o), status: 'Acquired' } });
  });

  r.post('/orders/:id/report', async (req, res) => {
    const body = parse(Report, req.body);
    const o = await loadOrder(req);
    if (!k.canSign(req.actor!.perms)) await deny(deps, req, `${k.collection}:${id(o)}`, `reports are written by the ${k.label}`);
    if (!['Acquired', 'Interpreted'].includes(o.status)) throw Errors.conflict('INVALID_TRANSITION', o.status === 'Final' ? 'The report is final. Add an addendum instead' : 'The study has not been acquired');
    const a = req.actor!;
    await col(req).updateOne({ _id: o._id }, { $set: { status: 'Interpreted', report: { ...body, authorId: a.userId, authorName: a.name, at: now() } }, $inc: { version: 1 } });
    await audit(deps, req, { action: `${k.module}.report.draft`, resource: `${k.collection}:${id(o)}`, outcome: 'success', meta: { preliminary: body.preliminary } });
    res.json({ data: { id: id(o), status: 'Interpreted', preliminary: body.preliminary } });
  });

  r.post('/orders/:id/sign', async (req, res) => {
    const body = parse(Sign, req.body);
    const o = await loadOrder(req);
    if (!k.canSign(req.actor!.perms)) await deny(deps, req, `${k.collection}:${id(o)}`, `only the ${k.label} signs`);
    assertRecentMfa(deps, req);
    if (o.status !== 'Interpreted') throw Errors.conflict('INVALID_TRANSITION', 'Write the report before signing');
    const a = req.actor!;
    const set: Document = { status: 'Final', signedBy: a.userId, signedByName: a.name, signedAt: now() };
    if (body.criticalFinding) set.critical = { finding: body.criticalFinding, raisedAt: now(), acknowledgedAt: null, acknowledgedByName: null };
    await col(req).updateOne({ _id: o._id, status: 'Interpreted' }, { $set: set, $inc: { version: 1 } });
    await audit(deps, req, { action: body.criticalFinding ? `${k.module}.critical.raise` : `${k.module}.sign`, resource: `${k.collection}:${id(o)}`, outcome: 'success' });
    await chargeEvent(req, { branchId: o.branchId, patientId: o.patientId, encounterId: o.encounterId, serviceCode: `${k.prefix}-${o.modality}`, sourceType: k.collection, sourceId: o._id, description: o.examination });
    res.json({ data: { id: id(o), status: 'Final', critical: Boolean(body.criticalFinding) } });
  });

  r.post('/orders/:id/addendum', async (req, res) => {
    const body = parse(Addendum, req.body);
    const o = await loadOrder(req);
    if (!k.canSign(req.actor!.perms)) await deny(deps, req, `${k.collection}:${id(o)}`, `only the ${k.label} adds addenda`);
    assertRecentMfa(deps, req);
    if (o.status !== 'Final') throw Errors.conflict('INVALID_TRANSITION', 'Addenda are added to final reports');
    await col(req).updateOne({ _id: o._id }, { $push: { addenda: { text: body.text, byName: req.actor!.name, at: now() } } as Document, $inc: { version: 1 } });
    await audit(deps, req, { action: `${k.module}.addendum`, resource: `${k.collection}:${id(o)}`, outcome: 'success' });
    res.status(201).json({ data: { id: id(o) } });
  });

  r.post('/orders/:id/acknowledge', async (req, res) => {
    const o = await col(req).findOne({ _id: idParam(req.params.id, 'Order'), tenantId: req.actor!.tenantId });
    if (!o) throw Errors.notFound('Order');
    const e = await db(req).collection('encounters').findOne({ _id: o.encounterId });
    await loadPatient(deps, req, o.patientId, { clinical: true });
    if (!encLevelOk(req.actor!.perms, e!.type, 'S')) await deny(deps, req, `${k.collection}:${id(o)}`, 'only a clinician on the visit acknowledges');
    if (!o.critical || o.critical.acknowledgedAt) throw Errors.conflict('NO_OPEN_CRITICAL', 'There is no open critical finding');
    const minutes = Math.round((now().getTime() - new Date(o.critical.raisedAt).getTime()) / 60_000);
    await col(req).updateOne({ _id: o._id }, { $set: { 'critical.acknowledgedAt': now(), 'critical.acknowledgedByName': req.actor!.name, 'critical.minutesToAcknowledge': minutes } });
    await audit(deps, req, { action: `${k.module}.critical.acknowledge`, resource: `${k.collection}:${id(o)}`, outcome: 'success', meta: { minutes } });
    res.json({ data: { id: id(o), minutesToAcknowledge: minutes } });
  });

  /** Spec §12.1: images stay in PACS; we hand out a short-lived, signed viewer link and audit it. */
  r.get('/orders/:id/viewer-link', async (req, res) => {
    const o = await col(req).findOne({ _id: idParam(req.params.id, 'Order'), tenantId: req.actor!.tenantId });
    if (!o) throw Errors.notFound('Order');
    if (!can(req.actor!.perms, k.module, 'E') || req.actor!.scope === 'assigned-patient') await loadPatient(deps, req, o.patientId, { clinical: true });
    else await assertBranch(deps, req, o.branchId);
    if (!o.studyInstanceUid) throw Errors.conflict('NO_STUDY', 'No images are linked to this order yet');
    const exp = Math.floor(now().getTime() / 1000) + 15 * 60;
    const payload = `${o.studyInstanceUid}.${req.actor!.userId.toHexString()}.${exp}`;
    const sig = createHmac('sha256', deps.config.dataKey).update(payload).digest('base64url');
    await audit(deps, req, { action: `${k.module}.viewer.open`, resource: `${k.collection}:${id(o)}`, outcome: 'allow' });
    res.json({ data: { url: `/viewer?study=${encodeURIComponent(o.studyInstanceUid)}&u=${req.actor!.userId.toHexString()}&exp=${exp}&sig=${sig}`, expiresAt: new Date(exp * 1000).toISOString() } });
  });

  return r;
}
