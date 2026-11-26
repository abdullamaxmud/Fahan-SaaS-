import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupHospital, type Hospital } from './fixtures';
import { startHarness, type Harness } from './helpers';

/** Spec §5.21: payers, policies, claims Draft → Submitted → Accepted/Rejected → Settled, AR transfers, denials. */
let h: Harness;
let H: Hospital;
const clock = new Date('2030-04-10T08:00:00Z');
let pid: string;
let payer: string;
let policy: string;
let inv: string;
let claim: string;

beforeAll(async () => {
  h = await startHarness();
  h.config.now = () => clock;
  H = await setupHospital(h, [
    { key: 'reception', role: 'reception' },
    { key: 'cashier', role: 'cashier' },
    { key: 'bo', role: 'billing-officer' },
    { key: 'claims', role: 'claims' },
    { key: 'fd', role: 'finance-director' },
  ]);
  pid = (await H.staff.reception!.c.post('/patients', { branchId: H.branchId, givenName: 'Hodan', familyName: 'Maxamed', dob: '1990-01-12' })).body.data.id;
  await H.staff.fd!.c.post('/billing/prices', { code: 'CONS-OPD', name: 'Outpatient consultation', category: 'consultation', priceMinor: 10_000, currency: 'USD' });
  await H.staff.fd!.c.post('/billing/prices', { code: 'LAB-CBC', name: 'Full blood count', category: 'laboratory', priceMinor: 10_000, currency: 'USD' });
  inv = await invoice(['CONS-OPD', 'LAB-CBC']);
});
afterAll(async () => {
  await h?.stop();
});

async function invoice(codes: string[]) {
  for (const serviceCode of codes) await H.staff.cashier!.c.post('/billing/charges', { patientId: pid, serviceCode, quantity: 1 });
  const id = (await H.staff.cashier!.c.post('/billing/invoices', { patientId: pid })).body.data.id;
  await H.staff.cashier!.c.post(`/billing/invoices/${id}/issue`);
  return id as string;
}
const tb = async () => {
  const d = (await H.staff.fd!.c.get('/accounting/trial-balance')).body.data;
  expect(d.balanced).toBe(true);
  return Object.fromEntries((d.rows as { accountCode: string; debitMinor: number; creditMinor: number }[]).map((r) => [r.accountCode, r.debitMinor - r.creditMinor]));
};
const invoiceNow = async (id = inv) => (await H.staff.cashier!.c.get(`/billing/invoices/${id}`)).body.data;
const payMobile = (id: string, amountMinor: number, key: string) => H.staff.cashier!.c.post(`/billing/invoices/${id}/payments`, { amountMinor, method: 'mobile-money' }).set('Idempotency-Key', key);

