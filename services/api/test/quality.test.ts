import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupHospital, type Hospital } from './fixtures';
import { startHarness, type Harness } from './helpers';

/** Spec §5.28: confidential incident permissions, Reported → Triaged → Investigating → Closed, infection surveillance, trends. */
let h: Harness;
let H: Hospital;
let inc = '';
let serious = '';
let patientId = '';
let mrn = '';

beforeAll(async () => {
  h = await startHarness();
  H = await setupHospital(h, [
    { key: 'nurse', role: 'nurse' },
    { key: 'cashier', role: 'cashier' },
    { key: 'qo', role: 'quality-officer' },
    { key: 'ipc', role: 'ipc' },
    { key: 'rec', role: 'reception' },
  ]);
  const p = await H.staff.rec!.c.post('/patients', { branchId: H.branchId, givenName: 'Faadumo', familyName: 'Xasan', dob: '1990-02-01', identifiers: [] });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  patientId = p.body.data.id;
  mrn = p.body.data.mrn;
});
afterAll(async () => {
  await h?.stop();
});

describe('incidents', () => {
  it('any member of staff can report, and sees only their own reports', async () => {
    const r = await H.staff.nurse!.c.post('/quality/incidents', { category: 'fall', severity: 'minor', occurredAt: new Date().toISOString(), location: 'Ward 3B', description: 'Patient slipped near the bathroom door', patientMrn: mrn });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.number).toMatch(/^INC-\d{2}-00001$/);
    inc = r.body.data.id;
    const c = await H.staff.cashier!.c.post('/quality/incidents', { category: 'behaviour', severity: 'death', occurredAt: new Date().toISOString(), location: 'Cash desk', description: 'Collapse in the queue; resuscitation failed' });
    expect(c.status).toBe(201);
    expect(c.body.data.serious).toBe(true);
    serious = c.body.data.id;
    const mine = await H.staff.nurse!.c.get('/quality/incidents/mine');
    expect(mine.body.data).toHaveLength(1);
    expect(mine.body.data[0].description).toContain('slipped');
  });

  it('incidents are confidential: other staff cannot list or open them', async () => {
    expect((await H.staff.nurse!.c.get('/quality/incidents')).status).toBe(403);
    expect((await H.staff.cashier!.c.get(`/quality/incidents/${inc}`)).status).toBe(403);
  });

  it('only quality leads see who reported; the IPC team sees the content', async () => {
    const lead = (await H.staff.qo!.c.get('/quality/incidents')).body.data;
    expect(lead[0].id).toBe(serious); // serious first
    expect(lead.find((x: { id: string }) => x.id === inc).reporter).toBe('nurse');
    const team = (await H.staff.ipc!.c.get('/quality/incidents')).body.data;
    expect(team.find((x: { id: string }) => x.id === inc)).toMatchObject({ reporter: null, patient: { mrn } });
    const view = (await H.admin.get('/quality/incidents')).body.data;
    expect(view.find((x: { id: string }) => x.id === inc)).toMatchObject({ description: null, patient: null, reporter: null });
  });

  it('moves Reported → Triaged → Investigating → Closed with history', async () => {
    expect((await H.staff.qo!.c.post(`/quality/incidents/${inc}/close`, { rootCause: 'x x x', outcome: 'y y y' })).status).toBe(409);
    expect((await H.staff.ipc!.c.post(`/quality/incidents/${inc}/triage`, { severity: 'minor', category: 'fall', investigatorId: H.staff.qo!.id })).status).toBe(200);
    expect((await H.staff.ipc!.c.post(`/quality/incidents/${inc}/triage`, { severity: 'minor', category: 'fall' })).status).toBe(409);
    expect((await H.staff.ipc!.c.post(`/quality/incidents/${inc}/investigate`, { note: 'Wet floor, no sign' })).body.data.status).toBe('Investigating');
    expect((await H.staff.ipc!.c.post(`/quality/incidents/${inc}/close`, { rootCause: 'Wet floor', outcome: 'Signage' })).status).toBe(403);
    const done = await H.staff.qo!.c.post(`/quality/incidents/${inc}/close`, { rootCause: 'Wet floor without a sign', outcome: 'Signs placed; cleaning rota changed' });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const d = (await H.staff.qo!.c.get(`/quality/incidents/${inc}`)).body.data;
    expect(d.history.map((x: { action: string }) => x.action)).toEqual(['reported', 'triaged', 'finding', 'closed']);
  });

  it('a serious incident needs a corrective action before closing', async () => {
    await H.staff.qo!.c.post(`/quality/incidents/${serious}/triage`, { severity: 'death', category: 'other' });
    await H.staff.qo!.c.post(`/quality/incidents/${serious}/investigate`, { note: 'No defibrillator near the cash desk' });
    expect((await H.staff.qo!.c.post(`/quality/incidents/${serious}/close`, { rootCause: 'No AED nearby', outcome: 'Reviewed' })).body.error.code).toBe('ACTION_REQUIRED');
    expect((await H.staff.qo!.c.post(`/quality/incidents/${serious}/actions`, { text: 'Install an AED at reception', owner: 'Facilities', dueOn: '2030-01-31' })).status).toBe(201);
    expect((await H.staff.qo!.c.post(`/quality/incidents/${serious}/close`, { rootCause: 'No AED nearby', outcome: 'AED ordered' })).status).toBe(200);
  });

  it('an incident cannot be dated in the future', async () => {
    const r = await H.staff.nurse!.c.post('/quality/incidents', { category: 'other', severity: 'no-harm', occurredAt: new Date(Date.now() + 86_400_000).toISOString(), location: 'Ward', description: 'Something that has not happened yet' });
    expect(r.status).toBe(400);
  });
});

