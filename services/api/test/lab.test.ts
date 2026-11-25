import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupHospital, type Hospital } from './fixtures';
import { startHarness, type Harness } from './helpers';

/** Spec §5.11 and §6 "Laboratory": order → collect → accession → process → verify → release → critical acknowledgement. */
let h: Harness;
let H: Hospital;
let enc = '';
let kTest = '';
let cbc = '';
let clock = new Date('2030-01-07T05:30:00Z');

beforeAll(async () => {
  h = await startHarness();
  h.config.now = () => clock;
  H = await setupHospital(h, [
    { key: 'reception', role: 'reception' },
    { key: 'doctor', role: 'physician' },
    { key: 'nurse', role: 'nurse' },
    { key: 'tech', role: 'lab-tech' },
    { key: 'path', role: 'pathologist' },
    { key: 'path2', role: 'pathologist' },
    { key: 'cashier', role: 'cashier' },
  ]);
  const rc = H.staff.reception!.c;
  const pid = (await rc.post('/patients', { branchId: H.branchId, givenName: 'Sahra', familyName: 'Jaamac', dob: '1981-04-19' })).body.data.id;
  enc = (await rc.post('/appointments/walk-in', { patientId: pid, providerId: H.staff.doctor!.id, reason: 'Weakness' })).body.data.encounterId;
  const p = H.staff.path!.c;
  kTest = (await p.post('/lab/tests', { code: 'K', name: 'Potassium', specimen: 'serum', turnaroundMinutes: 60, analytes: [{ code: 'K', name: 'Potassium', unit: 'mmol/L', refLow: 3.5, refHigh: 5.1, criticalLow: 2.5, criticalHigh: 6.0 }] })).body.data.id;
  const cbcRes = await p.post('/lab/tests', { code: 'CBC', name: 'Full blood count', specimen: 'blood', turnaroundMinutes: 90, analytes: [{ code: 'HB', name: 'Haemoglobin', unit: 'g/dL', refLow: 12, refHigh: 16, criticalLow: 7 }, { code: 'WBC', name: 'White cells', unit: '10^9/L', refLow: 4, refHigh: 11 }] });
  expect(cbcRes.status, JSON.stringify(cbcRes.body)).toBe(201);
  cbc = cbcRes.body.data.id;
});
afterAll(async () => {
  await h?.stop();
});

