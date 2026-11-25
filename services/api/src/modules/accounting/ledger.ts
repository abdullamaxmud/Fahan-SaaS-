import type { ClientSession, Db, Document, ObjectId } from 'mongodb';
import { AppError } from '../../lib/errors';

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
export const CURRENCIES = ['USD', 'SOS'] as const;
export type Currency = (typeof CURRENCIES)[number];

/** Default chart of accounts (spec §5.20). Hospitals can add accounts; these codes are used by system postings. */
export const DEFAULT_CHART: [string, string, AccountType][] = [
  ['1000', 'Cash on hand', 'asset'],
  ['1010', 'Bank', 'asset'],
  ['1020', 'Mobile money', 'asset'],
  ['1030', 'Card clearing', 'asset'],
  ['1100', 'Accounts receivable — patients', 'asset'],
  ['1110', 'Accounts receivable — insurers', 'asset'],
  ['1200', 'Inventory', 'asset'],
  ['2000', 'Accounts payable', 'liability'],
  ['2050', 'Goods received not invoiced', 'liability'],
  ['2100', 'Payroll liabilities', 'liability'],
  ['3000', 'Retained earnings', 'equity'],
  ['4000', 'Consultation revenue', 'revenue'],
  ['4010', 'Laboratory revenue', 'revenue'],
  ['4020', 'Imaging & diagnostics revenue', 'revenue'],
  ['4030', 'Pharmacy revenue', 'revenue'],
  ['4040', 'Inpatient revenue', 'revenue'],
  ['4050', 'Procedure revenue', 'revenue'],
  ['4090', 'Other revenue', 'revenue'],
  ['4900', 'Discounts & write-offs', 'revenue'],
  ['4910', 'Refunds', 'revenue'],
  ['5000', 'Salaries & wages', 'expense'],
  ['5100', 'Medical supplies', 'expense'],
  ['5900', 'Other operating expenses', 'expense'],
];
export const CASH_ACCOUNT: Record<string, string> = { cash: '1000', bank: '1010', 'mobile-money': '1020', card: '1030' };

export interface Line {
  accountCode: string;
  debitMinor?: number;
  creditMinor?: number;
  costCenter?: string;
}

export async function ensureChart(db: Db, tenantId: ObjectId, s?: ClientSession): Promise<void> {
  const existing = await db.collection('accounts').countDocuments({ tenantId }, { session: s });
  if (existing) return;
  await db.collection('accounts').insertMany(
    DEFAULT_CHART.map(([code, name, type]) => ({ tenantId, code, name, type, system: true, active: true, createdAt: new Date() })),
    { session: s },
  );
}

const periodOf = (date: string) => date.slice(0, 7);

/**
 * Posts one immutable, balanced journal entry (spec §2.4, §4.3). Amounts are integer minor units.
 * `source` makes system postings idempotent: the same source + kind is posted once.
 */
