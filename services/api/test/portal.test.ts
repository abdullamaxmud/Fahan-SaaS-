import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tenantDbName } from '../src/db/mongo';
import { activate, setupHospital, type Hospital } from './fixtures';
import { Client, startHarness, type Harness } from './helpers';

/** Spec §5.26: patients see only their own data; proxy rules; clinician-reviewed release of results; secure messages. */
let h: Harness;
let H: Hospital;
let me = '';
let child = '';
let other = '';
let patient: Client;
let carer: Client;
const clock = new Date('2030-01-07T05:00:00Z');

async function register(given: string, family: string, dob: string) {
  const r = await H.staff.rec!.c.post('/patients', { branchId: H.branchId, givenName: given, familyName: family, dob, identifiers: [], confirmNotDuplicate: true });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data.id as string;
}

beforeAll(async () => {
  h = await startHarness();
  h.config.now = () => clock;
  H = await setupHospital(h, [
    { key: 'rec', role: 'reception' },
    { key: 'records', role: 'records-officer' },
    { key: 'doc', role: 'physician' },
    { key: 'nurse', role: 'nurse' },
  ]);
  me = await register('Hibo', 'Cali', '1992-03-03');
  child = await register('Yaasiin', 'Cali', '2021-06-06');
  other = await register('Sahra', 'Maxamed', '1979-09-09');
  await H.staff.rec!.c.post('/appointments/schedules', { providerId: H.staff.doc!.id, branchId: H.branchId, weekdays: [0, 1, 2, 3, 4, 5, 6], start: '08:00', end: '12:00', slotMinutes: 30 });
});
afterAll(async () => {
  await h?.stop();
});

describe('portal accounts', () => {
  it('reception invites a patient; the patient signs in without staff MFA and sees only their own record', async () => {
    const inv = await H.staff.rec!.c.post('/portal-accounts', { patientId: me, email: 'hibo@mail.test', name: 'Hibo Cali', relationship: 'self' });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    expect(inv.body.data.needsApproval).toBe(false);
    patient = await activate(h, inv.body.data.invite.token, 'hibo@mail.test');
    const who = await patient.get('/auth/me');
    expect(who.body.data).toMatchObject({ mfa: 'ok', roles: ['patient'], patientIds: [me] });
    const mine = await patient.get('/portal/me');
    expect(mine.body.data.patients).toHaveLength(1);
    expect((await patient.get(`/portal/${other}/summary`)).status).toBe(403);
    expect((await patient.get(`/portal/${other}/results`)).status).toBe(403);
  });

  it('portal accounts cannot use the staff API, even where their role has a module', async () => {
    expect((await patient.get('/patients')).status).toBe(403);
    expect((await patient.get(`/appointments/slots?providerId=${H.staff.doc!.id}&date=2030-01-08`)).status).toBe(403);
    expect((await patient.post('/portal-accounts', { patientId: other, email: 'x@mail.test', name: 'X Y', relationship: 'self' })).status).toBe(403);
  });

  it('staff cannot use the patient side of the portal, and portal accounts stay out of the staff list', async () => {
    expect((await H.staff.rec!.c.get(`/portal/${me}/summary`)).status).toBe(403);
    const users = (await H.admin.get('/users')).body.data as { email: string }[];
    expect(users.map((u) => u.email)).not.toContain('hibo@mail.test');
  });

  it('caregiver access needs approval by a records officer other than the one who asked', async () => {
    const inv = await H.staff.rec!.c.post('/portal-accounts', { patientId: child, email: 'mother@mail.test', name: 'Hibo (mother)', relationship: 'parent' });
    expect(inv.body.data).toMatchObject({ needsApproval: true, invite: null });
    expect((await H.staff.rec!.c.post(`/portal-accounts/${inv.body.data.id}/approve`, { patientId: child })).status).toBe(403);
    const ok = await H.staff.records!.c.post(`/portal-accounts/${inv.body.data.id}/approve`, { patientId: child });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    carer = await activate(h, ok.body.data.invite.token, 'mother@mail.test');
    const view = (await carer.get('/portal/me')).body.data.patients;
    expect(view).toEqual([expect.objectContaining({ id: child, relationship: 'parent' })]);
    expect((await carer.get(`/portal/${me}/summary`)).status).toBe(403);
  });

  it('revoking access removes the link and ends the sessions of an account with nothing left', async () => {
    const acc = (await H.staff.rec!.c.get(`/portal-accounts?patientId=${child}`)).body.data[0];
    expect((await H.staff.rec!.c.post(`/portal-accounts/${acc.id}/revoke`, { patientId: child })).status).toBe(200);
    expect((await carer.get('/portal/me')).status).toBe(401);
  });
});

