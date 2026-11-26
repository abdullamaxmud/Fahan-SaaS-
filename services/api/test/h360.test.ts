import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { localDate } from '../src/lib/time';
import { setupHospital, type Hospital } from './fixtures';
import { startHarness, type Harness } from './helpers';

/** Spec §5.32 / §9.5 / §9.8: the monthly Hospital 360 report and its acceptance checklist. */
let h: Harness;
let H: Hospital;
const period = localDate(new Date(), 'Africa/Mogadishu').slice(0, 7);
let firstPid: string;
let v1: { id: string; contentHash: string };
let v2: string;

async function chargeAndPay(pid: string, key: string) {
  await H.staff.cashier!.c.post('/billing/charges', { patientId: pid, serviceCode: 'CONS-OPD', quantity: 1 });
  const inv = (await H.staff.cashier!.c.post('/billing/invoices', { patientId: pid })).body.data.id;
  await H.staff.cashier!.c.post(`/billing/invoices/${inv}/issue`);
  await H.staff.cashier!.c.post(`/billing/invoices/${inv}/payments`, { amountMinor: 1_000, method: 'mobile-money' }).set('Idempotency-Key', key);
}

beforeAll(async () => {
  h = await startHarness();
  H = await setupHospital(h, [
    { key: 'reception', role: 'reception' },
    { key: 'doctor', role: 'physician' },
    { key: 'cashier', role: 'cashier' },
    { key: 'analyst', role: 'analyst' },
    { key: 'fd', role: 'finance-director' },
    { key: 'fa', role: 'finance-approver' },
    { key: 'creviewer', role: 'clinical-reviewer' },
  ]);
  await H.staff.fd!.c.post('/billing/prices', { code: 'CONS-OPD', name: 'Outpatient consultation', category: 'consultation', priceMinor: 1_000, currency: 'USD' });
  for (let i = 0; i < 5; i++) {
    const pid = (await H.staff.reception!.c.post('/patients', { branchId: H.branchId, givenName: `Xog${i}`, familyName: 'Tijaabo', dob: `19${80 + i}-01-01` })).body.data.id;
    if (i === 0) firstPid = pid;
    const enc = (await H.staff.reception!.c.post('/appointments/walk-in', { patientId: pid, providerId: H.staff.doctor!.id, reason: 'Fever' })).body.data.encounterId;
    await H.staff.doctor!.c.post(`/encounters/${enc}/diagnoses`, { code: '1F40', display: 'Malaria due to Plasmodium falciparum', certainty: 'confirmed', primary: true });
  }
  await chargeAndPay(firstPid, 'h360-pay-0001');
});
afterAll(async () => {
  await h?.stop();
});

