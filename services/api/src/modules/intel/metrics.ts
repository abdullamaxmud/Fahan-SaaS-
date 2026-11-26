import { createHash } from 'node:crypto';
import type { Db, Document, ObjectId } from 'mongodb';
import { localDate, tzOffsetMs } from '../../lib/time';
import { balances, type Currency } from '../accounting/ledger';

/**
 * Certified metric definitions (spec §5.29 "metric definitions versioned", §9.3, §9.4, §9.5).
 * Every number an AI narrative or report shows comes from one of these, by id, with its version.
 */
export const SUPPRESSION_THRESHOLD = 5;
export type MetricUnit = 'minor' | 'count' | 'percent' | 'minutes' | 'days';
export interface MetricDef {
  id: string;
  version: string;
  domain: 'finance' | 'disease' | 'operations';
  label: string;
  unit: MetricUnit;
  definition: string;
}

const fin = (id: string, label: string, definition: string): MetricDef => ({ id: `fin.${id}`, version: 'finance-v1', domain: 'finance', label, unit: 'minor', definition });
const ops = (id: string, label: string, unit: MetricUnit, definition: string): MetricDef => ({ id: `ops.${id}`, version: 'operations-v1', domain: 'operations', label, unit, definition });

export const METRICS: MetricDef[] = [
  fin('grossBilled', 'Gross billed', 'Sum of issued invoice lines before discounts, by issue date in the month (voided excluded).'),
  fin('discounts', 'Discounts', 'Discounts on invoices issued in the month.'),
  fin('netBilled', 'Net billed', 'Gross billed minus discounts.'),
  fin('cashCollected', 'Cash collected', 'Settled payments received in the month minus refunds paid in the month.'),
  fin('refundsPaid', 'Refunds paid', 'Refunds paid in the month.'),
  fin('accountsReceivable', 'Accounts receivable', 'Balance of patient and insurer receivable accounts (1100, 1110) at month end.'),
  fin('recognizedRevenue', 'Recognised revenue', 'Credit side of posted revenue accounts in the month, net of discounts, refunds and write-offs.'),
  fin('operatingExpenses', 'Operating expenses', 'Debit side of posted expense accounts in the month.'),
  fin('operatingResult', 'Operating result', 'Recognised revenue minus operating expenses.'),
  { id: 'dis.confirmedPatients', version: 'disease-v1', domain: 'disease', label: 'Confirmed patients', unit: 'count', definition: 'Unique patients with at least one confirmed diagnosis of the code in the month (hospital time zone), deduplicated by patient + code + month. Ruled-out excluded.' },
  { id: 'dis.confirmedEncounters', version: 'disease-v1', domain: 'disease', label: 'Confirmed encounters', unit: 'count', definition: 'Unique visits with a confirmed diagnosis of the code in the month.' },
  { id: 'dis.newPatients', version: 'disease-v1', domain: 'disease', label: 'Newly diagnosed patients', unit: 'count', definition: 'Confirmed patients whose first confirmed diagnosis of the code falls in the month.' },
  { id: 'dis.suspectedPatients', version: 'disease-v1', domain: 'disease', label: 'Suspected patients', unit: 'count', definition: 'Unique patients with a suspected (not confirmed) diagnosis of the code in the month; reported separately, never added to confirmed.' },
  ops('opdVisits', 'Outpatient visits', 'count', 'Outpatient encounters started in the month.'),
  ops('erVisits', 'Emergency visits', 'count', 'Emergency encounters started in the month.'),
  ops('admissions', 'Admissions', 'count', 'Patients admitted to a bed in the month.'),
  ops('discharges', 'Discharges', 'count', 'Admissions discharged in the month.'),
  ops('alos', 'Average length of stay', 'days', 'Mean days from admission to discharge for discharges in the month.'),
  ops('occupancy', 'Bed occupancy', 'percent', 'Occupied bed-days in the month ÷ (beds × days in month).'),
  ops('labReleased', 'Lab results released', 'count', 'Laboratory orders released in the month.'),
  ops('labTatMedian', 'Lab turnaround (median)', 'minutes', 'Median minutes from order to release for results released in the month.'),
  ops('criticalAckMedian', 'Critical result acknowledgement (median)', 'minutes', 'Median minutes from critical value to clinician acknowledgement, acknowledged in the month.'),
  ops('imagingBacklog', 'Imaging backlog', 'count', 'Radiology and diagnostic orders not yet final when the snapshot was taken.'),
  ops('dispenses', 'Prescriptions dispensed', 'count', 'Prescriptions dispensed in the month.'),
  ops('stockouts', 'Stock-outs', 'count', 'Catalogue items with a reorder level and no usable stock when the snapshot was taken.'),
  ops('purchaseOrdersApproved', 'Purchase orders approved', 'count', 'Purchase orders approved in the month.'),
  ops('equipmentOutOfService', 'Equipment out of service', 'count', 'Devices out of service when the snapshot was taken.'),
  ops('rosterGaps', 'Uncovered shifts', 'count', 'Rostered shifts in the month left uncovered by approved leave.'),
  ops('qualityIncidents', 'Quality incidents', 'count', 'Incidents reported in the month (needs the quality module).'),
];
export const metricDef = (id: string) => METRICS.find((m) => m.id === id);

