import { Router, type Request } from 'express';
import type { Document, ObjectId, WithId } from 'mongodb';
import { z } from 'zod';
import { isBranchBound } from '@fahan/policy';
import type { Deps } from '../../context';
import { AppError, Errors } from '../../lib/errors';
import { idParam, objectId, parse } from '../../lib/validate';
import { audit } from '../../middleware/audit';
import { assertBranch, need } from '../../middleware/authorize';

/**
 * Spec §5.10 ICU / NICU / PICU: Open → Monitored → Transferred / Closed.
 *  - A stay belongs to an active admission; one open stay per admission.
 *  - Every device feeding readings is labelled on the stay (spec: "device feeds must be labeled").
 *  - Readings keep their source and device; nothing here treats the patient automatically.
 */
const UNITS = ['ICU', 'NICU', 'PICU', 'HDU'] as const;
const OPEN = ['Open', 'Monitored'];
const NewStay = z.object({ admissionId: objectId, unit: z.enum(UNITS), acuity: z.number().int().min(1).max(3).default(2), reason: z.string().trim().min(3).max(300) });
const Device = z.object({ deviceId: z.string().trim().min(2).max(60), kind: z.enum(['monitor', 'ventilator', 'infusion-pump', 'dialysis', 'other']), label: z.string().trim().min(2).max(80) });
const Review = z.object({ note: z.string().trim().min(3).max(2_000), acuity: z.number().int().min(1).max(3), ventilated: z.boolean() });
const Close = z.object({ outcome: z.enum(['stepped-down', 'transferred', 'discharged', 'died']), note: z.string().trim().min(3).max(1_000) });

const id = (x: { _id: ObjectId }) => x._id.toHexString();

