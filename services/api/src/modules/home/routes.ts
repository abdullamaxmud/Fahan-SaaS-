import { Router, type Request } from 'express';
import type { Document } from 'mongodb';
import { can, isBranchBound } from '@fahan/policy';
import type { Deps } from '../../context';
import { localDate, zonedToUtc } from '../../lib/time';

/**
 * The home screen: how much work is waiting for this person right now.
 * Every number is computed with the same permission and branch rules as the module it links to,
 * so a role only ever sees counts for work it is allowed to open. Counts only — no names, no clinical detail.
 */
export function homeRoutes(deps: Deps): Router {
  const r = Router();

  r.get('/', async (req, res) => {
    const a = req.actor!;
    if (a.kind === 'platform') {
      const t = deps.data.control().collection('tenants');
      const [active, suspended] = await Promise.all([t.countDocuments({ status: 'Active' }), t.countDocuments({ status: 'Suspended' })]);
      return res.json({ data: { counts: { tenantsActive: active, tenantsSuspended: suspended } } });
    }
    res.json({ data: { counts: await tenantCounts(deps, req) } });
  });

  return r;
}

async function tenantCounts(deps: Deps, req: Request): Promise<Record<string, number>> {
  const a = req.actor!;
  const db = a.db!;
  const p = a.perms;
  const tid = a.tenantId;
  const bf: Document = isBranchBound(a.scope) ? { branchId: a.branchId ?? null } : {};
  const mine = a.scope === 'assigned-patient';
  const staffQueue = !mine; // department worklists are for department staff, not ordering clinicians
  const now = deps.config.now();
  const tz = 'Africa/Mogadishu';
  const branch = a.branchId ? await db.collection('branches').findOne({ _id: a.branchId }, { projection: { timezone: 1 } }) : null;
  const zone = (branch?.timezone as string | undefined) ?? tz;
  const today = localDate(now, zone);
  const dayStart = zonedToUtc(today, '00:00', zone);
  const dayEnd = new Date(dayStart.getTime() + 24 * 3_600_000);
  const inDays = (n: number) => localDate(new Date(now.getTime() + n * 86_400_000), zone);

  const out: Record<string, number> = {};
  const jobs: Promise<void>[] = [];
  const count = (key: string, col: string, filter: Document) =>
    jobs.push(
      db
        .collection(col)
        .countDocuments({ tenantId: tid, ...filter })
        .then((n) => void (out[key] = n))
        .catch(() => undefined),
    );

  // Front desk
  if (can(p, 'appt', 'V')) {
    const f: Document = { ...bf, startsAt: { $gte: dayStart, $lt: dayEnd } };
    if (mine) f.providerId = a.userId;
    count('apptToday', 'appointments', { ...f, status: { $nin: ['Cancelled'] } });
    count('apptWaiting', 'appointments', { ...f, status: 'CheckedIn' });
  }
  if (can(p, 'mpi', 'A')) count('mergesPending', 'merge_requests', { status: 'Pending' });
  if (can(p, 'mpi', 'E') && !mine) count('patientsProvisional', 'patients', { ...(isBranchBound(a.scope) ? { branchIds: a.branchId ?? null } : {}), status: 'Provisional', mergedInto: null });

  // Clinical care
  const clinical = ['opd', 'er', 'icu', 'mat', 'nur', 'tele'].some((m) => can(p, m as never, 'V'));
  if (clinical) {
    const f: Document = { status: { $ne: 'Closed' } };
    if (mine) f.clinicianIds = a.userId;
    else Object.assign(f, bf);
    if (mine) count('myVisits', 'encounters', f);
    count('draftNotes', 'clinical_notes', { authorId: a.userId, status: 'Draft' });
    if (mine) {
      const enc = await db.collection('encounters').find({ tenantId: tid, clinicianIds: a.userId, status: { $ne: 'Closed' } }, { projection: { _id: 1 } }).toArray();
      count('criticals', 'lab_orders', { encounterId: { $in: enc.map((e) => e._id) }, critical: { $ne: null }, 'critical.acknowledgedAt': null });
    }
  }
  if (can(p, 'er', 'V')) {
    count('erActive', 'encounters', { ...bf, type: 'ER', 'ed.state': { $in: ['Arrived', 'Triaged', 'Treating'] } });
    count('erUntriaged', 'encounters', { ...bf, type: 'ER', 'ed.state': 'Arrived' });
  }
  if (can(p, 'bed', 'V')) {
    count('bedsFree', 'beds', { ...bf, status: 'Available' });
    count('bedsOccupied', 'beds', { ...bf, status: 'Occupied' });
    count('bedsCleaning', 'beds', { ...bf, status: 'Cleaning' });
  }
  if (can(p, 'adm', 'V')) {
    const f: Document = mine ? { attendingId: a.userId } : bf;
    count('admitted', 'admissions', { ...f, status: 'Admitted' });
    count('awaitingBed', 'admissions', { ...f, status: 'Requested' });
  }
  if (can(p, 'icu', 'V')) count('icuStays', 'critical_care_stays', { ...bf, status: { $in: ['Open', 'Monitored'] } });
  if (can(p, 'sx', 'V')) count('casesToday', 'surgery_cases', { startsAt: { $gte: dayStart, $lt: dayEnd }, status: { $ne: 'Cancelled' }, ...(mine ? { $or: [{ surgeonId: a.userId }, { anesthetistId: a.userId }] } : {}) });
  if (can(p, 'mat', 'V')) count('pregnancies', 'pregnancies', { ...bf, status: 'active' });
  if (can(p, 'amb', 'V')) count('referralsActive', 'referrals', { ...bf, status: { $in: ['Requested', 'Dispatched', 'Arrived'] } });
  if (can(p, 'tele', 'V')) count('teleToday', 'telehealth_sessions', { ...(mine ? { clinicianId: a.userId } : bf), startsAt: { $gte: dayStart, $lt: dayEnd }, status: { $in: ['Scheduled', 'Connected'] } });

  // Diagnostics & medicines
  if (can(p, 'lab', 'E') && staffQueue) {
    count('labToCollect', 'lab_orders', { ...bf, status: 'Ordered' });
    count('labInProgress', 'lab_orders', { ...bf, status: { $in: ['Collected', 'Processing'] } });
    count('criticals', 'lab_orders', { ...bf, critical: { $ne: null }, 'critical.acknowledgedAt': null });
  }
  if (can(p, 'lab', 'A')) {
    count('labToVerify', 'lab_orders', { ...bf, status: 'Processing', resultsEnteredAt: { $ne: null } });
    count('labToRelease', 'lab_orders', { ...bf, status: 'Verified' });
  }
  if (can(p, 'rad', 'E') && staffQueue) count('radOpen', 'imaging_orders', { ...bf, status: { $in: ['Ordered', 'Scheduled'] } });
  if (can(p, 'rad', 'A')) count('radToReport', 'imaging_orders', { ...bf, status: { $in: ['Acquired', 'Interpreted'] } });
  if (can(p, 'dx', 'E') && staffQueue) count('dxOpen', 'diagnostic_orders', { ...bf, status: { $in: ['Ordered', 'Scheduled', 'Acquired'] } });
  if (can(p, 'rx', 'S') && staffQueue) {
    count('rxToVerify', 'prescriptions', { ...bf, status: 'Signed' });
    count('rxToDispense', 'prescriptions', { ...bf, status: 'Verified' });
  }
  if (can(p, 'inv', 'V')) count('expiringLots', 'stock_lots', { quantity: { $gt: 0 }, expiry: { $gt: today, $lte: inDays(90) } });
  if (can(p, 'bb', 'V')) count('bbRequests', 'transfusion_requests', { status: { $in: ['Requested', 'Matched'] } });
  if (can(p, 'eq', 'V')) {
    count('eqDown', 'assets', { ...bf, status: 'OutOfService' });
    count('calibrationDue', 'assets', { ...bf, nextCalibrationDue: { $lte: inDays(14) } });
  }
  if (can(p, 'eq', 'E')) count('cssdOpen', 'sterilization_batches', { ...bf, status: { $in: ['Loaded', 'Running'] } });

  // Revenue
  if (can(p, 'bill', 'E')) {
    count('invoicesDraft', 'invoices', { ...bf, status: 'Draft' });
    count('invoicesUnpaid', 'invoices', { ...bf, status: { $in: ['Issued', 'PartiallyPaid'] } });
    if (a.roles.includes('cashier')) {
      jobs.push(
        db
          .collection('cashier_sessions')
          .countDocuments({ tenantId: tid, cashierId: a.userId, status: 'open' })
          .then((n) => void (out.tillClosed = n ? 0 : 1)),
      );
    }
  }
  if (can(p, 'bill', 'S')) {
    count('refundsPending', 'refunds', { ...bf, status: 'Requested' });
    count('chargesUnpriced', 'charges', { ...bf, status: 'unpriced' });
  }
  if (can(p, 'bill', 'A')) count('tillsToApprove', 'cashier_sessions', { status: 'pending-approval' });
  if (can(p, 'ins', 'V')) {
    count('claimsDraft', 'claims', { status: 'Draft' });
    count('claimsSubmitted', 'claims', { status: 'Submitted' });
  }
  if (can(p, 'acct', 'S')) {
    count('journalsToApprove', 'journal_drafts', { status: 'Draft', createdBy: { $ne: a.userId } });
    count('payrollToApprove', 'payroll_runs', { status: 'Draft' });
    count('payrollToPay', 'payroll_runs', { status: 'Approved' });
    count('supplierInvoicesToPay', 'supplier_invoices', { status: 'Matched' });
    count('financeInsights', 'ai_insights', { kind: 'finance', status: { $in: ['Generated', 'Reviewed'] } });
  }
  if (can(p, 'proc', 'S')) count('posToApprove', 'purchase_orders', { status: 'PendingApproval', createdBy: { $ne: a.userId } });

  // People
  if (can(p, 'hr', 'V')) {
    count('leavePending', 'leave_requests', { status: 'Requested' });
    count('credentialsExpiring', 'credentials', { expiresOn: { $lte: inDays(30) } });
    count('staffActive', 'employees', { status: 'active' });
  }

  // Quality & intelligence
  if (can(p, 'qual', 'V')) {
    count('incidentsOpen', 'quality_incidents', { status: { $in: ['Reported', 'Triaged', 'Investigating'] } });
    count('ipcOpen', 'ipc_cases', { status: { $in: ['Suspected', 'Confirmed'] } });
  }
  if (can(p, 'aidis', 'S')) count('diseaseInsights', 'ai_insights', { kind: 'disease', status: can(p, 'aidis', 'A') ? { $in: ['Generated', 'Validated'] } : 'Generated' });
  if (can(p, 'acct', 'S') || can(p, 'aidis', 'V')) count('h360ToSign', 'h360_reports', { status: 'Built' });
  if (can(p, 'ai360', 'A')) count('h360ToApprove', 'h360_reports', { status: 'Reviewed' });

  // Administration
  if (can(p, 'iam', 'V')) {
    count('usersActive', 'users', { ...bf, status: 'Active', roles: { $nin: ['patient', 'caregiver'] } });
    count('usersInvited', 'users', { ...bf, status: 'Invited' });
  }
  if (can(p, 'studio', 'A')) count('formsToApprove', 'form_definitions', { status: 'Tested' });
  if (can(p, 'qual', 'A')) count('formsSafety', 'form_definitions', { status: 'Tested', highRisk: true, safetySignoff: null });
  if (can(p, 'sec', 'V')) {
    count('breakGlassToReview', 'break_glass', { review: null });
    count('securityOpen', 'security_incidents', { status: { $ne: 'Closed' } });
  }
  if (can(p, 'portal', 'V') || can(p, 'opd', 'S')) count('messagesOpen', 'portal_threads', { status: 'Open', awaiting: 'staff' });

  await Promise.all(jobs);
  return out;
}
