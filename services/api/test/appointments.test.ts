import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupHospital, type Hospital } from './fixtures';
import { startHarness, type Harness } from './helpers';

/** Spec §5.4: slots, no double-booking under concurrency, check-in opens the encounter, cancel / no-show. */
let h: Harness;
let H: Hospital;
let patientId = '';
let patient2 = '';
let doctorId = '';
// Monday 7 Jan 2030, 07:30 in Mogadishu (UTC+3).
let clock = new Date('2030-01-07T04:30:00Z');

beforeAll(async () => {
  h = await startHarness();
  h.config.now = () => clock;
  H = await setupHospital(h, [
    { key: 'reception', role: 'reception' },
    { key: 'doctor', role: 'physician' },
    { key: 'nurse', role: 'nurse' },
    { key: 'cashier', role: 'cashier' },
  ]);
  doctorId = H.staff.doctor!.id;
  const rc = H.staff.reception!.c;
  patientId = (await rc.post('/patients', { branchId: H.branchId, givenName: 'Faadumo', familyName: 'Xasan', dob: '1992-03-14' })).body.data.id;
  patient2 = (await rc.post('/patients', { branchId: H.branchId, givenName: 'Khadar', familyName: 'Muuse', dob: '1985-11-02' })).body.data.id;
});
afterAll(async () => {
  await h?.stop();
});

const book = (startsAt: string, pid = patientId) => H.staff.reception!.c.post('/appointments', { patientId: pid, providerId: doctorId, startsAt, reason: 'Fever' });

describe('schedules and slots', () => {
  it('only lists clinicians who run clinics', async () => {
    const list = (await H.staff.reception!.c.get('/appointments/providers')).body.data;
    expect(list.map((p: { id: string }) => p.id)).toEqual([doctorId]);
  });

  it('creates a weekday session and rejects overlaps', async () => {
    const rc = H.staff.reception!.c;
    const ok = await rc.post('/appointments/schedules', { providerId: doctorId, branchId: H.branchId, weekdays: [1, 2, 3], start: '08:00', end: '12:00', slotMinutes: 20 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const clash = await rc.post('/appointments/schedules', { providerId: doctorId, branchId: H.branchId, weekdays: [1], start: '11:00', end: '13:00', slotMinutes: 20 });
    expect(clash.status).toBe(409);
    const bad = await rc.post('/appointments/schedules', { providerId: H.staff.nurse!.id, branchId: H.branchId, weekdays: [1], start: '08:00', end: '09:00', slotMinutes: 20 });
    expect(bad.status).toBe(400);
  });

  it('builds 12 slots in branch local time', async () => {
    const slots = (await H.staff.reception!.c.get(`/appointments/slots?providerId=${doctorId}&date=2030-01-07`)).body.data;
    expect(slots).toHaveLength(12);
    expect(slots[0]).toMatchObject({ time: '08:00', startsAt: '2030-01-07T05:00:00.000Z', free: true });
    expect((await H.staff.reception!.c.get(`/appointments/slots?providerId=${doctorId}&date=2030-01-06`)).body.data).toHaveLength(0); // Sunday
  });
});

describe('booking', () => {
  it('rejects times that are not slots', async () => {
    expect((await book('2030-01-07T05:10:00Z')).status).toBe(400);
  });

  it('never double-books a slot, even under concurrent requests', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => book('2030-01-07T05:00:00Z')));
    const codes = results.map((r) => r.status).sort();
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(5);
    const slot = (await H.staff.reception!.c.get(`/appointments/slots?providerId=${doctorId}&date=2030-01-07`)).body.data[0];
    expect(slot.free).toBe(false);
  });

  it('booking gives the doctor a care relationship with the patient', async () => {
    expect((await H.staff.doctor!.c.get(`/patients/${patientId}`)).status).toBe(200);
    expect((await H.staff.doctor!.c.get(`/patients/${patient2}`)).status).toBe(403);
  });

  it('cancelling frees the slot for someone else', async () => {
    const r = await book('2030-01-07T05:20:00Z', patient2);
    expect(r.status).toBe(201);
    expect((await H.staff.reception!.c.post(`/appointments/${r.body.data.id}/cancel`, { reason: 'Patient called' })).status).toBe(200);
    expect((await book('2030-01-07T05:20:00Z', patient2)).status).toBe(201);
  });

  it('cashier cannot book', async () => {
    expect((await H.staff.cashier!.c.post('/appointments', { patientId, providerId: doctorId, startsAt: '2030-01-07T06:00:00Z' })).status).toBe(403);
  });
});

describe('day list, check-in and no-show', () => {
  it('lists the day for reception; the doctor sees only their own list', async () => {
    const day = (await H.staff.reception!.c.get('/appointments?date=2030-01-07')).body.data;
    expect(day.map((x: { time: string; status: string }) => `${x.time} ${x.status}`)).toEqual(['08:00 Confirmed', '08:20 Cancelled', '08:20 Confirmed']);
    expect((await H.staff.doctor!.c.get('/appointments?date=2030-01-07')).body.data).toHaveLength(3);
  });

  it('check-in issues a queue number and opens an encounter', async () => {
    const appt = (await H.staff.reception!.c.get('/appointments?date=2030-01-07')).body.data[0];
    const res = await H.staff.reception!.c.post(`/appointments/${appt.id}/check-in`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'CheckedIn', queueNo: 1 });
    expect(res.body.data.encounterId).toMatch(/^[a-f0-9]{24}$/);
    expect((await H.staff.reception!.c.post(`/appointments/${appt.id}/check-in`)).status).toBe(409);
  });

  it('no-show only after a 15-minute grace period', async () => {
    const appt = (await H.staff.reception!.c.get('/appointments?date=2030-01-07')).body.data.find((x: { status: string }) => x.status === 'Confirmed');
    expect((await H.staff.reception!.c.post(`/appointments/${appt.id}/no-show`)).body.error.code).toBe('TOO_EARLY');
    clock = new Date('2030-01-07T05:40:00Z');
    expect((await H.staff.reception!.c.post(`/appointments/${appt.id}/no-show`)).status).toBe(200);
  });

  it('cannot check in for another day', async () => {
    const r = await book('2030-01-08T05:00:00Z');
    expect((await H.staff.reception!.c.post(`/appointments/${r.body.data.id}/check-in`)).body.error.code).toBe('NOT_TODAY');
  });
});
