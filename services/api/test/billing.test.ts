import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupHospital, type Hospital } from './fixtures';
import { startHarness, type Harness } from './helpers';

/** Spec §5.19 / §6 revenue cycle: charge → invoice → payment → receipt → ledger → reconciliation; refunds by separate approval. */
let h: Harness;
let H: Hospital;
const clock = new Date('2030-03-05T08:00:00Z');
let pid: string;
let inv: string;
let bigRefund: string;

beforeAll(async () => {
  h = await startHarness();
  h.config.now = () => clock;
  H = await setupHospital(h, [
    { key: 'reception', role: 'reception' },
    { key: 'cashier', role: 'cashier' },
    { key: 'bo', role: 'billing-officer' },
    { key: 'fd', role: 'finance-director' },
    { key: 'auditor', role: 'security-auditor' },
  ]);
  pid = (await H.staff.reception!.c.post('/patients', { branchId: H.branchId, givenName: 'Sahra', familyName: 'Cabdi Nuur', dob: '1988-07-01' })).body.data.id;
});
afterAll(async () => {
  await h?.stop();
});

const tb = async () => {
  const rows = (await H.staff.fd!.c.get('/accounting/trial-balance')).body.data.rows as { accountCode: string; debitMinor: number; creditMinor: number }[];
  return Object.fromEntries(rows.map((r) => [r.accountCode, r.debitMinor - r.creditMinor]));
};
const pay = (key: string | null, amountMinor: number, method = 'cash') => {
  const q = H.staff.cashier!.c.post(`/billing/invoices/${inv}/payments`, { amountMinor, method });
  return key ? q.set('Idempotency-Key', key) : q;
};

describe('prices, charges and invoices', () => {
  it('only finance sets prices; a new price is a new version', async () => {
    expect((await H.staff.bo!.c.post('/billing/prices', { code: 'CONS-GP', name: 'GP consultation', category: 'consultation', priceMinor: 1, currency: 'USD' })).status).toBe(403);
    await H.staff.fd!.c.post('/billing/prices', { code: 'CONS-GP', name: 'GP consultation', category: 'consultation', priceMinor: 12_000, currency: 'USD' });
    const v2 = await H.staff.fd!.c.post('/billing/prices', { code: 'CONS-GP', name: 'GP consultation', category: 'consultation', priceMinor: 15_000, currency: 'USD' });
    expect(v2.body.data.version).toBe(2);
    await H.staff.fd!.c.post('/billing/prices', { code: 'LAB-CBC', name: 'Full blood count', category: 'laboratory', priceMinor: 4_000, currency: 'USD' });
    const list = (await H.staff.cashier!.c.get('/billing/prices')).body.data;
    expect(list.map((p: { code: string; priceMinor: number }) => `${p.code}:${p.priceMinor}`)).toEqual(['CONS-GP:15000', 'LAB-CBC:4000']);
  });

  it('charges snapshot the current price; unknown services are refused', async () => {
    const c = H.staff.cashier!.c;
    expect((await c.post('/billing/charges', { patientId: pid, serviceCode: 'NOPE', quantity: 1 })).status).toBe(400);
    expect((await c.post('/billing/charges', { patientId: pid, serviceCode: 'CONS-GP', quantity: 1 })).status).toBe(201);
    expect((await c.post('/billing/charges', { patientId: pid, serviceCode: 'LAB-CBC', quantity: 2 })).status).toBe(201);
    const ch = (await c.get(`/billing/charges?patientId=${pid}`)).body.data;
    expect(ch.map((x: { unitPriceMinor: number }) => x.unitPriceMinor).sort()).toEqual([15_000, 4_000]);
  });

  it('a charge goes on one invoice only', async () => {
    const r = await H.staff.cashier!.c.post('/billing/invoices', { patientId: pid });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({ subtotalMinor: 23_000, status: 'Draft' });
    inv = r.body.data.id;
    expect((await H.staff.cashier!.c.post('/billing/invoices', { patientId: pid })).status).toBe(400);
  });

  it('discounts over 10% need finance; a smaller one the billing officer applies', async () => {
    expect((await H.staff.cashier!.c.post(`/billing/invoices/${inv}/discount`, { amountMinor: 1_000, reason: 'Staff family' })).status).toBe(403);
    expect((await H.staff.bo!.c.post(`/billing/invoices/${inv}/discount`, { amountMinor: 5_000, reason: 'Hardship case' })).status).toBe(403);
    const ok = await H.staff.bo!.c.post(`/billing/invoices/${inv}/discount`, { amountMinor: 2_000, reason: 'Hardship case' });
    expect(ok.body.data.totalMinor).toBe(21_000);
  });

  it('issuing posts receivable and revenue by service category', async () => {
    const r = await H.staff.cashier!.c.post(`/billing/invoices/${inv}/issue`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.invoiceNumber).toBe('INV-2030-000001');
    expect(await tb()).toMatchObject({ '1100': 21_000, '4900': 2_000, '4000': -15_000, '4010': -8_000 });
    expect((await H.staff.cashier!.c.post(`/billing/invoices/${inv}/discount`, { amountMinor: 100, reason: 'too late now' })).status).toBe(403);
  });
});

