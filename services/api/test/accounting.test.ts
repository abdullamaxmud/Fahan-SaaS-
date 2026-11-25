import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupHospital, type Hospital } from './fixtures';
import { startHarness, type Harness } from './helpers';

/** Spec §4.3 / §5.20: balanced double entry, immutable postings, reversals, closed periods, segregation of duties. */
let h: Harness;
let H: Hospital;
let clock = new Date('2030-02-10T08:00:00Z');

beforeAll(async () => {
  h = await startHarness();
  h.config.now = () => clock;
  H = await setupHospital(h, [
    { key: 'acc', role: 'accountant' },
    { key: 'fd', role: 'finance-director' },
    { key: 'cashier', role: 'cashier' },
  ]);
});
afterAll(async () => {
  await h?.stop();
});

const journal = (postingDate: string, amount: number, memo = 'Generator diesel') => ({
  postingDate,
  currency: 'USD',
  memo,
  lines: [
    { accountCode: '5900', debitMinor: amount },
    { accountCode: '1010', creditMinor: amount },
  ],
});

describe('journals', () => {
  it('the default chart exists; cashiers cannot see the ledger', async () => {
    const acc = (await H.staff.acc!.c.get('/accounting/accounts')).body.data;
    expect(acc.find((a: { code: string }) => a.code === '1100').name).toBe('Accounts receivable — patients');
    expect((await H.staff.cashier!.c.get('/accounting/journals')).status).toBe(403);
  });

  it('unbalanced or one-sided entries are refused', async () => {
    const r = await H.staff.acc!.c.post('/accounting/journals', { ...journal('2030-01-15', 1000), lines: [{ accountCode: '5900', debitMinor: 1000 }, { accountCode: '1010', creditMinor: 900 }] });
    expect(r.body.error.code).toBe('UNBALANCED_ENTRY');
  });

  it('the preparer cannot approve their own journal (segregation of duties)', async () => {
    const d = (await H.staff.acc!.c.post('/accounting/journals', journal('2030-01-15', 12_500))).body.data.id;
    expect((await H.staff.acc!.c.post(`/accounting/journals/${d}/approve`)).status).toBe(403);
    const ok = await H.staff.fd!.c.post(`/accounting/journals/${d}/approve`);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const tb = (await H.staff.acc!.c.get('/accounting/trial-balance')).body.data;
    expect(tb).toMatchObject({ totalDebitMinor: 12_500, totalCreditMinor: 12_500, balanced: true });
  });
});

describe('reversals and periods', () => {
  it('a posting is corrected by reversal, never edited; it cannot be reversed twice', async () => {
    const je = (await H.staff.fd!.c.get('/accounting/journals')).body.data[0];
    const r = await H.staff.fd!.c.post(`/accounting/journals/${je.id}/reverse`, { reason: 'Wrong account used' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await H.staff.fd!.c.post(`/accounting/journals/${je.id}/reverse`, { reason: 'again again' })).body.error.code).toBe('ALREADY_REVERSED');
    const list = (await H.staff.fd!.c.get('/accounting/journals')).body.data;
    expect(list.map((x: { state: string; reversalOf: string | null }) => `${x.state}:${x.reversalOf ? 'reversal' : 'original'}`).sort()).toEqual(['posted:reversal', 'reversed:original']);
  });

  it('closing January locks it; nothing more can be posted there', async () => {
    expect((await H.staff.acc!.c.post('/accounting/periods/2030-01/close')).status).toBe(403);
    expect((await H.staff.fd!.c.post('/accounting/periods/2030-02/close')).status).toBe(400); // current month
    expect((await H.staff.fd!.c.post('/accounting/periods/2030-01/close')).status).toBe(200);
    const d = (await H.staff.acc!.c.post('/accounting/journals', journal('2030-01-20', 500, 'Late January invoice'))).body.data.id;
    expect((await H.staff.fd!.c.post(`/accounting/journals/${d}/approve`)).body.error.code).toBe('PERIOD_CLOSED');
    expect((await H.staff.fd!.c.post('/accounting/periods/2030-01/close')).body.error.code).toBe('PERIOD_CLOSED');
  });

  it('a reversal lands in the open period; the closed month keeps its original figures', async () => {
    const jan = (await H.staff.fd!.c.get('/accounting/summary?period=2030-01&currency=USD')).body.data;
    expect(jan).toMatchObject({ operatingExpensesMinor: 12_500, recognizedRevenueMinor: 0, cashCollectedMinor: 0, metricVersion: 'finance-v1' });
    const feb = (await H.staff.fd!.c.get('/accounting/summary?period=2030-02&currency=USD')).body.data;
    expect(feb.operatingExpensesMinor).toBe(-12_500);
  });
});
