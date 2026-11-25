import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupHospital, type Hospital } from './fixtures';
import { startHarness, type Harness } from './helpers';

/** Spec §4.2, §5.14 and §6 "Prescription & dispensing". */
let h: Harness;
let H: Hospital;
let enc = '';
let pid = '';
let store = '';
let amox = '';
let pcm = '';
const clock = new Date('2030-01-07T05:00:00Z');

beforeAll(async () => {
  h = await startHarness();
  h.config.now = () => clock;
  H = await setupHospital(h, [
    { key: 'reception', role: 'reception' },
    { key: 'doctor', role: 'physician' },
    { key: 'nurse', role: 'nurse' },
    { key: 'pharm', role: 'pharmacist' },
    { key: 'pharm2', role: 'pharmacist' },
    { key: 'keeper', role: 'storekeeper' },
    { key: 'cashier', role: 'cashier' },
  ]);
  const rc = H.staff.reception!.c;
  pid = (await rc.post('/patients', { branchId: H.branchId, givenName: 'Ismaaciil', familyName: 'Warsame', dob: '1961-02-10' })).body.data.id;
  enc = (await rc.post('/appointments/walk-in', { patientId: pid, providerId: H.staff.doctor!.id, reason: 'Cough and fever' })).body.data.encounterId;
  await H.staff.doctor!.c.post(`/encounters/${enc}/care-team`, { userId: H.staff.nurse!.id });
  await H.staff.doctor!.c.post(`/patients/${pid}/allergies`, { substance: 'Penicillin', category: 'drug', severity: 'severe', verification: 'confirmed' });
  const k = H.staff.keeper!.c;
  store = (await k.post('/inventory/stores', { branchId: H.branchId, code: 'PHARM', name: 'Main pharmacy', kind: 'pharmacy' })).body.data.id;
  amox = (await k.post('/inventory/items', { code: 'AMOX500', name: 'Amoxicillin 500 mg capsule', unit: 'capsule', kind: 'medicine', medicine: { ingredient: 'amoxicillin', strength: '500 mg', form: 'capsule', route: 'oral', classes: ['penicillin', 'beta-lactam'] } })).body.data.id;
  pcm = (await k.post('/inventory/items', { code: 'PCM500', name: 'Paracetamol 500 mg tablet', unit: 'tablet', kind: 'medicine', medicine: { ingredient: 'paracetamol', strength: '500 mg', form: 'tablet', route: 'oral' } })).body.data.id;
  await k.post('/inventory/receive', { storeId: store, itemId: pcm, batch: 'P-OLD', expiry: '2030-02-01', quantity: 10 });
  await k.post('/inventory/receive', { storeId: store, itemId: pcm, batch: 'P-NEW', expiry: '2031-01-01', quantity: 100 });
});
afterAll(async () => {
  await h?.stop();
});

const rx = (itemId: string, quantity = 12) => H.staff.doctor!.c.post('/pharmacy/prescriptions', { encounterId: enc, itemId, dose: '1 tablet', frequency: 'qid', durationDays: 3, quantity });

describe('prescribing safety', () => {
  it('a drug class allergy blocks signing until the prescriber gives a reason', async () => {
    const d = (await rx(amox, 21)).body.data.id;
    const s = await H.staff.doctor!.c.post(`/pharmacy/prescriptions/${d}/sign`, {});
    expect(s.body.error.code).toBe('ALLERGY_CONFLICT');
    expect(s.body.error.details[0].message).toBe('Allergy to Penicillin (severe)');
    expect((await H.staff.doctor!.c.post(`/pharmacy/prescriptions/${d}/sign`, { overrideReason: 'short' })).status).toBe(400);
    await H.staff.doctor!.c.post(`/pharmacy/prescriptions/${d}/cancel`, { reason: 'Changed to non-penicillin' });
  });

  it('nurses cannot prescribe; only the prescriber signs; duplicates are flagged', async () => {
    expect((await H.staff.nurse!.c.post('/pharmacy/prescriptions', { encounterId: enc, itemId: pcm, dose: '1', frequency: 'qid', durationDays: 3, quantity: 12 })).status).toBe(403);
    const d = (await rx(pcm)).body.data.id;
    expect((await H.staff.pharm!.c.post(`/pharmacy/prescriptions/${d}/sign`, {})).status).toBe(403);
    expect((await H.staff.doctor!.c.post(`/pharmacy/prescriptions/${d}/sign`, {})).body.data).toMatchObject({ status: 'Signed', overridden: false });
    const dup = (await rx(pcm)).body.data.id;
    expect((await H.staff.doctor!.c.post(`/pharmacy/prescriptions/${dup}/sign`, {})).body.error.code).toBe('DUPLICATE_THERAPY');
    await H.staff.doctor!.c.post(`/pharmacy/prescriptions/${dup}/cancel`, { reason: 'Duplicate' });
  });
});

