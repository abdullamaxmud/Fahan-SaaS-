import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupHospital, type Hospital } from './fixtures';
import { startHarness, type Harness } from './helpers';

/** Spec §5.22: employees with restricted salary, credentials, rosters, leave, payroll with finance four-eyes. */
let h: Harness;
let H: Hospital;
const clock = new Date('2030-06-10T08:00:00Z');
let nurseEmp: string;
let leave: string;

beforeAll(async () => {
  h = await startHarness();
  h.config.now = () => clock;
  H = await setupHospital(h, [
    { key: 'hr', role: 'hr' },
    { key: 'hr2', role: 'hr' },
    { key: 'fd', role: 'finance-director' },
    { key: 'fa', role: 'finance-approver' },
    { key: 'acc', role: 'accountant' },
    { key: 'nurse', role: 'nurse' },
  ]);
});
afterAll(async () => {
  await h?.stop();
});

const tb = async () => {
  const d = (await H.staff.fd!.c.get('/accounting/trial-balance')).body.data;
  expect(d.balanced).toBe(true);
  return Object.fromEntries((d.rows as { accountCode: string; debitMinor: number; creditMinor: number }[]).map((r) => [r.accountCode, r.debitMinor - r.creditMinor]));
};

describe('employees and credentials', () => {
  it('HR keeps the record; only HR and finance administrators see pay', async () => {
    const hr = H.staff.hr!.c;
    const r = await hr.post('/hr/employees', { staffNumber: 'N-0101', name: 'Ayaan Cali', jobTitle: 'Staff nurse', branchId: H.branchId, userId: H.staff.nurse!.id, hireDate: '2029-01-01', salary: { currency: 'USD', baseMinor: 60_000, allowancesMinor: 10_000, deductionsMinor: 7_000 } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    nurseEmp = r.body.data.id;
    await hr.post('/hr/employees', { staffNumber: 'A-0007', name: 'Bashiir Nuur', jobTitle: 'HR officer', branchId: H.branchId, userId: H.staff.hr2!.id, hireDate: '2030-05-20', salary: { currency: 'USD', baseMinor: 50_000 } });
    await hr.post('/hr/employees', { staffNumber: 'D-0001', name: 'Dr Faarax', jobTitle: 'Physician', branchId: H.branchId, hireDate: '2030-01-01', salary: { currency: 'SOS', baseMinor: 3_000_000 } });
    expect((await hr.post('/hr/employees', { staffNumber: 'N-0101', name: 'Copy', jobTitle: 'Copy nurse', branchId: H.branchId, hireDate: '2030-01-01', salary: { currency: 'USD', baseMinor: 1 } })).body.error.code).toBe('EMPLOYEE_EXISTS');
    expect((await H.staff.acc!.c.post('/hr/employees', { staffNumber: 'X-1', name: 'Nope', jobTitle: 'Nobody', branchId: H.branchId, hireDate: '2030-01-01', salary: { currency: 'USD', baseMinor: 1 } })).status).toBe(403);

    const asAccountant = (await H.staff.acc!.c.get('/hr/employees')).body.data;
    expect(asAccountant).toHaveLength(3);
    expect(asAccountant.every((e: object) => !('salary' in e))).toBe(true);
    const asFd = (await H.staff.fd!.c.get('/hr/employees')).body.data;
    expect(asFd.find((e: { staffNumber: string }) => e.staffNumber === 'N-0101').salary.baseMinor).toBe(60_000);
  });

  it('credentials expiring within 30 days, or already expired, are listed', async () => {
    const hr = H.staff.hr!.c;
    await hr.post(`/hr/employees/${nurseEmp}/credentials`, { kind: 'nursing-licence', number: 'SNMC-2231', issuer: 'Somali Nursing Council', expiresOn: '2030-06-30' });
    await hr.post(`/hr/employees/${nurseEmp}/credentials`, { kind: 'bls', number: 'BLS-88', issuer: 'Red Crescent', expiresOn: '2030-05-01' });
    await hr.post(`/hr/employees/${nurseEmp}/credentials`, { kind: 'acls', number: 'ACLS-12', issuer: 'Red Crescent', expiresOn: '2031-02-01' });
    const list = (await H.staff.acc!.c.get('/hr/credentials/expiring')).body.data;
    expect(list.map((c: { kind: string; expired: boolean }) => `${c.kind}:${c.expired}`)).toEqual(['bls:true', 'nursing-licence:false']);
  });
});

describe('rosters and leave', () => {
  it('one shift per person per day', async () => {
    const hr = H.staff.hr!.c;
    expect((await hr.post('/hr/rosters/shifts', { employeeId: nurseEmp, date: '2030-06-15', shift: 'day', unit: 'Ward 3' })).status).toBe(201);
    expect((await hr.post('/hr/rosters/shifts', { employeeId: nurseEmp, date: '2030-06-15', shift: 'night' })).body.error.code).toBe('DOUBLE_BOOKED');
    expect((await hr.post('/hr/rosters/shifts', { employeeId: nurseEmp, date: '2030-06-16', shift: 'night', unit: 'Ward 3' })).status).toBe(201);
  });

  it('staff ask for their own leave; approval leaves the roster gap visible', async () => {
    expect((await H.staff.acc!.c.post('/hr/leave', { kind: 'annual', from: '2030-06-16', to: '2030-06-18' })).status).toBe(403); // no employee record
    const r = await H.staff.nurse!.c.post('/hr/leave', { kind: 'annual', from: '2030-06-16', to: '2030-06-18', reason: 'Family wedding' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    leave = r.body.data.id;
    const d = await H.staff.hr!.c.post(`/hr/leave/${leave}/decide`, { decision: 'approve' });
    expect(d.body.data).toMatchObject({ status: 'Approved', uncoveredShifts: 1 });
    expect((await H.staff.hr!.c.post('/hr/rosters/shifts', { employeeId: nurseEmp, date: '2030-06-17', shift: 'day' })).body.error.code).toBe('ON_LEAVE');
    const roster = (await H.staff.acc!.c.get('/hr/rosters?from=2030-06-15&to=2030-06-16')).body.data;
    expect(roster.map((x: { date: string; status: string }) => `${x.date}:${x.status}`)).toEqual(['2030-06-15:scheduled', '2030-06-16:uncovered']);
  });

  it('nobody decides their own leave', async () => {
    const own = (await H.staff.hr2!.c.post('/hr/leave', { kind: 'sick', from: '2030-06-11', to: '2030-06-11' })).body.data.id;
    expect((await H.staff.hr2!.c.post(`/hr/leave/${own}/decide`, { decision: 'approve' })).body.error.code).toBe('FOUR_EYES');
    expect((await H.staff.hr!.c.post(`/hr/leave/${own}/decide`, { decision: 'approve' })).body.data.status).toBe('Approved');
  });
});

describe('payroll', () => {
  let run: string;

  it('HR prepares one run per month and currency; finance sees totals, not each salary', async () => {
    const r = await H.staff.hr!.c.post('/hr/payroll/runs', { period: '2030-05', currency: 'USD' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({ employees: 2, grossMinor: 120_000, netMinor: 113_000, status: 'Draft' });
    run = r.body.data.id;
    expect((await H.staff.hr!.c.post('/hr/payroll/runs', { period: '2030-05', currency: 'USD' })).body.error.code).toBe('PAYROLL_EXISTS');
    const seen = (await H.staff.fa!.c.get('/hr/payroll/runs')).body.data[0];
    expect(seen).toMatchObject({ grossMinor: 120_000, deductionsMinor: 7_000 });
    expect(seen.lines).toBeUndefined();
  });

  it('HR cannot approve; finance approves (salary expense) and pays (net from the bank)', async () => {
    expect((await H.staff.hr!.c.post(`/hr/payroll/runs/${run}/approve`)).status).toBe(403);
    expect((await H.staff.fa!.c.post(`/hr/payroll/runs/${run}/pay`, { reference: 'BANK-0611' })).body.error.code).toBe('INVALID_TRANSITION');
    expect((await H.staff.fa!.c.post(`/hr/payroll/runs/${run}/approve`)).body.data.status).toBe('Approved');
    expect(await tb()).toMatchObject({ '5000': 120_000, '2100': -120_000 });
    expect((await H.staff.fa!.c.post(`/hr/payroll/runs/${run}/pay`, { reference: 'BANK-0611' })).body.data.status).toBe('Paid');
    expect(await tb()).toMatchObject({ '5000': 120_000, '2100': -7_000, '1010': -113_000 });
    expect((await H.staff.fa!.c.post(`/hr/payroll/runs/${run}/pay`, { reference: 'BANK-0612' })).body.error.code).toBe('INVALID_TRANSITION');
  });

  it('a Somali-shilling payroll is separate and includes only SOS-paid staff', async () => {
    const r = await H.staff.hr!.c.post('/hr/payroll/runs', { period: '2030-05', currency: 'SOS' });
    expect(r.body.data).toMatchObject({ employees: 1, grossMinor: 3_000_000 });
  });
});