describe('payers and policies', () => {
  it('the claims specialist registers payers; billing records the patient policy', async () => {
    expect((await H.staff.bo!.c.post('/insurance/payers', { code: 'TAKAFUL', name: 'Takaful Somalia', kind: 'insurer', currency: 'USD' })).status).toBe(403);
    const r = await H.staff.claims!.c.post('/insurance/payers', { code: 'TAKAFUL', name: 'Takaful Somalia', kind: 'insurer', currency: 'USD' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    payer = r.body.data.id;
    expect((await H.staff.claims!.c.post('/insurance/payers', { code: 'TAKAFUL', name: 'Again', kind: 'insurer', currency: 'USD' })).body.error.code).toBe('PAYER_EXISTS');
    policy = (await H.staff.bo!.c.post('/insurance/policies', { patientId: pid, payerId: payer, memberNumber: 'TK-55120', coveragePercent: 80, validFrom: '2030-01-01', validTo: '2030-12-31' })).body.data.id;
    const list = (await H.staff.cashier!.c.get(`/insurance/policies?patientId=${pid}`)).body.data;
    expect(list[0]).toMatchObject({ memberNumber: 'TK-55120', coveragePercent: 80, active: true });
  });

  it('a policy that did not cover the invoice date cannot be claimed against', async () => {
    const old = (await H.staff.bo!.c.post('/insurance/policies', { patientId: pid, payerId: payer, memberNumber: 'TK-OLD', coveragePercent: 100, validFrom: '2029-01-01', validTo: '2029-12-31' })).body.data.id;
    expect((await H.staff.bo!.c.post('/insurance/claims', { invoiceId: inv, policyId: old })).body.error.code).toBe('POLICY_INACTIVE');
  });
});

describe('claim lifecycle', () => {
  it('a claim covers the policy share; one open claim per invoice', async () => {
    const r = await H.staff.bo!.c.post('/insurance/claims', { invoiceId: inv, policyId: policy });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({ claimNumber: 'CLM-2030-000001', claimedMinor: 16_000, status: 'Draft' });
    claim = r.body.data.id;
    expect((await H.staff.bo!.c.post('/insurance/claims', { invoiceId: inv, policyId: policy })).body.error.code).toBe('CLAIM_OPEN');
  });

  it('submitting moves the claim to insurer receivable; the patient owes only their share', async () => {
    expect((await H.staff.bo!.c.post(`/insurance/claims/${claim}/submit`)).status).toBe(403);
    expect((await H.staff.claims!.c.post(`/insurance/claims/${claim}/submit`)).body.data.status).toBe('Submitted');
    expect(await tb()).toMatchObject({ '1100': 4_000, '1110': 16_000 });
    expect(await invoiceNow()).toMatchObject({ balanceMinor: 20_000, insuranceHoldMinor: 16_000, patientDueMinor: 4_000 });
    expect((await payMobile(inv, 5_000, 'ins-pay-0001')).body.error.code).toBe('OVERPAYMENT');
    expect((await payMobile(inv, 4_000, 'ins-pay-0002')).body.data.balanceMinor).toBe(16_000);
    expect((await H.staff.bo!.c.post(`/billing/invoices/${inv}/void`, { reason: 'Testing the guard' })).status).toBe(409);
  });

  it('a partial approval needs a reason; the cut goes back to the patient', async () => {
    expect((await H.staff.claims!.c.post(`/insurance/claims/${claim}/respond`, { decision: 'accept', approvedMinor: 15_000 })).status).toBe(400);
    expect((await H.staff.claims!.c.post(`/insurance/claims/${claim}/respond`, { decision: 'accept', approvedMinor: 17_000, denialCode: 'other' })).status).toBe(400);
    const r = await H.staff.claims!.c.post(`/insurance/claims/${claim}/respond`, { decision: 'accept', approvedMinor: 15_000, denialCode: 'not-covered', note: 'Lab panel not in plan' });
    expect(r.body.data).toMatchObject({ status: 'Accepted', returnedToPatientMinor: 1_000 });
    expect(await tb()).toMatchObject({ '1100': 1_000, '1110': 15_000 });
    expect((await invoiceNow()).patientDueMinor).toBe(1_000);
  });

  it('remittance settles the claim; a short payment is written off with a reason', async () => {
    expect((await H.staff.claims!.c.post(`/insurance/claims/${claim}/remit`, { amountMinor: 14_500, reference: 'TK-REM-881' })).status).toBe(400);
    const r = await H.staff.claims!.c.post(`/insurance/claims/${claim}/remit`, { amountMinor: 14_500, reference: 'TK-REM-881', shortPayReason: 'Contract tariff for CBC' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ status: 'Settled', writtenOffMinor: 500 });
    expect(await tb()).toMatchObject({ '1110': 0, '1010': 14_500, '4900': 500, '1100': 1_000 });
    expect(await invoiceNow()).toMatchObject({ paidMinor: 18_500, adjustmentMinor: 500, balanceMinor: 1_000, insuranceHoldMinor: 0, status: 'PartiallyPaid' });
    expect((await payMobile(inv, 1_000, 'ins-pay-0003')).body.data.invoiceStatus).toBe('Paid');
    expect((await tb())['1100']).toBe(0);
  });

  it('a rejected claim returns everything to the patient and frees the invoice for a new claim', async () => {
    const inv2 = await invoice(['CONS-OPD']);
    const c2 = (await H.staff.bo!.c.post('/insurance/claims', { invoiceId: inv2, policyId: policy })).body.data.id;
    await H.staff.claims!.c.post(`/insurance/claims/${c2}/submit`);
    expect((await H.staff.claims!.c.post(`/insurance/claims/${c2}/respond`, { decision: 'reject', denialCode: 'missing-documents' })).status).toBe(400); // note required
    const r = await H.staff.claims!.c.post(`/insurance/claims/${c2}/respond`, { decision: 'reject', denialCode: 'missing-documents', note: 'Referral letter missing' });
    expect(r.body.data).toMatchObject({ status: 'Rejected', returnedToPatientMinor: 8_000 });
    expect(await tb()).toMatchObject({ '1110': 0, '1100': 10_000 });
    expect((await invoiceNow(inv2)).insuranceHoldMinor).toBe(0);
    expect((await H.staff.bo!.c.post('/insurance/claims', { invoiceId: inv2, policyId: policy })).status).toBe(201);
  });

  it('reports denials by reason and open receivable by age', async () => {
    const d = (await H.staff.fd!.c.get('/insurance/reports/denials')).body.data;
    expect(d).toEqual([
      { denialCode: 'missing-documents', claims: 1, deniedMinor: 8_000 },
      { denialCode: 'not-covered', claims: 1, deniedMinor: 1_000 },
    ]);
    expect((await H.staff.fd!.c.get('/insurance/reports/ageing')).body.data.openClaims).toBe(0);
  });
});