// ---------- helpers ----------

/** Canonical JSON (sorted keys) so the same facts always hash the same. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v as object)
    .sort()
    .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}
export const factsHash = (x: unknown) => createHash('sha256').update(canonical(x)).digest('hex');

export async function hospitalTz(db: Db, tenantId: ObjectId): Promise<string> {
  const b = await db.collection('branches').findOne({ tenantId }, { sort: { createdAt: 1 }, projection: { timezone: 1 } });
  return (b?.timezone as string) ?? 'Africa/Mogadishu';
}

/** UTC instants for the start of the month and the start of the next month, in the hospital's time zone. */
export function monthBounds(period: string, tz: string): { from: Date; to: Date; days: number; lastDay: string } {
  const [y, m] = period.split('-').map(Number);
  const startUtc = new Date(Date.UTC(y!, m! - 1, 1));
  const endUtc = new Date(Date.UTC(y!, m!, 1));
  const days = Math.round((endUtc.getTime() - startUtc.getTime()) / 86_400_000);
  return {
    from: new Date(startUtc.getTime() - tzOffsetMs(startUtc, tz)),
    to: new Date(endUtc.getTime() - tzOffsetMs(endUtc, tz)),
    days,
    lastDay: `${period}-${String(days).padStart(2, '0')}`,
  };
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
};
const round1 = (n: number) => Math.round(n * 10) / 10;
/** Small cohorts are suppressed (spec §5.29): 1–4 becomes null with a flag; 0 stays 0. */
export const suppress = (n: number) => (n > 0 && n < SUPPRESSION_THRESHOLD ? null : n);

export function ageBand(dob: string | undefined, at: Date): string {
  if (!dob) return 'unknown';
  const d = new Date(`${dob}T00:00:00Z`);
  let age = at.getUTCFullYear() - d.getUTCFullYear();
  if (at.getUTCMonth() < d.getUTCMonth() || (at.getUTCMonth() === d.getUTCMonth() && at.getUTCDate() < d.getUTCDate())) age--;
  return age < 5 ? '0-4' : age < 15 ? '5-14' : age < 25 ? '15-24' : age < 45 ? '25-44' : age < 65 ? '45-64' : '65+';
}

// ---------- finance (spec §9.4) ----------

export interface FinanceFacts {
  metrics: Record<string, number>;
  revenueMix: { accountCode: string; name: string; amountMinor: number }[];
  expenseMix: { accountCode: string; name: string; amountMinor: number }[];
  counts: { invoicesIssued: number; payments: number; refunds: number };
}

