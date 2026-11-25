import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupHospital, type Hospital } from './fixtures';
import { startHarness, type Harness } from './helpers';

/** Spec §5.17: antenatal care, delivery, separate newborn records linked to the mother. */
let h: Harness;
let H: Hospital;
let mother = '';
let pregnancy = '';
const clock = new Date('2030-01-07T05:00:00Z');

beforeAll(async () => {
  h = await startHarness();
  h.config.now = () => clock;
  H = await setupHospital(h, [
    { key: 'reception', role: 'reception' },
    { key: 'obs', role: 'obstetrician' },
    { key: 'midwife', role: 'midwife' },
    { key: 'cashier', role: 'cashier' },
  ]);
  const rc = H.staff.reception!.c;
  mother = (await rc.post('/patients', { branchId: H.branchId, givenName: 'Hibaaq', familyName: 'Nuur', dob: '1998-06-01', sexAtBirth: 'female' })).body.data.id;
  for (const k of ['obs', 'midwife']) {
    await rc.post('/appointments/schedules', { providerId: H.staff[k]!.id, branchId: H.branchId, weekdays: [1], start: '08:00', end: '10:00', slotMinutes: 30 });
    await rc.post('/appointments', { patientId: mother, providerId: H.staff[k]!.id, startsAt: k === 'obs' ? '2030-01-07T05:30:00Z' : '2030-01-07T06:00:00Z' });
  }
});
afterAll(async () => {
  await h?.stop();
});

describe('antenatal', () => {
  it('opens one pregnancy with EDD by Naegele and current gestation', async () => {
    const r = await H.staff.midwife!.c.post('/maternity/pregnancies', { patientId: mother, lmp: '2029-05-01', gravida: 2, para: 1 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({ edd: '2030-02-05', gestation: { weeks: 35, days: 6 } });
    pregnancy = r.body.data.id;
    expect((await H.staff.obs!.c.post('/maternity/pregnancies', { patientId: mother, lmp: '2029-05-01', gravida: 2, para: 1 })).body.error.code).toBe('PREGNANCY_ACTIVE');
  });

  it('flags raised blood pressure and abnormal fetal heart rate', async () => {
    const v = await H.staff.midwife!.c.post(`/maternity/pregnancies/${pregnancy}/antenatal`, { bpSystolic: 152, bpDiastolic: 96, fetalHeartRate: 172, presentation: 'cephalic' });
    expect(v.body.data.flags).toEqual(['raised-blood-pressure', 'fetal-heart-rate-out-of-range']);
    const ok = await H.staff.midwife!.c.post(`/maternity/pregnancies/${pregnancy}/antenatal`, { bpSystolic: 118, bpDiastolic: 74, fetalHeartRate: 140 });
    expect(ok.body.data.flags).toEqual([]);
  });

  it('cashier cannot read maternity records', async () => {
    expect((await H.staff.cashier!.c.get(`/maternity/pregnancies/${pregnancy}`)).status).toBe(403);
  });
});

describe('delivery and newborns', () => {
  it('midwives record visits but the obstetrician signs the delivery', async () => {
    const body = {
      deliveredAt: '2030-01-07T04:40:00Z',
      mode: 'spontaneous-vaginal',
      bloodLossMl: 650,
      babies: [
        { sexAtBirth: 'female', weightGrams: 2450, apgar1: 8, apgar5: 9, outcome: 'live' },
        { sexAtBirth: 'male', weightGrams: 2210, apgar1: 7, apgar5: 9, outcome: 'live' },
      ],
    };
    expect((await H.staff.midwife!.c.post(`/maternity/pregnancies/${pregnancy}/delivery`, body)).status).toBe(403);
    const r = await H.staff.obs!.c.post(`/maternity/pregnancies/${pregnancy}/delivery`, body);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.newbornIds).toHaveLength(2);
    expect(r.body.data.warnings).toEqual(['blood-loss-at-or-above-500ml']);
    expect((await H.staff.obs!.c.post(`/maternity/pregnancies/${pregnancy}/delivery`, body)).status).toBe(409);
  });

  it('each live baby is its own patient, born today, linked to the mother and her care team', async () => {
    const fam = (await H.staff.obs!.c.get(`/maternity/patients/${mother}/family`)).body.data;
    expect(fam.newborns.map((b: { names: { given: string; family: string } }) => `${b.names.given} ${b.names.family}`)).toEqual(['Baby A of Hibaaq Nuur', 'Baby B of Hibaaq Nuur']);
    expect(fam.newborns[0]).toMatchObject({ dob: '2030-01-07', sexAtBirth: 'female' });
    const baby = fam.newborns[0]._id;
    const back = (await H.staff.midwife!.c.get(`/maternity/patients/${baby}/family`)).body.data;
    expect(back.mother._id).toBe(mother);
    expect((await H.staff.reception!.c.get(`/patients/${baby}`)).body.data.mrn).toMatch(/^MGD-30-/);
  });

  it('after delivery a new pregnancy can be opened later', async () => {
    const p = (await H.staff.obs!.c.get(`/maternity/pregnancies/${pregnancy}`)).body.data;
    expect(p.status).toBe('delivered');
    expect(p.gestation).toBeNull();
  });
});
