import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compatible } from '../src/modules/bloodbank/routes';
import { setupHospital, type Hospital } from './fixtures';
import { startHarness, type Harness } from './helpers';

/** Spec §5.18: compatibility under protocol, unit-level traceability and recall. */
describe('ABO/RhD compatibility table', () => {
  it('red cells: O- to everyone, AB+ receives all, Rh- recipients need Rh- units', () => {
    expect(compatible('red-cells', 'O-', 'AB+')).toBe(true);
    expect(compatible('red-cells', 'A+', 'O+')).toBe(false);
    expect(compatible('red-cells', 'O+', 'A-')).toBe(false);
    expect(compatible('red-cells', 'B-', 'AB-')).toBe(true);
  });
  it('plasma runs the other way: AB plasma is universal', () => {
    expect(compatible('plasma', 'AB+', 'O-')).toBe(true);
    expect(compatible('plasma', 'O+', 'A+')).toBe(false);
  });
  it('whole blood must be ABO identical', () => {
    expect(compatible('whole-blood', 'O-', 'A+')).toBe(false);
    expect(compatible('whole-blood', 'A-', 'A+')).toBe(true);
  });
});

let h: Harness;
let H: Hospital;
let pid = '';
let enc = '';
const units: Record<string, string> = {};
const clock = new Date('2030-01-07T05:00:00Z');

beforeAll(async () => {
  h = await startHarness();
  h.config.now = () => clock;
  H = await setupHospital(h, [
    { key: 'reception', role: 'reception' },
    { key: 'doctor', role: 'physician' },
    { key: 'nurse', role: 'nurse' },
    { key: 'nurse2', role: 'nurse' },
    { key: 'bb', role: 'bloodbank' },
    { key: 'bb2', role: 'bloodbank' },
    { key: 'cashier', role: 'cashier' },
  ]);
  const rc = H.staff.reception!.c;
  pid = (await rc.post('/patients', { branchId: H.branchId, givenName: 'Nasra', familyName: 'Daud', dob: '1974-09-09', sexAtBirth: 'female' })).body.data.id;
  enc = (await rc.post('/appointments/walk-in', { patientId: pid, providerId: H.staff.doctor!.id, reason: 'GI bleed' })).body.data.encounterId;
  for (const k of ['nurse', 'nurse2']) await H.staff.doctor!.c.post(`/encounters/${enc}/care-team`, { userId: H.staff[k]!.id });
  for (const [n, g, c] of [
    ['U-A-POS-001', 'A+', 'red-cells'],
    ['U-O-NEG-002', 'O-', 'red-cells'],
    ['U-B-POS-003', 'B+', 'red-cells'],
    ['U-AB-PL-004', 'AB+', 'plasma'],
  ] as const) {
    units[n] = (await H.staff.bb!.c.post('/bloodbank/units', { unitNumber: n, group: g, component: c, volumeMl: 280, collectedOn: '2030-01-01', expiry: '2030-02-10' })).body.data.id;
  }
});
afterAll(async () => {
  await h?.stop();
});

describe('transfusion', () => {
  let reqId = '';

  it('expired units are refused at receipt', async () => {
    expect((await H.staff.bb!.c.post('/bloodbank/units', { unitNumber: 'U-OLD-999', group: 'O+', component: 'red-cells', volumeMl: 280, collectedOn: '2029-11-01', expiry: '2030-01-01' })).status).toBe(400);
  });

  it('a signing clinician requests; crossmatch waits for a twice-confirmed blood group', async () => {
    expect((await H.staff.nurse!.c.post('/bloodbank/requests', { encounterId: enc, component: 'red-cells', units: 2, indication: 'Hb 6.1 with active bleeding', urgency: 'urgent' })).status).toBe(403);
    reqId = (await H.staff.doctor!.c.post('/bloodbank/requests', { encounterId: enc, component: 'red-cells', units: 2, indication: 'Hb 6.1 with active bleeding', urgency: 'urgent' })).body.data.id;
    const bb = H.staff.bb!.c;
    expect((await bb.post(`/bloodbank/requests/${reqId}/crossmatch`, { unitIds: [units['U-A-POS-001']] })).body.error.code).toBe('GROUP_NOT_CONFIRMED');
    expect((await bb.post('/bloodbank/typing', { patientId: pid, group: 'A+', sampleRef: 'S-1' })).body.data.confirmedGroup).toBeNull();
    // Same person, second sample: still not independent.
    expect((await bb.post('/bloodbank/typing', { patientId: pid, group: 'A+', sampleRef: 'S-2' })).body.data.confirmedGroup).toBeNull();
    expect((await H.staff.bb2!.c.post('/bloodbank/typing', { patientId: pid, group: 'A+', sampleRef: 'S-3' })).body.data.confirmedGroup).toBe('A+');
  });

  it('refuses incompatible or wrong-component units with reasons', async () => {
    const r = await H.staff.bb!.c.post(`/bloodbank/requests/${reqId}/crossmatch`, { unitIds: [units['U-B-POS-003'], units['U-AB-PL-004']] });
    expect(r.body.error.code).toBe('INCOMPATIBLE_OR_UNAVAILABLE');
    expect(r.body.error.details.map((d: { message: string }) => d.message)).toEqual(['B+ red-cells is not compatible with recipient A+', 'Unit is plasma, request is red-cells']);
  });

  it('reserves compatible units, issues, and administers with an independent bedside check', async () => {
    const bb = H.staff.bb!.c;
    const m = await bb.post(`/bloodbank/requests/${reqId}/crossmatch`, { unitIds: [units['U-A-POS-001'], units['U-O-NEG-002']] });
    expect(m.body.data).toMatchObject({ status: 'Matched', recipientGroup: 'A+' });
    expect((await bb.post(`/bloodbank/requests/${reqId}/issue`, { unitId: units['U-B-POS-003'] })).body.error.code).toBe('NOT_RESERVED');
    expect((await bb.post(`/bloodbank/requests/${reqId}/issue`, { unitId: units['U-A-POS-001'] })).status).toBe(200);
    const n = H.staff.nurse!.c;
    expect((await n.post(`/bloodbank/requests/${reqId}/administer`, { unitId: units['U-A-POS-001'], checkedBy: H.staff.nurse!.id })).body.error.code).toBe('FOUR_EYES');
    expect((await n.post(`/bloodbank/requests/${reqId}/administer`, { unitId: units['U-O-NEG-002'], checkedBy: H.staff.nurse2!.id })).body.error.code).toBe('NOT_ISSUED');
    expect((await n.post(`/bloodbank/requests/${reqId}/administer`, { unitId: units['U-A-POS-001'], checkedBy: H.staff.nurse2!.id })).body.data.status).toBe('Transfused');
  });

  it('a unit can be traced to its recipient for recall', async () => {
    const t = (await H.staff.bb!.c.get('/bloodbank/units/trace/U-A-POS-001')).body.data;
    expect(t.recipient._id).toBe(pid);
    expect(t.history.map((x: { event: string }) => x.event)).toEqual(['received', 'reserved', 'issued', 'transfused']);
    expect(t.history[3].checkedByName).toBe('nurse2');
  });

  it('cashier cannot see the blood bank', async () => {
    expect((await H.staff.cashier!.c.get('/bloodbank/units')).status).toBe(403);
  });
});
