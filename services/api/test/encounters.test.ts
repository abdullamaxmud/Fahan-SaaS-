import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupHospital, type Hospital } from './fixtures';
import { startHarness, type Harness } from './helpers';

/** Spec §5.5 / §6 "Outpatient to diagnosis": vitals, signed notes, amendments, ICD-11 diagnoses, close, timeline. */
let h: Harness;
let H: Hospital;
let patientId = '';
let enc = '';
const clock = new Date('2030-01-07T05:30:00Z'); // Monday 08:30 Mogadishu

beforeAll(async () => {
  h = await startHarness();
  h.config.now = () => clock;
  H = await setupHospital(h, [
    { key: 'reception', role: 'reception' },
    { key: 'doctor', role: 'physician' },
    { key: 'doctor2', role: 'physician' },
    { key: 'nurse', role: 'nurse' },
    { key: 'cashier', role: 'cashier' },
  ]);
  const rc = H.staff.reception!.c;
  patientId = (await rc.post('/patients', { branchId: H.branchId, givenName: 'Faadumo', familyName: 'Xasan', dob: '1992-03-14', sexAtBirth: 'female' })).body.data.id;
  await rc.post('/appointments/schedules', { providerId: H.staff.doctor!.id, branchId: H.branchId, weekdays: [1], start: '08:00', end: '12:00', slotMinutes: 20 });
  const appt = await rc.post('/appointments', { patientId, providerId: H.staff.doctor!.id, startsAt: '2030-01-07T06:00:00Z', reason: 'Fever for 3 days' });
  enc = (await rc.post(`/appointments/${appt.body.data.id}/check-in`)).body.data.encounterId;
});
afterAll(async () => {
  await h?.stop();
});

const doc = () => H.staff.doctor!.c;
const nurse = () => H.staff.nurse!.c;

describe('care team', () => {
  it('the booked doctor sees the visit; the nurse needs to be added first', async () => {
    expect((await doc().get('/encounters')).body.data.map((e: { id: string }) => e.id)).toEqual([enc]);
    expect((await nurse().get(`/encounters/${enc}`)).status).toBe(403);
    expect((await doc().post(`/encounters/${enc}/care-team`, { userId: H.staff.nurse!.id })).status).toBe(200);
    expect((await nurse().get(`/encounters/${enc}`)).status).toBe(200);
  });

  it('an unrelated doctor cannot open it', async () => {
    expect((await H.staff.doctor2!.c.get(`/encounters/${enc}`)).status).toBe(403);
  });
});

describe('vitals', () => {
  it('records with the canonical unit and rejects implausible values or wrong units', async () => {
    const ok = await nurse().post(`/encounters/${enc}/observations`, { code: 'temperature', value: 38.62 });
    expect(ok.status).toBe(201);
    expect(ok.body.data).toMatchObject({ value: 38.6, unit: '°C' });
    expect((await nurse().post(`/encounters/${enc}/observations`, { code: 'temperature', value: 386 })).status).toBe(400);
    expect((await nurse().post(`/encounters/${enc}/observations`, { code: 'temperature', value: 101, unit: '°F' })).status).toBe(400);
    expect((await nurse().post(`/encounters/${enc}/observations`, { code: 'bp-systolic', value: 148 })).status).toBe(201);
  });

  it('corrections append and keep the original', async () => {
    const e = (await nurse().get(`/encounters/${enc}`)).body.data;
    const bp = e.observations.find((o: { code: string }) => o.code === 'bp-systolic');
    const c = await nurse().post(`/encounters/${enc}/observations/${bp.id}/correct`, { value: 138, reason: 'Misread cuff' });
    expect(c.status).toBe(201);
    const after = (await nurse().get(`/encounters/${enc}`)).body.data.observations.filter((o: { code: string }) => o.code === 'bp-systolic');
    expect(after.map((o: { status: string; value: number }) => `${o.status}:${o.value}`).sort()).toEqual(['Corrected:148', 'Recorded:138']);
    expect((await nurse().post(`/encounters/${enc}/observations/${bp.id}/correct`, { value: 140, reason: 'again' })).status).toBe(409);
  });
});

