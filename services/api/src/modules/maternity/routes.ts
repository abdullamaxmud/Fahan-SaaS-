import { Router, type Request } from 'express';
import type { Document, ObjectId } from 'mongodb';
import { z } from 'zod';
import { nameKeys } from '@fahan/terminology';
import type { Deps } from '../../context';
import { AppError, Errors } from '../../lib/errors';
import { localDate } from '../../lib/time';
import { idParam, objectId, parse } from '../../lib/validate';
import { audit } from '../../middleware/audit';
import { need } from '../../middleware/authorize';
import { assertRecentMfa } from '../../middleware/session';
import { loadPatient, patientScopeFilter } from '../patients/access';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const NewPregnancy = z.object({ patientId: objectId, lmp: day, gravida: z.number().int().min(1).max(25), para: z.number().int().min(0).max(25), notes: z.string().trim().max(1_000).optional() });
const Antenatal = z.object({
  bpSystolic: z.number().int().min(60).max(260),
  bpDiastolic: z.number().int().min(30).max(160),
  fundalHeightCm: z.number().min(5).max(50).optional(),
  fetalHeartRate: z.number().int().min(60).max(240).optional(),
  presentation: z.enum(['cephalic', 'breech', 'transverse', 'unknown']).optional(),
  notes: z.string().trim().max(2_000).optional(),
});
const Baby = z.object({
  sexAtBirth: z.enum(['female', 'male', 'unknown']),
  weightGrams: z.number().int().min(300).max(6_500),
  apgar1: z.number().int().min(0).max(10),
  apgar5: z.number().int().min(0).max(10),
  outcome: z.enum(['live', 'stillbirth']),
});
const Delivery = z.object({
  deliveredAt: z.string().datetime(),
  mode: z.enum(['spontaneous-vaginal', 'assisted-vaginal', 'caesarean']),
  bloodLossMl: z.number().int().min(0).max(10_000),
  babies: z.array(Baby).min(1).max(6),
  notes: z.string().trim().max(5_000).optional(),
});

const id = (x: { _id: ObjectId }) => x._id.toHexString();
const DAY = 86_400_000;
const addDays = (d: string, n: number) => new Date(new Date(`${d}T00:00:00Z`).getTime() + n * DAY).toISOString().slice(0, 10);
/** Gestational age in completed weeks+days from the last menstrual period. */
const gestation = (lmp: string, at: Date) => {
  const days = Math.floor((at.getTime() - new Date(`${lmp}T00:00:00Z`).getTime()) / DAY);
  return { weeks: Math.floor(days / 7), days: days % 7 };
};

