import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCsv } from '../src/modules/migrations/routes';
import { setupHospital, type Hospital } from './fixtures';
import { startHarness, type Harness } from './helpers';

/** Spec §15 Phase 7 "data migration with verification": dry run, duplicates, four-eyes commit, reconciliation, rollback. */
let h: Harness;
let H: Hospital;
let batch: string;
const next = new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10);

const chunk1 = `legacy_id,given_name,middle_name,family_name,dob,sex,phone
H-1001,Asha,,Warsame,1985-04-11,F,061 555 1001
H-1002,Hassan,Abdi,"Nuur Hassan",14/02/1972,M,"+252 61 555 1002"
H-1003,Nimco,,Farah,2012-02-14,f,
H-1004,Bad,,Date,31/02/1990,M,
H-1005,Future,,Baby,${next},F,`;
const chunk2 = `legacy_id,given_name,middle_name,family_name,dob,sex,phone
H-1006,Odd,,Sex,1990-01-01,X,
H-1007,NoSurname,,,1990-01-01,M,
H-1001,Again,,Repeat,1990-01-01,M,
H-1008,Faadumo,,Cali,1992-03-14,F,
H-1009,Bile,,Osman,1990-12-08,M,
H-1010,Bile,,Osman,1990-12-08,M,`;

beforeAll(async () => {
  h = await startHarness();
  H = await setupHospital(h, [
    { key: 'rec1', role: 'records-officer' },
    { key: 'rec2', role: 'records-officer' },
    { key: 'reception', role: 'reception' },
    { key: 'doctor', role: 'physician' },
  ]);
  // Already in the patient index: the legacy row H-1008 is the same person.
  await H.staff.reception!.c.post('/patients', { branchId: H.branchId, givenName: 'Faadumo', familyName: 'Cali', dob: '1992-03-14' });
});
afterAll(async () => {
  await h?.stop();
});

describe('loading', () => {
  it('the CSV reader handles quotes, doubled quotes and line endings', () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\n')).toEqual([['a', 'b'], ['x, y', 'say "hi"']]);
  });

  it('only records officers load batches; the header is checked', async () => {
    expect((await H.staff.reception!.c.post('/migrations/batches', { source: 'legacy-his', branchId: H.branchId })).status).toBe(403);
    const b = await H.staff.rec1!.c.post('/migrations/batches', { source: 'legacy-his', branchId: H.branchId });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    batch = b.body.data.id;
    expect((await H.staff.rec1!.c.post(`/migrations/batches/${batch}/rows`, { csv: 'id,name\n1,x' })).status).toBe(400);
    expect((await H.staff.rec1!.c.post(`/migrations/batches/${batch}/rows`, { csv: chunk1 })).body.data.added).toBe(5);
    expect((await H.staff.rec1!.c.post(`/migrations/batches/${batch}/rows`, { csv: chunk2 })).body.data.counts.total).toBe(11);
  });
});

describe('dry run', () => {
  it('finds bad dates, unknown codes, missing names, repeated ids and likely duplicates — writing nothing', async () => {
    const before = (await H.staff.reception!.c.get('/patients')).body.data.length;
    const v = await H.staff.rec1!.c.post(`/migrations/batches/${batch}/validate`);
    expect(v.body.data.counts).toMatchObject({ total: 11, ok: 4, error: 5, duplicate: 2 });
    expect((await H.staff.reception!.c.get('/patients')).body.data.length).toBe(before);
    const errs = (await H.staff.rec1!.c.get(`/migrations/batches/${batch}/rows?status=error`)).body.data as { raw: { legacy_id: string }; errors: string[] }[];
    const why = Object.fromEntries(errs.map((e) => [e.raw.legacy_id, e.errors.join('; ')]));
    expect(why['H-1004']).toMatch(/not a real date/);
    expect(why['H-1005']).toMatch(/future/);
    expect(why['H-1006']).toMatch(/sex/);
    expect(why['H-1007']).toMatch(/family_name/);
    expect(errs.find((e) => e.raw.legacy_id === 'H-1001' && /repeats row 1/.test(e.errors.join()))).toBeTruthy();
  });
});

