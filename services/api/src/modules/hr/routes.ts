import { Router, type Request } from 'express';
import { ObjectId, type ClientSession, type Document } from 'mongodb';
import { z } from 'zod';
import { can, isBranchBound } from '@fahan/policy';
import type { Deps } from '../../context';
import { AppError, Errors } from '../../lib/errors';
import { localDate } from '../../lib/time';
import { idParam, objectId, parse } from '../../lib/validate';
import { audit } from '../../middleware/audit';
import { deny, need } from '../../middleware/authorize';
import { assertRecentMfa } from '../../middleware/session';
import { CURRENCIES, postEntry, type Currency } from '../accounting/ledger';

export const CREDENTIAL_WARNING_DAYS = 30;
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const minor = z.number().int().min(0).max(1e11);
const NewEmployee = z.object({
  staffNumber: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,20}$/),
  name: z.string().trim().min(2).max(120),
  jobTitle: z.string().trim().min(2).max(80),
  branchId: objectId,
  userId: objectId.optional(),
  hireDate: day,
  salary: z.object({ currency: z.enum(CURRENCIES), baseMinor: minor, allowancesMinor: minor.default(0), deductionsMinor: minor.default(0) }),
});
const Credential = z.object({
  kind: z.enum(['medical-licence', 'nursing-licence', 'pharmacy-licence', 'midwifery-licence', 'bls', 'acls', 'radiation-safety', 'other']),
  number: z.string().trim().min(2).max(60),
  issuer: z.string().trim().min(2).max(120),
  expiresOn: day,
});
const Shift = z.object({ employeeId: objectId, date: day, shift: z.enum(['day', 'evening', 'night']), unit: z.string().trim().max(60).optional() });
const Leave = z.object({ kind: z.enum(['annual', 'sick', 'maternity', 'unpaid', 'study']), from: day, to: day, reason: z.string().trim().max(300).optional() });
const Run = z.object({ period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), currency: z.enum(CURRENCIES) });

const id = (x: { _id: ObjectId }) => x._id.toHexString();
const lastDay = (period: string) => {
  const [y, m] = period.split('-').map(Number);
  return `${period}-${String(new Date(Date.UTC(y!, m!, 0)).getUTCDate()).padStart(2, '0')}`;
};