describe('ordering', () => {
  it('only a signing clinician on the visit orders; nurses and the lab tech cannot', async () => {
    expect((await H.staff.nurse!.c.post('/lab/orders', { encounterId: enc, testIds: [kTest] })).status).toBe(403);
    expect((await H.staff.tech!.c.post('/lab/orders', { encounterId: enc, testIds: [kTest] })).status).toBe(403);
    const r = await H.staff.doctor!.c.post('/lab/orders', { encounterId: enc, testIds: [kTest, cbc], priority: 'stat', clinicalNote: 'On ACE inhibitor' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toHaveLength(2);
  });

  it('the worklist is for the laboratory, ordered by priority', async () => {
    expect((await H.staff.doctor!.c.get('/lab/worklist')).status).toBe(403);
    const wl = (await H.staff.tech!.c.get('/lab/worklist')).body.data;
    expect(wl.map((o: { testCode: string; priority: string }) => `${o.testCode}:${o.priority}`)).toEqual(['K:stat', 'CBC:stat']);
  });
});

describe('processing and verification', () => {
  let k = '';
  beforeAll(async () => {
    k = (await H.staff.tech!.c.get('/lab/worklist')).body.data.find((o: { testCode: string }) => o.testCode === 'K').id;
  });

  it('collection assigns a unique accession number; steps cannot be skipped', async () => {
    const t = H.staff.tech!.c;
    expect((await t.post(`/lab/orders/${k}/results`, { results: [{ analyteCode: 'K', value: 6.8 }] })).body.error.code).toBe('INVALID_TRANSITION');
    const c = await t.post(`/lab/orders/${k}/collect`);
    expect(c.body.data.accessionNumber).toMatch(/^ACC-MGD-300107-00001$/);
    expect((await t.post(`/lab/orders/${k}/collect`)).status).toBe(409);
    expect((await t.post(`/lab/orders/${k}/receive`)).status).toBe(200);
  });

  it('results are flagged against reference and critical limits; all analytes required', async () => {
    const t = H.staff.tech!.c;
    expect((await t.post(`/lab/orders/${k}/results`, { results: [{ analyteCode: 'NA', value: 140 }] })).status).toBe(400);
    const r = await t.post(`/lab/orders/${k}/results`, { results: [{ analyteCode: 'K', value: 6.8 }] });
    expect(r.body.data.flags).toEqual(['K:HH']);
  });

  it('the technician cannot verify; a failed QC blocks the pathologist until rerun', async () => {
    expect((await H.staff.tech!.c.post(`/lab/orders/${k}/verify`)).status).toBe(403);
    expect((await H.staff.tech!.c.post('/lab/qc', { testId: kTest, analyteCode: 'K', level: 'L2', value: 6.4, mean: 5.0, sd: 0.2 })).body.data.outcome).toBe('fail');
    expect((await H.staff.path!.c.post(`/lab/orders/${k}/verify`)).body.error.code).toBe('QC_FAILED');
    clock = new Date('2030-01-07T05:40:00Z');
    expect((await H.staff.tech!.c.post('/lab/qc', { testId: kTest, analyteCode: 'K', level: 'L2', value: 5.1, mean: 5.0, sd: 0.2 })).body.data.outcome).toBe('pass');
  });

  it('the person who entered results cannot verify them (four eyes)', async () => {
    const cbcId = (await H.staff.tech!.c.get('/lab/worklist')).body.data.find((o: { testCode: string }) => o.testCode === 'CBC').id;
    const p = H.staff.path!.c;
    await H.staff.tech!.c.post(`/lab/orders/${cbcId}/collect`);
    await H.staff.tech!.c.post(`/lab/orders/${cbcId}/receive`);
    await p.post(`/lab/orders/${cbcId}/results`, { results: [{ analyteCode: 'HB', value: 11.2 }, { analyteCode: 'WBC', value: 7.4 }] });
    expect((await p.post(`/lab/orders/${cbcId}/verify`)).body.error.code).toBe('FOUR_EYES');
    expect((await H.staff.path2!.c.post(`/lab/orders/${cbcId}/verify`)).status).toBe(200);
  });

  it('nothing is visible to the doctor until released', async () => {
    const p = H.staff.path!.c;
    expect((await p.post(`/lab/orders/${k}/release`)).body.error.code).toBe('NOT_VERIFIED');
    expect((await p.post(`/lab/orders/${k}/verify`)).body.data).toMatchObject({ status: 'Verified', critical: true });
    const before = (await H.staff.doctor!.c.get(`/lab/orders?encounterId=${enc}`)).body.data.find((o: { testCode: string }) => o.testCode === 'K');
    expect(before.results).toEqual([]);
    expect((await p.post(`/lab/orders/${k}/release`)).status).toBe(200);
    const after = (await H.staff.doctor!.c.get(`/lab/orders?encounterId=${enc}`)).body.data.find((o: { testCode: string }) => o.testCode === 'K');
    expect(after.results[0]).toMatchObject({ value: 6.8, flag: 'HH', unit: 'mmol/L' });
  });

  it('a released result is charged once; with no price yet it is held for billing', async () => {
    const charges = (await H.staff.cashier!.c.get('/billing/charges')).body.data;
    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({ serviceCode: 'LAB-K', status: 'unpriced', sourceType: 'lab_order' });
  });
});

describe('critical values', () => {
  it('stay open until a clinician on the visit acknowledges them', async () => {
    const open = (await H.staff.doctor!.c.get('/lab/criticals')).body.data;
    expect(open).toHaveLength(1);
    clock = new Date('2030-01-07T05:52:00Z');
    expect((await H.staff.nurse!.c.post(`/lab/orders/${open[0].id}/acknowledge`)).status).toBe(403);
    const ack = await H.staff.doctor!.c.post(`/lab/orders/${open[0].id}/acknowledge`);
    expect(ack.body.data.minutesToAcknowledge).toBe(12);
    expect((await H.staff.tech!.c.get('/lab/criticals')).body.data).toHaveLength(0);
  });

  it('released results are amended with history, never overwritten', async () => {
    const k = (await H.staff.doctor!.c.get(`/lab/orders?encounterId=${enc}`)).body.data.find((o: { testCode: string }) => o.testCode === 'K');
    const r = await H.staff.path!.c.post(`/lab/orders/${k.id}/amend`, { results: [{ analyteCode: 'K', value: 4.2 }], reason: 'Haemolysed sample, repeat value' });
    expect(r.status).toBe(200);
    const again = (await H.staff.doctor!.c.get(`/lab/orders?encounterId=${enc}`)).body.data.find((o: { testCode: string }) => o.testCode === 'K');
    expect(again).toMatchObject({ amended: true });
    expect(again.results[0].flag).toBe('N');
  });

  it('cashier cannot see lab results', async () => {
    expect((await H.staff.cashier!.c.get(`/lab/orders?encounterId=${enc}`)).status).toBe(403);
  });
});
