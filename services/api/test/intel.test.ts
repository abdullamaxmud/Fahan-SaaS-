import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { localDate } from '../src/lib/time';
import { setupHospital, type Hospital } from './fixtures';
import { startHarness, type Harness } from './helpers';

/** Spec §5.29, §9.3, §9.4, §9.6: certified metrics, immutable snapshots, suppression, re-run consistency. */
let h: Harness;
let H: Hospital;
const period = localDate(new Date(), 'Africa/Mogadishu').slice(0, 7);
const pids: string[] = [];
const encs: string[] = [];
const dxIds: Record<string, string> = {};
let disease: { id: string; hash: string };

beforeAll(async () => {
  h = await startHarness();
  H = await setupHospital(h, [
    { key: 'reception', role: 'reception' },
    { key: 'doctor', role: 'physician' },
    { key: 'analyst', role: 'analyst' },
    { key: 'gov', role: 'clinical-governance' },
    { key: 'fd', role: 'finance-director' },
    { key: 'cashier', role: 'cashier' },
    { key: 'nurse', role: 'nurse' },
  ]);
  const rc = H.staff.reception!.c;
  const doc = H.staff.doctor!.c;
  const dobs = ['1960-01-01', '1975-05-05', '1988-08-08', '1995-02-02', '2001-03-03', '2015-06-06'];
  for (const [i, dob] of dobs.entries()) {
    const pid = (await rc.post('/patients', { branchId: H.branchId, givenName: `Bukaan${i}`, familyName: 'Tijaabo', dob })).body.data.id;
    pids.push(pid);
    const enc = (await rc.post('/appointments/walk-in', { patientId: pid, providerId: H.staff.doctor!.id, reason: 'Fever' })).body.data.encounterId;
    encs.push(enc);
    await doc.post(`/encounters/${enc}/diagnoses`, { code: '1F40', display: 'Malaria due to Plasmodium falciparum', certainty: 'confirmed', primary: true });
    if (i < 5) dxIds[`ca40-${i}`] = (await doc.post(`/encounters/${enc}/diagnoses`, { code: 'CA40', display: 'Pneumonia', certainty: 'suspected' })).body.data.id;
    if (i < 2) await doc.post(`/encounters/${enc}/diagnoses`, { code: 'BA00', display: 'Essential hypertension', certainty: 'confirmed' });
  }
  // A ruled-out condition is never counted, as confirmed or as suspected (spec §14.2).
  await doc.post(`/encounters/${encs[5]}/diagnoses`, { code: 'CA40', display: 'Pneumonia', certainty: 'ruled_out' });
  // The first patient comes back: a second confirmed visit is one more encounter, not one more patient.
  const again = (await rc.post('/appointments/walk-in', { patientId: pids[0], providerId: H.staff.doctor!.id, reason: 'Fever again' })).body.data.encounterId;
  await doc.post(`/encounters/${again}/diagnoses`, { code: '1F40', display: 'Malaria due to Plasmodium falciparum', certainty: 'confirmed', primary: true });
  // The last patient already had malaria confirmed last month, so they are not newly diagnosed.
  const tdb = h.data.tenant('fahan_t_hiil');
  const p6 = await tdb.collection('diagnoses').findOne({ code: '1F40' }, { sort: { recordedAt: -1 } });
  const lastMonth = new Date(Date.now() - 40 * 86_400_000);
  await tdb.collection('diagnoses').insertOne({ ...p6, _id: undefined, patientId: (await tdb.collection('patients').findOne({ 'names.given': 'Bukaan5' }))!._id, recordedAt: lastMonth });

  // A small amount of revenue for the finance snapshot.
  await H.staff.fd!.c.post('/billing/prices', { code: 'CONS-OPD', name: 'Outpatient consultation', category: 'consultation', priceMinor: 1_000, currency: 'USD' });
  await H.staff.cashier!.c.post('/billing/charges', { patientId: pids[0], serviceCode: 'CONS-OPD', quantity: 2 });
  const inv = (await H.staff.cashier!.c.post('/billing/invoices', { patientId: pids[0] })).body.data.id;
  await H.staff.cashier!.c.post(`/billing/invoices/${inv}/issue`);
  await H.staff.cashier!.c.post(`/billing/invoices/${inv}/payments`, { amountMinor: 1_500, method: 'mobile-money' }).set('Idempotency-Key', 'intel-pay-0001');
});
afterAll(async () => {
  await h?.stop();
});

describe('metric definitions', () => {
  it('are versioned and readable by intelligence roles only', async () => {
    const r = await H.staff.analyst!.c.get('/intel/metrics');
    expect(r.body.data.suppressionThreshold).toBe(5);
    expect(r.body.data.metrics.find((m: { id: string }) => m.id === 'fin.recognizedRevenue')).toMatchObject({ version: 'finance-v1', unit: 'minor' });
    expect((await H.staff.nurse!.c.get('/intel/metrics')).status).toBe(403);
  });
});

