import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupHospital, type Hospital } from './fixtures';
import { startHarness, type Harness } from './helpers';

/** Spec §5.33: no-code forms, Draft → Tested → Approved → Published → Retired, historical submissions keep their version. */
let h: Harness;
let H: Hospital;
let v1: string;
let v2: string;
let sub1: string;

const fallRisk = {
  key: 'fall-risk',
  name: 'Fall risk assessment',
  module: 'nur',
  highRisk: true,
  approval: { module: 'nur', level: 'S' },
  fields: [
    { type: 'number', key: 'score', label: 'Morse score', required: true, min: 0, max: 125, integer: true },
    { type: 'select', key: 'risk', label: 'Risk level', labelSo: 'Heerka khatarta', required: true, options: ['low', 'medium', 'high'] },
    { type: 'longtext', key: 'notes', label: 'Notes' },
  ],
};

beforeAll(async () => {
  h = await startHarness();
  H = await setupHospital(h, [
    { key: 'designer', role: 'designer' },
    { key: 'cso', role: 'clinical-safety-officer' },
    { key: 'nurse', role: 'nurse' },
    { key: 'lead', role: 'shift-lead' },
    { key: 'cashier', role: 'cashier' },
  ]);
});
afterAll(async () => {
  await h?.stop();
});

describe('designing a form', () => {
  it('designers build forms from safe field types; others cannot', async () => {
    expect((await H.staff.nurse!.c.post('/studio/forms', fallRisk)).status).toBe(403);
    const dup = await H.staff.designer!.c.post('/studio/forms', { ...fallRisk, key: 'dup-form', fields: [fallRisk.fields[0], fallRisk.fields[0]] });
    expect(dup.body.error.code).toBe('VALIDATION_FAILED');
    expect((await H.staff.designer!.c.post('/studio/forms', { ...fallRisk, key: 'bad-form', fields: [{ type: 'text', key: '__proto__', label: 'x' }] })).status).toBe(400);
    expect((await H.staff.designer!.c.post('/studio/forms', { ...fallRisk, key: 'bad-form', fields: [{ type: 'script', key: 'run', label: 'x', code: 'process.exit()' }] })).status).toBe(400);
    const r = await H.staff.designer!.c.post('/studio/forms', fallRisk);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    v1 = r.body.data.id;
    expect(r.body.data).toMatchObject({ version: 1, status: 'Draft' });
  });

  it('a form is tested with a sample before it can be approved', async () => {
    expect((await H.admin.post(`/studio/forms/${v1}/approve`)).body.error.code).toBe('INVALID_TRANSITION');
    const bad = await H.staff.designer!.c.post(`/studio/forms/${v1}/test`, { sample: { score: 200, risk: 'extreme', extra: 1 } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual(['extra', 'risk', 'score']);
    expect((await H.staff.designer!.c.post(`/studio/forms/${v1}/test`, { sample: { score: 45, risk: 'medium' } })).body.data.status).toBe('Tested');
  });

  it('high-risk forms need the clinical safety officer; the designer never approves their own', async () => {
    expect((await H.staff.designer!.c.post(`/studio/forms/${v1}/approve`)).status).toBe(403);
    expect((await H.admin.post(`/studio/forms/${v1}/approve`)).body.error.code).toBe('SAFETY_SIGNOFF_REQUIRED');
    expect((await H.staff.cso!.c.post(`/studio/forms/${v1}/safety-signoff`, { note: 'Thresholds agree with the falls policy' })).body.data.safetySigned).toBe(true);
    expect((await H.admin.post(`/studio/forms/${v1}/approve`)).body.data.status).toBe('Approved');
    expect((await H.staff.designer!.c.put(`/studio/forms/${v1}`, fallRisk)).body.error.code).toBe('NOT_EDITABLE');
    expect((await H.admin.post(`/studio/forms/${v1}/publish`)).body.data).toMatchObject({ status: 'Published', version: 1 });
  });
});

describe('using a form', () => {
  it('staff of the form’s module submit valid answers; approval rules hold the submission', async () => {
    expect((await H.staff.cashier!.c.post('/studio/forms/by-key/fall-risk/submissions', { data: { score: 10, risk: 'low' } })).status).toBe(403);
    expect((await H.staff.nurse!.c.post('/studio/forms/by-key/fall-risk/submissions', { data: { score: 'many', risk: 'low' } })).status).toBe(400);
    const r = await H.staff.nurse!.c.post('/studio/forms/by-key/fall-risk/submissions', { data: { score: 55, risk: 'high', notes: 'Unsteady gait' } });
    expect(r.body.data).toMatchObject({ formVersion: 1, status: 'Pending' });
    sub1 = r.body.data.id;
    expect((await H.staff.nurse!.c.post(`/studio/submissions/${sub1}/decide`, { decision: 'approve' })).status).toBe(403);
    expect((await H.staff.lead!.c.post(`/studio/submissions/${sub1}/decide`, { decision: 'approve' })).body.data.status).toBe('Approved');
    const mine = (await H.staff.nurse!.c.get('/studio/published')).body.data;
    expect(mine.map((f: { key: string }) => f.key)).toEqual(['fall-risk']);
  });
});

describe('versions', () => {
  it('a new version goes through the same steps; the old one retires', async () => {
    const r = await H.staff.designer!.c.post(`/studio/forms/${v1}/versions`);
    expect(r.body.data).toMatchObject({ version: 2, status: 'Draft' });
    v2 = r.body.data.id;
    const fields = [...fallRisk.fields, { type: 'checkbox', key: 'bed_rails', label: 'Bed rails up', required: true }];
    await H.staff.designer!.c.put(`/studio/forms/${v2}`, { ...fallRisk, fields });
    await H.staff.designer!.c.post(`/studio/forms/${v2}/test`, { sample: { score: 30, risk: 'medium', bed_rails: true } });
    await H.staff.cso!.c.post(`/studio/forms/${v2}/safety-signoff`);
    await H.admin.post(`/studio/forms/${v2}/approve`);
    expect((await H.admin.post(`/studio/forms/${v2}/publish`)).body.data.version).toBe(2);
    expect((await H.staff.designer!.c.get(`/studio/forms/${v1}`)).body.data.status).toBe('Retired');
    expect((await H.staff.nurse!.c.post('/studio/forms/by-key/fall-risk/submissions', { data: { score: 20, risk: 'low' } })).body.error.details[0].path).toBe('bed_rails');
    expect((await H.staff.nurse!.c.post('/studio/forms/by-key/fall-risk/submissions', { data: { score: 20, risk: 'low', bed_rails: true } })).body.data.formVersion).toBe(2);
  });

  it('old submissions are still read with the fields of their own version', async () => {
    const list = (await H.staff.lead!.c.get('/studio/forms/by-key/fall-risk/submissions')).body.data;
    const old = list.find((s: { id: string }) => s.id === sub1);
    expect(old).toMatchObject({ formVersion: 1, status: 'Approved' });
    expect(old.answers.map((a: { key: string }) => a.key)).toEqual(['score', 'risk', 'notes']);
    const recent = list.find((s: { formVersion: number }) => s.formVersion === 2);
    expect(recent.answers.map((a: { key: string }) => a.key)).toContain('bed_rails');
  });

  it('a change is reversible: republishing version 1 rolls back', async () => {
    expect((await H.admin.post(`/studio/forms/${v1}/publish`)).body.data).toMatchObject({ status: 'Published', version: 1 });
    expect((await H.staff.designer!.c.get(`/studio/forms/${v2}`)).body.data.status).toBe('Retired');
    expect((await H.staff.nurse!.c.post('/studio/forms/by-key/fall-risk/submissions', { data: { score: 20, risk: 'low' } })).body.data.formVersion).toBe(1);
  });
});
