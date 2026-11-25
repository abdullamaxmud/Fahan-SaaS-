import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupHospital, type Hospital } from './fixtures';
import { startHarness, type Harness } from './helpers';

/** Spec §5.7 / §5.8 / §14.2: atomic bed assignment, one active admission, transfer, discharge. */
let h: Harness;
let H: Hospital;
let p1 = '';
let p2 = '';
let wardId = '';
let beds: { id: string; code: string }[] = [];

beforeAll(async () => {
  h = await startHarness();
  H = await setupHospital(h, [
    { key: 'reception', role: 'reception' },
    { key: 'officer', role: 'admission-officer' },
    { key: 'wm', role: 'ward-manager' },
    { key: 'doctor', role: 'ward-physician' },
    { key: 'nurse', role: 'nurse' },
    { key: 'manager', role: 'branch-manager' },
  ]);
  const rc = H.staff.reception!.c;
  p1 = (await rc.post('/patients', { branchId: H.branchId, givenName: 'Maxamed', familyName: 'Guuleed', dob: '1968-07-02' })).body.data.id;
  p2 = (await rc.post('/patients', { branchId: H.branchId, givenName: 'Sahra', familyName: 'Jaamac', dob: '1981-04-19' })).body.data.id;
});
afterAll(async () => {
  await h?.stop();
});

const admit = (pid: string) => H.staff.officer!.c.post('/admissions', { patientId: pid, attendingId: H.staff.doctor!.id, reason: 'Community-acquired pneumonia', source: 'OPD' });

describe('wards and beds', () => {
  it('ward manager creates a ward with beds; others cannot', async () => {
    const w = await H.staff.wm!.c.post('/wards', { branchId: H.branchId, code: '3B', name: 'Ward 3B Medical', kind: 'general' });
    expect(w.status, JSON.stringify(w.body)).toBe(201);
    wardId = w.body.data.id;
    const b = await H.staff.wm!.c.post(`/wards/${wardId}/beds`, { count: 4 });
    expect(b.body.data.codes).toEqual(['3B-01', '3B-02', '3B-03', '3B-04']);
    expect((await H.staff.nurse!.c.post('/wards', { branchId: H.branchId, code: 'X', name: 'Nope', kind: 'general' })).status).toBe(403);
    beds = (await H.staff.officer!.c.get('/wards')).body.data[0].beds;
    expect(beds).toHaveLength(4);
  });
});

describe('admission', () => {
  let a1 = '';
  let a2 = '';

  it('one active admission per patient', async () => {
    const r = await admit(p1);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    a1 = r.body.data.id;
    expect((await admit(p1)).body.error.code).toBe('ALREADY_ADMITTED');
    a2 = (await admit(p2)).body.data.id;
  });

  it('two people cannot put two patients in the same bed, even at the same moment', async () => {
    const bed = beds[0]!.id;
    const [x, y] = await Promise.all([
      H.staff.officer!.c.post(`/admissions/${a1}/assign-bed`, { bedId: bed }),
      H.staff.wm!.c.post(`/admissions/${a2}/assign-bed`, { bedId: bed }),
    ]);
    const codes = [x.status, y.status].sort();
    expect(codes).toEqual([200, 409]);
    const loser = x.status === 409 ? x : y;
    expect(loser.body.error.code).toBe('BED_ALREADY_OCCUPIED');
    const board = (await H.staff.officer!.c.get('/wards')).body.data[0].beds;
    expect(board.filter((b: { status: string }) => b.status === 'Occupied')).toHaveLength(1);
  });

  it('assigning the same bed again is idempotent; a second bed is refused', async () => {
    const winner = (await H.staff.officer!.c.get('/admissions')).body.data.find((x: { status: string }) => x.status === 'Admitted');
    const again = await H.staff.officer!.c.post(`/admissions/${winner.id}/assign-bed`, { bedId: beds[0]!.id });
    expect(again.body.data.replay).toBe(true);
    expect((await H.staff.officer!.c.post(`/admissions/${winner.id}/assign-bed`, { bedId: beds[1]!.id })).status).toBe(409);
  });

  it('the attending doctor gets the inpatient visit; branch manager sees initials only', async () => {
    const list = (await H.staff.doctor!.c.get('/admissions')).body.data;
    const adm = list.find((x: { status: string }) => x.status === 'Admitted');
    expect(adm.bed).toBe('3B-01');
    const enc = await H.staff.doctor!.c.get(`/encounters/${adm.encounterId}`);
    expect(enc.status).toBe(200);
    expect(enc.body.data.type).toBe('IP');
    const mb = (await H.staff.manager!.c.get('/wards')).body.data[0].beds[0];
    expect(mb.patient).toHaveProperty('initials');
    expect(mb.patient).not.toHaveProperty('names');
  });
});

