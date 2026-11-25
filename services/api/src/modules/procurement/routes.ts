import { Router, type Request } from 'express';
import type { ClientSession, Document, ObjectId } from 'mongodb';
import { z } from 'zod';
import { can } from '@fahan/policy';
import type { Deps } from '../../context';
import { AppError, Errors } from '../../lib/errors';
import { localDate } from '../../lib/time';
import { idParam, objectId, parse } from '../../lib/validate';
import { audit } from '../../middleware/audit';
import { assertBranch, deny, need } from '../../middleware/authorize';
import { assertRecentMfa } from '../../middleware/session';
import { CURRENCIES, postEntry, type Currency } from '../accounting/ledger';
import { receiveLot } from '../inventory/stock';

/** Spec §5.16 approval limits: orders above this need the finance director (proc:A); below, a procurement supervisor (proc:S). */
export const PO_SUPERVISOR_LIMIT_MINOR = 50_000;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const qty = z.number().int().positive().max(1_000_000);
const price = z.number().int().positive().max(1e10);
const NewSupplier = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,20}$/),
  name: z.string().trim().min(2).max(120),
  currency: z.enum(CURRENCIES),
  phone: z.string().trim().max(30).optional(),
  taxId: z.string().trim().max(40).optional(),
});
const NewOrder = z.object({
  supplierId: objectId,
  storeId: objectId,
  lines: z.array(z.object({ itemId: objectId, quantity: qty, unitPriceMinor: price })).min(1).max(100),
  note: z.string().trim().max(300).optional(),
});
const Receipt = z.object({ lines: z.array(z.object({ itemId: objectId, quantity: qty, batch: z.string().trim().min(1).max(40), expiry: day })).min(1).max(100), deliveryNote: z.string().trim().max(60).optional() });
const SupplierInvoice = z.object({
  orderId: objectId,
  invoiceNo: z.string().trim().toUpperCase().min(1).max(40),
  invoiceDate: day,
  lines: z.array(z.object({ itemId: objectId, quantity: qty, unitPriceMinor: price })).min(1).max(100),
});
const Reason = z.object({ reason: z.string().trim().min(5).max(300) });

const id = (x: { _id: ObjectId }) => x._id.toHexString();

/**
 * Spec §5.16 procurement and §6 procure-to-pay: requisition → approved order → goods receipt → supplier invoice
 * (3-way match) → payment. Receipt: Dr inventory / Cr goods received not invoiced. Invoice: Dr GRNI / Cr payables.
 */