export async function computeFinance(db: Db, tenantId: ObjectId, period: string, currency: Currency): Promise<FinanceFacts> {
  const inMonth = { $gte: `${period}-01`, $lte: `${period}-31` };
  const inv = await db.collection('invoices').find({ tenantId, currency, status: { $nin: ['Draft', 'Voided'] }, issuedOn: inMonth }, { projection: { subtotalMinor: 1, discountMinor: 1 } }).toArray();
  const gross = inv.reduce((n, i) => n + (i.subtotalMinor as number), 0);
  const discounts = inv.reduce((n, i) => n + (i.discountMinor as number), 0);
  const pays = await db.collection('payments').aggregate([{ $match: { tenantId, currency, receivedOn: inMonth } }, { $group: { _id: null, n: { $sum: '$amountMinor' }, c: { $sum: 1 } } }]).toArray();
  const refs = await db.collection('refunds').aggregate([{ $match: { tenantId, currency, status: 'Paid', paidOn: inMonth } }, { $group: { _id: null, n: { $sum: '$amountMinor' }, c: { $sum: 1 } } }]).toArray();
  const inPeriod = await balances(db, tenantId, currency, { periodKey: period });
  const toDate = await balances(db, tenantId, currency, { upTo: `${period}-31` });
  const accts = await db.collection('accounts').find({ tenantId }).toArray();
  const acct = (code: string) => accts.find((x) => x.code === code);
  const net = (rows: typeof inPeriod, code: string, side: 'credit' | 'debit') => {
    const r = rows.find((x) => x.accountCode === code);
    return r ? (side === 'credit' ? r.creditMinor - r.debitMinor : r.debitMinor - r.creditMinor) : 0;
  };
  const revenueMix = inPeriod.filter((r) => acct(r.accountCode)?.type === 'revenue').map((r) => ({ accountCode: r.accountCode, name: acct(r.accountCode)!.name as string, amountMinor: net(inPeriod, r.accountCode, 'credit') }));
  const expenseMix = inPeriod.filter((r) => acct(r.accountCode)?.type === 'expense').map((r) => ({ accountCode: r.accountCode, name: acct(r.accountCode)!.name as string, amountMinor: net(inPeriod, r.accountCode, 'debit') }));
  const recognized = revenueMix.reduce((n, r) => n + r.amountMinor, 0);
  const expenses = expenseMix.reduce((n, r) => n + r.amountMinor, 0);
  const refundsPaid = (refs[0]?.n as number) ?? 0;
  return {
    metrics: {
      'fin.grossBilled': gross,
      'fin.discounts': discounts,
      'fin.netBilled': gross - discounts,
      'fin.cashCollected': ((pays[0]?.n as number) ?? 0) - refundsPaid,
      'fin.refundsPaid': refundsPaid,
      'fin.accountsReceivable': net(toDate, '1100', 'debit') + net(toDate, '1110', 'debit'),
      'fin.recognizedRevenue': recognized,
      'fin.operatingExpenses': expenses,
      'fin.operatingResult': recognized - expenses,
    },
    revenueMix: revenueMix.filter((r) => r.amountMinor !== 0),
    expenseMix: expenseMix.filter((r) => r.amountMinor !== 0),
    counts: { invoicesIssued: inv.length, payments: (pays[0]?.c as number) ?? 0, refunds: (refs[0]?.c as number) ?? 0 },
  };
}

// ---------- disease (spec §9.3) ----------

export interface DiseaseRow {
  code: string;
  display: string;
  confirmedPatients: number | null;
  confirmedEncounters: number | null;
  newPatients: number | null;
  suspectedPatients: number | null;
  byAgeBand: Record<string, number | null>;
  byBranch: Record<string, number | null>;
}

