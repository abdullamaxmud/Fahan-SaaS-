import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupHospital, type Hospital } from './fixtures';
import { startHarness, type Harness } from './helpers';

/** Allergies, visit-type permissions and break-glass (spec §3.4, §4.1). */
let h: Harness;
let H: Hospital;
let patientId = '';
let enc = '';
const clock = new Date('2030-01-07T05:30:00Z');

beforeAll(async () => {
  h = await startHarness();
  h.config.now = () => clock;
  H = await setupHospital(h, [
    { key: 'reception', role: 'reception' },
    { key: 'doctor', role: 'physician' },
    { key: 'other', role: 'physician' },
    { key: 'ernurse', role: 'er-nurse' },
    { key: 'cashier', role: 'cashier' },
    { key: 'auditor', role: 'security-auditor' },
  ]);
  const rc = H.staff.reception!.c;
  patientId = (await rc.post('/patients', { branchId: H.branchId, givenName: 'Ismaaciil', familyName: 'Warsame', dob: '1961-02-10' })).body.data.id;
  enc = (await H.staff.doctor!.c.post('/encounters', { patientId })).body.data?.id;
});
afterAll(async () => {
  await h?.stop();
});

describe('opening a visit never creates a care relationship', () => {
  it('a doctor cannot open a visit for a branch patient they do not care for', async () => {
    expect(enc).toBeUndefined();
    const w = await H.staff.doctor!.c.post('/encounters', { patientId, reason: 'Chest pain' });
    expect(w.status).toBe(403);
  });

  it('reception checks in a walk-in with a chosen clinician', async () => {
    const w = await H.staff.reception!.c.post('/appointments/walk-in', { patientId, providerId: H.staff.doctor!.id, reason: 'Chest pain' });
    expect(w.status, JSON.stringify(w.body)).toBe(201);
    expect(w.body.data.queueNo).toBe(1);
    expect((await H.staff.doctor!.c.get(`/encounters/${w.body.data.encounterId}`)).status).toBe(200);
    // Now in the doctor's care, a follow-up visit can be opened directly.
    expect((await H.staff.doctor!.c.post('/encounters', { patientId, reason: 'Review' })).status).toBe(201);
  });
});

describe('allergies', () => {
  beforeAll(async () => {
    // Give the doctor a care relationship via a booked appointment.
    const rc = H.staff.reception!.c;
    await rc.post('/appointments/schedules', { providerId: H.staff.doctor!.id, branchId: H.branchId, weekdays: [1], start: '08:00', end: '10:00', slotMinutes: 20 });
    const ap = await rc.post('/appointments', { patientId, providerId: H.staff.doctor!.id, startsAt: '2030-01-07T05:40:00Z' });
    enc = (await rc.post(`/appointments/${ap.body.data.id}/check-in`)).body.data.encounterId;
  });

  it('records allergies once and shows them on the visit', async () => {
    const d = H.staff.doctor!.c;
    const a = await d.post(`/patients/${patientId}/allergies`, { substance: 'Penicillin', category: 'drug', reaction: 'Anaphylaxis', severity: 'life-threatening', verification: 'confirmed' });
    expect(a.status).toBe(201);
    expect((await d.post(`/patients/${patientId}/allergies`, { substance: 'penicillin', category: 'drug', severity: 'mild', verification: 'suspected' })).status).toBe(409);
    const v = (await d.get(`/encounters/${enc}`)).body.data;
    expect(v.patient.allergies.map((x: { substance: string }) => x.substance)).toEqual(['Penicillin']);
  });

  it('entered-in-error removes it from the active list but keeps history', async () => {
    const d = H.staff.doctor!.c;
    const list = (await d.get(`/patients/${patientId}/allergies`)).body.data;
    expect((await d.patch(`/patients/${patientId}/allergies/${list[0].id}`, { status: 'entered-in-error', reason: 'Wrong patient', version: 1 })).status).toBe(200);
    expect((await d.get(`/encounters/${enc}`)).body.data.patient.allergies).toHaveLength(0);
    expect((await d.get(`/patients/${patientId}/allergies`)).body.data[0].status).toBe('entered-in-error');
  });

  it('cashier and reception cannot see or add allergies', async () => {
    expect((await H.staff.cashier!.c.get(`/patients/${patientId}/allergies`)).status).toBe(403);
    expect((await H.staff.reception!.c.post(`/patients/${patientId}/allergies`, { substance: 'Latex', category: 'other', severity: 'mild', verification: 'suspected' })).status).toBe(403);
  });

  it('an emergency nurse cannot open an outpatient visit', async () => {
    expect((await H.staff.ernurse!.c.get(`/encounters/${enc}`)).status).toBe(403);
  });
});

describe('break-glass', () => {
  let grant = '';

  it('an unrelated doctor is refused, declares an emergency, then gets time-limited access', async () => {
    const o = H.staff.other!.c;
    expect((await o.get(`/patients/${patientId}/timeline`)).status).toBe(403);
    expect((await o.post('/break-glass', { patientId, reason: 'short' })).status).toBe(400);
    const g = await o.post('/break-glass', { patientId, reason: 'Collapsed in waiting area, treating doctor unavailable' });
    expect(g.status).toBe(201);
    grant = g.body.data.id;
    expect((await o.get(`/patients/${patientId}/timeline`)).status).toBe(200);
    expect((await o.get(`/encounters/${enc}`)).status).toBe(200);
  });

  it('cashiers cannot use break-glass', async () => {
    expect((await H.staff.cashier!.c.post('/break-glass', { patientId, reason: 'I really need to see this record now please' })).status).toBe(403);
  });

  it('the security auditor reviews it, which also ends the access', async () => {
    const au = H.staff.auditor!.c;
    const pending = (await au.get('/security/break-glass')).body.data;
    expect(pending).toHaveLength(1);
    expect(pending[0].eventsOnPatient).toBeGreaterThanOrEqual(2);
    expect((await au.post(`/security/break-glass/${grant}/review`, { outcome: 'justified', note: 'Confirmed with ED lead' })).status).toBe(200);
    expect((await au.post(`/security/break-glass/${grant}/review`, { outcome: 'justified', note: 'again' })).status).toBe(409);
    expect((await H.staff.other!.c.get(`/patients/${patientId}/timeline`)).status).toBe(403);
  });
});
