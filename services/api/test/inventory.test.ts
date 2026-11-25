import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupHospital, type Hospital } from './fixtures';
import { startHarness, type Harness } from './helpers';

/** Spec §5.15: batches and expiry, transfers, first-expiry-first-out, never negative under concurrency. */
let h: Harness;
let H: Hospital;
let main = '';
let pharmacy = '';
let amox = '';
const clock = new Date('2030-01-07T05:00:00Z');

beforeAll(async () => {
  h = await startHarness();
  h.config.now = () => clock;
  H = await setupHospital(h, [
    { key: 'store', role: 'storekeeper' },
    { key: 'pharm', role: 'pharmacist' },
    { key: 'cashier', role: 'cashier' },
    { key: 'other', role: 'storekeeper', branch: 2 },
  ]);
  const s = H.staff.store!.c;
  main = (await s.post('/inventory/stores', { branchId: H.branchId, code: 'MAIN', name: 'Main store', kind: 'main' })).body.data.id;
  pharmacy = (await s.post('/inventory/stores', { branchId: H.branchId, code: 'PHARM', name: 'Main pharmacy', kind: 'pharmacy' })).body.data.id;
  amox = (await s.post('/inventory/items', { code: 'AMOX500', name: 'Amoxicillin 500 mg capsule', unit: 'capsule', kind: 'medicine', reorderLevel: 100, medicine: { ingredient: 'amoxicillin', strength: '500 mg', form: 'capsule', route: 'oral', classes: ['penicillin', 'beta-lactam'] } })).body.data.id;
});
afterAll(async () => {
  await h?.stop();
});

describe('receiving and catalogue', () => {
  it('medicines need structured details', async () => {
    expect((await H.staff.store!.c.post('/inventory/items', { code: 'X1', name: 'Mystery', unit: 'tab', kind: 'medicine' })).status).toBe(400);
  });

  it('receives batches with expiry; expired stock is refused; batch expiry cannot change', async () => {
    const s = H.staff.store!.c;
    expect((await s.post('/inventory/receive', { storeId: main, itemId: amox, batch: 'OLD', expiry: '2029-12-31', quantity: 10 })).status).toBe(400);
    expect((await s.post('/inventory/receive', { storeId: main, itemId: amox, batch: 'A1', expiry: '2030-03-01', quantity: 40 })).status).toBe(201);
    expect((await s.post('/inventory/receive', { storeId: main, itemId: amox, batch: 'B2', expiry: '2031-01-01', quantity: 200 })).status).toBe(201);
    expect((await s.post('/inventory/receive', { storeId: main, itemId: amox, batch: 'A1', expiry: '2030-06-01', quantity: 5 })).body.error.code).toBe('BATCH_EXPIRY_MISMATCH');
    const stock = (await s.get(`/inventory/stock?storeId=${main}`)).body.data[0];
    expect(stock).toMatchObject({ usable: 240, low: false });
    expect(stock.lots.map((l: { batch: string; status: string }) => `${l.batch}:${l.status}`)).toEqual(['A1:expiring', 'B2:ok']);
  });
});

describe('moving stock', () => {
  it('transfers first-expiry-first-out into the pharmacy', async () => {
    const r = await H.staff.store!.c.post('/inventory/transfer', { fromStoreId: main, toStoreId: pharmacy, itemId: amox, quantity: 50 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.moved.map((m: { batch: string; quantity: number }) => `${m.batch}:${m.quantity}`)).toEqual(['A1:40', 'B2:10']);
    const ph = (await H.staff.pharm!.c.get(`/inventory/stock?storeId=${pharmacy}`)).body.data[0];
    expect(ph).toMatchObject({ usable: 50, low: true });
  });

  it('two people cannot take the last stock at the same time', async () => {
    const p = H.staff.pharm!.c;
    const [x, y] = await Promise.all([
      p.post('/inventory/issue', { storeId: pharmacy, itemId: amox, quantity: 30, reason: 'Ward 3B top-up' }),
      p.post('/inventory/issue', { storeId: pharmacy, itemId: amox, quantity: 30, reason: 'Ward 4A top-up' }),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    const lost = x.status === 409 ? x : y;
    expect(lost.body.error).toMatchObject({ code: 'INSUFFICIENT_STOCK', available: 20 });
    expect((await p.get(`/inventory/stock?storeId=${pharmacy}`)).body.data[0].usable).toBe(20);
  });

  it('adjustments cannot go below zero and every movement is recorded', async () => {
    const p = H.staff.pharm!.c;
    const lot = (await p.get(`/inventory/stock?storeId=${pharmacy}`)).body.data[0].lots[0];
    expect((await p.post('/inventory/adjust', { lotId: lot.id, delta: -999, reason: 'Stock count' })).body.error.code).toBe('INSUFFICIENT_STOCK');
    expect((await p.post('/inventory/adjust', { lotId: lot.id, delta: -2, reason: 'Two capsules damaged' })).status).toBe(200);
    const moves = (await p.get(`/inventory/movements?itemId=${amox}&storeId=${pharmacy}`)).body.data;
    expect(moves.map((m: { type: string }) => m.type).sort()).toEqual(['adjust', 'issue', 'transfer-in', 'transfer-in']);
  });
});

describe('access', () => {
  it('another branch cannot use this branch store; cashier has no inventory access', async () => {
    expect((await H.staff.other!.c.get(`/inventory/stock?storeId=${main}`)).status).toBe(403);
    expect((await H.staff.cashier!.c.get('/inventory/items')).status).toBe(403);
  });
});