export function procurementRoutes(deps: Deps): Router {
  const r = Router();
  const db = (req: Request) => req.actor!.db!;
  const today = () => localDate(deps.config.now(), 'Africa/Mogadishu');

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
  async function number(req: Request, prefix: string, s: ClientSession) {
    const y = today().slice(0, 4);
    const c = await db(req).collection<{ _id: string; seq: number }>('counters').findOneAndUpdate({ _id: `${prefix.toLowerCase()}:${y}` }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after', session: s });
    return `${prefix}-${y}-${String(c!.seq).padStart(5, '0')}`;
  }

  async function loadOrder(req: Request) {
    const o = await db(req).collection('purchase_orders').findOne({ _id: idParam(req.params.id, 'Purchase order'), tenantId: req.actor!.tenantId });
    if (!o) throw Errors.notFound('Purchase order');
    await assertBranch(deps, req, o.branchId);
    return o;
  }

  const orderView = (o: Document) => ({
    id: id(o as { _id: ObjectId }),
    number: o.number,
    status: o.status,
    supplierId: o.supplierId.toHexString(),
    supplierName: o.supplierName,
    storeId: o.storeId.toHexString(),
    currency: o.currency,
    totalMinor: o.totalMinor,
    lines: (o.lines as Document[]).map((l) => ({ itemId: l.itemId.toHexString(), itemName: l.itemName, quantity: l.quantity, unitPriceMinor: l.unitPriceMinor, receivedQuantity: l.receivedQuantity, invoicedQuantity: l.invoicedQuantity })),
    createdByName: o.createdByName,
    approvedByName: o.approvedByName ?? null,
    createdAt: o.createdAt,
  });

  // ---- suppliers ----
  r.get('/suppliers', need(deps, 'proc', 'V'), async (req, res) => {
    const list = await db(req).collection('suppliers').find({ tenantId: req.actor!.tenantId, active: true }).sort({ name: 1 }).toArray();
    res.json({ data: list.map((x) => ({ id: id(x), code: x.code, name: x.name, currency: x.currency, phone: x.phone ?? null })) });
  });

  r.post('/suppliers', need(deps, 'proc', 'E'), async (req, res) => {
    const body = parse(NewSupplier, req.body);
    try {
      const ins = await db(req).collection('suppliers').insertOne({ tenantId: req.actor!.tenantId, ...body, active: true, createdAt: new Date(), createdBy: req.actor!.userId });
      await audit(deps, req, { action: 'proc.supplier.create', resource: `supplier:${ins.insertedId.toHexString()}`, outcome: 'success', meta: { code: body.code } });
      res.status(201).json({ data: { id: ins.insertedId.toHexString() } });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw Errors.conflict('SUPPLIER_EXISTS', `Supplier ${body.code} already exists`);
      throw e;
    }
  });

  // ---- purchase orders ----
  r.post('/orders', need(deps, 'proc', 'E'), async (req, res) => {
    const body = parse(NewOrder, req.body);
    const a = req.actor!;
    const sup = await db(req).collection('suppliers').findOne({ _id: body.supplierId, tenantId: a.tenantId, active: true });
    if (!sup) throw Errors.notFound('Supplier');
    const store = await db(req).collection('stores').findOne({ _id: body.storeId, tenantId: a.tenantId });
    if (!store) throw Errors.notFound('Store');
    if (new Set(body.lines.map((l) => l.itemId.toHexString())).size !== body.lines.length) throw Errors.validation([{ path: 'lines', message: 'List each item once' }]);
    const items = await db(req).collection('items').find({ _id: { $in: body.lines.map((l) => l.itemId) }, tenantId: a.tenantId }).toArray();
    if (items.length !== body.lines.length) throw Errors.validation([{ path: 'lines', message: 'One or more items are not in the catalogue' }]);
    const lines = body.lines.map((l) => ({ ...l, itemName: items.find((i) => i._id.equals(l.itemId))!.name, receivedQuantity: 0, invoicedQuantity: 0 }));
    const total = lines.reduce((n, l) => n + l.quantity * l.unitPriceMinor, 0);
    const out = await txn(async (s) => {
      const num = await number(req, 'PO', s);
      const ins = await db(req).collection('purchase_orders').insertOne(
        { tenantId: a.tenantId, branchId: store.branchId, storeId: store._id, supplierId: sup._id, supplierName: sup.name, currency: sup.currency, number: num, lines, totalMinor: total, note: body.note, status: 'Draft', createdBy: a.userId, createdByName: a.name, createdAt: new Date(), version: 1 },
        { session: s },
      );
      return { id: ins.insertedId.toHexString(), number: num };
    });
    res.status(201).json({ data: { ...out, totalMinor: total, status: 'Draft', needsFinanceDirector: total > PO_SUPERVISOR_LIMIT_MINOR } });
  });

  r.get('/orders', need(deps, 'proc', 'V'), async (req, res) => {
    const q = parse(z.object({ status: z.string().optional() }), req.query);
    const f: Document = { tenantId: req.actor!.tenantId };
    if (q.status) f.status = q.status;
    const list = await db(req).collection('purchase_orders').find(f).sort({ createdAt: -1 }).limit(300).toArray();
    res.json({ data: list.map(orderView) });
  });

  r.get('/orders/:id', need(deps, 'proc', 'V'), async (req, res) => {
    res.json({ data: orderView(await loadOrder(req)) });
  });

  r.post('/orders/:id/submit', need(deps, 'proc', 'E'), async (req, res) => {
    const o = await loadOrder(req);
    const upd = await db(req).collection('purchase_orders').updateOne({ _id: o._id, status: 'Draft' }, { $set: { status: 'PendingApproval', submittedAt: new Date() }, $inc: { version: 1 } });
    if (!upd.modifiedCount) throw Errors.conflict('INVALID_TRANSITION', `Order is ${o.status}`);
    res.json({ data: { id: id(o), status: 'PendingApproval' } });
  });

  r.post('/orders/:id/approve', need(deps, 'proc', 'S'), async (req, res) => {
    const o = await loadOrder(req);
    const a = req.actor!;
    if (o.createdBy.equals(a.userId)) throw new AppError(403, 'FOUR_EYES', 'Someone other than the buyer approves the order');
    if (o.totalMinor > PO_SUPERVISOR_LIMIT_MINOR && !can(a.perms, 'proc', 'A')) await deny(deps, req, `purchase_order:${id(o)}`, 'order above the approval limit needs the finance director');
    assertRecentMfa(deps, req);
    const upd = await db(req).collection('purchase_orders').updateOne({ _id: o._id, status: 'PendingApproval' }, { $set: { status: 'Approved', approvedBy: a.userId, approvedByName: a.name, approvedAt: new Date() }, $inc: { version: 1 } });
    if (!upd.modifiedCount) throw Errors.conflict('INVALID_TRANSITION', 'Only submitted orders are approved');
    await audit(deps, req, { action: 'proc.order.approve', resource: `purchase_order:${id(o)}`, outcome: 'success', meta: { totalMinor: o.totalMinor } });
    res.json({ data: { id: id(o), status: 'Approved' } });
  });

  r.post('/orders/:id/cancel', need(deps, 'proc', 'E'), async (req, res) => {
    const { reason } = parse(Reason, req.body);
    const o = await loadOrder(req);
    if (o.status === 'Approved' && !can(req.actor!.perms, 'proc', 'A')) await deny(deps, req, `purchase_order:${id(o)}`, 'cancelling an approved order needs the finance director');
    const upd = await db(req).collection('purchase_orders').updateOne({ _id: o._id, status: { $in: ['Draft', 'PendingApproval', 'Approved'] } }, { $set: { status: 'Cancelled', cancelReason: reason }, $inc: { version: 1 } });
    if (!upd.modifiedCount) throw Errors.conflict('INVALID_TRANSITION', 'Orders with deliveries cannot be cancelled');
    await audit(deps, req, { action: 'proc.order.cancel', resource: `purchase_order:${id(o)}`, outcome: 'success', meta: { reason } });
    res.json({ data: { id: id(o), status: 'Cancelled' } });
  });

  // ---- goods receipt (storekeeper) ----
  r.post('/orders/:id/receipts', need(deps, 'inv', 'E'), async (req, res) => {
    const body = parse(Receipt, req.body);
    const o = await loadOrder(req);
    if (!['Approved', 'PartiallyReceived'].includes(o.status)) throw Errors.conflict('NOT_APPROVED', 'Goods are received only against an approved order');
    const a = req.actor!;
    const lines = (o.lines as Document[]).map((l) => ({ ...l }));
    for (const g of body.lines) {
      if (g.expiry <= today()) throw Errors.validation([{ path: 'expiry', message: `Batch ${g.batch} has already expired` }]);
      const l = lines.find((x) => x.itemId.equals(g.itemId));
      if (!l) throw Errors.validation([{ path: 'lines', message: 'An item that is not on the order was delivered; return it to the supplier' }]);
      l.receivedQuantity += g.quantity;
      if (l.receivedQuantity > l.quantity) throw Errors.validation([{ path: 'lines', message: `More ${l.itemName} than ordered (${l.quantity})` }]);
    }
    const value = body.lines.reduce((n, g) => n + g.quantity * lines.find((x) => x.itemId.equals(g.itemId))!.unitPriceMinor, 0);
    const complete = lines.every((l) => l.receivedQuantity === l.quantity);
    const grn = await txn(async (s) => {
      const num = await number(req, 'GRN', s);
      const upd = await db(req).collection('purchase_orders').updateOne({ _id: o._id, version: o.version }, { $set: { lines, status: complete ? 'Received' : 'PartiallyReceived' }, $inc: { version: 1 } }, { session: s });
      if (!upd.modifiedCount) throw Errors.conflict('VERSION_CONFLICT', 'Another delivery was recorded meanwhile; reload');
      for (const g of body.lines) await receiveLot(db(req), s, { tenantId: a.tenantId!, storeId: o.storeId, branchId: o.branchId, itemId: g.itemId, batch: g.batch, expiry: g.expiry, quantity: g.quantity, by: a.userId, ref: `${o.number}/${num}` });
      const ins = await db(req).collection('goods_receipts').insertOne({ tenantId: a.tenantId, orderId: o._id, number: num, lines: body.lines, valueMinor: value, deliveryNote: body.deliveryNote, receivedBy: a.userId, receivedAt: new Date() }, { session: s });
      await postEntry(db(req), s, {
        tenantId: a.tenantId!,
        postingDate: today(),
        currency: o.currency as Currency,
        memo: `Goods receipt ${num} on ${o.number}`,
        lines: [{ accountCode: '1200', debitMinor: value }, { accountCode: '2050', creditMinor: value }],
        source: { type: 'goods_receipt', id: ins.insertedId.toHexString(), kind: 'receive' },
        by: a.userId,
      });
      return num;
    });
    await audit(deps, req, { action: 'proc.receipt', resource: `purchase_order:${id(o)}`, outcome: 'success', meta: { grn, valueMinor: value } });
    res.status(201).json({ data: { number: grn, valueMinor: value, orderStatus: complete ? 'Received' : 'PartiallyReceived' } });
  });

  // ---- supplier invoices: 3-way match against the order (price) and receipts (quantity) ----
  r.post('/supplier-invoices', need(deps, 'proc', 'E'), async (req, res) => {
    const body = parse(SupplierInvoice, req.body);
    const a = req.actor!;
    const o = await db(req).collection('purchase_orders').findOne({ _id: body.orderId, tenantId: a.tenantId });
    if (!o) throw Errors.notFound('Purchase order');
    const lines = (o.lines as Document[]).map((l) => ({ ...l }));
    const exceptions: string[] = [];
    for (const v of body.lines) {
      const l = lines.find((x) => x.itemId.equals(v.itemId));
      if (!l) {
        exceptions.push('an invoiced item is not on the order');
        continue;
      }
      if (v.unitPriceMinor !== l.unitPriceMinor) exceptions.push(`${l.itemName}: invoiced at ${v.unitPriceMinor}, ordered at ${l.unitPriceMinor}`);
      if (l.invoicedQuantity + v.quantity > l.receivedQuantity) exceptions.push(`${l.itemName}: invoiced ${l.invoicedQuantity + v.quantity}, received ${l.receivedQuantity}`);
      l.invoicedQuantity += v.quantity;
    }
    const total = body.lines.reduce((n, v) => n + v.quantity * v.unitPriceMinor, 0);
    const status = exceptions.length ? 'Exception' : 'Matched';
    const doc = { tenantId: a.tenantId, supplierId: o.supplierId, supplierName: o.supplierName, orderId: o._id, orderNumber: o.number, invoiceNo: body.invoiceNo, invoiceDate: body.invoiceDate, currency: o.currency, lines: body.lines, totalMinor: total, status, exceptions, recordedBy: a.userId, recordedByName: a.name, recordedAt: new Date() };
    try {
      const out = await txn(async (s) => {
        const ins = await db(req).collection('supplier_invoices').insertOne(doc, { session: s });
        if (status === 'Matched') {
          await db(req).collection('purchase_orders').updateOne({ _id: o._id, version: o.version }, { $set: { lines }, $inc: { version: 1 } }, { session: s }).then((u) => {
            if (!u.modifiedCount) throw Errors.conflict('VERSION_CONFLICT', 'The order changed meanwhile; reload');
          });
          await postEntry(db(req), s, {
            tenantId: a.tenantId!,
            postingDate: today(),
            currency: o.currency as Currency,
            memo: `Supplier invoice ${body.invoiceNo} (${o.supplierName}) on ${o.number}`,
            lines: [{ accountCode: '2050', debitMinor: total }, { accountCode: '2000', creditMinor: total }],
            source: { type: 'supplier_invoice', id: ins.insertedId.toHexString(), kind: 'match' },
            by: a.userId,
          });
        }
        return ins.insertedId;
      });
      await audit(deps, req, { action: 'proc.supplier_invoice.record', resource: `supplier_invoice:${out.toHexString()}`, outcome: 'success', meta: { status, totalMinor: total } });
      res.status(201).json({ data: { id: out.toHexString(), status, exceptions, totalMinor: total } });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) {
        await audit(deps, req, { action: 'proc.supplier_invoice.duplicate', resource: `supplier:${o.supplierId.toHexString()}`, outcome: 'deny', meta: { invoiceNo: body.invoiceNo } });
        throw Errors.conflict('DUPLICATE_SUPPLIER_INVOICE', `Invoice ${body.invoiceNo} from ${o.supplierName} is already recorded`);
      }
      throw e;
    }
  });

  r.get('/supplier-invoices', need(deps, 'proc', 'V'), async (req, res) => {
    const q = parse(z.object({ status: z.enum(['Matched', 'Exception', 'Paid']).optional() }), req.query);
    const f: Document = { tenantId: req.actor!.tenantId };
    if (q.status) f.status = q.status;
    const list = await db(req).collection('supplier_invoices').find(f).sort({ recordedAt: -1 }).limit(300).toArray();
    res.json({ data: list.map((x) => ({ id: id(x), invoiceNo: x.invoiceNo, supplierName: x.supplierName, orderNumber: x.orderNumber, totalMinor: x.totalMinor, currency: x.currency, status: x.status, exceptions: x.exceptions, invoiceDate: x.invoiceDate, paidOn: x.paidOn ?? null })) });
  });

  /** Supplier payment: finance only, never the person who recorded the invoice, only for matched invoices. */
  r.post('/supplier-invoices/:id/pay', need(deps, 'acct', 'S'), async (req, res) => {
    const body = parse(z.object({ reference: z.string().trim().min(3).max(60) }), req.body);
    const x = await db(req).collection('supplier_invoices').findOne({ _id: idParam(req.params.id, 'Supplier invoice'), tenantId: req.actor!.tenantId });
    if (!x) throw Errors.notFound('Supplier invoice');
    const a = req.actor!;
    if (x.recordedBy.equals(a.userId)) throw new AppError(403, 'FOUR_EYES', 'Someone other than the person who recorded the invoice pays it');
    assertRecentMfa(deps, req);
    if (x.status !== 'Matched') throw Errors.conflict(x.status === 'Paid' ? 'ALREADY_PAID' : 'NOT_MATCHED', x.status === 'Paid' ? 'This invoice is already paid' : 'Resolve the 3-way match exceptions before paying');
    await txn(async (s) => {
      const upd = await db(req).collection('supplier_invoices').updateOne({ _id: x._id, status: 'Matched' }, { $set: { status: 'Paid', paidOn: today(), paidBy: a.userId, paymentRef: body.reference } }, { session: s });
      if (!upd.modifiedCount) throw Errors.conflict('ALREADY_PAID', 'This invoice is already paid');
      await postEntry(db(req), s, {
        tenantId: a.tenantId!,
        postingDate: today(),
        currency: x.currency as Currency,
        memo: `Payment ${body.reference} to ${x.supplierName} for ${x.invoiceNo}`,
        lines: [{ accountCode: '2000', debitMinor: x.totalMinor }, { accountCode: '1010', creditMinor: x.totalMinor }],
        source: { type: 'supplier_invoice', id: id(x), kind: 'pay' },
        by: a.userId,
      });
    });
    await audit(deps, req, { action: 'proc.supplier_invoice.pay', resource: `supplier_invoice:${id(x)}`, outcome: 'success', meta: { amountMinor: x.totalMinor } });
    res.json({ data: { id: id(x), status: 'Paid' } });
  });

  return r;
}
