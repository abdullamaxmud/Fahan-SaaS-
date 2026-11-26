import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupHospital, type Hospital } from './fixtures';
import { startHarness, type Harness } from './helpers';

/** Spec §5.10 (Open → Monitored → Transferred / Closed; labelled device feeds) and §5.24 CSSD sterilisation. */
let h: Harness;
let H: Hospital;
let admissionId = '';
let encounterId = '';
let stay = '';

beforeAll(async () => {
  h = await startHarness();
  H = await setupHospital(h, [
    { key: 'rec', role: 'reception' },
    { key: 'officer', role: 'admission-officer' },
    { key: 'wm', role: 'ward-manager' },
    { key: 'doc', role: 'ward-physician' },
    { key: 'icu', role: 'icu-team' },
    { key: 'nurse', role: 'nurse' },
    { key: 'bio', role: 'biomedical' },
    { key: 'cssd', role: 'facilities-cssd' },
  ]);
  const p = await H.staff.rec!.c.post('/patients', { branchId: H.branchId, givenName: 'Cumar', familyName: 'Xuseen', dob: '1960-01-01' });
  const w = await H.staff.wm!.c.post('/wards', { branchId: H.branchId, code: 'ICU', name: 'Intensive care', kind: 'icu' });
  await H.staff.wm!.c.post(`/wards/${w.body.data.id}/beds`, { count: 2 });
  const beds = (await H.staff.officer!.c.get('/wards')).body.data[0].beds;
  const a = await H.staff.officer!.c.post('/admissions', { patientId: p.body.data.id, attendingId: H.staff.doc!.id, reason: 'Septic shock', source: 'ER' });
  admissionId = a.body.data.id;
  const asg = await H.staff.officer!.c.post(`/admissions/${admissionId}/assign-bed`, { bedId: beds[0].id });
  expect(asg.status, JSON.stringify(asg.body)).toBe(200);
  encounterId = asg.body.data.encounterId;
});
afterAll(async () => {
  await h?.stop();
});