export async function computeDisease(db: Db, tenantId: ObjectId, period: string, tz: string): Promise<{ rows: DiseaseRow[]; suppressedCells: number; totalConfirmedPatients: number | null }> {
  const { from, to } = monthBounds(period, tz);
  const dx = await db.collection('diagnoses').find({ tenantId, recordedAt: { $gte: from, $lt: to }, certainty: { $in: ['confirmed', 'suspected'] } }, { projection: { code: 1, display: 1, certainty: 1, patientId: 1, encounterId: 1, branchId: 1, recordedAt: 1 } }).toArray();
  // Merged records count once, under the surviving patient.
  const pats = await db.collection('patients').find({ _id: { $in: dx.map((d) => d.patientId) } }, { projection: { dob: 1, mergedInto: 1 } }).toArray();
  const survivor = (id: ObjectId) => ((pats.find((p) => p._id.equals(id))?.mergedInto as ObjectId | undefined) ?? id).toHexString();
  const dobOf = (pid: string) => (pats.find((p) => p._id.toHexString() === pid)?.dob as string | undefined) ?? (pats.find((p) => survivor(p._id) === pid)?.dob as string | undefined);
  const branches = await db.collection('branches').find({ tenantId }, { projection: { code: 1 } }).toArray();
  const branchCode = (b: ObjectId) => (branches.find((x) => x._id.equals(b))?.code as string) ?? 'unknown';

  const codes = [...new Set(dx.map((d) => d.code as string))].sort();
  let suppressedCells = 0;
  const sup = (n: number) => {
    const v = suppress(n);
    if (v === null) suppressedCells++;
    return v;
  };
  const rows: DiseaseRow[] = [];
  const allConfirmed = new Set<string>();
  for (const code of codes) {
    const conf = dx.filter((d) => d.code === code && d.certainty === 'confirmed');
    const susp = dx.filter((d) => d.code === code && d.certainty === 'suspected');
    const confPatients = new Map<string, Document>();
    for (const d of conf) {
      const p = survivor(d.patientId);
      if (!confPatients.has(p)) confPatients.set(p, d);
      allConfirmed.add(p);
    }
    const confirmedSet = new Set(confPatients.keys());
    const suspectedOnly = new Set(susp.map((d) => survivor(d.patientId)).filter((p) => !confirmedSet.has(p)));
    const earlier = await db
      .collection('diagnoses')
      .find({ tenantId, code, certainty: 'confirmed', recordedAt: { $lt: from }, patientId: { $in: conf.map((d) => d.patientId) } }, { projection: { patientId: 1 } })
      .toArray();
    const seenBefore = new Set(earlier.map((d) => survivor(d.patientId)));
    const byAge: Record<string, number> = {};
    const byBranch: Record<string, number> = {};
    for (const [p, d] of confPatients) {
      const band = ageBand(dobOf(p), d.recordedAt as Date);
      byAge[band] = (byAge[band] ?? 0) + 1;
      const bc = branchCode(d.branchId as ObjectId);
      byBranch[bc] = (byBranch[bc] ?? 0) + 1;
    }
    rows.push({
      code,
      display: (conf[0] ?? susp[0])!.display as string,
      confirmedPatients: sup(confirmedSet.size),
      confirmedEncounters: sup(new Set(conf.map((d) => d.encounterId.toHexString())).size),
      newPatients: sup([...confirmedSet].filter((p) => !seenBefore.has(p)).length),
      suspectedPatients: sup(suspectedOnly.size),
      byAgeBand: Object.fromEntries(Object.entries(byAge).sort().map(([k, v]) => [k, sup(v)])),
      byBranch: Object.fromEntries(Object.entries(byBranch).sort().map(([k, v]) => [k, sup(v)])),
    });
  }
  rows.sort((a, b) => (b.confirmedPatients ?? 0) - (a.confirmedPatients ?? 0) || a.code.localeCompare(b.code));
  return { rows, suppressedCells, totalConfirmedPatients: suppress(allConfirmed.size) };
}

// ---------- operations (spec §9.5) ----------