describe('notes', () => {
  let noteId = '';

  it('drafts are private to the author until signed', async () => {
    const n = await doc().post(`/encounters/${enc}/notes`, { kind: 'assessment', text: 'Uncomplicated falciparum malaria.' });
    expect(n.status).toBe(201);
    noteId = n.body.data.id;
    expect((await nurse().get(`/encounters/${enc}`)).body.data.notes).toHaveLength(0);
    expect((await nurse().patch(`/encounters/${enc}/notes/${noteId}`, { text: 'x', version: 1 })).status).toBe(404);
  });

  it('nurses cannot sign; the author signs and the note becomes read-only', async () => {
    const nn = await nurse().post(`/encounters/${enc}/notes`, { kind: 'progress', text: 'Obs taken.' });
    expect((await nurse().post(`/encounters/${enc}/notes/${nn.body.data.id}/sign`)).status).toBe(403);
    expect((await doc().patch(`/encounters/${enc}/notes/${noteId}`, { text: 'Uncomplicated P. falciparum malaria.', version: 1 })).status).toBe(200);
    expect((await doc().post(`/encounters/${enc}/notes/${noteId}/sign`)).status).toBe(200);
    expect((await doc().patch(`/encounters/${enc}/notes/${noteId}`, { text: 'changed', version: 3 })).body.error.code).toBe('NOTE_SIGNED');
    expect((await nurse().get(`/encounters/${enc}`)).body.data.status).toBe('Signed');
  });

  it('amendment creates a new signed version and supersedes the old one', async () => {
    const a = await doc().post(`/encounters/${enc}/notes/${noteId}/amend`, { text: 'Uncomplicated P. falciparum malaria. RDT positive.', reason: 'Added RDT result' });
    expect(a.status).toBe(201);
    const notes = (await doc().get(`/encounters/${enc}`)).body.data.notes.filter((n: { kind: string }) => n.kind === 'assessment');
    expect(notes.map((n: { status: string }) => n.status)).toEqual(['Amended', 'Signed']);
    expect((await doc().post(`/encounters/${enc}/notes/${noteId}/amend`, { text: 'x', reason: 'again' })).status).toBe(409);
  });
});

describe('diagnoses and closing', () => {
  it('validates ICD-11 codes and keeps one primary', async () => {
    expect((await doc().post(`/encounters/${enc}/diagnoses`, { code: 'B50.0', display: 'ICD-10 code', certainty: 'confirmed' })).status).toBe(400);
    const a = await doc().post(`/encounters/${enc}/diagnoses`, { code: '1f40', display: 'Malaria due to Plasmodium falciparum', certainty: 'suspected', primary: true });
    expect(a.status).toBe(201);
    expect(a.body.data.code).toBe('1F40');
    await doc().post(`/encounters/${enc}/diagnoses`, { code: 'BA00', display: 'Essential hypertension', certainty: 'confirmed', primary: true });
    const dx = (await doc().get(`/encounters/${enc}`)).body.data.diagnoses;
    expect(dx.filter((d: { primary: boolean }) => d.primary).map((d: { code: string }) => d.code)).toEqual(['BA00']);
    expect((await nurse().post(`/encounters/${enc}/diagnoses`, { code: 'CA40', display: 'Pneumonia', certainty: 'suspected' })).status).toBe(403);
  });

  it('certainty changes keep history', async () => {
    const d = (await doc().get(`/encounters/${enc}`)).body.data.diagnoses.find((x: { code: string }) => x.code === '1F40');
    const up = await doc().patch(`/encounters/${enc}/diagnoses/${d.id}`, { certainty: 'confirmed', primary: true, version: d.version });
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    const again = (await doc().get(`/encounters/${enc}`)).body.data.diagnoses.find((x: { code: string }) => x.code === '1F40');
    expect(again.history[0]).toMatchObject({ certainty: 'suspected' });
  });

  it('refuses to close with unsigned drafts, then closes and completes the appointment', async () => {
    const blocked = await doc().post(`/encounters/${enc}/close`);
    expect(blocked.body.error.code).toBe('ENCOUNTER_INCOMPLETE'); // nurse's progress draft is unsigned
    const draft = (await nurse().get(`/encounters/${enc}`)).body.data.notes.find((n: { status: string }) => n.status === 'Draft');
    expect((await doc().agent.delete(`/api/v1/encounters/${enc}/notes/${draft.id}`).set('x-csrf-token', doc().csrf)).status).toBe(404); // not the author
    expect((await nurse().agent.delete(`/api/v1/encounters/${enc}/notes/${draft.id}`).set('x-csrf-token', nurse().csrf)).status).toBe(204);
    const ok = await doc().post(`/encounters/${enc}/close`);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const day = (await H.staff.reception!.c.get('/appointments?date=2030-01-07')).body.data;
    expect(day[0].status).toBe('Completed');
    expect((await nurse().post(`/encounters/${enc}/observations`, { code: 'heart-rate', value: 90 })).body.error.code).toBe('ENCOUNTER_CLOSED');
  });
});

describe('timeline', () => {
  it('shows the longitudinal record to the care team, audited', async () => {
    const t = await doc().get(`/patients/${patientId}/timeline`);
    expect(t.status).toBe(200);
    const kinds = new Set(t.body.data.items.map((i: { kind: string }) => i.kind));
    for (const k of ['encounter', 'note', 'diagnosis', 'observation', 'appointment']) expect(kinds.has(k)).toBe(true);
    expect(t.body.data.items.some((i: { detail: string | null }) => i.detail === '148 mmHg')).toBe(false); // corrected value hidden
  });

  it('cashier and reception cannot read clinical history even with the patient id', async () => {
    expect((await H.staff.cashier!.c.get(`/patients/${patientId}/timeline`)).status).toBe(403);
    expect((await H.staff.reception!.c.get(`/patients/${patientId}/timeline`)).status).toBe(403);
    expect((await H.staff.cashier!.c.get(`/encounters/${enc}`)).status).toBe(403);
  });
});
