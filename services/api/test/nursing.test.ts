import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupHospital, type Hospital } from './fixtures';
import { startHarness, type Harness } from './helpers';

/** Spec §5.9 nursing and §5.10 critical care. */
let h: Harness;
let H: Hospital;
let admissionId = '';
let encounterId = '';
let wardId = '';

beforeAll(async () => {
  h = await startHarness();
  H = await setupHospital(h, [
    { key: 'reception', role: 'reception' },
    { key: 'officer', role: 'admission-officer' },
    { key: 'wm', role: 'ward-manager' },
    { key: 'doctor', role: 'ward-physician' },
    { key: 'nurse', role: 'nurse' },
    { key: 'nurse2', role: 'nurse' },
    { key: 'lead', role: 'shift-lead' },
    { key: 'icu', role: 'icu-team' },
    { key: 'cashier', role: 'cashier' },
  ]);
  const pid = (await H.staff.reception!.c.post('/patients', { branchId: H.branchId, givenName: 'Nasra', familyName: 'Daud', dob: '1974-09-09' })).body.data.id;
  wardId = (await H.staff.wm!.c.post('/wards', { branchId: H.branchId, code: 'ICU', name: 'Intensive care', kind: 'icu' })).body.data.id;
  await H.staff.wm!.c.post(`/wards/${wardId}/beds`, { count: 2 });
  const bed = (await H.staff.officer!.c.get('/wards')).body.data[0].beds[0].id;
  admissionId = (await H.staff.officer!.c.post('/admissions', { patientId: pid, attendingId: H.staff.doctor!.id, reason: 'Septic shock', source: 'ER' })).body.data.id;
  encounterId = (await H.staff.officer!.c.post(`/admissions/${admissionId}/assign-bed`, { bedId: bed })).body.data.encounterId;
  for (const k of ['nurse', 'nurse2']) await H.staff.doctor!.c.post(`/encounters/${encounterId}/care-team`, { userId: H.staff[k]!.id });
});
afterAll(async () => {
  await h?.stop();
});

describe('care plans', () => {
  it('a nurse on the care team writes and closes a plan; cashier cannot read it', async () => {
    const n = H.staff.nurse!.c;
    const p = await n.post(`/nursing/admissions/${admissionId}/care-plans`, { problem: 'Risk of pressure injury', goal: 'Skin intact at discharge', interventions: ['Turn 2-hourly', 'Pressure-relieving mattress'] });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    expect((await n.patch(`/nursing/care-plans/${p.body.data.id}`, { status: 'resolved', outcome: 'Mobilising independently', version: 1 })).status).toBe(200);
    expect((await n.patch(`/nursing/care-plans/${p.body.data.id}`, { status: 'resolved', outcome: 'again', version: 1 })).status).toBe(409);
    expect((await H.staff.cashier!.c.get(`/nursing/admissions/${admissionId}/care-plans`)).status).toBe(403);
  });
});

describe('handover', () => {
  it('only lists patients on the ward, and the incoming nurse acknowledges it', async () => {
    const n = H.staff.nurse!.c;
    expect((await n.post(`/nursing/wards/${wardId}/handovers`, { shift: 'night', summary: 'Quiet night', items: [{ admissionId: '0123456789abcdef01234567', note: 'x' }] })).status).toBe(400);
    const hv = await n.post(`/nursing/wards/${wardId}/handovers`, { shift: 'night', summary: 'One patient on noradrenaline', items: [{ admissionId, note: 'MAP > 65 since 04:00', risks: ['deterioration', 'pressure-injury'] }] });
    expect(hv.status, JSON.stringify(hv.body)).toBe(201);
    expect((await n.post(`/nursing/handovers/${hv.body.data.id}/acknowledge`)).body.error.code).toBe('FOUR_EYES');
    expect((await H.staff.nurse2!.c.post(`/nursing/handovers/${hv.body.data.id}/acknowledge`)).status).toBe(200);
    const list = (await H.staff.lead!.c.get(`/nursing/wards/${wardId}/handovers`)).body.data;
    expect(list[0]).toMatchObject({ shift: 'night', acknowledgedBy: 'nurse2' });
  });
});

describe('nursing notes and ICU devices', () => {
  it('a shift lead verifies a nurse note so it no longer blocks discharge', async () => {
    const note = await H.staff.nurse!.c.post(`/encounters/${encounterId}/notes`, { kind: 'progress', text: 'Febrile 38.9, blood cultures sent' });
    expect((await H.staff.nurse2!.c.post(`/nursing/notes/${note.body.data.id}/verify`)).status).toBe(403); // nurses cannot verify
    expect((await H.staff.lead!.c.post(`/nursing/notes/${note.body.data.id}/verify`)).body.data.status).toBe('Signed');
  });

  it('device readings must name the device', async () => {
    const icu = H.staff.icu!.c;
    expect((await icu.post(`/encounters/${encounterId}/observations`, { code: 'spo2', value: 91, source: 'device' })).status).toBe(400);
    const ok = await icu.post(`/encounters/${encounterId}/observations`, { code: 'spo2', value: 91, source: 'device', deviceId: 'MON-ICU-02' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const enc = (await icu.get(`/encounters/${encounterId}`)).body.data;
    expect(enc.type).toBe('IP');
  });
});
