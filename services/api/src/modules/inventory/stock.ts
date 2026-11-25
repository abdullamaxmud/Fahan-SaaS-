import type { ClientSession, Db, ObjectId } from 'mongodb';
import { AppError } from '../../lib/errors';

export interface Taken {
  lotId: ObjectId;
  batch: string;
  expiry: string;
  quantity: number;
}

/**
 * Takes stock inside the caller's transaction (spec §5.15: never allow negative available quantity).
 * With a lot: from that lot only. Without: first-expiry-first-out across unexpired lots.
 * Every decrement is conditional on enough quantity remaining, so concurrent takers cannot overdraw.
 */
export async function takeStock(
  db: Db,
  s: ClientSession,
  o: { tenantId: ObjectId; storeId: ObjectId; itemId: ObjectId; quantity: number; lotId?: ObjectId; today: string },
): Promise<Taken[]> {
  const lots = db.collection('stock_lots');
  const base = { tenantId: o.tenantId, storeId: o.storeId, itemId: o.itemId, expiry: { $gt: o.today } };
  const candidates = o.lotId
    ? await lots.find({ ...base, _id: o.lotId }, { session: s }).toArray()
    : await lots.find({ ...base, quantity: { $gt: 0 } }, { session: s }).sort({ expiry: 1, _id: 1 }).toArray();
  let need = o.quantity;
  const taken: Taken[] = [];
  for (const lot of candidates) {
    if (need <= 0) break;
    const take = Math.min(need, lot.quantity as number);
    if (take <= 0) continue;
    const upd = await lots.updateOne({ _id: lot._id, quantity: { $gte: take } }, { $inc: { quantity: -take, version: 1 } }, { session: s });
    if (!upd.modifiedCount) continue; // someone else took it first; try the next lot
    taken.push({ lotId: lot._id, batch: lot.batch, expiry: lot.expiry, quantity: take });
    need -= take;
  }
  if (need > 0) {
    const available = o.quantity - need;
    throw new AppError(409, 'INSUFFICIENT_STOCK', `Only ${available} available in this store${o.lotId ? ' for that batch' : ' in unexpired batches'}`, [], { available });
  }
  return taken;
}

export async function recordMovements(
  db: Db,
  s: ClientSession,
  base: { tenantId: ObjectId; storeId: ObjectId; itemId: ObjectId; type: string; by: ObjectId; ref?: string; reason?: string },
  lines: { lotId: ObjectId; quantity: number }[],
): Promise<void> {
  if (!lines.length) return;
  const at = new Date();
  await db.collection('inventory_movements').insertMany(
    lines.map((l) => ({ ...base, lotId: l.lotId, quantity: l.quantity, at })),
    { session: s },
  );
}

/** Adds a received batch to a store (creating the lot if new) and records the movement, in the caller's transaction. */
export async function receiveLot(
  db: Db,
  s: ClientSession,
  r: { tenantId: ObjectId; storeId: ObjectId; branchId: ObjectId; itemId: ObjectId; batch: string; expiry: string; quantity: number; by: ObjectId; ref?: string },
): Promise<{ _id: ObjectId; quantity: number }> {
  const existing = await db.collection('stock_lots').findOne({ storeId: r.storeId, itemId: r.itemId, batch: r.batch }, { session: s });
  if (existing && existing.expiry !== r.expiry) throw new AppError(409, 'BATCH_EXPIRY_MISMATCH', `Batch ${r.batch} is already recorded with expiry ${existing.expiry}`);
  const up = await db.collection('stock_lots').findOneAndUpdate(
    { tenantId: r.tenantId, storeId: r.storeId, itemId: r.itemId, batch: r.batch },
    { $inc: { quantity: r.quantity, version: 1 }, $setOnInsert: { expiry: r.expiry, branchId: r.branchId, createdAt: new Date() } },
    { upsert: true, returnDocument: 'after', session: s },
  );
  await recordMovements(db, s, { tenantId: r.tenantId, storeId: r.storeId, itemId: r.itemId, type: 'receive', by: r.by, ref: r.ref }, [{ lotId: up!._id, quantity: r.quantity }]);
  return { _id: up!._id, quantity: up!.quantity as number };
}
