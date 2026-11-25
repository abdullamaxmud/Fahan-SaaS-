import { Router, type Request } from 'express';
import type { ClientSession, Document, ObjectId } from 'mongodb';
import { z } from 'zod';
import { isBranchBound } from '@fahan/policy';
import type { Deps } from '../../context';
import { AppError, Errors } from '../../lib/errors';
import { localDate } from '../../lib/time';
import { objectId, parse } from '../../lib/validate';
import { audit } from '../../middleware/audit';
import { assertBranch, need } from '../../middleware/authorize';
import { recordMovements, takeStock } from './stock';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const qty = z.number().int().positive().max(1_000_000);
const NewStore = z.object({ branchId: objectId, code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,12}$/), name: z.string().trim().min(2).max(80), kind: z.enum(['main', 'pharmacy', 'ward', 'laboratory', 'theatre']) });
const NewItem = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,20}$/),
  name: z.string().trim().min(2).max(120),
  unit: z.string().trim().min(1).max(20),
  kind: z.enum(['medicine', 'consumable', 'reagent', 'other']),
  reorderLevel: z.number().int().min(0).max(1_000_000).default(0),
  medicine: z
    .object({ ingredient: z.string().trim().min(2).max(120), strength: z.string().trim().min(1).max(40), form: z.enum(['tablet', 'capsule', 'syrup', 'injection', 'infusion', 'cream', 'drops', 'inhaler', 'other']), route: z.enum(['oral', 'iv', 'im', 'sc', 'topical', 'inhaled', 'rectal', 'other']), classes: z.array(z.string().trim().toLowerCase().min(2).max(40)).max(10).default([]) })
    .optional(),
});
const Receive = z.object({ storeId: objectId, itemId: objectId, batch: z.string().trim().min(1).max(40), expiry: day, quantity: qty, supplierRef: z.string().trim().max(60).optional() });
const Transfer = z.object({ fromStoreId: objectId, toStoreId: objectId, itemId: objectId, quantity: qty, lotId: objectId.optional() });
const Issue = z.object({ storeId: objectId, itemId: objectId, quantity: qty, reason: z.string().trim().min(3).max(200), lotId: objectId.optional() });
const Adjust = z.object({ lotId: objectId, delta: z.number().int().refine((n) => n !== 0, 'Use a non-zero amount'), reason: z.string().trim().min(5).max(300) });

const id = (x: { _id: ObjectId }) => x._id.toHexString();

