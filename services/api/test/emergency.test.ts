import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupHospital, type Hospital } from './fixtures';
import { startHarness, type Harness } from './helpers';

/** Spec §5.6 and §6 "Emergency to inpatient". */
let h: Harness;
let H: Hospital;
let known = '';
let clock = new Date('2030-01-07T02:00:00Z');

beforeAll(async () => {
  h = await startHarness();
  h.config.now = () => clock;
  H = await setupHospital(h, [
    { key: 'reception2', role: 'reception', branch: 2 },
    { key: 'ernurse', role: 'er-nurse' },
    { key: 'erdoc', role: 'er-clinician' },
    { key: 'ward', role: 'ward-physician' },
    { key: 'cashier', role: 'cashier' },
  ]);
  known = (await H.staff.reception2!.c.post('/patients', { branchId: H.branch2Id, givenName: 'Khadar', familyName: 'Muuse', dob: '1985-11-02' })).body.data.id;
});
afterAll(async () => {
  await h?.stop();
});

const nurse = () => H.staff.ernurse!.c;
const doc = () => H.staff.erdoc!.c;

describe('arrival and triage', () => {
  let unknownVisit = '';
  let knownVisit = '';

  it('registers an unidentified patient with an estimated age', async () => {
    const r = await nurse().post('/emergency/arrivals', { unknown: { sexAtBirth: 'male', estimatedAge: 30, description: 'Brought by police after road traffic crash' }, mode: 'police', complaint: 'Unresponsive' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    unknownVisit = r.body.data.id;
    const board = (await nurse().get('/emergency/board')).body.data;
    expect(board[0].patient).toMatchObject({ unidentified: true, names: { given: 'Unknown', family: 'Male 1' }, dob: '2000-01-01' });
  });

  it('a registered patient from another branch arrives here', async () => {
    const r = await nurse().post('/emergency/arrivals', { patientId: known, mode: 'walk-in', complaint: 'Chest pain' });
    expect(r.status).toBe(201);
    knownVisit = r.body.data.id;
  });

  it('rejects an arrival that is neither registered nor described', async () => {
    expect((await nurse().post('/emergency/arrivals', { mode: 'walk-in', complaint: 'Cough' })).status).toBe(400);
  });

  it('board sorts by triage level; re-triage needs a reason and is audited', async () => {
    expect((await nurse().post(`/emergency/${knownVisit}/triage`, { esi: 2 })).status).toBe(200);
    expect((await nurse().post(`/emergency/${unknownVisit}/triage`, { esi: 1 })).status).toBe(200);
    const board = await nurse().get('/emergency/board');
    expect(board.body.data.map((x: { esi: number }) => x.esi)).toEqual([1, 2]);
    expect(board.body.meta.byEsi).toEqual([1, 1, 0, 0, 0]);
    expect((await nurse().post(`/emergency/${knownVisit}/triage`, { esi: 3 })).status).toBe(400);
    expect((await nurse().post(`/emergency/${knownVisit}/triage`, { esi: 3, overrideReason: 'Pain settled, ECG normal' })).status).toBe(200);
    const audit = (await H.admin.get('/audit/events?limit=50')).body.data;
    expect(audit.find((e: { action: string }) => e.action === 'er.triage.override')).toMatchObject({ meta: { esi: 3, from: 2 } });
  });

  it('cashier cannot see the board', async () => {
    expect((await H.staff.cashier!.c.get('/emergency/board')).status).toBe(403);
  });
});

describe('treatment and disposition', () => {
  let visit = '';
  beforeAll(async () => {
    visit = (await nurse().get('/emergency/board')).body.data.find((x: { esi: number }) => x.esi === 3).id;
  });

  it('nurses cannot take or disposition a patient', async () => {
    expect((await nurse().post(`/emergency/${visit}/take`)).status).toBe(403);
    expect((await nurse().post(`/emergency/${visit}/disposition`, { disposition: 'discharged', note: 'Home with advice' })).status).toBe(403);
  });

  it('disposition before being seen is refused (except left without being seen)', async () => {
    const r = await doc().post(`/emergency/${visit}/disposition`, { disposition: 'discharged', note: 'Home with advice' });
    expect(r.body.error.code).toBe('NOT_SEEN');
  });

  it('taking the patient records door-to-doctor time', async () => {
    clock = new Date('2030-01-07T02:14:00Z');
    const r = await doc().post(`/emergency/${visit}/take`);
    expect(r.body.data).toMatchObject({ state: 'Treating', doorToDoctorMinutes: 14 });
    // The emergency doctor can now write in the emergency visit.
    expect((await doc().post(`/encounters/${visit}/observations`, { code: 'heart-rate', value: 104 })).status).toBe(201);
  });

  it('admit from emergency creates the admission request and closes the visit', async () => {
    const r = await doc().post(`/emergency/${visit}/disposition`, {
      disposition: 'admitted',
      note: 'Unstable angina, for cardiology admission',
      admission: { attendingId: H.staff.ward!.id, reason: 'Unstable angina' },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.admissionId).toMatch(/^[a-f0-9]{24}$/);
    const adm = (await H.staff.ward!.c.get('/admissions')).body.data[0];
    expect(adm).toMatchObject({ status: 'Requested', source: 'ER' });
    expect((await nurse().get('/emergency/board')).body.data).toHaveLength(1);
    expect((await doc().post(`/emergency/${visit}/disposition`, { disposition: 'discharged', note: 'again again' })).status).toBe(409);
  });

  it('left without being seen can be recorded straight from triage', async () => {
    const left = (await nurse().get('/emergency/board')).body.data[0].id;
    const r = await doc().post(`/emergency/${left}/disposition`, { disposition: 'left-without-being-seen', note: 'Not in waiting area when called x3' });
    expect(r.status).toBe(200);
    expect((await nurse().get('/emergency/board')).body.meta.total).toBe(0);
  });
});
