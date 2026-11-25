import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupHospital, type Hospital } from './fixtures';
import { startHarness, type Harness } from './helpers';

/** Spec §5.12 radiology, §5.13 diagnostics, §5.24 equipment blocking, §6 "X-ray / radiology". */
let h: Harness;
let H: Hospital;
let enc = '';
let ct = '';
let ecgMachine = '';
let clock = new Date('2030-01-07T05:00:00Z');

beforeAll(async () => {
  h = await startHarness();
  h.config.now = () => clock;
  H = await setupHospital(h, [
    { key: 'reception', role: 'reception' },
    { key: 'doctor', role: 'physician' },
    { key: 'rg', role: 'radiographer' },
    { key: 'rad', role: 'radiologist' },
    { key: 'dxt', role: 'dx-tech' },
    { key: 'bio', role: 'biomedical' },
    { key: 'cashier', role: 'cashier' },
  ]);
  const rc = H.staff.reception!.c;
  const pid = (await rc.post('/patients', { branchId: H.branchId, givenName: 'Ayaan', familyName: 'Cilmi', dob: '2001-02-02', sexAtBirth: 'female' })).body.data.id;
  enc = (await rc.post('/appointments/walk-in', { patientId: pid, providerId: H.staff.doctor!.id, reason: 'Head injury' })).body.data.encounterId;
  ct = (await H.staff.bio!.c.post('/equipment/assets', { branchId: H.branchId, code: 'CT-1', name: 'CT scanner', kind: 'imaging', modality: 'CT' })).body.data.id;
  ecgMachine = (await H.staff.bio!.c.post('/equipment/assets', { branchId: H.branchId, code: 'ECG-1', name: '12-lead ECG', kind: 'diagnostic', modality: 'ECG' })).body.data.id;
});
afterAll(async () => {
  await h?.stop();
});

const ctOrder = (extra: object = {}) =>
  H.staff.doctor!.c.post('/radiology/orders', { encounterId: enc, modality: 'CT', examination: 'CT head without contrast', priority: 'urgent', clinicalQuestion: 'Intracranial bleed after fall?', ...extra });