describe('infection prevention & control', () => {
  it('the IPC team records, confirms and closes cases; trends count only real cases', async () => {
    expect((await H.staff.nurse!.c.post('/quality/ipc', { patientMrn: mrn, organism: 'MRSA', site: 'skin', onsetDate: '2026-01-02', hospitalAcquired: true, isolation: 'contact' })).status).toBe(403);
    const today = new Date().toISOString().slice(0, 10);
    const a = await H.staff.ipc!.c.post('/quality/ipc', { patientMrn: mrn, organism: 'Klebsiella pneumoniae', site: 'urinary', onsetDate: today, hospitalAcquired: true, isolation: 'contact', ward: '3B' });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const b = await H.staff.ipc!.c.post('/quality/ipc', { patientMrn: mrn, organism: 'Influenza A', site: 'respiratory', onsetDate: today, hospitalAcquired: false, isolation: 'droplet' });
    expect((await H.staff.ipc!.c.post(`/quality/ipc/${a.body.data.id}/close`, { note: 'early' })).status).toBe(409);
    expect((await H.staff.ipc!.c.post(`/quality/ipc/${a.body.data.id}/confirm`, { note: 'Culture positive' })).body.data.status).toBe('Confirmed');
    expect((await H.staff.ipc!.c.post(`/quality/ipc/${b.body.data.id}/rule-out`, { note: 'PCR negative' })).body.data.status).toBe('RuledOut');
    const s = (await H.staff.qo!.c.get('/quality/summary')).body.data;
    expect(s.infections.haiByMonth.at(-1)).toBe(1);
    expect(s.infections.bySite).toEqual({ urinary: 1 });
    expect(s.incidents.serious).toBe(1);
    expect((await H.staff.nurse!.c.get('/quality/summary')).status).toBe(403);
  });

  it('shows the work on the home counts of quality roles', async () => {
    const c = (await H.staff.qo!.c.get('/home')).body.data.counts;
    expect(c).toMatchObject({ incidentsOpen: 0, ipcOpen: 1 });
    expect((await H.staff.cashier!.c.get('/home')).body.data.counts.incidentsOpen).toBeUndefined();
  });
});