describe('payments', () => {
  it('needs an Idempotency-Key, and cash needs an open till', async () => {
    expect((await pay(null, 1_000)).status).toBe(400);
    expect((await pay('k-cash-0001', 1_000)).body.error.code).toBe('NO_SESSION');
    expect((await H.staff.cashier!.c.post('/billing/cashier/open', { currency: 'USD', openingFloatMinor: 10_000 })).status).toBe(201);
    expect((await H.staff.cashier!.c.post('/billing/cashier/open', { currency: 'USD', openingFloatMinor: 0 })).body.error.code).toBe('SESSION_OPEN');
  });

  it('a replayed payment returns the same receipt and posts nothing twice', async () => {
    const first = await pay('k-cash-0001', 10_000);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.data).toMatchObject({ receiptNo: 'RCT-2030-000001', invoiceStatus: 'PartiallyPaid', balanceMinor: 11_000 });
    const again = await pay('k-cash-0001', 10_000);
    expect(again.body.data).toMatchObject({ receiptNo: 'RCT-2030-000001', replay: true });
    expect(await tb()).toMatchObject({ '1000': 10_000, '1100': 11_000 });
  });

  it('overpayment is refused; the balance settles the invoice', async () => {
    expect((await pay('k-mm-0002', 50_000, 'mobile-money')).body.error.code).toBe('OVERPAYMENT');
    const r = await pay('k-mm-0003', 11_000, 'mobile-money');
    expect(r.body.data).toMatchObject({ invoiceStatus: 'Paid', balanceMinor: 0 });
    expect((await H.staff.bo!.c.post(`/billing/invoices/${inv}/void`, { reason: 'Changed my mind' })).body.error.code).toBe('HAS_PAYMENTS');
  });
});

describe('refunds', () => {
  it('a refund above threshold is rejected without authorised approval and preserved in audit', async () => {
    const r = await H.staff.cashier!.c.post(`/billing/invoices/${inv}/refunds`, { amountMinor: 6_000, method: 'cash', reason: 'Lab test not done' });
    expect(r.body.data).toMatchObject({ status: 'Requested', needsFinanceDirector: true });
    bigRefund = r.body.data.id;
    expect((await H.staff.cashier!.c.post(`/billing/refunds/${bigRefund}/approve`)).status).toBe(403);
    const bo = await H.staff.bo!.c.post(`/billing/refunds/${bigRefund}/approve`);
    expect(bo.status).toBe(403);
    const trail = await H.staff.auditor!.c.get('/audit/events?limit=100');
    expect(trail.status, JSON.stringify(trail.body)).toBe(200);
    const ev = trail.body.data;
    expect(ev.some((e: { outcome: string; resource: string; actorId: string }) => e.outcome === 'deny' && e.resource === `refund:${bigRefund}` && e.actorId === H.staff.bo!.id)).toBe(true);
    const ok = await H.staff.fd!.c.post(`/billing/refunds/${bigRefund}/approve`);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await H.staff.fd!.c.post(`/billing/refunds/${bigRefund}/approve`)).body.error.code).toBe('INVALID_TRANSITION');
  });

  it('nobody approves their own refund, and no more than was paid comes back', async () => {
    const small = (await H.staff.bo!.c.post(`/billing/invoices/${inv}/refunds`, { amountMinor: 1_000, method: 'mobile-money', reason: 'Duplicate visit' })).body.data.id;
    expect((await H.staff.bo!.c.post(`/billing/refunds/${small}/approve`)).body.error.code).toBe('FOUR_EYES');
    expect((await H.staff.cashier!.c.post(`/billing/invoices/${inv}/refunds`, { amountMinor: 20_000, method: 'cash', reason: 'Everything back' })).status).toBe(400);
    expect((await H.staff.fd!.c.post(`/billing/refunds/${small}/reject`, { reason: 'Visit did happen' })).body.data.status).toBe('Rejected');
    expect(await tb()).toMatchObject({ '1000': 4_000, '4910': 6_000 });
  });
});

describe('till close and finance figures', () => {
  it('a short till waits for the finance director, never the cashier', async () => {
    const c = await H.staff.cashier!.c.post('/billing/cashier/close', { countedCashMinor: 13_900 });
    expect(c.body.data).toMatchObject({ status: 'pending-approval', expectedCashMinor: 14_000, discrepancyMinor: -100 });
    const sid = c.body.data.id;
    expect((await H.staff.bo!.c.post(`/billing/cashier/${sid}/approve`, { reason: 'Coin miscount' })).status).toBe(403);
    expect((await H.staff.fd!.c.post(`/billing/cashier/${sid}/approve`, { reason: 'Coin miscount' })).body.data.status).toBe('closed');
  });

  it('billed, recognised and collected are separate numbers', async () => {
    const s = (await H.staff.fd!.c.get('/accounting/summary?period=2030-03&currency=USD')).body.data;
    expect(s).toMatchObject({ grossBilledMinor: 23_000, netBilledMinor: 21_000, cashCollectedMinor: 15_000, accountsReceivableMinor: 0, recognizedRevenueMinor: 15_000 });
    expect((await H.staff.fd!.c.get('/accounting/trial-balance')).body.data.balanced).toBe(true);
  });

  it('voiding an unpaid invoice reverses its posting and frees the charges', async () => {
    await H.staff.cashier!.c.post('/billing/charges', { patientId: pid, serviceCode: 'CONS-GP', quantity: 1 });
    const id = (await H.staff.cashier!.c.post('/billing/invoices', { patientId: pid })).body.data.id;
    await H.staff.cashier!.c.post(`/billing/invoices/${id}/issue`);
    expect((await tb())['1100']).toBe(15_000);
    expect((await H.staff.bo!.c.post(`/billing/invoices/${id}/void`, { reason: 'Wrong patient selected' })).body.data.status).toBe('Voided');
    expect((await tb())['1100']).toBe(0);
    expect((await H.staff.cashier!.c.get(`/billing/charges?patientId=${pid}&status=unbilled`)).body.data).toHaveLength(1);
  });
});