describe('verification and dispensing', () => {
  let d = '';
  beforeAll(async () => {
    d = (await H.staff.pharm!.c.get('/pharmacy/queue')).body.data.find((x: { status: string }) => x.status === 'Signed').id;
  });

  it('cannot dispense before verification; the doctor cannot see the pharmacy queue', async () => {
    expect((await H.staff.doctor!.c.get('/pharmacy/queue')).status).toBe(403);
    const r = await H.staff.pharm!.c.post(`/pharmacy/prescriptions/${d}/dispense`, { storeId: store });
    expect(r.status).toBe(400); // no Idempotency-Key
    const r2 = await H.staff.pharm!.c.agent.post(`/api/v1/pharmacy/prescriptions/${d}/dispense`).set('x-csrf-token', H.staff.pharm!.c.csrf).set('Idempotency-Key', 'try-before-verify').send({ storeId: store });
    expect(r2.body.error.code).toBe('NOT_VERIFIED');
    expect((await H.staff.pharm!.c.post(`/pharmacy/prescriptions/${d}/verify`)).status).toBe(200);
  });

  it('dispensing takes the earliest-expiring batch; a replay with the same key takes nothing more', async () => {
    const p = H.staff.pharm!.c;
    const send = (key: string) => p.agent.post(`/api/v1/pharmacy/prescriptions/${d}/dispense`).set('x-csrf-token', p.csrf).set('Idempotency-Key', key).send({ storeId: store });
    const [a, b] = await Promise.all([send('disp-0001-abc'), send('disp-0001-abc')]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const first = a.body.data.replay ? b : a;
    expect(first.body.data.lots.map((l: { batch: string; quantity: number }) => `${l.batch}:${l.quantity}`)).toEqual(['P-OLD:10', 'P-NEW:2']);
    expect([a.body.data.replay, b.body.data.replay].filter(Boolean)).toHaveLength(1);
    const stock = (await H.staff.keeper!.c.get(`/inventory/stock?storeId=${store}`)).body.data.find((x: { code: string }) => x.code === 'PCM500');
    expect(stock.usable).toBe(98);
    expect((await send('disp-0002-xyz')).body.error.code).toBe('NOT_VERIFIED');
  });

  it('nurses chart each dose; held or refused doses need a reason', async () => {
    const n = H.staff.nurse!.c;
    expect((await n.post(`/pharmacy/prescriptions/${d}/administrations`, { status: 'given', doseGiven: '500 mg' })).status).toBe(201);
    expect((await n.post(`/pharmacy/prescriptions/${d}/administrations`, { status: 'held' })).status).toBe(400);
    expect((await n.post(`/pharmacy/prescriptions/${d}/administrations`, { status: 'held', reason: 'Temperature 36.8, PRN not needed' })).status).toBe(201);
    expect((await n.get(`/pharmacy/prescriptions/${d}/administrations`)).body.data).toHaveLength(2);
  });

  it('unused medicine returns to stock, never more than was dispensed', async () => {
    const p = H.staff.pharm!.c;
    expect((await p.post(`/pharmacy/prescriptions/${d}/return`, { quantity: 50, reason: 'Too many' })).status).toBe(400);
    expect((await p.post(`/pharmacy/prescriptions/${d}/return`, { quantity: 4, reason: 'Course stopped early' })).body.data.returned).toBe(4);
    const stock = (await H.staff.keeper!.c.get(`/inventory/stock?storeId=${store}`)).body.data.find((x: { code: string }) => x.code === 'PCM500');
    expect(stock.usable).toBe(102);
  });

  it('cashier cannot see prescriptions', async () => {
    expect((await H.staff.cashier!.c.get(`/pharmacy/prescriptions?encounterId=${enc}`)).status).toBe(403);
  });
});
