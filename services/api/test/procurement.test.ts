import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupHospital, type Hospital } from './fixtures';
import { startHarness, type Harness } from './helpers';

/** Spec §5.23 / §6 procure-to-pay: approved order → goods receipt → 3-way matched invoice → payment, all on the ledger. */
let h: Harness;
let H: Hospital;
const clock = new Date('2030-05-06T08:00:00Z');
let store: string;
let gloves: string;
let syringes: string;
let supplier: string;
let po: string;
let matched: string;
let exception: string;

beforeAll(async () => {
  h = await startHarness();
  h.config.now = () => clock;
  H = await setupHospital(h, [
    { key: 'buyer', role: 'procurement' },
    { key: 'keeper', role: 'storekeeper' },
    { key: 'fd', role: 'finance-director' },
    { key: 'cashier', role: 'cashier' },
  ]);
  const k = H.staff.keeper!.c;
  store = (await k.post('/inventory/stores', { branchId: H.branchId, code: 'MAIN', name: 'Main store', kind: 'main' })).body.data.id;
  gloves = (await k.post('/inventory/items', { code: 'GLOVE-M', name: 'Exam gloves (M)', unit: 'box', kind: 'consumable' })).body.data.id;
  syringes = (await k.post('/inventory/items', { code: 'SYR-5', name: 'Syringe 5 ml', unit: 'each', kind: 'consumable' })).body.data.id;
});
afterAll(async () => {
  await h?.stop();
});

const tb = async () => {
  const d = (await H.staff.fd!.c.get('/accounting/trial-balance')).body.data;
  expect(d.balanced).toBe(true);
  return Object.fromEntries((d.rows as { accountCode: string; debitMinor: number; creditMinor: number }[]).map((r) => [r.accountCode, r.debitMinor - r.creditMinor]));
};
const invoice = (invoiceNo: string, quantity: number, unitPriceMinor = 250) => H.staff.buyer!.c.post('/procurement/supplier-invoices', { orderId: po, invoiceNo, invoiceDate: '2030-05-06', lines: [{ itemId: gloves, quantity, unitPriceMinor }] });