export function icuRoutes(deps: Deps): Router {
  const r = Router();
  const db = (req: Request) => req.actor!.db!;

  async function stay(req: Request) {
    const x = await db(req).collection('critical_care_stays').findOne({ _id: idParam(req.params.id, 'ICU stay'), tenantId: req.actor!.tenantId });
    if (!x) throw Errors.notFound('ICU stay');
    await assertBranch(deps, req, x.branchId);
    return x;
  }

  async function latest(req: Request, encounterIds: ObjectId[]) {
    if (!encounterIds.length) return [];
    return db(req)
      .collection('observations')
      .aggregate([
        { $match: { tenantId: req.actor!.tenantId, encounterId: { $in: encounterIds }, status: 'Recorded' } },
        { $sort: { effectiveAt: -1 } },
        { $group: { _id: { e: '$encounterId', c: '$code' }, value: { $first: '$value' }, unit: { $first: '$unit' }, at: { $first: '$effectiveAt' }, source: { $first: '$source' }, deviceId: { $first: '$deviceId' } } },
      ])
      .toArray();
  }

  const view = (x: WithId<Document>, extra: Document = {}) => ({
    id: id(x),
    unit: x.unit,
    status: x.status,
    acuity: x.acuity,
    ventilated: Boolean(x.ventilated),
    reason: x.reason,
    openedAt: x.openedAt,
    encounterId: (x.encounterId as ObjectId).toHexString(),
    admissionId: (x.admissionId as ObjectId).toHexString(),
    devices: ((x.devices ?? []) as Document[]).filter((d) => !d.detachedAt).map((d) => ({ deviceId: d.deviceId, kind: d.kind, label: d.label, attachedAt: d.attachedAt })),
    outcome: x.outcome ?? null,
    closedAt: x.closedAt ?? null,
    ...extra,
  });

  r.get('/stays', need(deps, 'icu', 'V'), async (req, res) => {
    const a = req.actor!;
    const q = parse(z.object({ status: z.enum(['active', 'all']).default('active') }), req.query);
    const f: Document = { tenantId: a.tenantId };
    if (q.status === 'active') f.status = { $in: OPEN };
    if (a.scope === 'assigned-patient') {
      // Clinicians who work patient by patient see only the critical-care patients in their care.
      const mine = await db(req).collection('patients').find({ tenantId: a.tenantId, careTeam: a.userId }, { projection: { _id: 1 } }).toArray();
      f.patientId = { $in: mine.map((p) => p._id) };
    } else if (isBranchBound(a.scope)) f.branchId = a.branchId ?? null;
    const list = await db(req).collection('critical_care_stays').find(f).sort({ acuity: 1, openedAt: 1 }).limit(200).toArray();
    const [pats, adms, obs] = await Promise.all([
      db(req).collection('patients').find({ _id: { $in: list.map((x) => x.patientId) } }, { projection: { names: 1, mrn: 1, dob: 1, sexAtBirth: 1 } }).toArray(),
      db(req).collection('admissions').find({ _id: { $in: list.map((x) => x.admissionId) } }, { projection: { bedId: 1 } }).toArray(),
      latest(req, list.map((x) => x.encounterId)),
    ]);
    const beds = await db(req).collection('beds').find({ _id: { $in: adms.map((x) => x.bedId).filter(Boolean) } }, { projection: { code: 1 } }).toArray();
    res.json({
      data: list.map((x) => {
        const p = pats.find((y) => y._id.equals(x.patientId));
        const adm = adms.find((y) => y._id.equals(x.admissionId));
        return view(x, {
          patient: p ? { id: id(p), mrn: p.mrn, names: p.names, dob: p.dob, sexAtBirth: p.sexAtBirth ?? null } : null,
          bed: beds.find((b) => adm?.bedId && b._id.equals(adm.bedId))?.code ?? null,
          vitals: obs.filter((o) => (o._id.e as ObjectId).equals(x.encounterId)).map((o) => ({ code: o._id.c, value: o.value, unit: o.unit, at: o.at, source: o.source, deviceId: o.deviceId ?? null })),
        });
      }),
    });
  });

  /** Admitted patients not yet in critical care, for opening a stay. */
  r.get('/candidates', need(deps, 'icu', 'E'), async (req, res) => {
    const a = req.actor!;
    const f: Document = { tenantId: a.tenantId, status: 'Admitted' };
    if (isBranchBound(a.scope) && a.scope !== 'assigned-patient') f.branchId = a.branchId ?? null;
    const open = await db(req).collection('critical_care_stays').distinct('admissionId', { tenantId: a.tenantId, status: { $in: OPEN } });
    f._id = { $nin: open };
    const adms = await db(req).collection('admissions').find(f).sort({ admittedAt: -1 }).limit(200).toArray();
    const pats = await db(req).collection('patients').find({ _id: { $in: adms.map((x) => x.patientId) } }, { projection: { names: 1, mrn: 1 } }).toArray();
    res.json({ data: adms.map((x) => ({ admissionId: id(x), patient: pats.find((p) => p._id.equals(x.patientId)) ?? null })) });
  });

  r.post('/stays', need(deps, 'icu', 'E'), async (req, res) => {
    const body = parse(NewStay, req.body);
    const a = req.actor!;
    const adm = await db(req).collection('admissions').findOne({ _id: body.admissionId, tenantId: a.tenantId });
    if (!adm) throw Errors.notFound('Admission');
    await assertBranch(deps, req, adm.branchId);
    if (adm.status !== 'Admitted' || !adm.encounterId) throw Errors.conflict('NOT_ADMITTED', 'The patient must be admitted to a bed first');
    try {
      const ins = await db(req).collection('critical_care_stays').insertOne({
        tenantId: a.tenantId,
        branchId: adm.branchId,
        admissionId: adm._id,
        encounterId: adm.encounterId,
        patientId: adm.patientId,
        unit: body.unit,
        acuity: body.acuity,
        reason: body.reason,
        ventilated: false,
        status: 'Open',
        openLock: true,
        devices: [],
        reviews: [],
        openedAt: new Date(),
        openedBy: a.userId,
      });
      await db(req).collection('encounters').updateOne({ _id: adm.encounterId }, { $addToSet: { clinicianIds: a.userId } });
      await db(req).collection('patients').updateOne({ _id: adm.patientId }, { $addToSet: { careTeam: a.userId } });
      await audit(deps, req, { action: 'icu.stay.open', resource: `icu_stay:${ins.insertedId.toHexString()}`, outcome: 'success', meta: { unit: body.unit } });
      res.status(201).json({ data: { id: ins.insertedId.toHexString(), status: 'Open' } });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw Errors.conflict('STAY_OPEN', 'This admission already has an open critical-care stay');
      throw e;
    }
  });

  r.get('/stays/:id', need(deps, 'icu', 'V'), async (req, res) => {
    const x = await stay(req);
    const since = new Date(deps.config.now().getTime() - 48 * 3_600_000);
    const obs = await db(req)
      .collection('observations')
      .find({ tenantId: req.actor!.tenantId, encounterId: x.encounterId, status: 'Recorded', effectiveAt: { $gte: since } })
      .sort({ effectiveAt: 1 })
      .limit(2_000)
      .toArray();
    const p = await db(req).collection('patients').findOne({ _id: x.patientId }, { projection: { names: 1, mrn: 1, dob: 1, sexAtBirth: 1 } });
    res.json({
      data: view(x, {
        patient: p ? { id: id(p), mrn: p.mrn, names: p.names, dob: p.dob, sexAtBirth: p.sexAtBirth ?? null } : null,
        reviews: ((x.reviews ?? []) as Document[]).map((v) => ({ at: v.at, byName: v.byName, note: v.note, acuity: v.acuity, ventilated: v.ventilated })),
        allDevices: ((x.devices ?? []) as Document[]).map((d) => ({ deviceId: d.deviceId, kind: d.kind, label: d.label, attachedAt: d.attachedAt, detachedAt: d.detachedAt ?? null })),
        trend: obs.map((o) => ({ code: o.code, value: o.value, unit: o.unit, at: o.effectiveAt, source: o.source, deviceId: o.deviceId ?? null })),
      }),
    });
  });

  r.post('/stays/:id/devices', need(deps, 'icu', 'E'), async (req, res) => {
    const body = parse(Device, req.body);
    const x = await stay(req);
    if (!OPEN.includes(x.status)) throw Errors.conflict('STAY_CLOSED', 'This stay is closed');
    if (((x.devices ?? []) as Document[]).some((d) => d.deviceId === body.deviceId && !d.detachedAt)) throw Errors.conflict('DEVICE_ATTACHED', `${body.deviceId} is already attached`);
    const busy = await db(req).collection('critical_care_stays').findOne({ tenantId: req.actor!.tenantId, status: { $in: OPEN }, devices: { $elemMatch: { deviceId: body.deviceId, detachedAt: null } } });
    if (busy) throw new AppError(409, 'DEVICE_IN_USE', `${body.deviceId} is attached to another patient`);
    await db(req)
      .collection('critical_care_stays')
      .updateOne({ _id: x._id }, { $push: { devices: { ...body, attachedAt: new Date(), attachedBy: req.actor!.userId, detachedAt: null } } as Document, $set: { status: 'Monitored' } });
    await audit(deps, req, { action: 'icu.device.attach', resource: `icu_stay:${id(x)}`, outcome: 'success', meta: { deviceId: body.deviceId, kind: body.kind } });
    res.status(201).json({ data: { id: id(x), status: 'Monitored' } });
  });

  r.post('/stays/:id/devices/:deviceId/detach', need(deps, 'icu', 'E'), async (req, res) => {
    const x = await stay(req);
    const upd = await db(req)
      .collection('critical_care_stays')
      .updateOne({ _id: x._id }, { $set: { 'devices.$[d].detachedAt': new Date() } }, { arrayFilters: [{ 'd.deviceId': String(req.params.deviceId), 'd.detachedAt': null }] });
    if (!upd.modifiedCount) throw Errors.notFound('Device');
    await audit(deps, req, { action: 'icu.device.detach', resource: `icu_stay:${id(x)}`, outcome: 'success', meta: { deviceId: String(req.params.deviceId) } });
    res.json({ data: { id: id(x) } });
  });

  /** Daily round by the critical-care team: acuity and ventilation status, signed with a name and time. */
  r.post('/stays/:id/review', need(deps, 'icu', 'S'), async (req, res) => {
    const body = parse(Review, req.body);
    const x = await stay(req);
    if (!OPEN.includes(x.status)) throw Errors.conflict('STAY_CLOSED', 'This stay is closed');
    await db(req)
      .collection('critical_care_stays')
      .updateOne({ _id: x._id }, { $set: { acuity: body.acuity, ventilated: body.ventilated }, $push: { reviews: { ...body, at: new Date(), by: req.actor!.userId, byName: req.actor!.name } } as Document });
    await audit(deps, req, { action: 'icu.review', resource: `icu_stay:${id(x)}`, outcome: 'success', meta: { acuity: body.acuity } });
    res.status(201).json({ data: { id: id(x) } });
  });

  r.post('/stays/:id/close', need(deps, 'icu', 'S'), async (req, res) => {
    const body = parse(Close, req.body);
    const x = await stay(req);
    const status = body.outcome === 'stepped-down' || body.outcome === 'transferred' ? 'Transferred' : 'Closed';
    const upd = await db(req)
      .collection('critical_care_stays')
      .updateOne(
        { _id: x._id, status: { $in: OPEN } },
        { $set: { status, outcome: body.outcome, closeNote: body.note, closedAt: new Date(), closedBy: req.actor!.userId, 'devices.$[d].detachedAt': new Date() }, $unset: { openLock: '' } },
        { arrayFilters: [{ 'd.detachedAt': null }] },
      );
    if (!upd.modifiedCount) throw Errors.conflict('STAY_CLOSED', 'This stay is already closed');
    await audit(deps, req, { action: 'icu.stay.close', resource: `icu_stay:${id(x)}`, outcome: 'success', meta: { outcome: body.outcome } });
    res.json({ data: { id: id(x), status } });
  });

  return r;
}