describe('disease snapshot (spec §9.3)', () => {
  it('counts unique patients, separates suspected, excludes ruled-out, and suppresses small cohorts', async () => {
    const r = await H.staff.analyst!.c.post('/intel/snapshots', { kind: 'disease', period });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    disease = { id: r.body.data.id, hash: r.body.data.hash };
    const rows = r.body.data.facts.rows as { code: string; confirmedPatients: number | null; confirmedEncounters: number | null; newPatients: number | null; suspectedPatients: number | null }[];
    expect(rows.find((x) => x.code === '1F40')).toMatchObject({ confirmedPatients: 6, confirmedEncounters: 7, newPatients: 5, suspectedPatients: 0 });
    expect(rows.find((x) => x.code === 'CA40')).toMatchObject({ confirmedPatients: 0, suspectedPatients: 5 });
    expect(rows.find((x) => x.code === 'BA00')).toMatchObject({ confirmedPatients: null, confirmedEncounters: null });
    expect(r.body.data.facts.suppressedCells).toBeGreaterThan(0);
    expect(JSON.stringify(r.body.data)).not.toMatch(/Bukaan|patientId/);
  });

  it('capturing again on unchanged data returns the same snapshot and numbers', async () => {
    const r = await H.staff.gov!.c.post('/intel/snapshots', { kind: 'disease', period });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ id: disease.id, hash: disease.hash, reused: true, seq: 1 });
    expect((await H.staff.analyst!.c.get(`/intel/snapshots/${disease.id}/verify`)).body.data).toMatchObject({ intact: true, matchesLiveData: true });
  });

  it('a late coding correction makes a new version; the old one stays as it was', async () => {
    await H.staff.doctor!.c.patch(`/encounters/${encs[0]}/diagnoses/${dxIds['ca40-0']}`, { certainty: 'confirmed', version: 1 });
    expect((await H.staff.analyst!.c.get(`/intel/snapshots/${disease.id}/verify`)).body.data).toMatchObject({ intact: true, matchesLiveData: false });
    const r = await H.staff.analyst!.c.post('/intel/snapshots', { kind: 'disease', period });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ seq: 2, supersedes: disease.id });
    const ca40 = r.body.data.facts.rows.find((x: { code: string }) => x.code === 'CA40');
    expect(ca40).toMatchObject({ confirmedPatients: null, suspectedPatients: null }); // 1 confirmed, 4 suspected: both suppressed
    const old = (await H.staff.analyst!.c.get(`/intel/snapshots/${disease.id}`)).body.data;
    expect(old.facts.rows.find((x: { code: string }) => x.code === 'CA40').suspectedPatients).toBe(5);
  });

  it('tampering with a stored snapshot is detected', async () => {
    const tdb = h.data.tenant('fahan_t_hiil');
    await tdb.collection('metric_snapshots').updateOne({ seq: 1, kind: 'disease' }, { $set: { 'facts.rows.0.confirmedPatients': 60 } });
    expect((await H.staff.analyst!.c.get(`/intel/snapshots/${disease.id}/verify`)).body.data.intact).toBe(false);
  });

  it('exports CSV with suppression marks for authorised roles, and the export is audited', async () => {
    const r = await H.staff.analyst!.c.get(`/intel/snapshots/${disease.id}/export.csv`);
    expect(r.headers['content-type']).toContain('text/csv');
    expect(r.text).toContain('BA00,Essential hypertension,<5,<5');
    expect((await H.staff.fd!.c.get(`/intel/snapshots/${disease.id}/export.csv`)).status).toBe(403);
    const trail = await H.admin.get('/audit/events?limit=100');
    expect(trail.status, JSON.stringify(trail.body)).toBe(200);
    expect(trail.body.data.some((e: { action: string; actorId: string }) => e.action === 'bi.snapshot.export' && e.actorId === H.staff.analyst!.id)).toBe(true);
  });
});

describe('finance and operations snapshots', () => {
  it('finance figures are the same numbers as the official accounting report (spec §5.30)', async () => {
    const snap = (await H.staff.fd!.c.post('/intel/snapshots', { kind: 'finance', period, currency: 'USD' })).body.data;
    const official = (await H.staff.fd!.c.get(`/accounting/summary?period=${period}&currency=USD`)).body.data;
    expect(snap.facts.metrics).toMatchObject({
      'fin.grossBilled': official.grossBilledMinor,
      'fin.cashCollected': official.cashCollectedMinor,
      'fin.recognizedRevenue': official.recognizedRevenueMinor,
      'fin.accountsReceivable': official.accountsReceivableMinor,
    });
    expect(snap.facts.metrics).toMatchObject({ 'fin.grossBilled': 2_000, 'fin.cashCollected': 1_500, 'fin.accountsReceivable': 500 });
    expect((await H.staff.gov!.c.post('/intel/snapshots', { kind: 'finance', period, currency: 'USD' })).status).toBe(403);
  });

  it('operations metrics count this month and mark what is not available', async () => {
    const r = await H.staff.analyst!.c.post('/intel/snapshots', { kind: 'operations', period });
    expect(r.body.data.facts.metrics['ops.opdVisits']).toBe(7);
    expect(r.body.data.facts.metrics['ops.qualityIncidents']).toBeNull();
    expect(r.body.data.facts.unavailable['ops.qualityIncidents']).toBeTruthy();
    const next = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 7);
    expect((await H.staff.analyst!.c.post('/intel/snapshots', { kind: 'operations', period: next })).status).toBe(400);
  });
});