describe('purchase orders', () => {
  it('suppliers are registered once; cashiers have no procurement access', async () => {
    const r = await H.staff.buyer!.c.post('/procurement/suppliers', { code: 'MEDSUP', name: 'Medsup Trading', currency: 'USD', phone: '+252 61 000 0000' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    supplier = r.body.data.id;
    expect((await H.staff.buyer!.c.post('/procurement/suppliers', { code: 'MEDSUP', name: 'Again', currency: 'USD' })).body.error.code).toBe('SUPPLIER_EXISTS');
    expect((await H.staff.cashier!.c.get('/procurement/suppliers')).status).toBe(403);
  });

  it('an order is approved by someone else, within their limit', async () => {
    const r = await H.staff.buyer!.c.post('/procurement/orders', { supplierId: supplier, storeId: store, lines: [{ itemId: gloves, quantity: 100, unitPriceMinor: 250 }, { itemId: syringes, quantity: 200, unitPriceMinor: 100 }] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({ number: 'PO-2030-00001', totalMinor: 45_000, needsFinanceDirector: false });
    po = r.body.data.id;
    expect((await H.staff.keeper!.c.post(`/procurement/orders/${po}/receipts`, { lines: [{ itemId: gloves, quantity: 1, batch: 'G1', expiry: '2031-01-01' }] })).body.error.code).toBe('NOT_APPROVED');
    await H.staff.buyer!.c.post(`/procurement/orders/${po}/submit`);
    expect((await H.staff.buyer!.c.post(`/procurement/orders/${po}/approve`)).status).toBe(403);

    const own = (await H.staff.fd!.c.post('/procurement/orders', { supplierId: supplier, storeId: store, lines: [{ itemId: gloves, quantity: 2_000, unitPriceMinor: 250 }] })).body.data;
    expect(own.needsFinanceDirector).toBe(true);
    await H.staff.fd!.c.post(`/procurement/orders/${own.id}/submit`);
    expect((await H.staff.fd!.c.post(`/procurement/orders/${own.id}/approve`)).body.error.code).toBe('FOUR_EYES');

    expect((await H.staff.fd!.c.post(`/procurement/orders/${po}/approve`)).body.data.status).toBe('Approved');
  });
});

describe('receipt, match and payment', () => {
  it('a delivery adds stock and posts inventory against goods-received-not-invoiced', async () => {
    const r = await H.staff.keeper!.c.post(`/procurement/orders/${po}/receipts`, { lines: [{ itemId: gloves, quantity: 60, batch: 'G1', expiry: '2031-01-01' }], deliveryNote: 'DN-4411' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({ number: 'GRN-2030-00001', valueMinor: 15_000, orderStatus: 'PartiallyReceived' });
    expect(await tb()).toMatchObject({ '1200': 15_000, '2050': -15_000 });
    expect((await H.staff.keeper!.c.post(`/procurement/orders/${po}/receipts`, { lines: [{ itemId: gloves, quantity: 50, batch: 'G2', expiry: '2031-01-01' }] })).status).toBe(400);
  });

  it('an invoice for more than was received, or at another price, is an exception and posts nothing', async () => {
    const over = await invoice('SUP-001', 100);
    expect(over.body.data).toMatchObject({ status: 'Exception' });
    expect(over.body.data.exceptions[0]).toContain('received 60');
    exception = over.body.data.id;
    const price = await invoice('SUP-002', 60, 260);
    expect(price.body.data.exceptions[0]).toContain('ordered at 250');
    expect((await tb())['2000']).toBeUndefined();
  });

  it('a matched invoice moves the liability to payables; the same invoice number is refused', async () => {
    const r = await invoice('SUP-003', 60);
    expect(r.body.data).toMatchObject({ status: 'Matched', exceptions: [] });
    matched = r.body.data.id;
    expect(await tb()).toMatchObject({ '2050': 0, '2000': -15_000 });
    expect((await invoice('sup-003', 60)).body.error.code).toBe('DUPLICATE_SUPPLIER_INVOICE');
  });

  it('finance pays matched invoices only, once', async () => {
    expect((await H.staff.buyer!.c.post(`/procurement/supplier-invoices/${matched}/pay`, { reference: 'TRF-001' })).status).toBe(403);
    expect((await H.staff.fd!.c.post(`/procurement/supplier-invoices/${exception}/pay`, { reference: 'TRF-001' })).body.error.code).toBe('NOT_MATCHED');
    expect((await H.staff.fd!.c.post(`/procurement/supplier-invoices/${matched}/pay`, { reference: 'TRF-001' })).body.data.status).toBe('Paid');
    expect((await H.staff.fd!.c.post(`/procurement/supplier-invoices/${matched}/pay`, { reference: 'TRF-002' })).body.error.code).toBe('ALREADY_PAID');
    expect(await tb()).toMatchObject({ '2000': 0, '1010': -15_000, '1200': 15_000 });
  });

  it('the rest of the delivery completes the order', async () => {
    const r = await H.staff.keeper!.c.post(`/procurement/orders/${po}/receipts`, { lines: [{ itemId: gloves, quantity: 40, batch: 'G2', expiry: '2031-03-01' }, { itemId: syringes, quantity: 200, batch: 'S1', expiry: '2032-01-01' }] });
    expect(r.body.data).toMatchObject({ orderStatus: 'Received', valueMinor: 30_000 });
    const o = (await H.staff.buyer!.c.get(`/procurement/orders/${po}`)).body.data;
    expect(o.lines.map((l: { receivedQuantity: number; invoicedQuantity: number }) => `${l.receivedQuantity}/${l.invoicedQuantity}`)).toEqual(['100/60', '200/0']);
  });
});
