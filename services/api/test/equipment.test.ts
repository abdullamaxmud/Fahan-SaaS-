import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupHospital, type Hospital } from './fixtures';
import { startHarness, type Harness } from './helpers';

/** Spec §5.24: maintenance status may block bookings; safety certification (calibration) tracked. */
let h: Harness;
let H: Hospital;
let ct = '';
const clock = new Date('2030-01-07T05:00:00Z');

beforeAll(async () => {
  h = await startHarness();
  h.config.now = () => clock;
  H = await setupHospital(h, [
    { key: 'bio', role: 'biomedical' },
    { key: 'fac', role: 'facilities-cssd' },
    { key: 'rg', role: 'radiographer' },
  ]);
});
afterAll(async () => {
  await h?.stop();
});

describe('equipment', () => {
  it('the biomedical lead registers devices; facilities cannot', async () => {
    expect((await H.staff.fac!.c.post('/equipment/assets', { branchId: H.branchId, code: 'CT-1', name: 'CT scanner', kind: 'imaging', modality: 'CT' })).status).toBe(403);
    const r = await H.staff.bio!.c.post('/equipment/assets', { branchId: H.branchId, code: 'CT-1', name: 'CT scanner 64-slice', kind: 'imaging', modality: 'CT', nextCalibrationDue: '2029-12-31' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    ct = r.body.data.id;
  });

  it('overdue calibration makes a device unusable', async () => {
    const list = (await H.staff.rg!.c.get('/equipment/assets?modality=CT')).body.data;
    expect(list[0]).toMatchObject({ usable: false, blockedReason: 'CT-1 calibration was due 2029-12-31' });
  });

  it('a passed calibration needs the next due date and restores use', async () => {
    const job = await H.staff.fac!.c.post(`/equipment/assets/${ct}/jobs`, { kind: 'calibration', scheduledFor: '2030-01-07' });
    expect((await H.staff.fac!.c.post(`/equipment/jobs/${job.body.data.id}/complete`, { result: 'pass', notes: 'Phantom within tolerance' })).status).toBe(400);
    expect((await H.staff.fac!.c.post(`/equipment/jobs/${job.body.data.id}/complete`, { result: 'pass', notes: 'Phantom within tolerance', nextCalibrationDue: '2030-07-07' })).status).toBe(200);
    expect((await H.staff.rg!.c.get('/equipment/assets')).body.data[0].usable).toBe(true);
  });

  it('a failed repair takes the device out of service; only the biomedical lead releases it, after the job closes', async () => {
    const job = await H.staff.fac!.c.post(`/equipment/assets/${ct}/jobs`, { kind: 'repair', scheduledFor: '2030-01-07', notes: 'Tube arcing' });
    expect((await H.staff.fac!.c.post(`/equipment/jobs/${job.body.data.id}/complete`, { result: 'fail', notes: 'Tube needs replacement' })).body.data.assetStatus).toBe('OutOfService');
    expect((await H.staff.fac!.c.post(`/equipment/assets/${ct}/release`, { reason: 'Fixed' })).status).toBe(403);
    const fix = await H.staff.fac!.c.post(`/equipment/assets/${ct}/jobs`, { kind: 'repair', scheduledFor: '2030-01-08', notes: 'Replace tube' });
    expect((await H.staff.bio!.c.post(`/equipment/assets/${ct}/release`, { reason: 'Tube replaced' })).body.error.code).toBe('JOB_OPEN');
    await H.staff.fac!.c.post(`/equipment/jobs/${fix.body.data.id}/complete`, { result: 'pass', notes: 'New tube fitted and tested' });
    expect((await H.staff.bio!.c.post(`/equipment/assets/${ct}/release`, { reason: 'Tube replaced, QA passed' })).body.data.status).toBe('Available');
  });
});