export async function postEntry(
  db: Db,
  s: ClientSession,
  e: {
    tenantId: ObjectId;
    postingDate: string;
    currency: Currency;
    memo: string;
    lines: Line[];
    source: { type: string; id: string; kind: string };
    by: ObjectId;
    reversalOf?: ObjectId;
  },
): Promise<ObjectId> {
  const lines = e.lines.map((l) => ({ accountCode: l.accountCode, debitMinor: l.debitMinor ?? 0, creditMinor: l.creditMinor ?? 0, costCenter: l.costCenter }));
  for (const l of lines) {
    if (!Number.isSafeInteger(l.debitMinor) || !Number.isSafeInteger(l.creditMinor) || l.debitMinor < 0 || l.creditMinor < 0) throw new AppError(400, 'INVALID_AMOUNT', 'Amounts are whole minor units and never negative');
    if ((l.debitMinor > 0) === (l.creditMinor > 0)) throw new AppError(400, 'INVALID_LINE', `Line ${l.accountCode} must be either a debit or a credit`);
  }
  const dr = lines.reduce((n, l) => n + l.debitMinor, 0);
  const cr = lines.reduce((n, l) => n + l.creditMinor, 0);
  if (dr !== cr || dr === 0) throw new AppError(409, 'UNBALANCED_ENTRY', `Debits (${dr}) must equal credits (${cr})`);
  await ensureChart(db, e.tenantId, s);
  const codes = [...new Set(lines.map((l) => l.accountCode))];
  const found = await db.collection('accounts').countDocuments({ tenantId: e.tenantId, code: { $in: codes }, active: true }, { session: s });
  if (found !== codes.length) throw new AppError(400, 'UNKNOWN_ACCOUNT', 'One or more accounts do not exist');
  const periodKey = periodOf(e.postingDate);
  const period = await db.collection('periods').findOne({ tenantId: e.tenantId, key: periodKey }, { session: s });
  if (period?.status === 'closed') throw new AppError(409, 'PERIOD_CLOSED', `Period ${periodKey} is closed. Post in an open period`);
  const c = await db
    .collection<{ _id: string; seq: number }>('counters')
    .findOneAndUpdate({ _id: `je:${periodKey}` }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after', session: s });
  try {
    const ins = await db.collection('journal_entries').insertOne(
      {
        tenantId: e.tenantId,
        entryNo: `JE-${periodKey.replace('-', '')}-${String(c!.seq).padStart(5, '0')}`,
        postingDate: e.postingDate,
        periodKey,
        currency: e.currency,
        memo: e.memo,
        lines,
        totalMinor: dr,
        source: e.source,
        state: 'posted',
        reversalOf: e.reversalOf,
        createdBy: e.by,
        createdAt: new Date(),
      },
      { session: s },
    );
    return ins.insertedId;
  } catch (err) {
    if ((err as { code?: number }).code === 11000) throw new AppError(409, 'ALREADY_POSTED', 'This transaction has already been posted');
    throw err;
  }
}

/** Corrections never edit a posting: a mirror entry is posted in an open period (spec §4.3). */
export async function reverseEntry(db: Db, s: ClientSession, o: { tenantId: ObjectId; entryId: ObjectId; postingDate: string; reason: string; by: ObjectId }): Promise<ObjectId> {
  const je = await db.collection('journal_entries').findOne({ _id: o.entryId, tenantId: o.tenantId }, { session: s });
  if (!je) throw new AppError(404, 'NOT_FOUND', 'Journal entry not found');
  if (je.state !== 'posted' || je.reversalOf) throw new AppError(409, 'ALREADY_REVERSED', 'This entry is already reversed or is itself a reversal');
  const id = await postEntry(db, s, {
    tenantId: o.tenantId,
    postingDate: o.postingDate,
    currency: je.currency,
    memo: `Reversal of ${je.entryNo}: ${o.reason}`,
    lines: (je.lines as Document[]).map((l) => ({ accountCode: l.accountCode, debitMinor: l.creditMinor, creditMinor: l.debitMinor, costCenter: l.costCenter })),
    source: { type: je.source.type, id: je.source.id, kind: `${je.source.kind}:reversal` },
    by: o.by,
    reversalOf: je._id,
  });
  await db.collection('journal_entries').updateOne({ _id: je._id }, { $set: { state: 'reversed', reversedBy: id, reversedAt: new Date() } }, { session: s });
  return id;
}

/** Account balances for a currency, optionally limited to one period or up to a date. */
export async function balances(db: Db, tenantId: ObjectId, currency: Currency, f: { periodKey?: string; upTo?: string } = {}) {
  const match: Document = { tenantId, currency };
  if (f.periodKey) match.periodKey = f.periodKey;
  if (f.upTo) match.postingDate = { $lte: f.upTo };
  const rows = await db
    .collection('journal_entries')
    .aggregate([{ $match: match }, { $unwind: '$lines' }, { $group: { _id: '$lines.accountCode', debit: { $sum: '$lines.debitMinor' }, credit: { $sum: '$lines.creditMinor' } } }, { $sort: { _id: 1 } }])
    .toArray();
  return rows.map((r) => ({ accountCode: r._id as string, debitMinor: r.debit as number, creditMinor: r.credit as number }));
}