/** Spec §5.22 HR, rosters & payroll. Salary is restricted to HR and finance administrators. */
export function hrRoutes(deps: Deps): Router {
  const r = Router();
  const db = (req: Request) => req.actor!.db!;
  const today = () => localDate(deps.config.now(), 'Africa/Mogadishu');
  const seesPay = (req: Request) => can(req.actor!.perms, 'hr', 'A') || can(req.actor!.perms, 'acct', 'A');

  async function txn<T>(fn: (s: ClientSession) => Promise<T>): Promise<T> {
    const s = deps.data.client.startSession();
    try {
      let out: T | undefined;
      await s.withTransaction(async () => {
        out = await fn(s);
      });
      return out as T;
    } finally {
      await s.endSession();
    }
  }

  const employeeView = (req: Request, e: Document) => ({
    id: id(e as { _id: ObjectId }),
    staffNumber: e.staffNumber,
    name: e.name,
    jobTitle: e.jobTitle,
    branchId: e.branchId.toHexString(),
    hireDate: e.hireDate,
    status: e.status,
    ...(seesPay(req) ? { salary: e.salary } : {}),
  });

  async function loadEmployee(req: Request, raw: unknown) {
    const e = await db(req).collection('employees').findOne({ _id: raw instanceof ObjectId ? raw : idParam(raw, 'Employee'), tenantId: req.actor!.tenantId });
    if (!e) throw Errors.notFound('Employee');
    return e;
  }

  // ---- employees ----
  r.get('/employees', need(deps, 'hr', 'V'), async (req, res) => {
    const a = req.actor!;
    const f: Document = { tenantId: a.tenantId, status: 'active' };
    if (isBranchBound(a.scope)) f.branchId = a.branchId ?? null;
    const list = await db(req).collection('employees').find(f).sort({ name: 1 }).toArray();
    res.json({ data: list.map((e) => employeeView(req, e)) });
  });

  r.post('/employees', need(deps, 'hr', 'A'), async (req, res) => {
    const body = parse(NewEmployee, req.body);
    const a = req.actor!;
    if (body.userId && !(await db(req).collection('users').findOne({ _id: body.userId, tenantId: a.tenantId }))) throw Errors.notFound('User account');
    try {
      const ins = await db(req).collection('employees').insertOne({ tenantId: a.tenantId, ...body, status: 'active', createdAt: new Date(), createdBy: a.userId });
      await audit(deps, req, { action: 'hr.employee.create', resource: `employee:${ins.insertedId.toHexString()}`, outcome: 'success', meta: { staffNumber: body.staffNumber } });
      res.status(201).json({ data: { id: ins.insertedId.toHexString() } });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw Errors.conflict('EMPLOYEE_EXISTS', 'That staff number or user account is already on file');
      throw e;
    }
  });

  r.post('/employees/:id/salary', need(deps, 'hr', 'A'), async (req, res) => {
    const salary = parse(NewEmployee.shape.salary, req.body);
    const e = await loadEmployee(req, req.params.id);
    assertRecentMfa(deps, req);
    await db(req).collection('employees').updateOne({ _id: e._id }, { $set: { salary }, $push: { salaryHistory: { ...e.salary, until: today(), changedBy: req.actor!.userId } } as Document });
    // Amounts stay out of the audit trail; that the change happened, and by whom, is what is recorded.
    await audit(deps, req, { action: 'hr.salary.change', resource: `employee:${id(e)}`, outcome: 'success' });
    res.json({ data: { id: id(e) } });
  });

  // ---- credentials ----
  r.post('/employees/:id/credentials', need(deps, 'hr', 'A'), async (req, res) => {
    const body = parse(Credential, req.body);
    const e = await loadEmployee(req, req.params.id);
    const ins = await db(req).collection('credentials').insertOne({ tenantId: req.actor!.tenantId, employeeId: e._id, employeeName: e.name, ...body, createdAt: new Date() });
    await audit(deps, req, { action: 'hr.credential.add', resource: `employee:${id(e)}`, outcome: 'success', meta: { kind: body.kind, expiresOn: body.expiresOn } });
    res.status(201).json({ data: { id: ins.insertedId.toHexString() } });
  });

  r.get('/credentials/expiring', need(deps, 'hr', 'V'), async (req, res) => {
    const q = parse(z.object({ days: z.coerce.number().int().min(1).max(365).default(CREDENTIAL_WARNING_DAYS) }), req.query);
    const t = today();
    const until = localDate(new Date(new Date(`${t}T12:00:00Z`).getTime() + q.days * 86_400_000), 'UTC');
    const list = await db(req).collection('credentials').find({ tenantId: req.actor!.tenantId, expiresOn: { $lte: until } }).sort({ expiresOn: 1 }).toArray();
    res.json({ data: list.map((c) => ({ id: id(c), employeeId: c.employeeId.toHexString(), employeeName: c.employeeName, kind: c.kind, number: c.number, expiresOn: c.expiresOn, expired: c.expiresOn < t })) });
  });

  // ---- rosters ----
  r.post('/rosters/shifts', need(deps, 'hr', 'A'), async (req, res) => {
    const body = parse(Shift, req.body);
    const e = await loadEmployee(req, body.employeeId);
    const onLeave = await db(req).collection('leave_requests').findOne({ employeeId: e._id, status: 'Approved', from: { $lte: body.date }, to: { $gte: body.date } });
    if (onLeave) throw Errors.conflict('ON_LEAVE', `${e.name} is on approved leave that day`);
    try {
      const ins = await db(req).collection('roster_shifts').insertOne({ ...body, tenantId: req.actor!.tenantId, branchId: e.branchId, employeeId: e._id, employeeName: e.name, status: 'scheduled', createdBy: req.actor!.userId });
      res.status(201).json({ data: { id: ins.insertedId.toHexString() } });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw Errors.conflict('DOUBLE_BOOKED', `${e.name} already has a shift on ${body.date}`);
      throw err;
    }
  });

  r.get('/rosters', need(deps, 'hr', 'V'), async (req, res) => {
    const q = parse(z.object({ from: day, to: day }), req.query);
    const a = req.actor!;
    const f: Document = { tenantId: a.tenantId, date: { $gte: q.from, $lte: q.to } };
    if (isBranchBound(a.scope)) f.branchId = a.branchId ?? null;
    const list = await db(req).collection('roster_shifts').find(f).sort({ date: 1, shift: 1 }).toArray();
    res.json({ data: list.map((x) => ({ id: id(x), employeeId: x.employeeId.toHexString(), employeeName: x.employeeName, date: x.date, shift: x.shift, unit: x.unit ?? null, status: x.status })) });
  });

  // ---- leave: staff ask for themselves; HR approves, never their own ----
  r.post('/leave', async (req, res) => {
    const body = parse(Leave, req.body);
    if (body.to < body.from) throw Errors.validation([{ path: 'to', message: 'Leave must end on or after the day it starts' }]);
    const a = req.actor!;
    const me = await db(req).collection('employees').findOne({ tenantId: a.tenantId, userId: a.userId, status: 'active' });
    if (!me) await deny(deps, req, 'leave', 'your account is not linked to an employee record');
    const ins = await db(req).collection('leave_requests').insertOne({ tenantId: a.tenantId, employeeId: me!._id, employeeName: me!.name, userId: a.userId, ...body, status: 'Requested', requestedAt: new Date() });
    res.status(201).json({ data: { id: ins.insertedId.toHexString(), status: 'Requested' } });
  });

  r.get('/leave', need(deps, 'hr', 'V'), async (req, res) => {
    const list = await db(req).collection('leave_requests').find({ tenantId: req.actor!.tenantId, status: 'Requested' }).sort({ from: 1 }).toArray();
    res.json({ data: list.map((l) => ({ id: id(l), employeeName: l.employeeName, kind: l.kind, from: l.from, to: l.to, reason: l.reason ?? null, status: l.status })) });
  });

  r.post('/leave/:id/decide', need(deps, 'hr', 'A'), async (req, res) => {
    const body = parse(z.object({ decision: z.enum(['approve', 'reject']), note: z.string().trim().max(300).optional() }), req.body);
    const l = await db(req).collection('leave_requests').findOne({ _id: idParam(req.params.id, 'Leave request'), tenantId: req.actor!.tenantId });
    if (!l) throw Errors.notFound('Leave request');
    if (l.userId.equals(req.actor!.userId)) throw new AppError(403, 'FOUR_EYES', 'Someone else decides your own leave');
    const status = body.decision === 'approve' ? 'Approved' : 'Rejected';
    const upd = await db(req).collection('leave_requests').updateOne({ _id: l._id, status: 'Requested' }, { $set: { status, decidedBy: req.actor!.userId, decisionNote: body.note } });
    if (!upd.modifiedCount) throw Errors.conflict('INVALID_TRANSITION', 'Already decided');
    // Shifts in the leave window lose their person; the roster shows the gap instead of hiding it.
    const gaps = status === 'Approved' ? (await db(req).collection('roster_shifts').updateMany({ employeeId: l.employeeId, date: { $gte: l.from, $lte: l.to }, status: 'scheduled' }, { $set: { status: 'uncovered' } })).modifiedCount : 0;
    await audit(deps, req, { action: `hr.leave.${body.decision}`, resource: `leave:${id(l)}`, outcome: 'success', meta: { uncoveredShifts: gaps } });
    res.json({ data: { id: id(l), status, uncoveredShifts: gaps } });
  });

  // ---- payroll: HR prepares, finance approves and pays (four eyes) ----
  const runView = (req: Request, x: Document) => ({
    id: id(x as { _id: ObjectId }),
    period: x.period,
    currency: x.currency,
    status: x.status,
    employees: (x.lines as Document[]).length,
    grossMinor: x.grossMinor,
    deductionsMinor: x.deductionsMinor,
    netMinor: x.netMinor,
    preparedByName: x.preparedByName,
    ...(seesPay(req) ? { lines: x.lines } : {}),
  });

  r.post('/payroll/runs', need(deps, 'hr', 'A'), async (req, res) => {
    const body = parse(Run, req.body);
    const a = req.actor!;
    const end = lastDay(body.period);
    const staff = await db(req).collection('employees').find({ tenantId: a.tenantId, status: 'active', hireDate: { $lte: end }, 'salary.currency': body.currency }).sort({ staffNumber: 1 }).toArray();
    if (!staff.length) throw Errors.validation([{ path: 'period', message: `Nobody is paid in ${body.currency} for ${body.period}` }]);
    const lines = staff.map((e) => {
      const gross = e.salary.baseMinor + (e.salary.allowancesMinor ?? 0);
      const deductions = Math.min(e.salary.deductionsMinor ?? 0, gross);
      return { employeeId: e._id, staffNumber: e.staffNumber, name: e.name, grossMinor: gross, deductionsMinor: deductions, netMinor: gross - deductions };
    });
    const sum = (k: 'grossMinor' | 'deductionsMinor' | 'netMinor') => lines.reduce((n, l) => n + l[k], 0);
    try {
      const ins = await db(req).collection('payroll_runs').insertOne({ tenantId: a.tenantId, ...body, lines, grossMinor: sum('grossMinor'), deductionsMinor: sum('deductionsMinor'), netMinor: sum('netMinor'), status: 'Draft', preparedBy: a.userId, preparedByName: a.name, preparedAt: new Date() });
      await audit(deps, req, { action: 'hr.payroll.prepare', resource: `payroll:${ins.insertedId.toHexString()}`, outcome: 'success', meta: { period: body.period, employees: lines.length } });
      res.status(201).json({ data: { id: ins.insertedId.toHexString(), employees: lines.length, grossMinor: sum('grossMinor'), netMinor: sum('netMinor'), status: 'Draft' } });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw Errors.conflict('PAYROLL_EXISTS', `There is already a ${body.currency} payroll for ${body.period}`);
      throw e;
    }
  });

  r.get('/payroll/runs', async (req, res) => {
    if (!can(req.actor!.perms, 'hr', 'V') && !can(req.actor!.perms, 'acct', 'S')) await deny(deps, req, 'payroll', 'requires HR or finance access');
    const list = await db(req).collection('payroll_runs').find({ tenantId: req.actor!.tenantId }).sort({ period: -1 }).limit(60).toArray();
    res.json({ data: list.map((x) => runView(req, x)) });
  });

  async function loadRun(req: Request) {
    const x = await db(req).collection('payroll_runs').findOne({ _id: idParam(req.params.id, 'Payroll run'), tenantId: req.actor!.tenantId });
    if (!x) throw Errors.notFound('Payroll run');
    return x;
  }

  r.post('/payroll/runs/:id/approve', need(deps, 'acct', 'S'), async (req, res) => {
    const x = await loadRun(req);
    const a = req.actor!;
    if (x.preparedBy.equals(a.userId)) throw new AppError(403, 'FOUR_EYES', 'The person who prepared the payroll cannot approve it');
    assertRecentMfa(deps, req);
    if (x.status !== 'Draft') throw Errors.conflict('INVALID_TRANSITION', `Payroll is ${String(x.status).toLowerCase()}`);
    await txn(async (s) => {
      const upd = await db(req).collection('payroll_runs').updateOne({ _id: x._id, status: 'Draft' }, { $set: { status: 'Approved', approvedBy: a.userId, approvedAt: new Date() } }, { session: s });
      if (!upd.modifiedCount) throw Errors.conflict('INVALID_TRANSITION', 'Payroll changed meanwhile');
      await postEntry(db(req), s, {
        tenantId: a.tenantId!,
        postingDate: today(),
        currency: x.currency as Currency,
        memo: `Payroll ${x.period} (${(x.lines as Document[]).length} staff)`,
        lines: [{ accountCode: '5000', debitMinor: x.grossMinor }, { accountCode: '2100', creditMinor: x.grossMinor }],
        source: { type: 'payroll', id: id(x), kind: 'accrue' },
        by: a.userId,
      });
    });
    await audit(deps, req, { action: 'hr.payroll.approve', resource: `payroll:${id(x)}`, outcome: 'success', meta: { period: x.period } });
    res.json({ data: { id: id(x), status: 'Approved' } });
  });

  r.post('/payroll/runs/:id/pay', need(deps, 'acct', 'S'), async (req, res) => {
    const body = parse(z.object({ reference: z.string().trim().min(3).max(60) }), req.body);
    const x = await loadRun(req);
    const a = req.actor!;
    assertRecentMfa(deps, req);
    if (x.status !== 'Approved') throw Errors.conflict('INVALID_TRANSITION', x.status === 'Paid' ? 'This payroll is already paid' : 'Approve the payroll before paying it');
    await txn(async (s) => {
      const upd = await db(req).collection('payroll_runs').updateOne({ _id: x._id, status: 'Approved' }, { $set: { status: 'Paid', paidBy: a.userId, paidOn: today(), paymentRef: body.reference } }, { session: s });
      if (!upd.modifiedCount) throw Errors.conflict('INVALID_TRANSITION', 'Payroll changed meanwhile');
      // Net pay leaves the bank; withheld deductions stay in payroll liabilities until remitted.
      await postEntry(db(req), s, {
        tenantId: a.tenantId!,
        postingDate: today(),
        currency: x.currency as Currency,
        memo: `Salaries paid for ${x.period} (${body.reference})`,
        lines: [{ accountCode: '2100', debitMinor: x.netMinor }, { accountCode: '1010', creditMinor: x.netMinor }],
        source: { type: 'payroll', id: id(x), kind: 'pay' },
        by: a.userId,
      });
    });
    await audit(deps, req, { action: 'hr.payroll.pay', resource: `payroll:${id(x)}`, outcome: 'success', meta: { period: x.period } });
    res.json({ data: { id: id(x), status: 'Paid' } });
  });

  return r;
}
