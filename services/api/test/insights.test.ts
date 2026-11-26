import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { localDate } from '../src/lib/time';
import { checkNarrative, type Fact } from '../src/modules/intel/narrative';
import { setupHospital, type Hospital } from './fixtures';
import { startHarness, type Harness } from './helpers';

/** Spec §5.30, §5.31, §9.6, §9.7: AI is read-only, numbers checked against facts, human review before release. */
let h: Harness;
let H: Hospital;
const period = localDate(new Date(), 'Africa/Mogadishu').slice(0, 7);
let finSnap: string;
let finInsight: string;

beforeAll(async () => {
  h = await startHarness();
  H = await setupHospital(h, [
    { key: 'reception', role: 'reception' },
    { key: 'doctor', role: 'physician' },
    { key: 'cashier', role: 'cashier' },
    { key: 'analyst', role: 'analyst' },
    { key: 'fa', role: 'finance-approver' },
    { key: 'fd', role: 'finance-director' },
    { key: 'cso', role: 'clinical-safety-officer' },
    { key: 'gov', role: 'clinical-governance' },
  ]);
  const rc = H.staff.reception!.c;
  const doc = H.staff.doctor!.c;
  for (let i = 0; i < 5; i++) {
    const pid = (await rc.post('/patients', { branchId: H.branchId, givenName: `Qof${i}`, familyName: 'Tijaabo', dob: `19${70 + i}-01-01` })).body.data.id;
    const enc = (await rc.post('/appointments/walk-in', { patientId: pid, providerId: H.staff.doctor!.id, reason: 'Fever' })).body.data.encounterId;
    await doc.post(`/encounters/${enc}/diagnoses`, { code: '1F40', display: 'Malaria due to Plasmodium falciparum', certainty: 'confirmed', primary: true });
    if (i < 2) await doc.post(`/encounters/${enc}/diagnoses`, { code: 'BA00', display: 'Essential hypertension', certainty: 'confirmed' });
    if (i === 0) {
      await H.staff.fd!.c.post('/billing/prices', { code: 'CONS-OPD', name: 'Outpatient consultation', category: 'consultation', priceMinor: 1_000, currency: 'USD' });
      await H.staff.fd!.c.post('/billing/prices', { code: 'LAB-CBC', name: 'Full blood count', category: 'laboratory', priceMinor: 1_200, currency: 'USD' });
      await H.staff.cashier!.c.post('/billing/charges', { patientId: pid, serviceCode: 'CONS-OPD', quantity: 1 });
      await H.staff.cashier!.c.post('/billing/charges', { patientId: pid, serviceCode: 'LAB-CBC', quantity: 1 });
      const inv = (await H.staff.cashier!.c.post('/billing/invoices', { patientId: pid })).body.data.id;
      await H.staff.cashier!.c.post(`/billing/invoices/${inv}/issue`);
      await H.staff.cashier!.c.post(`/billing/invoices/${inv}/payments`, { amountMinor: 2_200, method: 'mobile-money' }).set('Idempotency-Key', 'ins-pay-0001');
    }
  }
  finSnap = (await H.staff.fd!.c.post('/intel/snapshots', { kind: 'finance', period, currency: 'USD' })).body.data.id;
});
afterAll(async () => {
  await h?.stop();
});

describe('the number check', () => {
  const facts: Fact[] = [{ id: 'fin.recognizedRevenue', label: 'Recognised revenue', value: 2_200, unit: 'minor', currency: 'USD' }];
  it('passes text whose numbers are cited facts', () => {
    expect(checkNarrative({ provider: 't', template: 't', sections: [{ heading: 'x', sentences: [{ text: 'Revenue was $22.00.', cites: ['fin.recognizedRevenue'] }] }] }, facts, period, []).ok).toBe(true);
  });
  it('fails text with an invented number or an unknown metric', () => {
    const bad = checkNarrative({ provider: 't', template: 't', sections: [{ heading: 'x', sentences: [{ text: 'Revenue was $22.00, up 40% on last year.', cites: ['fin.recognizedRevenue', 'fin.madeUp'] }] }] }, facts, period, []);
    expect(bad.ok).toBe(false);
    expect(bad.unsupported[0]).toContain('40');
    expect(bad.uncited).toEqual(['fin.madeUp']);
  });
});

