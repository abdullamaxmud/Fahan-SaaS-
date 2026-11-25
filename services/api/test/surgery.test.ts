import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHECKLIST } from '../src/modules/surgery/routes';
import { setupHospital, type Hospital } from './fixtures';
import { startHarness, type Harness } from './helpers';

/** Spec §5.16 + §4.2: consent, checklists, sign-offs and room conflicts enforced. */
let h: Harness;
let H: Hospital;
let patientId = '';
let ot1 = '';
let ot2 = '';
let caseId = '';
const clock = new Date('2030-01-07T04:00:00Z'); // 07:00 Mogadishu

const all = (phase: keyof typeof CHECKLIST) => ({ items: Object.fromEntries(CHECKLIST[phase].map((k) => [k, true])) });

beforeAll(async () => {
  h = await startHarness();
  h.config.now = () => clock;
  H = await setupHospital(h, [
    { key: 'reception', role: 'reception' },
    { key: 'officer', role: 'admission-officer' },
    { key: 'surgeon', role: 'surgeon' },
    { key: 'surgeon2', role: 'surgeon' },
    { key: 'anest', role: 'anesthetist' },
    { key: 'tnurse', role: 'theatre-nurse' },
    { key: 'facilities', role: 'facilities-cssd' },
  ]);
  patientId = (await H.staff.reception!.c.post('/patients', { branchId: H.branchId, givenName: 'Khadar', familyName: 'Muuse', dob: '1985-11-02' })).body.data.id;
  // Admission under the surgeon creates the care relationship.
  await H.staff.officer!.c.post('/admissions', { patientId, attendingId: H.staff.surgeon!.id, reason: 'Acute appendicitis', source: 'ER' });
  ot1 = (await H.admin.post('/surgery/theatres', { branchId: H.branchId, code: 'OT-1', name: 'Main theatre 1' })).body.data.id;
  ot2 = (await H.admin.post('/surgery/theatres', { branchId: H.branchId, code: 'OT-2', name: 'Main theatre 2' })).body.data.id;
});
afterAll(async () => {
  await h?.stop();
});

const plan = (who: string, theatreId: string, startsAt: string, surgeonKey = 'surgeon') =>
  H.staff[who]!.c.post('/surgery/cases', { patientId, procedure: 'Laparoscopic appendicectomy', side: 'not-applicable', surgeonId: H.staff[surgeonKey]!.id, anesthetistId: H.staff.anest!.id, theatreId, startsAt, minutes: 90 });

