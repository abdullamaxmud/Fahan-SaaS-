import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupHospital, type Hospital } from './fixtures';
import { startHarness, type Harness } from './helpers';

/** Spec §5.3 / §4.1: MPI identity, duplicate prevention, approved and reversible merges. */
let h: Harness;
let H: Hospital;
let faadumo = '';

const reg = (H: Hospital, body: object, who = 'reception') => H.staff[who]!.c.post('/patients', { branchId: H.branchId, ...body });

beforeAll(async () => {
  h = await startHarness();
  H = await setupHospital(h, [
    { key: 'reception', role: 'reception' },
    { key: 'reception2', role: 'reception', branch: 2 },
    { key: 'records', role: 'records-officer' },
    { key: 'cashier', role: 'cashier' },
    { key: 'doctor', role: 'physician' },
  ]);
});
afterAll(async () => {
  await h?.stop();
});

describe('registration', () => {
  it('creates a provisional patient with a branch MRN', async () => {
    const res = await reg(H, { givenName: 'Faadumo', middleName: 'Cali', familyName: 'Xasan', dob: '1992-03-14', sexAtBirth: 'female', phone: '061 555 0147' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'Provisional', phone: '252615550147' });
    expect(res.body.data.mrn).toMatch(/^MGD-\d{2}-000001$/);
    faadumo = res.body.data.id;
  });

  it('rejects future dates of birth and missing names', async () => {
    const res = await reg(H, { givenName: '', familyName: 'X', dob: '2999-01-01' });
    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d: { path: string }) => d.path)).toEqual(expect.arrayContaining(['givenName', 'dob']));
  });

  it('blocks a likely duplicate spelled differently, with candidates', async () => {
    const res = await reg(H, { givenName: 'Fadumo', middleName: 'Ali', familyName: 'Hassan', dob: '1992-03-14' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('POSSIBLE_DUPLICATE');
    expect(res.body.error.candidates[0]).toMatchObject({ id: faadumo, branches: ['MGD'] });
    expect(res.body.error.candidates[0].phone).toMatch(/^\+252 ··· ··47$/);
  });

  it('allows an override that is recorded', async () => {
    const res = await reg(H, { givenName: 'Fadumo', middleName: 'Ali', familyName: 'Hassan', dob: '1992-03-14', confirmNotDuplicate: true });
    expect(res.status).toBe(201);
    const audit = await H.admin.get('/audit/events?limit=20');
    expect(audit.body.data.find((e: { action: string }) => e.action === 'mpi.patient.create')?.meta.duplicateOverride).toBe(true);
  });

  it('matches on a national id regardless of name', async () => {
    await reg(H, { givenName: 'Bile', familyName: 'Gaarane', dob: '1997-05-02', identifiers: [{ system: 'national-id', value: 'SO-1234567' }] });
    const dup = await H.staff.reception!.c.post('/patients/duplicates', { givenName: 'Someone', familyName: 'Else', identifiers: [{ system: 'national-id', value: 'SO-1234567' }] });
    expect(dup.body.data[0].score).toBe(1);
  });
});

describe('search and scope', () => {
  it('finds by spelling variant, MRN and phone', async () => {
    const c = H.staff.reception!.c;
    expect((await c.get('/patients?q=Mohamed')).body.data).toHaveLength(0);
    expect((await c.get('/patients?q=Xasan')).body.data.length).toBeGreaterThanOrEqual(2); // Xasan + Hassan
    const p = (await c.get(`/patients/${faadumo}`)).body.data;
    expect((await c.get(`/patients?q=${p.mrn}`)).body.data[0].id).toBe(faadumo);
    expect((await c.get('/patients?q=0615550147')).body.data[0].id).toBe(faadumo);
  });

  it('another branch cannot open the record until it links it', async () => {
    const c = H.staff.reception2!.c;
    expect((await c.get(`/patients/${faadumo}`)).status).toBe(403);
    expect((await c.post(`/patients/${faadumo}/link-branch`)).status).toBe(200);
    expect((await c.get(`/patients/${faadumo}`)).status).toBe(200);
  });

  it('clinicians only see patients in their care', async () => {
    expect((await H.staff.doctor!.c.get(`/patients/${faadumo}`)).status).toBe(403);
    expect((await H.staff.doctor!.c.get('/patients')).body.data).toHaveLength(0);
  });

  it('updates demographics with optimistic concurrency; MRN is immutable', async () => {
    const c = H.staff.reception!.c;
    const p = (await c.get(`/patients/${faadumo}`)).body.data;
    const ok = await c.patch(`/patients/${faadumo}`, { phone: '0615550148', version: p.version, mrn: 'HACK-00-000001' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.mrn).toBe(p.mrn);
    const stale = await c.patch(`/patients/${faadumo}`, { phone: '0615550149', version: p.version });
    expect(stale.status).toBe(409);
    expect((await c.post(`/patients/${faadumo}/verify`)).body.data.status).toBe('Verified');
  });
});

describe('merge', () => {
  let dupId = '';
  let reqId = '';

  it('reception requests, cannot approve; records officer approves (four eyes)', async () => {
    const rc = H.staff.reception!.c;
    dupId = (await rc.get('/patients?q=Hassan')).body.data.find((p: { id: string }) => p.id !== faadumo).id;
    const r = await rc.post('/patients/merge-requests', { survivorId: faadumo, duplicateId: dupId, reason: 'Same person, registered twice at front desk' });
    expect(r.status).toBe(201);
    reqId = r.body.data.id;
    expect((await rc.post(`/patients/merge-requests/${reqId}/approve`)).status).toBe(403);
    const ok = await H.staff.records!.c.post(`/patients/merge-requests/${reqId}/approve`);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it('merged record leaves search and the survivor keeps the old MRN as an alias', async () => {
    const rc = H.staff.reception!.c;
    expect((await rc.get('/patients?q=Hassan')).body.data.map((p: { id: string }) => p.id)).toEqual([faadumo]);
    const s = (await rc.get(`/patients/${faadumo}`)).body.data;
    expect(s.identifiers.some((i: { system: string }) => i.system === 'mrn-alias')).toBe(true);
    expect((await rc.get(`/patients/${dupId}`)).body.data.status).toBe('Merged');
  });

  it('a merge can be reversed', async () => {
    const res = await H.staff.records!.c.post(`/patients/merge-requests/${reqId}/reverse`);
    expect(res.status).toBe(200);
    const rc = H.staff.reception!.c;
    expect((await rc.get(`/patients/${dupId}`)).body.data.status).toBe('Provisional');
    expect((await rc.get(`/patients/${faadumo}`)).body.data.identifiers.some((i: { system: string }) => i.system === 'mrn-alias')).toBe(false);
  });
});

describe('consent', () => {
  it('keeps an append-only consent history', async () => {
    const rc = H.staff.reception!.c;
    expect((await rc.post(`/patients/${faadumo}/consents`, { type: 'sms-reminders', status: 'granted', method: 'verbal' })).status).toBe(201);
    expect((await rc.post(`/patients/${faadumo}/consents`, { type: 'sms-reminders', status: 'withdrawn', method: 'verbal' })).status).toBe(201);
    const list = (await rc.get(`/patients/${faadumo}/consents`)).body.data;
    expect(list.map((c: { status: string }) => c.status)).toEqual(['withdrawn', 'granted']);
    expect((await H.staff.cashier!.c.post(`/patients/${faadumo}/consents`, { type: 'treatment', status: 'granted', method: 'written' })).status).toBe(403);
  });
});
