import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupHospital, type Hospital } from './fixtures';
import { startHarness, type Harness } from './helpers';

/** Spec §5.25: referrals, ambulance dispatch, arrival and handover linked to the destination encounter. */
let h: Harness;
let H: Hospital;
let amb1 = '';
let amb2 = '';
let referral = '';

beforeAll(async () => {
  h = await startHarness();
  H = await setupHospital(h, [
    { key: 'dispatch', role: 'dispatch' },
    { key: 'ernurse', role: 'er-nurse' },
    { key: 'gp', role: 'referring-provider' },
    { key: 'cashier', role: 'cashier' },
  ]);
  amb1 = (await H.admin.post('/ambulance/vehicles', { branchId: H.branchId, code: 'AMB-04', kind: 'advanced' })).body.data.id;
  amb2 = (await H.admin.post('/ambulance/vehicles', { branchId: H.branchId, code: 'AMB-07', kind: 'basic' })).body.data.id;
});
afterAll(async () => {
  await h?.stop();
});

describe('inbound referral to handover', () => {
  it('an external doctor refers a patient', async () => {
    const r = await H.staff.gp!.c.post('/referrals', {
      direction: 'inbound',
      branchId: H.branchId,
      patientSummary: 'Female 24, RLQ pain 18h, guarding',
      fromFacility: 'Kaah Clinic',
      toFacility: 'Hiil Mogadishu Central',
      reason: 'Suspected appendicitis',
      priority: 'emergency',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    referral = r.body.data.id;
  });

  it('dispatch sends one vehicle; it cannot be sent on a second run', async () => {
    const d = H.staff.dispatch!.c;
    const r = await d.post(`/referrals/${referral}/dispatch`, { vehicleId: amb1, crew: ['Abdirisaaq Hurre', 'Paramedic Ali'], pickup: 'Kaah Clinic, Hodan' });
    expect(r.body.data).toMatchObject({ status: 'Dispatched', vehicle: 'AMB-04' });
    const other = await H.staff.gp!.c.post('/referrals', { direction: 'inbound', branchId: H.branchId, patientSummary: 'Male 60, chest pain', fromFacility: 'Kaah Clinic', toFacility: 'Hiil', reason: 'ACS', priority: 'urgent' });
    expect((await d.post(`/referrals/${other.body.data.id}/dispatch`, { vehicleId: amb1, crew: ['X Y'], pickup: 'Kaah' })).body.error.code).toBe('VEHICLE_UNAVAILABLE');
    expect((await d.post(`/referrals/${other.body.data.id}/dispatch`, { vehicleId: amb2, crew: ['X Y'], pickup: 'Kaah' })).status).toBe(200);
    expect((await d.post(`/ambulance/vehicles/${amb2}/status`, { status: 'OutOfService' })).body.error.code).toBe('VEHICLE_ON_RUN');
  });

  it('arrival, then the emergency nurse links the handover to the new emergency visit', async () => {
    expect((await H.staff.dispatch!.c.post(`/referrals/${referral}/arrive`)).status).toBe(200);
    const visit = await H.staff.ernurse!.c.post('/emergency/arrivals', { unknown: { sexAtBirth: 'female', estimatedAge: 24, description: 'Referred from Kaah Clinic' }, mode: 'ambulance', complaint: 'Abdominal pain' });
    const r = await H.staff.ernurse!.c.post(`/referrals/${referral}/handover`, { encounterId: visit.body.data.id, note: 'Handed over to triage, ESI 2' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const fleet = (await H.staff.dispatch!.c.get('/ambulance/vehicles')).body.data;
    expect(fleet.find((v: { code: string }) => v.code === 'AMB-04').status).toBe('Available');
  });

  it('the referring doctor sees only status, never the clinical detail or visit', async () => {
    const mine = (await H.staff.gp!.c.get('/referrals?status=all')).body.data;
    expect(mine).toHaveLength(2);
    const r = mine.find((x: { id: string }) => x.id === referral);
    expect(r.status).toBe('HandedOver');
    expect(r).not.toHaveProperty('patientSummary');
    expect(r).not.toHaveProperty('encounterId');
    const staff = (await H.staff.ernurse!.c.get('/referrals?status=all')).body.data.find((x: { id: string }) => x.id === referral);
    expect(staff.encounterId).toMatch(/^[a-f0-9]{24}$/);
  });

  it('cashier has no access to referrals', async () => {
    expect((await H.staff.cashier!.c.get('/referrals')).status).toBe(403);
  });
});