describe('booking', () => {
  it('two bookings for the same theatre and time: exactly one wins', async () => {
    const [a, b] = await Promise.all([plan('surgeon', ot1, '2030-01-07T06:00:00Z'), plan('surgeon', ot1, '2030-01-07T06:30:00Z')]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const lost = a.status === 409 ? a : b;
    expect(lost.body.error.code).toBe('THEATRE_CONFLICT');
    caseId = (a.status === 201 ? a : b).body.data.id;
  });

  it('the same surgeon cannot be in two theatres at once', async () => {
    const r = await plan('surgeon', ot2, '2030-01-07T06:45:00Z');
    expect(r.body.error.message).toMatch(/surgeon is already operating/);
  });

  it('an out-of-service theatre cannot be booked', async () => {
    expect((await H.staff.facilities!.c.post(`/surgery/theatres/${ot2}/status`, { status: 'OutOfService', reason: 'Anaesthesia machine calibration' })).status).toBe(200);
    const r = await plan('surgeon', ot2, '2030-01-07T10:00:00Z');
    expect(r.body.error.code).toBe('THEATRE_UNAVAILABLE');
    const sched = (await H.staff.tnurse!.c.get('/surgery/schedule?date=2030-01-07')).body.data;
    expect(sched.map((t: { code: string; status: string }) => `${t.code}:${t.status}`)).toEqual(['OT-1:Available', 'OT-2:OutOfService']);
    expect(sched[0].cases[0]).toMatchObject({ status: 'Planned', start: expect.stringMatching(/^09:/) });
  });
});

describe('safety gates', () => {
  const s = () => H.staff.surgeon!.c;
  const n = () => H.staff.tnurse!.c;

  it('sign-in needs consent and every item confirmed', async () => {
    expect((await n().post(`/surgery/cases/${caseId}/checklist/time-out`, all('time-out'))).body.error.code).toBe('CHECKLIST_ORDER');
    expect((await n().post(`/surgery/cases/${caseId}/checklist/sign-in`, all('sign-in'))).body.error.code).toBe('NO_CONSENT');
    expect((await n().post(`/surgery/cases/${caseId}/consent`, { method: 'written', signedBy: 'patient', risksExplained: true })).status).toBe(403); // nurse
    expect((await s().post(`/surgery/cases/${caseId}/consent`, { method: 'verbal-witnessed', signedBy: 'patient', risksExplained: true })).status).toBe(400); // needs witness
    expect((await s().post(`/surgery/cases/${caseId}/consent`, { method: 'written', signedBy: 'patient', risksExplained: true })).status).toBe(200);
    const partial = await n().post(`/surgery/cases/${caseId}/checklist/sign-in`, { items: { 'identity-confirmed': true } });
    expect(partial.body.error.code).toBe('CHECKLIST_INCOMPLETE');
    expect(partial.body.error.details).toHaveLength(CHECKLIST['sign-in'].length - 1);
    expect((await n().post(`/surgery/cases/${caseId}/checklist/sign-in`, all('sign-in'))).status).toBe(200);
  });

  it('each step unlocks only after the previous one', async () => {
    expect((await s().post(`/surgery/cases/${caseId}/advance`, { to: 'InProcedure' })).body.error.code).toBe('INVALID_TRANSITION');
    expect((await s().post(`/surgery/cases/${caseId}/advance`, { to: 'Prepared' })).status).toBe(200);
    expect((await s().post(`/surgery/cases/${caseId}/advance`, { to: 'InProcedure' })).body.error.code).toBe('SAFETY_GATE');
    expect((await n().post(`/surgery/cases/${caseId}/checklist/time-out`, all('time-out'))).status).toBe(200);
    expect((await s().post(`/surgery/cases/${caseId}/advance`, { to: 'InProcedure' })).status).toBe(200);
  });

  it('only the operating surgeon signs the operative note; recovery needs it and sign-out', async () => {
    expect((await H.staff.anest!.c.post(`/surgery/cases/${caseId}/operative-note`, { text: 'Inflamed appendix removed laparoscopically.' })).status).toBe(403);
    const gate = await s().post(`/surgery/cases/${caseId}/advance`, { to: 'Recovery' });
    expect(gate.body.error.details.map((d: { message: string }) => d.message)).toEqual(['Sign the operative note', 'Complete the sign-out checklist']);
    expect((await s().post(`/surgery/cases/${caseId}/operative-note`, { text: 'Inflamed appendix removed laparoscopically. No perforation.', estimatedBloodLossMl: 20 })).status).toBe(200);
    expect((await s().post(`/surgery/cases/${caseId}/operative-note`, { text: 'Changing my mind about the note text.' })).body.error.code).toBe('NOTE_SIGNED');
    expect((await n().post(`/surgery/cases/${caseId}/checklist/sign-out`, all('sign-out'))).status).toBe(200);
    expect((await s().post(`/surgery/cases/${caseId}/advance`, { to: 'Recovery' })).status).toBe(200);
    expect((await H.staff.anest!.c.post(`/surgery/cases/${caseId}/advance`, { to: 'Completed' })).status).toBe(200);
  });

  it('the case keeps a full timeline and cannot be cancelled after it started', async () => {
    const c = (await n().get(`/surgery/cases/${caseId}`)).body.data;
    expect(c.timeline.map((t: { status: string }) => t.status)).toEqual(['Planned', 'Prepared', 'InProcedure', 'Recovery', 'Completed']);
    expect(c.checklist['sign-out'].byName).toBe('tnurse');
    expect((await s().post(`/surgery/cases/${caseId}/cancel`, { reason: 'test' })).status).toBe(409);
  });
});