describe('commit and reconciliation', () => {
  it('needs a second person, fresh MFA and a decision on every likely duplicate', async () => {
    expect((await H.staff.rec1!.c.post(`/migrations/batches/${batch}/commit`)).body.error.code).toBe('FOUR_EYES');
    expect((await H.staff.rec2!.c.post(`/migrations/batches/${batch}/commit`)).body.error.code).toBe('UNRESOLVED_DUPLICATES');
    const dups = (await H.staff.rec2!.c.get(`/migrations/batches/${batch}/rows?status=duplicate`)).body.data as { id: string; raw: { legacy_id: string } }[];
    for (const d of dups) await H.staff.rec2!.c.post(`/migrations/batches/${batch}/rows/${d.id}/resolve`, { action: d.raw.legacy_id === 'H-1008' ? 'skip' : 'create' });
  });

  it('imports exactly the accepted rows, with new MRNs and legacy ids, and the fingerprints agree', async () => {
    const r = await H.staff.rec2!.c.post(`/migrations/batches/${batch}/commit`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.counts).toMatchObject({ imported: 5, skipped: 1, error: 5 });
    expect(r.body.data.verification).toMatchObject({ expectedRows: 5, actualRows: 5, verified: true });
    const p = await h.data.tenant('fahan_t_hiil').collection('patients').findOne({ 'migration.legacyId': 'H-1002' });
    expect(p).toMatchObject({ names: { given: 'Hassan', middle: 'Abdi', family: 'Nuur Hassan' }, dob: '1972-02-14', sexAtBirth: 'male', phone: '252615551002', identifiers: [{ system: 'legacy:legacy-his', value: 'H-1002' }] });
    expect(p!.mrn).toMatch(/^MGD-\d{2}-\d{6}$/);
    expect((await H.staff.rec2!.c.post(`/migrations/batches/${batch}/commit`)).body.error.code).toBe('INVALID_TRANSITION');
  });

  it('a legacy record is never imported twice, even from a new batch', async () => {
    const b2 = (await H.staff.rec1!.c.post('/migrations/batches', { source: 'legacy-his', branchId: H.branchId })).body.data.id;
    await H.staff.rec1!.c.post(`/migrations/batches/${b2}/rows`, { csv: 'legacy_id,given_name,family_name,dob,sex\nH-1001,Asha,Warsame,1985-04-11,F' });
    await H.staff.rec1!.c.post(`/migrations/batches/${b2}/validate`);
    const rows = (await H.staff.rec1!.c.get(`/migrations/batches/${b2}/rows`)).body.data;
    expect(rows[0].errors.join()).toMatch(/already imported/);
  });

  it('verification notices when an imported record no longer matches what was committed', async () => {
    const tdb = h.data.tenant('fahan_t_hiil');
    await tdb.collection('patients').updateOne({ 'migration.legacyId': 'H-1003' }, { $set: { dob: '2012-02-15' } });
    expect((await H.staff.rec1!.c.get(`/migrations/batches/${batch}/verify`)).body.data.verification.verified).toBe(false);
    await tdb.collection('patients').updateOne({ 'migration.legacyId': 'H-1003' }, { $set: { dob: '2012-02-14' } });
    expect((await H.staff.rec1!.c.get(`/migrations/batches/${batch}/verify`)).body.data.verification.verified).toBe(true);
  });
});

describe('rollback', () => {
  it('removes untouched imports and keeps any record already used for care', async () => {
    const asha = await h.data.tenant('fahan_t_hiil').collection('patients').findOne({ 'migration.legacyId': 'H-1001' });
    expect((await H.staff.reception!.c.post('/appointments/walk-in', { patientId: asha!._id.toHexString(), providerId: H.staff.doctor!.id, reason: 'Follow-up' })).status).toBe(201);
    const r = await H.staff.rec1!.c.post(`/migrations/batches/${batch}/rollback`, { reason: 'Wrong source extract' });
    expect(r.body.data).toMatchObject({ status: 'PartiallyRolledBack', removed: 4, kept: [asha!.mrn] });
    const left = await h.data.tenant('fahan_t_hiil').collection('patients').countDocuments({ 'migration.batchId': { $exists: true } });
    expect(left).toBe(1);
  });
});
