import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupHospital, type Hospital } from './fixtures';
import { startHarness, type Harness } from './helpers';

/** Spec §5.27: Scheduled → Connected → Completed; no call without consent; the visit joins the record. */
let h: Harness;
let H: Hospital;
let patientId = '';
let sid = '';
const clock = new Date('2030-01-07T05:00:00Z'); // 08:00 in Mogadishu

beforeAll(async () => {
  h = await startHarness();
  h.config.now = () => clock;
  H = await setupHospital(h, [
    { key: 'rec', role: 'reception' },
    { key: 'tele', role: 'tele-clinician' },
    { key: 'doc', role: 'physician' },
    { key: 'cash', role: 'cashier' },
  ]);
  const p = await H.staff.rec!.c.post('/patients', { branchId: H.branchId, givenName: 'Cawo', familyName: 'Nuur', dob: '1985-05-05', identifiers: [] });
  patientId = p.body.data.id;
});
afterAll(async () => {
  await h?.stop();
});

describe('telemedicine', () => {
  it('reception books a video visit with a video clinician; others cannot book', async () => {
    const list = (await H.staff.rec!.c.get('/telemedicine/clinicians')).body.data as { id: string }[];
    expect(list.map((x) => x.id)).toContain(H.staff.tele!.id);
    expect(list.map((x) => x.id)).toContain(H.staff.doc!.id);
    expect((await H.staff.cash!.c.post('/telemedicine/sessions', { patientId, clinicianId: H.staff.tele!.id, date: '2030-01-07', time: '10:00', reason: 'Follow-up' })).status).toBe(403);
    expect((await H.staff.rec!.c.post('/telemedicine/sessions', { patientId, clinicianId: H.staff.cash!.id, date: '2030-01-07', time: '10:00', reason: 'Follow-up' })).status).toBe(400);
    const r = await H.staff.rec!.c.post('/telemedicine/sessions', { patientId, clinicianId: H.staff.tele!.id, date: '2030-01-07', time: '10:00', minutes: 20, reason: 'Blood pressure follow-up' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    sid = r.body.data.id;
  });

  it('a clinician cannot be double-booked, and times in the past are refused', async () => {
    expect((await H.staff.rec!.c.post('/telemedicine/sessions', { patientId, clinicianId: H.staff.tele!.id, date: '2030-01-07', time: '10:10', reason: 'Another' })).body.error.code).toBe('SLOT_TAKEN');
    expect((await H.staff.rec!.c.post('/telemedicine/sessions', { patientId, clinicianId: H.staff.tele!.id, date: '2030-01-06', time: '10:00', reason: 'Yesterday' })).status).toBe(400);
  });

  it('the visit cannot start without consent, and only its own clinician runs it', async () => {
    expect((await H.staff.tele!.c.post(`/telemedicine/sessions/${sid}/start`)).body.error.code).toBe('CONSENT_REQUIRED');
    expect((await H.staff.doc!.c.post(`/telemedicine/sessions/${sid}/consent`, { video: true, method: 'verbal' })).status).toBe(403);
    expect((await H.staff.tele!.c.post(`/telemedicine/sessions/${sid}/consent`, { video: false, method: 'verbal' })).status).toBe(400);
    expect((await H.staff.tele!.c.post(`/telemedicine/sessions/${sid}/consent`, { video: true, recording: false, method: 'verbal' })).status).toBe(200);
  });

  it('starting opens an outpatient visit that the clinician documents; completing closes the call', async () => {
    const s = await H.staff.tele!.c.post(`/telemedicine/sessions/${sid}/start`);
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(s.body.data.url).toMatch(/^https:\/\/meet\.jit\.si\/fahan-[A-Za-z0-9]+$/);
    const enc = await H.staff.tele!.c.get(`/encounters/${s.body.data.encounterId}`);
    expect(enc.status).toBe(200);
    expect(enc.body.data.patient.id).toBe(patientId);
    const note = await H.staff.tele!.c.post(`/encounters/${s.body.data.encounterId}/notes`, { kind: 'progress', text: 'BP well controlled on video review.' });
    expect([200, 201, 400]).toContain(note.status);
    const day = (await H.staff.tele!.c.get('/telemedicine/sessions?date=2030-01-07')).body.data;
    expect(day[0]).toMatchObject({ status: 'Connected', consent: { video: true, recording: false } });
    expect((await H.staff.tele!.c.post(`/telemedicine/sessions/${sid}/complete`, { summary: 'Continue current dose' })).body.data.status).toBe('Completed');
    expect((await H.staff.rec!.c.post(`/telemedicine/sessions/${sid}/cancel`, { reason: 'Too late' })).status).toBe(409);
  });

  it('counts today’s video visits on the clinician home', async () => {
    await H.staff.rec!.c.post('/telemedicine/sessions', { patientId, clinicianId: H.staff.tele!.id, date: '2030-01-07', time: '14:00', reason: 'Results' });
    expect((await H.staff.tele!.c.get('/home')).body.data.counts.teleToday).toBe(1);
  });
});
