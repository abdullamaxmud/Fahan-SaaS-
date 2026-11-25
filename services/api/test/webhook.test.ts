import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signPayload } from '../src/modules/billing/webhook';
import { setupHospital, type Hospital } from './fixtures';
import { startHarness, type Harness } from './helpers';

/** Spec §8.1 / §12.1: signed, fresh, idempotent provider callbacks; unmatched money parked for review. */
let h: Harness;
let H: Hospital;
const clock = new Date('2030-03-05T08:00:00Z');
let secret: string;
let invoiceNumber: string;
let invoiceId: string;

beforeAll(async () => {
  h = await startHarness();
  h.config.now = () => clock;
  H = await setupHospital(h, [
    { key: 'reception', role: 'reception' },
    { key: 'cashier', role: 'cashier' },
    { key: 'bo', role: 'billing-officer' },
    { key: 'fd', role: 'finance-director' },
  ]);
  const pid = (await H.staff.reception!.c.post('/patients', { branchId: H.branchId, givenName: 'Cumar', familyName: 'Xasan', dob: '1975-05-05' })).body.data.id;
  await H.staff.fd!.c.post('/billing/prices', { code: 'CONS-OPD', name: 'Outpatient consultation', category: 'consultation', priceMinor: 2_000, currency: 'USD' });
  await H.staff.cashier!.c.post('/billing/charges', { patientId: pid, serviceCode: 'CONS-OPD', quantity: 1 });
  invoiceId = (await H.staff.cashier!.c.post('/billing/invoices', { patientId: pid })).body.data.id;
  invoiceNumber = (await H.staff.cashier!.c.post(`/billing/invoices/${invoiceId}/issue`)).body.data.invoiceNumber;
});
afterAll(async () => {
  await h?.stop();
});

const now = () => String(Math.floor(clock.getTime() / 1000));
function send(body: object, opts: { ts?: string; key?: string; tenant?: string; provider?: string } = {}) {
  const raw = JSON.stringify(body);
  const ts = opts.ts ?? now();
  return supertest(h.app)
    .post(`/api/v1/webhooks/payments/${opts.tenant ?? 'hiil'}/${opts.provider ?? 'evc-plus'}`)
    .set('content-type', 'application/json')
    .set('x-fahan-timestamp', ts)
    .set('x-fahan-signature', signPayload(opts.key ?? secret, ts, raw))
    .send(raw);
}
const event = (transactionId: string, amountMinor: number, inv = invoiceNumber) => ({ eventId: `ev-${transactionId}`, transactionId, status: 'succeeded', invoiceNumber: inv, amountMinor, currency: 'USD', payer: '25261xxxx12' });

describe('provider registration', () => {
  it('only finance registers a provider; the secret is shown once', async () => {
    expect((await H.staff.bo!.c.post('/billing/providers', { provider: 'evc-plus' })).status).toBe(403);
    const r = await H.staff.fd!.c.post('/billing/providers', { provider: 'evc-plus' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    secret = r.body.data.secret;
    expect(secret.length).toBeGreaterThan(30);
    const list = await H.staff.bo!.c.get('/billing/providers');
    expect(JSON.stringify(list.body)).not.toContain(secret);
  });
});

describe('callbacks', () => {
  it('a wrong signature or stale timestamp is refused and nothing is paid', async () => {
    expect((await send(event('TX-0001', 500), { key: 'not-the-secret' })).status).toBe(401);
    expect((await send(event('TX-0001', 500), { ts: String(Number(now()) - 301) })).status).toBe(401);
    expect((await send(event('TX-0001', 500), { provider: 'zaad' })).status).toBe(401); // not registered
    expect((await send(event('TX-0001', 500), { tenant: 'nobody' })).status).toBe(404);
    expect((await H.staff.cashier!.c.get(`/billing/invoices/${invoiceId}`)).body.data.paidMinor).toBe(0);
  });

  it('a signed payment is applied once, however often the provider retries', async () => {
    const r = await send(event('TX-0001', 500));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ status: 'applied', receiptNo: 'RCT-2030-000001' });
    expect((await send(event('TX-0001', 500))).body.data).toEqual({ duplicate: true });
    const inv = (await H.staff.cashier!.c.get(`/billing/invoices/${invoiceId}`)).body.data;
    expect(inv).toMatchObject({ paidMinor: 500, balanceMinor: 1_500, status: 'PartiallyPaid' });
    expect(inv.payments).toHaveLength(1);
    const tb = (await H.staff.fd!.c.get('/accounting/trial-balance')).body.data.rows.find((x: { accountCode: string }) => x.accountCode === '1020');
    expect(tb.debitMinor).toBe(500);
  });

  it('money that matches nothing is parked for the billing officer', async () => {
    expect((await send(event('TX-0002', 99_999))).body.data).toMatchObject({ status: 'unmatched', reason: 'amount is more than the balance due' });
    expect((await send(event('TX-0003', 100, 'INV-2030-999999'))).body.data).toMatchObject({ status: 'unmatched', reason: 'invoice not found' });
    const parked = (await H.staff.bo!.c.get('/billing/payment-events?status=unmatched')).body.data;
    expect(parked.map((e: { transactionId: string }) => e.transactionId).sort()).toEqual(['TX-0002', 'TX-0003']);
    expect((await H.staff.cashier!.c.get(`/billing/invoices/${invoiceId}`)).body.data.paidMinor).toBe(500);
  });

  it('rotating the secret retires the old one', async () => {
    const old = secret;
    secret = (await H.staff.fd!.c.post('/billing/providers', { provider: 'evc-plus' })).body.data.secret;
    expect((await send(event('TX-0004', 100), { key: old })).status).toBe(401);
    expect((await send(event('TX-0004', 100))).body.data.status).toBe('applied');
  });
});