describe('transfer, discharge and bed turnover', () => {
  let adm: { id: string; encounterId: string } = { id: '', encounterId: '' };

  beforeAll(async () => {
    adm = (await H.staff.doctor!.c.get('/admissions')).body.data.find((x: { status: string }) => x.status === 'Admitted');
  });

  it('transfer moves the patient and sends the old bed to cleaning', async () => {
    const t = await H.staff.officer!.c.post(`/admissions/${adm.id}/transfer`, { bedId: beds[2]!.id, reason: 'Needs side room' });
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    const board = (await H.staff.officer!.c.get('/wards')).body.data[0].beds;
    expect(board.map((b: { status: string }) => b.status)).toEqual(['Cleaning', 'Available', 'Occupied', 'Available']);
  });

  it('cleaning → available is ward work; out-of-service needs the ward manager', async () => {
    expect((await H.staff.officer!.c.post(`/beds/${beds[0]!.id}/status`, { status: 'Available' })).status).toBe(200);
    expect((await H.staff.officer!.c.post(`/beds/${beds[3]!.id}/status`, { status: 'OutOfService', reason: 'Broken rail' })).status).toBe(403);
    expect((await H.staff.wm!.c.post(`/beds/${beds[3]!.id}/status`, { status: 'OutOfService', reason: 'Broken rail' })).status).toBe(200);
  });

  it('discharge needs the doctor, a summary and no open drafts', async () => {
    expect((await H.staff.officer!.c.post(`/admissions/${adm.id}/discharge`, { disposition: 'home', summary: 'Improved on antibiotics, afebrile 48 hours.' })).status).toBe(403);
    const d = H.staff.doctor!.c;
    const draft = await d.post(`/encounters/${adm.encounterId}/notes`, { kind: 'progress', text: 'Day 2' });
    expect((await d.post(`/admissions/${adm.id}/discharge`, { disposition: 'home', summary: 'Improved on antibiotics, afebrile 48 hours.' })).body.error.code).toBe('DISCHARGE_INCOMPLETE');
    await d.post(`/encounters/${adm.encounterId}/notes/${draft.body.data.id}/sign`);
    const ok = await d.post(`/admissions/${adm.id}/discharge`, { disposition: 'home', summary: 'Improved on antibiotics, afebrile 48 hours.', followUp: 'OPD in 1 week' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const enc = (await d.get(`/encounters/${adm.encounterId}`)).body.data;
    expect(enc.status).toBe('Closed');
    expect(enc.notes.map((n: { kind: string }) => n.kind)).toContain('discharge');
    const board = (await H.staff.officer!.c.get('/wards')).body.data[0].beds;
    expect(board[2].status).toBe('Cleaning');
  });

  it('after discharge the patient can be admitted again', async () => {
    const list = (await H.staff.officer!.c.get('/admissions?status=all')).body.data;
    const discharged = list.find((x: { status: string }) => x.status === 'Discharged');
    expect((await admit(discharged.patient.id)).status).toBe(201);
  });
});