describe('critical care stays', () => {
  it('the ICU team opens one stay per admission; other roles cannot', async () => {
    expect((await H.staff.nurse!.c.post('/icu/stays', { admissionId, unit: 'ICU', reason: 'Septic shock' })).status).toBe(403);
    const cands = (await H.staff.icu!.c.get('/icu/candidates')).body.data;
    expect(cands.map((c: { admissionId: string }) => c.admissionId)).toContain(admissionId);
    const r = await H.staff.icu!.c.post('/icu/stays', { admissionId, unit: 'ICU', acuity: 1, reason: 'Septic shock on noradrenaline' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    stay = r.body.data.id;
    expect((await H.staff.icu!.c.post('/icu/stays', { admissionId, unit: 'ICU', reason: 'Again' })).body.error.code).toBe('STAY_OPEN');
  });

  it('attaching a labelled device moves the stay to Monitored; a device cannot serve two patients', async () => {
    expect((await H.staff.icu!.c.post(`/icu/stays/${stay}/devices`, { deviceId: 'MON-07', kind: 'monitor', label: 'Bedside monitor bay 1' })).body.data.status).toBe('Monitored');
    expect((await H.staff.icu!.c.post(`/icu/stays/${stay}/devices`, { deviceId: 'MON-07', kind: 'monitor', label: 'Again' })).body.error.code).toBe('DEVICE_ATTACHED');
  });

  it('device readings keep their source; the trend shows where each value came from', async () => {
    const o = await H.staff.icu!.c.post(`/encounters/${encounterId}/observations`, { code: 'heart-rate', value: 128, source: 'device', deviceId: 'MON-07' });
    expect(o.status, JSON.stringify(o.body)).toBe(201);
    await H.staff.icu!.c.post(`/encounters/${encounterId}/observations`, { code: 'heart-rate', value: 118, source: 'manual' });
    const d = (await H.staff.icu!.c.get(`/icu/stays/${stay}`)).body.data;
    expect(d.trend.map((x: { source: string; deviceId: string | null }) => [x.source, x.deviceId])).toEqual([
      ['device', 'MON-07'],
      ['manual', null],
    ]);
    const board = (await H.staff.icu!.c.get('/icu/stays')).body.data[0];
    expect(board.vitals.find((v: { code: string }) => v.code === 'heart-rate')).toMatchObject({ value: 118, source: 'manual' });
  });

  it('the daily review records acuity and ventilation; closing detaches devices', async () => {
    expect((await H.staff.icu!.c.post(`/icu/stays/${stay}/review`, { note: 'Weaning pressors', acuity: 2, ventilated: true })).status).toBe(201);
    const c = await H.staff.icu!.c.post(`/icu/stays/${stay}/close`, { outcome: 'stepped-down', note: 'To ward 3B' });
    expect(c.body.data.status).toBe('Transferred');
    const d = (await H.staff.icu!.c.get(`/icu/stays/${stay}`)).body.data;
    expect(d.devices).toHaveLength(0);
    expect(d.allDevices[0].detachedAt).not.toBeNull();
    expect((await H.staff.icu!.c.post(`/icu/stays/${stay}/review`, { note: 'x x x', acuity: 2, ventilated: false })).status).toBe(409);
  });
});

describe('CSSD sterilisation', () => {
  let ac = '';
  it('a load runs only in a working steriliser; failed loads are never released', async () => {
    const a = await H.staff.bio!.c.post('/equipment/assets', { branchId: H.branchId, code: 'AC-1', name: 'Steam autoclave', kind: 'autoclave', nextCalibrationDue: '2099-01-01' });
    ac = a.body.data.id;
    const b = await H.staff.cssd!.c.post('/equipment/cssd/batches', { autoclaveId: ac, program: '134C-4min', items: [{ set: 'Laparotomy set', qty: 2 }] });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    expect((await H.staff.cssd!.c.post('/equipment/cssd/batches', { autoclaveId: ac, program: '134C-4min', items: [{ set: 'Minor set', qty: 1 }] })).body.error.code).toBe('STERILISER_BUSY');
    expect((await H.staff.cssd!.c.post(`/equipment/cssd/batches/${b.body.data.id}/result`, { chemical: 'pass', biological: 'pass' })).status).toBe(409);
    await H.staff.cssd!.c.post(`/equipment/cssd/batches/${b.body.data.id}/start`);
    expect((await H.staff.cssd!.c.post(`/equipment/cssd/batches/${b.body.data.id}/result`, { chemical: 'pass', biological: 'fail' })).body.data.status).toBe('Failed');
    expect((await H.staff.cssd!.c.post(`/equipment/cssd/batches/${b.body.data.id}/release`)).body.error.code).toBe('LOAD_FAILED');
  });

  it('a passed load is released and can be recalled by the biomedical lead with its sets listed', async () => {
    const b = await H.staff.cssd!.c.post('/equipment/cssd/batches', { autoclaveId: ac, program: '121C-20min', items: [{ set: 'Caesarean set', qty: 3 }] });
    await H.staff.cssd!.c.post(`/equipment/cssd/batches/${b.body.data.id}/start`);
    await H.staff.cssd!.c.post(`/equipment/cssd/batches/${b.body.data.id}/result`, { chemical: 'pass', biological: 'pass' });
    expect((await H.staff.cssd!.c.post(`/equipment/cssd/batches/${b.body.data.id}/release`)).body.data.status).toBe('Released');
    expect((await H.staff.cssd!.c.post(`/equipment/cssd/batches/${b.body.data.id}/recall`, { reason: 'Wet packs found' })).status).toBe(403);
    const r = await H.staff.bio!.c.post(`/equipment/cssd/batches/${b.body.data.id}/recall`, { reason: 'Wet packs found in theatre' });
    expect(r.body.data).toMatchObject({ status: 'Recalled', sets: [{ set: 'Caesarean set', qty: 3 }] });
  });

  it('an out-of-service steriliser cannot take a load', async () => {
    await H.staff.cssd!.c.post(`/equipment/assets/${ac}/out-of-service`, { reason: 'Door seal leaking' });
    expect((await H.staff.cssd!.c.post('/equipment/cssd/batches', { autoclaveId: ac, program: '134C-4min', items: [{ set: 'Minor set', qty: 1 }] })).body.error.code).toBe('DEVICE_UNAVAILABLE');
  });
});