describe('financial intelligence (spec §5.30)', () => {
  it('the AI summary carries the official figures and the source period', async () => {
    expect((await H.staff.cashier!.c.post('/intel/insights', { snapshotId: finSnap })).status).toBe(403);
    const r = await H.staff.analyst!.c.post('/intel/insights', { snapshotId: finSnap });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const x = r.body.data;
    finInsight = x.id;
    expect(x).toMatchObject({ status: 'Generated', period, provider: 'fahan-template', template: 'finance-narrative-v1', check: { ok: true } });
    expect(x.disclosure).toMatch(/Written by AI/);
    const official = (await H.staff.fd!.c.get(`/accounting/summary?period=${period}&currency=USD`)).body.data;
    const fact = (k: string) => x.citedFacts.find((f: { id: string }) => f.id === k).value;
    expect(fact('fin.recognizedRevenue')).toBe(official.recognizedRevenueMinor);
    expect(fact('fin.cashCollected')).toBe(official.cashCollectedMinor);
    const text = x.sections.flatMap((s: { sentences: { text: string }[] }) => s.sentences.map((t) => t.text)).join(' ');
    expect(text).toContain('recognised revenue was $22.00');
    expect(text).toContain('laboratory revenue at $12.00, 54.5% of revenue');
  });

  it('is reviewed by finance and released by a second finance person; then it is frozen', async () => {
    expect((await H.staff.analyst!.c.post(`/intel/insights/${finInsight}/advance`)).status).toBe(403);
    expect((await H.staff.fa!.c.post(`/intel/insights/${finInsight}/advance`, { note: 'Figures agree with the ledger' })).body.data.status).toBe('Reviewed');
    expect((await H.staff.fa!.c.post(`/intel/insights/${finInsight}/advance`)).body.error.code).toBe('FOUR_EYES');
    expect((await H.staff.fd!.c.post(`/intel/insights/${finInsight}/advance`)).body.data.status).toBe('Published');
    expect((await H.staff.fd!.c.post(`/intel/insights/${finInsight}/advance`)).body.error.code).toBe('INVALID_TRANSITION');
    expect((await H.staff.fd!.c.post(`/intel/insights/${finInsight}/reject`, { note: 'Changed my mind' })).body.error.code).toBe('INVALID_TRANSITION');
    const hist = (await H.staff.analyst!.c.get(`/intel/insights/${finInsight}`)).body.data.history.map((e: { action: string }) => e.action);
    expect(hist).toEqual(['generated', 'reviewed', 'published']);
  });

  it('a reviewer can reject a draft with a reason', async () => {
    const id = (await H.staff.analyst!.c.post('/intel/insights', { snapshotId: finSnap })).body.data.id;
    expect((await H.staff.fa!.c.post(`/intel/insights/${id}/reject`, { note: 'Wait for the month to close' })).body.data.status).toBe('Rejected');
  });
});

describe('disease intelligence (spec §5.31)', () => {
  it('uses only unsuppressed counts, says what it is not, and is validated then reviewed by clinicians', async () => {
    const snap = (await H.staff.analyst!.c.post('/intel/snapshots', { kind: 'disease', period })).body.data.id;
    const x = (await H.staff.analyst!.c.post('/intel/insights', { snapshotId: snap })).body.data;
    expect(x.check.ok).toBe(true);
    const text = x.sections.flatMap((s: { sentences: { text: string }[] }) => s.sentences.map((t) => t.text)).join(' ');
    expect(text).toContain('Malaria due to Plasmodium falciparum (1F40) was confirmed in 5 patients');
    expect(text).toContain('not population prevalence');
    expect(text).not.toContain('BA00');
    expect(x.citedFacts.some((f: { id: string }) => f.id.startsWith('dis.BA00'))).toBe(false);
    expect((await H.staff.fd!.c.get(`/intel/insights/${x.id}`)).status).toBe(403);
    expect((await H.staff.cso!.c.post(`/intel/insights/${x.id}/advance`)).body.data.status).toBe('Validated');
    expect((await H.staff.cso!.c.post(`/intel/insights/${x.id}/advance`)).status).toBe(403);
    expect((await H.staff.gov!.c.post(`/intel/insights/${x.id}/advance`)).body.data.status).toBe('Reviewed');
  });
});

describe('integrity', () => {
  it('an insight whose source snapshot was altered cannot be released', async () => {
    const id = (await H.staff.analyst!.c.post('/intel/insights', { snapshotId: finSnap })).body.data.id;
    const tdb = h.data.tenant('fahan_t_hiil');
    const s = await tdb.collection('metric_snapshots').findOne({ kind: 'finance' });
    await tdb.collection('metric_snapshots').updateOne({ _id: s!._id }, { $set: { facts: { ...s!.facts, counts: { invoicesIssued: 99, payments: 0, refunds: 0 } } } });
    expect((await H.staff.fa!.c.post(`/intel/insights/${id}/advance`)).body.error.code).toBe('SNAPSHOT_TAMPERED');
    expect((await H.staff.analyst!.c.post('/intel/insights', { snapshotId: finSnap })).body.error.code).toBe('SNAPSHOT_TAMPERED');
  });
});