/** Spec §5.17 maternity, neonatal & pediatrics: Antenatal → Delivery → Postnatal; newborns get their own linked record. */
export function maternityRoutes(deps: Deps): Router {
  const r = Router();
  const db = (req: Request) => req.actor!.db!;
  const now = () => deps.config.now();

  async function loadPregnancy(req: Request) {
    const p = await db(req).collection('pregnancies').findOne({ _id: idParam(req.params.id, 'Pregnancy'), tenantId: req.actor!.tenantId });
    if (!p) throw Errors.notFound('Pregnancy');
    const mother = await loadPatient(deps, req, p.patientId, { clinical: true });
    return { p, mother };
  }

  const view = (p: Document, visits: Document[] = []) => ({
    id: id(p as { _id: ObjectId }),
    patientId: p.patientId.toHexString(),
    status: p.status,
    lmp: p.lmp,
    edd: p.edd,
    gravida: p.gravida,
    para: p.para,
    gestation: p.status === 'active' ? gestation(p.lmp, now()) : null,
    visits: visits.map((v) => ({ id: id(v as { _id: ObjectId }), at: v.at, gestation: v.gestation, bp: `${v.bpSystolic}/${v.bpDiastolic}`, fetalHeartRate: v.fetalHeartRate ?? null, fundalHeightCm: v.fundalHeightCm ?? null, presentation: v.presentation ?? null, flags: v.flags, notes: v.notes ?? null })),
    delivery: p.delivery ? { ...p.delivery, newbornIds: (p.delivery.newbornIds as ObjectId[]).map((x) => x.toHexString()) } : null,
  });

  r.get('/pregnancies', need(deps, 'mat', 'V'), async (req, res) => {
    const a = req.actor!;
    const visible = await db(req).collection('patients').find({ tenantId: a.tenantId, ...patientScopeFilter(req) }, { projection: { _id: 1 } }).toArray();
    const list = await db(req).collection('pregnancies').find({ tenantId: a.tenantId, status: 'active', patientId: { $in: visible.map((x) => x._id) } }).sort({ edd: 1 }).limit(300).toArray();
    const moms = await db(req).collection('patients').find({ _id: { $in: list.map((x) => x.patientId) } }, { projection: { names: 1, mrn: 1, dob: 1 } }).toArray();
    res.json({ data: list.map((p) => ({ ...view(p), mother: moms.find((m) => m._id.equals(p.patientId)) ?? null })) });
  });

  r.post('/pregnancies', need(deps, 'mat', 'E'), async (req, res) => {
    const body = parse(NewPregnancy, req.body);
    const mother = await loadPatient(deps, req, body.patientId, { clinical: true });
    if (mother.sexAtBirth === 'male') throw Errors.validation([{ path: 'patientId', message: 'This record is registered as male' }]);
    const g = gestation(body.lmp, now());
    if (g.weeks < 0 || g.weeks > 44) throw Errors.validation([{ path: 'lmp', message: 'The last menstrual period must be within the last 44 weeks' }]);
    const a = req.actor!;
    try {
      const ins = await db(req).collection('pregnancies').insertOne({
        tenantId: a.tenantId,
        patientId: mother._id,
        lmp: body.lmp,
        edd: addDays(body.lmp, 280), // Naegele's rule
        gravida: body.gravida,
        para: body.para,
        notes: body.notes,
        status: 'active',
        activeLock: true,
        createdAt: new Date(),
        createdBy: a.userId,
        version: 1,
      });
      await audit(deps, req, { action: 'mat.pregnancy.open', resource: `patient:${id(mother)}`, outcome: 'success' });
      res.status(201).json({ data: { id: ins.insertedId.toHexString(), edd: addDays(body.lmp, 280), gestation: g } });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw Errors.conflict('PREGNANCY_ACTIVE', 'This patient already has an active pregnancy record');
      throw e;
    }
  });

  r.get('/pregnancies/:id', need(deps, 'mat', 'V'), async (req, res) => {
    const { p } = await loadPregnancy(req);
    const visits = await db(req).collection('antenatal_visits').find({ pregnancyId: p._id }).sort({ at: -1 }).toArray();
    res.json({ data: view(p, visits) });
  });

  r.post('/pregnancies/:id/antenatal', need(deps, 'mat', 'E'), async (req, res) => {
    const body = parse(Antenatal, req.body);
    const { p } = await loadPregnancy(req);
    if (p.status !== 'active') throw Errors.conflict('INVALID_TRANSITION', 'This pregnancy has ended');
    const at = now();
    // Flags draw attention; they are not a diagnosis (clinical rules need local sign-off, spec §4.2).
    const flags: string[] = [];
    if (body.bpSystolic >= 140 || body.bpDiastolic >= 90) flags.push('raised-blood-pressure');
    if (body.fetalHeartRate !== undefined && (body.fetalHeartRate < 110 || body.fetalHeartRate > 160)) flags.push('fetal-heart-rate-out-of-range');
    const a = req.actor!;
    const ins = await db(req).collection('antenatal_visits').insertOne({ tenantId: a.tenantId, pregnancyId: p._id, patientId: p.patientId, ...body, gestation: gestation(p.lmp, at), flags, at, recordedBy: a.userId });
    await audit(deps, req, { action: 'mat.antenatal.record', resource: `pregnancy:${id(p)}`, outcome: 'success', meta: { flags: flags.join(',') } });
    res.status(201).json({ data: { id: ins.insertedId.toHexString(), gestation: gestation(p.lmp, at), flags } });
  });

  r.post('/pregnancies/:id/delivery', need(deps, 'mat', 'S'), async (req, res) => {
    const body = parse(Delivery, req.body);
    const { p, mother } = await loadPregnancy(req);
    assertRecentMfa(deps, req);
    if (p.status !== 'active') throw Errors.conflict('INVALID_TRANSITION', 'A delivery is already recorded for this pregnancy');
    const deliveredAt = new Date(body.deliveredAt);
    if (deliveredAt.getTime() > now().getTime() + 5 * 60_000) throw Errors.validation([{ path: 'deliveredAt', message: 'Delivery time cannot be in the future' }]);
    const a = req.actor!;
    const branchId = (mother.branchIds as ObjectId[])[0]!;
    const branch = await db(req).collection('branches').findOne({ _id: branchId });
    const tz = branch?.timezone ?? 'Africa/Mogadishu';
    const newbornIds: ObjectId[] = [];
    const s = deps.data.client.startSession();
    try {
      await s.withTransaction(async () => {
        newbornIds.length = 0;
        const yy = deliveredAt.getUTCFullYear().toString().slice(2);
        for (const [i, b] of body.babies.entries()) {
          if (b.outcome !== 'live') continue;
          const counter = await db(req)
            .collection<{ _id: string; seq: number }>('counters')
            .findOneAndUpdate({ _id: `mrn:${branch?.code}:${yy}` }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after', session: s });
          const suffix = body.babies.length > 1 ? ` ${String.fromCharCode(65 + i)}` : '';
          const names = { given: `Baby${suffix}`, family: `of ${mother.names.given} ${mother.names.family}` };
          const ins = await db(req).collection('patients').insertOne(
            {
              tenantId: a.tenantId,
              branchIds: mother.branchIds,
              mrn: `${branch?.code}-${yy}-${String(counter!.seq).padStart(6, '0')}`,
              names,
              nameKeys: nameKeys(names.given, mother.names.given, mother.names.family),
              dob: localDate(deliveredAt, tz),
              sexAtBirth: b.sexAtBirth,
              identifiers: [],
              contacts: [],
              status: 'Provisional',
              newborn: true,
              motherId: mother._id,
              careTeam: mother.careTeam ?? [],
              createdAt: new Date(),
              createdBy: a.userId,
              version: 1,
            },
            { session: s },
          );
          newbornIds.push(ins.insertedId);
          await db(req)
            .collection('newborn_records')
            .insertOne({ tenantId: a.tenantId, babyId: ins.insertedId, motherId: mother._id, pregnancyId: p._id, ...b, bornAt: deliveredAt }, { session: s });
        }
        const upd = await db(req).collection('pregnancies').updateOne(
          { _id: p._id, status: 'active' },
          {
            $set: {
              status: 'delivered',
              delivery: { at: deliveredAt, mode: body.mode, bloodLossMl: body.bloodLossMl, babies: body.babies, notes: body.notes, recordedBy: a.userId, recordedByName: a.name, newbornIds },
            },
            $unset: { activeLock: '' },
            $inc: { version: 1 },
          },
          { session: s },
        );
        if (!upd.modifiedCount) throw Errors.conflict('INVALID_TRANSITION', 'A delivery was just recorded by someone else');
      });
    } finally {
      await s.endSession();
    }
    await audit(deps, req, { action: 'mat.delivery', resource: `pregnancy:${id(p)}`, outcome: 'success', meta: { mode: body.mode, live: newbornIds.length } });
    if (body.bloodLossMl >= 500) {
      // Postpartum haemorrhage threshold — surfaced to the caller as a warning, never auto-treated.
      return res.json({ data: { id: id(p), status: 'delivered', newbornIds: newbornIds.map((x) => x.toHexString()), warnings: ['blood-loss-at-or-above-500ml'] } });
    }
    res.json({ data: { id: id(p), status: 'delivered', newbornIds: newbornIds.map((x) => x.toHexString()), warnings: [] } });
  });

  /** Mother ↔ newborn link (spec §5.17 acceptance: separate newborn record with longitudinal linkage). */
  r.get('/patients/:id/family', need(deps, 'mat', 'V'), async (req, res) => {
    const pt = await loadPatient(deps, req, idParam(req.params.id, 'Patient'), { clinical: true });
    const a = req.actor!;
    const babies = await db(req).collection('patients').find({ tenantId: a.tenantId, motherId: pt._id }, { projection: { names: 1, mrn: 1, dob: 1, sexAtBirth: 1 } }).toArray();
    const mother = pt.motherId ? await db(req).collection('patients').findOne({ _id: pt.motherId }, { projection: { names: 1, mrn: 1, dob: 1 } }) : null;
    if (!babies.length && !mother) throw new AppError(404, 'NO_FAMILY_LINK', 'No mother or newborn is linked to this record');
    res.json({ data: { mother, newborns: babies } });
  });

  return r;
}