/** Spec §5.15 inventory & supply chain. */
export function inventoryRoutes(deps: Deps): Router {
  const r = Router();
  const db = (req: Request) => req.actor!.db!;
  const today = () => localDate(deps.config.now(), 'Africa/Mogadishu');

  async function store(req: Request, storeId: ObjectId) {
    const s = await db(req).collection('stores').findOne({ _id: storeId, tenantId: req.actor!.tenantId });
    if (!s) throw Errors.notFound('Store');
    await assertBranch(deps, req, s.branchId);
    return s;
  }
  async function item(req: Request, itemId: ObjectId) {
    const i = await db(req).collection('items').findOne({ _id: itemId, tenantId: req.actor!.tenantId });
    if (!i) throw Errors.notFound('Item');
    return i;
  }
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

  r.get('/stores', need(deps, 'inv', 'V'), async (req, res) => {
    const a = req.actor!;
    const f: Document = { tenantId: a.tenantId };
    if (isBranchBound(a.scope)) f.branchId = a.branchId ?? null;
    const list = await db(req).collection('stores').find(f).sort({ code: 1 }).toArray();
    res.json({ data: list.map((s) => ({ id: id(s), code: s.code, name: s.name, kind: s.kind, branchId: s.branchId.toHexString() })) });
  });

  r.post('/stores', need(deps, 'inv', 'E'), async (req, res) => {
    const body = parse(NewStore, req.body);
    await assertBranch(deps, req, body.branchId);
    try {
      const ins = await db(req).collection('stores').insertOne({ tenantId: req.actor!.tenantId, ...body, createdAt: new Date() });
      res.status(201).json({ data: { id: ins.insertedId.toHexString(), code: body.code } });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw Errors.conflict('STORE_EXISTS', `Store ${body.code} already exists`);
      throw e;
    }
  });

  r.get('/items', need(deps, 'inv', 'V'), async (req, res) => {
    const q = parse(z.object({ q: z.string().trim().max(60).optional(), kind: z.string().optional() }), req.query);
    const f: Document = { tenantId: req.actor!.tenantId };
    if (q.kind) f.kind = q.kind;
    if (q.q) f.$or = [{ name: { $regex: q.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }, { code: q.q.toUpperCase() }];
    const list = await db(req).collection('items').find(f).sort({ name: 1 }).limit(200).toArray();
    res.json({ data: list.map(({ _id, tenantId, ...i }) => ({ id: _id.toHexString(), ...i })) });
  });

  r.post('/items', need(deps, 'inv', 'E'), async (req, res) => {
    const body = parse(NewItem, req.body);
    if (body.kind === 'medicine' && !body.medicine) throw Errors.validation([{ path: 'medicine', message: 'Medicines need ingredient, strength, form and route' }]);
    try {
      const ins = await db(req).collection('items').insertOne({ tenantId: req.actor!.tenantId, ...body, createdAt: new Date(), createdBy: req.actor!.userId });
      await audit(deps, req, { action: 'inv.item.create', resource: `item:${ins.insertedId.toHexString()}`, outcome: 'success', meta: { code: body.code } });
      res.status(201).json({ data: { id: ins.insertedId.toHexString(), code: body.code } });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw Errors.conflict('ITEM_EXISTS', `Item ${body.code} already exists`);
      throw e;
    }
  });

  r.get('/stock', need(deps, 'inv', 'V'), async (req, res) => {
    const q = parse(z.object({ storeId: objectId }), req.query);
    const s = await store(req, q.storeId);
    const lots = await db(req).collection('stock_lots').find({ storeId: s._id, quantity: { $gt: 0 } }).sort({ expiry: 1 }).toArray();
    const items = await db(req).collection('items').find({ _id: { $in: lots.map((l) => l.itemId) } }).toArray();
    const t = today();
    const soon = localDate(new Date(deps.config.now().getTime() + 90 * 86_400_000), 'Africa/Mogadishu');
    const rows = items.map((i) => {
      const mine = lots.filter((l) => l.itemId.equals(i._id));
      const usable = mine.filter((l) => l.expiry > t).reduce((n, l) => n + l.quantity, 0);
      return {
        itemId: id(i),
        code: i.code,
        name: i.name,
        unit: i.unit,
        usable,
        expired: mine.filter((l) => l.expiry <= t).reduce((n, l) => n + l.quantity, 0),
        low: usable < (i.reorderLevel ?? 0),
        lots: mine.map((l) => ({ id: id(l), batch: l.batch, expiry: l.expiry, quantity: l.quantity, status: l.expiry <= t ? 'expired' : l.expiry <= soon ? 'expiring' : 'ok' })),
      };
    });
    res.json({ data: rows.sort((x, y) => x.name.localeCompare(y.name)) });
  });

  r.post('/receive', need(deps, 'inv', 'E'), async (req, res) => {
    const body = parse(Receive, req.body);
    const s = await store(req, body.storeId);
    await item(req, body.itemId);
    if (body.expiry <= today()) throw Errors.validation([{ path: 'expiry', message: 'This batch has already expired' }]);
    const a = req.actor!;
    const lot = await txn(async (ss) => {
      const existing = await db(req).collection('stock_lots').findOne({ storeId: s._id, itemId: body.itemId, batch: body.batch }, { session: ss });
      if (existing && existing.expiry !== body.expiry) throw new AppError(409, 'BATCH_EXPIRY_MISMATCH', `Batch ${body.batch} is already recorded with expiry ${existing.expiry}`);
      const up = await db(req).collection('stock_lots').findOneAndUpdate(
        { tenantId: a.tenantId!, storeId: s._id, itemId: body.itemId, batch: body.batch },
        { $inc: { quantity: body.quantity, version: 1 }, $setOnInsert: { expiry: body.expiry, branchId: s.branchId, createdAt: new Date() } },
        { upsert: true, returnDocument: 'after', session: ss },
      );
      await recordMovements(db(req), ss, { tenantId: a.tenantId!, storeId: s._id, itemId: body.itemId, type: 'receive', by: a.userId, ref: body.supplierRef }, [{ lotId: up!._id, quantity: body.quantity }]);
      return up!;
    });
    await audit(deps, req, { action: 'inv.receive', resource: `lot:${id(lot)}`, outcome: 'success', meta: { quantity: body.quantity } });
    res.status(201).json({ data: { lotId: id(lot), quantity: lot.quantity } });
  });

  r.post('/transfer', need(deps, 'inv', 'E'), async (req, res) => {
    const body = parse(Transfer, req.body);
    if (body.fromStoreId.equals(body.toStoreId)) throw Errors.validation([{ path: 'toStoreId', message: 'Choose a different store' }]);
    const [from, to] = [await store(req, body.fromStoreId), await store(req, body.toStoreId)];
    const a = req.actor!;
    const taken = await txn(async (s) => {
      const t = await takeStock(db(req), s, { tenantId: a.tenantId!, storeId: from._id, itemId: body.itemId, quantity: body.quantity, lotId: body.lotId, today: today() });
      const inLines: { lotId: ObjectId; quantity: number }[] = [];
      for (const x of t) {
        const dest = await db(req).collection('stock_lots').findOneAndUpdate(
          { tenantId: a.tenantId!, storeId: to._id, itemId: body.itemId, batch: x.batch },
          { $inc: { quantity: x.quantity, version: 1 }, $setOnInsert: { expiry: x.expiry, branchId: to.branchId, createdAt: new Date() } },
          { upsert: true, returnDocument: 'after', session: s },
        );
        inLines.push({ lotId: dest!._id, quantity: x.quantity });
      }
      const ref = `transfer:${from.code}->${to.code}`;
      await recordMovements(db(req), s, { tenantId: a.tenantId!, storeId: from._id, itemId: body.itemId, type: 'transfer-out', by: a.userId, ref }, t.map((x) => ({ lotId: x.lotId, quantity: -x.quantity })));
      await recordMovements(db(req), s, { tenantId: a.tenantId!, storeId: to._id, itemId: body.itemId, type: 'transfer-in', by: a.userId, ref }, inLines);
      return t;
    });
    await audit(deps, req, { action: 'inv.transfer', resource: `item:${body.itemId.toHexString()}`, outcome: 'success', meta: { quantity: body.quantity, from: from.code, to: to.code } });
    res.json({ data: { moved: taken } });
  });

  r.post('/issue', need(deps, 'inv', 'E'), async (req, res) => {
    const body = parse(Issue, req.body);
    const s = await store(req, body.storeId);
    const a = req.actor!;
    const taken = await txn(async (ss) => {
      const t = await takeStock(db(req), ss, { tenantId: a.tenantId!, storeId: s._id, itemId: body.itemId, quantity: body.quantity, lotId: body.lotId, today: today() });
      await recordMovements(db(req), ss, { tenantId: a.tenantId!, storeId: s._id, itemId: body.itemId, type: 'issue', by: a.userId, reason: body.reason }, t.map((x) => ({ lotId: x.lotId, quantity: -x.quantity })));
      return t;
    });
    await audit(deps, req, { action: 'inv.issue', resource: `item:${body.itemId.toHexString()}`, outcome: 'success', meta: { quantity: body.quantity } });
    res.json({ data: { taken } });
  });

  r.post('/adjust', need(deps, 'inv', 'E'), async (req, res) => {
    const body = parse(Adjust, req.body);
    const a = req.actor!;
    const lot = await db(req).collection('stock_lots').findOne({ _id: body.lotId, tenantId: a.tenantId });
    if (!lot) throw Errors.notFound('Batch');
    await store(req, lot.storeId);
    await txn(async (s) => {
      const filter: Document = { _id: lot._id };
      if (body.delta < 0) filter.quantity = { $gte: -body.delta };
      const upd = await db(req).collection('stock_lots').updateOne(filter, { $inc: { quantity: body.delta, version: 1 } }, { session: s });
      if (!upd.modifiedCount) throw new AppError(409, 'INSUFFICIENT_STOCK', 'An adjustment cannot make stock negative');
      await recordMovements(db(req), s, { tenantId: a.tenantId!, storeId: lot.storeId, itemId: lot.itemId, type: 'adjust', by: a.userId, reason: body.reason }, [{ lotId: lot._id, quantity: body.delta }]);
    });
    await audit(deps, req, { action: 'inv.adjust', resource: `lot:${id(lot)}`, outcome: 'success', meta: { delta: body.delta } });
    res.json({ data: { lotId: id(lot) } });
  });

  r.get('/movements', need(deps, 'inv', 'V'), async (req, res) => {
    const q = parse(z.object({ itemId: objectId, storeId: objectId.optional() }), req.query);
    const f: Document = { tenantId: req.actor!.tenantId, itemId: q.itemId };
    if (q.storeId) {
      await store(req, q.storeId);
      f.storeId = q.storeId;
    }
    const list = await db(req).collection('inventory_movements').find(f).sort({ at: -1 }).limit(200).toArray();
    res.json({ data: list.map((m) => ({ id: id(m), type: m.type, quantity: m.quantity, lotId: m.lotId.toHexString(), storeId: m.storeId.toHexString(), ref: m.ref ?? null, reason: m.reason ?? null, at: m.at })) });
  });

  return r;
}