export async function computeOperations(db: Db, tenantId: ObjectId, period: string, tz: string, now: Date): Promise<{ metrics: Record<string, number | null>; unavailable: Record<string, string> }> {
  const { from, to, days } = monthBounds(period, tz);
  const t = { tenantId };
  const range = { $gte: from, $lt: to };
  const inMonthDay = { $gte: `${period}-01`, $lte: `${period}-31` };
  const count = (c: string, f: Document) => db.collection(c).countDocuments({ ...t, ...f });

  const discharged = await db.collection('admissions').find({ ...t, 'discharge.at': range }, { projection: { admittedAt: 1, discharge: 1 } }).toArray();
  const stays = discharged.filter((a) => a.admittedAt).map((a) => ((a.discharge.at as Date).getTime() - (a.admittedAt as Date).getTime()) / 86_400_000);
  const overlapping = await db.collection('admissions').find({ ...t, admittedAt: { $lt: to }, $or: [{ 'discharge.at': { $gte: from } }, { status: 'Admitted' }] }, { projection: { admittedAt: 1, discharge: 1 } }).toArray();
  const bedMs = overlapping.reduce((n, a) => {
    const s = Math.max((a.admittedAt as Date).getTime(), from.getTime());
    const e = Math.min(((a.discharge?.at as Date | undefined) ?? (now < to ? now : to)).getTime(), to.getTime());
    return n + Math.max(0, e - s);
  }, 0);
  const beds = await count('beds', {});
  const released = await db.collection('lab_orders').find({ ...t, releasedAt: range }, { projection: { orderedAt: 1, releasedAt: 1 } }).toArray();
  const acks = await db.collection('lab_orders').find({ ...t, 'critical.acknowledgedAt': range }, { projection: { critical: 1 } }).toArray();
  const backlog = (await count('imaging_orders', { status: { $in: ['Ordered', 'Scheduled', 'Acquired', 'Interpreted'] } })) + (await count('diagnostic_orders', { status: { $in: ['Ordered', 'Scheduled', 'Acquired', 'Interpreted'] } }));
  const items = await db.collection('items').find({ ...t, reorderLevel: { $gt: 0 } }, { projection: { _id: 1 } }).toArray();
  const today = localDate(now, tz);
  const stocked = await db.collection('stock_lots').aggregate([{ $match: { ...t, itemId: { $in: items.map((i) => i._id) }, expiry: { $gt: today }, quantity: { $gt: 0 } } }, { $group: { _id: '$itemId' } }]).toArray();

  return {
    metrics: {
      'ops.opdVisits': await count('encounters', { type: 'OPD', startedAt: range }),
      'ops.erVisits': await count('encounters', { type: 'ER', startedAt: range }),
      'ops.admissions': await count('admissions', { admittedAt: range }),
      'ops.discharges': discharged.length,
      'ops.alos': stays.length ? round1(stays.reduce((n, x) => n + x, 0) / stays.length) : null,
      'ops.occupancy': beds ? round1((bedMs / 86_400_000 / (beds * days)) * 100) : null,
      'ops.labReleased': released.length,
      'ops.labTatMedian': median(released.filter((o) => o.orderedAt).map((o) => Math.round(((o.releasedAt as Date).getTime() - (o.orderedAt as Date).getTime()) / 60_000))),
      'ops.criticalAckMedian': median(acks.map((o) => o.critical.minutesToAcknowledge as number).filter((n) => typeof n === 'number')),
      'ops.imagingBacklog': backlog,
      'ops.dispenses': await count('prescriptions', { 'dispensed.at': range }),
      'ops.stockouts': items.length - stocked.length,
      'ops.purchaseOrdersApproved': await count('purchase_orders', { approvedAt: range }),
      'ops.equipmentOutOfService': await count('assets', { status: 'OutOfService' }),
      'ops.rosterGaps': await count('roster_shifts', { date: inMonthDay, status: 'uncovered' }),
      'ops.qualityIncidents': null,
    },
    unavailable: { 'ops.qualityIncidents': 'The quality & incidents module is not live yet.' },
  };
}