describe('radiology', () => {
  let order = '';

  it('an ionising study for a woman of child-bearing age needs pregnancy status', async () => {
    expect((await ctOrder()).body.error.details[0].path).toBe('pregnancyStatus');
    expect((await ctOrder({ pregnancyStatus: 'unknown' })).body.error.details[0].path).toBe('justification');
    const r = await ctOrder({ pregnancyStatus: 'not-pregnant' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.accessionNumber).toMatch(/^RAD-MGD-300107-00001$/);
    order = r.body.data.id;
  });

  it('an out-of-service scanner cannot be booked; bookings on one scanner never overlap', async () => {
    const rg = H.staff.rg!.c;
    await H.staff.bio!.c.post(`/equipment/assets/${ct}/out-of-service`, { reason: 'Gantry fault' });
    expect((await rg.post(`/radiology/orders/${order}/schedule`, { assetId: ct, startsAt: '2030-01-07T06:00:00Z' })).body.error.code).toBe('EQUIPMENT_UNAVAILABLE');
    await H.staff.bio!.c.post(`/equipment/assets/${ct}/release`, { reason: 'Gantry fixed' });
    expect((await rg.post(`/radiology/orders/${order}/schedule`, { assetId: ct, startsAt: '2030-01-07T06:00:00Z' })).status).toBe(200);
    const second = (await ctOrder({ pregnancyStatus: 'not-pregnant', examination: 'CT cervical spine' })).body.data.id;
    expect((await rg.post(`/radiology/orders/${second}/schedule`, { assetId: ct, startsAt: '2030-01-07T06:10:00Z' })).body.error.code).toBe('SLOT_TAKEN');
    expect((await rg.post(`/radiology/orders/${second}/schedule`, { assetId: ecgMachine, startsAt: '2030-01-07T07:00:00Z' })).status).toBe(400);
  });

  it('acquisition requires a DICOM study reference', async () => {
    const rg = H.staff.rg!.c;
    expect((await rg.post(`/radiology/orders/${order}/acquire`, {})).status).toBe(400);
    expect((await rg.post(`/radiology/orders/${order}/acquire`, { studyInstanceUid: '1.2.840.113619.2.55.3.604688.11' })).status).toBe(200);
  });

  it('only the radiologist reports and signs; the clinician sees nothing until final', async () => {
    expect((await H.staff.rg!.c.post(`/radiology/orders/${order}/report`, { findings: 'No bleed seen.', impression: 'Normal' })).status).toBe(403);
    const rad = H.staff.rad!.c;
    expect((await rad.post(`/radiology/orders/${order}/report`, { findings: 'Small acute subdural haematoma, 6 mm, left convexity.', impression: 'Acute left SDH' })).status).toBe(200);
    expect((await H.staff.doctor!.c.get(`/radiology/orders?encounterId=${enc}`)).body.data.find((o: { id: string }) => o.id === order).report).toBeNull();
    const s = await rad.post(`/radiology/orders/${order}/sign`, { criticalFinding: 'Acute subdural haematoma' });
    expect(s.body.data).toMatchObject({ status: 'Final', critical: true });
    const seen = (await H.staff.doctor!.c.get(`/radiology/orders?encounterId=${enc}`)).body.data.find((o: { id: string }) => o.id === order);
    expect(seen.report.impression).toBe('Acute left SDH');
    expect(seen.signedByName).toBe('rad');
  });

  it('final reports change only by addendum; the doctor acknowledges the critical finding', async () => {
    expect((await H.staff.rad!.c.post(`/radiology/orders/${order}/report`, { findings: 'changed', impression: 'changed' })).status).toBe(409);
    expect((await H.staff.rad!.c.post(`/radiology/orders/${order}/addendum`, { text: 'Discussed with neurosurgery at 08:40.' })).status).toBe(201);
    clock = new Date('2030-01-07T05:09:00Z');
    expect((await H.staff.doctor!.c.post(`/radiology/orders/${order}/acknowledge`)).body.data.minutesToAcknowledge).toBe(9);
  });

  it('viewer links are short-lived and audited; cashiers get none', async () => {
    const v = await H.staff.doctor!.c.get(`/radiology/orders/${order}/viewer-link`);
    expect(v.body.data.url).toMatch(/^\/viewer\?study=1\.2\.840/);
    expect(new Date(v.body.data.expiresAt).getTime() - clock.getTime()).toBe(15 * 60_000);
    expect((await H.staff.cashier!.c.get(`/radiology/orders/${order}/viewer-link`)).status).toBe(403);
  });
});

describe('diagnostics (ECG)', () => {
  it('a technician performs, a specialist signs', async () => {
    const o = await H.staff.doctor!.c.post('/diagnostics/orders', { encounterId: enc, modality: 'ECG', examination: '12-lead ECG', clinicalQuestion: 'Syncope — arrhythmia?' });
    expect(o.status, JSON.stringify(o.body)).toBe(201);
    const id = o.body.data.id;
    const t = H.staff.dxt!.c;
    expect((await t.post(`/diagnostics/orders/${id}/schedule`, { assetId: ecgMachine, startsAt: '2030-01-07T05:30:00Z', minutes: 10 })).status).toBe(200);
    expect((await t.post(`/diagnostics/orders/${id}/acquire`, { note: 'Tracing stored on device' })).status).toBe(200);
    expect((await t.post(`/diagnostics/orders/${id}/report`, { findings: 'Sinus rhythm 72', impression: 'Normal ECG' })).status).toBe(403);
    expect((await H.staff.doctor!.c.post(`/diagnostics/orders/${id}/report`, { findings: 'Sinus rhythm 72, normal axis, no ST change', impression: 'Normal ECG' })).status).toBe(200);
    expect((await H.staff.doctor!.c.post(`/diagnostics/orders/${id}/sign`, {})).body.data.status).toBe('Final');
  });
});