describe('building', () => {
  it('only Hospital 360 reviewers build; viewers and other staff cannot', async () => {
    expect((await H.staff.cashier!.c.post('/intel/h360', { period })).status).toBe(403);
    expect((await H.staff.cashier!.c.get('/intel/h360')).status).toBe(403);
    expect((await H.staff.analyst!.c.post('/intel/h360', { period })).status).toBe(403);
  });

  it('every figure cites its certified metric and snapshot; missing data is shown as unavailable', async () => {
    const r = await H.staff.fd!.c.post('/intel/h360', { period, currency: 'USD' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const x = r.body.data;
    v1 = { id: x.id, contentHash: x.contentHash };
    expect(x).toMatchObject({ status: 'Built', version: 1, check: { ok: true } });
    expect(x.content.cover).toMatchObject({ organisation: 'Hiil Medical Group', period, currency: 'USD' });
    const official = (await H.staff.fd!.c.get(`/accounting/summary?period=${period}&currency=USD`)).body.data;
    const exec = x.content.executive as { metricId: string; value: number | null; snapshotId: string }[];
    expect(exec.find((c) => c.metricId === 'fin.recognizedRevenue')!.value).toBe(official.recognizedRevenueMinor);
    expect(exec.find((c) => c.metricId === 'ops.opdVisits')!.value).toBe(5);
    expect(exec.every((c) => c.metricId && /^[0-9a-f]{24}$/.test(c.snapshotId))).toBe(true);
    expect(x.content.quality.find((c: { metricId: string }) => c.metricId === 'ops.qualityIncidents')).toMatchObject({ value: null, unavailable: expect.any(String) });
    expect(x.content.financial.budget.unavailable).toBeTruthy();
    expect(x.content.clinical.topConditions[0]).toMatchObject({ code: '1F40', confirmedPatients: 5 });
    expect(x.content.narrative.disclosure).toMatch(/Written by AI/);
    expect(x.content.sources.map((s: { kind: string }) => s.kind)).toEqual(['finance', 'disease', 'operations']);
    expect(JSON.stringify(x.content)).not.toMatch(/Xog\d|patientId/);
  });

  it('rebuilding from the same data gives the same numbers and fingerprint', async () => {
    const r = (await H.staff.fd!.c.post('/intel/h360', { period, currency: 'USD' })).body.data;
    v2 = r.id;
    expect(r.version).toBe(2);
    expect(r.contentHash).toBe(v1.contentHash);
    expect((await H.staff.fa!.c.post(`/intel/h360/${v1.id}/reject`, { note: 'Duplicate build' })).body.data.status).toBe('Rejected');
  });
});

describe('review, approval and publication', () => {
  it('finance and clinical sections are signed by the right people, never one person for both', async () => {
    expect((await H.staff.creviewer!.c.post(`/intel/h360/${v2}/signoff`, { section: 'finance' })).status).toBe(403);
    expect((await H.staff.fa!.c.post(`/intel/h360/${v2}/signoff`, { section: 'finance', note: 'Agrees with the ledger' })).body.data.status).toBe('Built');
    expect((await H.staff.fa!.c.post(`/intel/h360/${v2}/signoff`, { section: 'finance' })).body.error.code).toBe('ALREADY_SIGNED');
    expect((await H.staff.fa!.c.post(`/intel/h360/${v2}/signoff`, { section: 'clinical' })).status).toBe(403);
    expect((await H.staff.fd!.c.post(`/intel/h360/${v2}/approve`)).status).toBe(403);
    expect((await H.admin.post(`/intel/h360/${v2}/approve`)).body.error.code).toBe('INVALID_TRANSITION');
    expect((await H.staff.creviewer!.c.post(`/intel/h360/${v2}/signoff`, { section: 'clinical', note: 'Coding reviewed' })).body.data.status).toBe('Reviewed');
  });

  it('the owner approves and publishes; the published report is signed and exportable by viewers only', async () => {
    expect((await H.staff.analyst!.c.get(`/intel/h360/${v2}/export`)).body.error.code).toBe('NOT_PUBLISHED');
    expect((await H.admin.post(`/intel/h360/${v2}/approve`, { note: 'Approved for the board' })).body.data.status).toBe('Approved');
    const p = await H.admin.post(`/intel/h360/${v2}/publish`);
    expect(p.body.data).toMatchObject({ status: 'Published', signature: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const ex = await H.staff.analyst!.c.get(`/intel/h360/${v2}/export`);
    expect(ex.status).toBe(200);
    expect(ex.body.data.manifest).toMatchObject({ format: 'fahan-h360-v1', version: 2, contentHash: v1.contentHash, signature: p.body.data.signature });
    expect(ex.body.data.manifest.signoffs.owner.byName).toBeTruthy();
    expect((await H.staff.cashier!.c.get(`/intel/h360/${v2}/export`)).status).toBe(403);
    expect((await H.staff.analyst!.c.get(`/intel/h360/${v2}/verify`)).body.data).toMatchObject({ contentIntact: true, signatureValid: true });
    expect((await H.staff.fa!.c.post(`/intel/h360/${v2}/reject`, { note: 'Too late now' })).body.error.code).toBe('INVALID_TRANSITION');
  });

  it('a correction is a new version that supersedes the published one', async () => {
    await chargeAndPay(firstPid, 'h360-pay-0002');
    const v3 = (await H.staff.fd!.c.post('/intel/h360', { period, currency: 'USD' })).body.data;
    expect(v3.version).toBe(3);
    expect(v3.contentHash).not.toBe(v1.contentHash);
    await H.staff.fa!.c.post(`/intel/h360/${v3.id}/signoff`, { section: 'finance' });
    await H.staff.creviewer!.c.post(`/intel/h360/${v3.id}/signoff`, { section: 'clinical' });
    await H.admin.post(`/intel/h360/${v3.id}/approve`);
    expect((await H.admin.post(`/intel/h360/${v3.id}/publish`)).body.data.status).toBe('Published');
    expect((await H.staff.analyst!.c.get(`/intel/h360/${v2}`)).body.data.status).toBe('Superseded');
  });

  it('editing a stored report is detected', async () => {
    const tdb = h.data.tenant('fahan_t_hiil');
    const x = await tdb.collection('h360_reports').findOne({ version: 2 });
    await tdb.collection('h360_reports').updateOne({ _id: x!._id }, { $set: { 'content.cover.organisation': 'Someone Else' } });
    expect((await H.staff.analyst!.c.get(`/intel/h360/${v2}/verify`)).body.data.contentIntact).toBe(false);
  });
});