describe('appointments in the portal', () => {
  it('a patient books a free slot at least an hour ahead, and cannot book a taken one', async () => {
    const docs = (await patient.get(`/portal/${me}/clinicians`)).body.data;
    expect(docs.map((d: { id: string }) => d.id)).toContain(H.staff.doc!.id);
    const today = (await patient.get(`/portal/${me}/slots?providerId=${H.staff.doc!.id}&date=2030-01-07`)).body.data;
    expect(today[0].time).toBe('09:00'); // 08:00 and 08:30 are too soon
    const s = today.find((x: { time: string }) => x.time === '10:00').startsAt;
    const b = await patient.post(`/portal/${me}/appointments`, { providerId: H.staff.doc!.id, startsAt: s, reason: 'Check-up' });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    expect((await patient.post(`/portal/${me}/appointments`, { providerId: H.staff.doc!.id, startsAt: s })).body.error.code).toBe('SLOT_TAKEN');
    const list = (await patient.get(`/portal/${me}/appointments`)).body.data;
    expect(list[0]).toMatchObject({ status: 'Confirmed', canCancel: true });
    expect((await patient.post(`/portal/${me}/appointments/${list[0].id}/cancel`)).body.data.status).toBe('Cancelled');
  });
});

describe('results', () => {
  it('only results a clinician on the visit chose to share appear in the portal', async () => {
    const w = await H.staff.rec!.c.post('/appointments/walk-in', { patientId: me, providerId: H.staff.doc!.id, reason: 'Fatigue' });
    const db = h.data.tenant(tenantDbName('hiil'));
    const ins = await db.collection('lab_orders').insertOne({
      tenantId: (await db.collection('branches').findOne({}))!.tenantId,
      branchId: new ObjectId(H.branchId),
      encounterId: new ObjectId(w.body.data.encounterId),
      patientId: new ObjectId(me),
      testCode: 'HB',
      testName: 'Haemoglobin',
      status: 'Released',
      releasedAt: new Date(),
      results: [{ analyteCode: 'HB', name: 'Haemoglobin', value: 11.2, unit: 'g/dL', refLow: 12, refHigh: 16, flag: 'L' }],
    });
    expect((await patient.get(`/portal/${me}/results`)).body.data).toHaveLength(0);
    expect((await H.staff.nurse!.c.post(`/portal-share/lab/${ins.insertedId.toHexString()}`)).status).toBe(403);
    expect((await H.staff.doc!.c.post(`/portal-share/lab/${ins.insertedId.toHexString()}`)).status).toBe(200);
    const res = (await patient.get(`/portal/${me}/results`)).body.data;
    expect(res[0]).toMatchObject({ name: 'Haemoglobin', results: [{ value: 11.2, flag: 'L', range: '12–16' }] });
  });
});

describe('messages and video visits', () => {
  it('a patient writes to the hospital; reception sees it, replies and the patient reads the reply', async () => {
    const m = await patient.post(`/portal/${me}/messages`, { subject: 'Repeat prescription', text: 'Can I get my tablets renewed?' });
    expect(m.status).toBe(201);
    expect((await H.staff.rec!.c.get('/home')).body.data.counts.messagesOpen).toBe(1);
    const inbox = (await H.staff.rec!.c.get('/portal-inbox')).body.data;
    expect(inbox[0]).toMatchObject({ subject: 'Repeat prescription', awaiting: 'staff', patient: { id: me } });
    await H.staff.rec!.c.post(`/portal-inbox/${inbox[0].id}/reply`, { text: 'Please book a visit with your doctor.' });
    const thread = (await patient.get(`/portal/${me}/messages`)).body.data[0];
    expect(thread.messages.map((x: { from: string }) => x.from)).toEqual(['patient', 'staff']);
    expect((await patient.get(`/portal/${me}/summary`)).body.data.repliesWaiting).toBe(1);
    expect((await H.staff.nurse!.c.get('/portal-inbox')).status).toBe(403);
  });

  it('a patient consents to a video visit in the portal and joins only once the clinician starts', async () => {
    const s = await H.staff.rec!.c.post('/telemedicine/sessions', { patientId: me, clinicianId: H.staff.doc!.id, date: '2030-01-07', time: '14:00', reason: 'Results review' });
    expect(s.status, JSON.stringify(s.body)).toBe(201);
    const v = (await patient.get(`/portal/${me}/video-visits`)).body.data[0];
    expect(v).toMatchObject({ consent: false, canJoin: false });
    expect((await patient.get(`/portal/${me}/video-visits/${v.id}/join`)).body.error.code).toBe('NOT_STARTED');
    expect((await patient.post(`/portal/${me}/video-visits/${v.id}/consent`, { recording: false })).status).toBe(200);
    expect((await H.staff.doc!.c.post(`/telemedicine/sessions/${v.id}/start`)).status).toBe(200);
    expect((await patient.get(`/portal/${me}/video-visits/${v.id}/join`)).body.data.url).toMatch(/^https:\/\/meet\.jit\.si\//);
  });
});
