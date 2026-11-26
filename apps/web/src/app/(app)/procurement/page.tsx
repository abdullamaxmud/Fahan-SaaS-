'use client';

import { useCallback, useEffect, useState } from 'react';
import { PackageCheck, Plus, ShoppingCart, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { money, toMinor } from '@/lib/money';
import { canDo, useMe } from '@/lib/session';
import { useReauth } from '@/components/Reauth';
import { Card, ErrorNote, Field, PageHeader, Pill, fieldErrors, useAction } from '@/components/ui';

interface Supplier { id: string; code: string; name: string; currency: string }
interface Store { id: string; code: string; name: string }
interface Item { id: string; code: string; name: string; unit: string }
interface OLine { itemId: string; itemName: string; quantity: number; unitPriceMinor: number; receivedQuantity: number; invoicedQuantity: number }
interface Order { id: string; number: string; status: string; supplierName: string; currency: string; totalMinor: number; lines: OLine[]; createdByName: string; approvedByName: string | null }
interface SInvoice { id: string; invoiceNo: string; supplierName: string; orderNumber: string; totalMinor: number; currency: string; status: string; exceptions: string[]; paidOn: string | null }

const tone = (s: string) => (s === 'Received' || s === 'Paid' || s === 'Matched' ? 'ok' : s === 'Cancelled' || s === 'Exception' ? 'crit' : s === 'PendingApproval' ? 'warn' : s === 'Draft' ? 'plain' : 'info');

export default function ProcurementPage() {
  const { me } = useMe();
  const { t } = useLang();
  const { guarded, dialog } = useReauth();
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [invoices, setInvoices] = useState<SInvoice[]>([]);
  const [sup, setSup] = useState({ code: '', name: '', currency: 'USD', phone: '' });
  const [po, setPo] = useState({ supplierId: '', storeId: '', lines: [{ itemId: '', quantity: '', price: '' }] });
  const [grn, setGrn] = useState<Record<string, { quantity: string; batch: string; expiry: string }>>({});
  const [si, setSi] = useState<{ orderId: string; invoiceNo: string; invoiceDate: string; lines: { itemId: string; quantity: string; price: string }[] }>({ orderId: '', invoiceNo: '', invoiceDate: new Date().toISOString().slice(0, 10), lines: [] });
  const load = useAction();
  const act = useAction();
  const buyer = canDo(me, 'proc', 'E');
  const approver = canDo(me, 'proc', 'S');
  const keeper = canDo(me, 'inv', 'E');
  const payer = canDo(me, 'acct', 'S');
  // Orders name a store and catalogue items, which only people with inventory access can list.
  const stockView = canDo(me, 'inv', 'V');

  const refresh = useCallback(async () => {
    await load.run(async () => {
      const [s, o, i, st, it] = await Promise.all([
        api<Supplier[]>('/procurement/suppliers'),
        api<Order[]>('/procurement/orders'),
        api<SInvoice[]>('/procurement/supplier-invoices'),
        stockView ? api<Store[]>('/inventory/stores') : Promise.resolve([] as Store[]),
        stockView ? api<Item[]>('/inventory/items') : Promise.resolve([] as Item[]),
      ]);
      setSuppliers(s);
      setOrders(o);
      setInvoices(i);
      setStores(st);
      setItems(it);
    });
  }, [stockView]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const run = async (fn: () => Promise<unknown>, after?: () => void) => {
    if ((await act.run(fn)) !== undefined) {
      after?.();
      await refresh();
    }
  };
  const fe = fieldErrors(act.error);
  const poTotal = po.lines.reduce((n, l) => n + (Number(l.quantity) || 0) * (toMinor(l.price || '0') || 0), 0);
  const g = (k: string) => grn[k] ?? { quantity: '', batch: '', expiry: '' };

  const pickOrder = (id: string) => {
    const o = orders.find((x) => x.id === id);
    setSi({ ...si, orderId: id, lines: (o?.lines ?? []).filter((l) => l.receivedQuantity > l.invoicedQuantity).map((l) => ({ itemId: l.itemId, quantity: String(l.receivedQuantity - l.invoicedQuantity), price: (l.unitPriceMinor / 100).toFixed(2) })) });
  };

  return (
    <>
      {dialog}
      <PageHeader title={t('Procurement', 'Iibsiga')}>
        {t('Suppliers, purchase orders and supplier invoices.', 'Alaab-qeybiyayaasha, dalabyada iyo biilasha.')}
      </PageHeader>
      <ErrorNote error={load.error ?? (Object.keys(fe).length ? null : act.error)} />

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="grid gap-4">
          <Card title={t('Purchase orders', 'Dalabaadka')}>
            <ul className="grid gap-2 px-4 pb-4 text-[13px]">
              {orders.map((o) => (
                <li key={o.id} className="rounded-[10px] border border-line p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <b className="font-mono">{o.number}</b>
                    <Pill tone={tone(o.status)}>{o.status}</Pill>
                    <span className="text-ink-2">{o.supplierName}</span>
                    <span className="num ml-auto font-semibold">{money(o.totalMinor, o.currency)}</span>
                  </div>
                  <table className="mt-2 w-full text-[12.5px]">
                    <tbody>
                      {o.lines.map((l) => (
                        <tr key={l.itemId}>
                          <td className="py-0.5">{l.itemName}</td>
                          <td className="num py-0.5 text-right">
                            {l.receivedQuantity}/{l.quantity} {t('received', 'la helay')}
                          </td>
                          <td className="num py-0.5 text-right text-ink-3">@ {money(l.unitPriceMinor, o.currency)}</td>
                          {keeper && ['Approved', 'PartiallyReceived'].includes(o.status) && l.receivedQuantity < l.quantity ? (
                            <td className="py-0.5 pl-2">
                              <div className="flex justify-end gap-1">
                                <input className="input h-7 w-16" inputMode="numeric" placeholder={String(l.quantity - l.receivedQuantity)} value={g(o.id + l.itemId).quantity} onChange={(e) => setGrn({ ...grn, [o.id + l.itemId]: { ...g(o.id + l.itemId), quantity: e.target.value } })} aria-label="Quantity" />
                                <input className="input h-7 w-20" placeholder={t('batch', 'dufcad')} value={g(o.id + l.itemId).batch} onChange={(e) => setGrn({ ...grn, [o.id + l.itemId]: { ...g(o.id + l.itemId), batch: e.target.value } })} aria-label="Batch" />
                                <input className="input h-7 w-32" type="date" value={g(o.id + l.itemId).expiry} onChange={(e) => setGrn({ ...grn, [o.id + l.itemId]: { ...g(o.id + l.itemId), expiry: e.target.value } })} aria-label="Expiry" />
                              </div>
                            </td>
                          ) : null}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {buyer && o.status === 'Draft' ? (
                      <button className="btn btn-primary h-8" onClick={() => run(() => api(`/procurement/orders/${o.id}/submit`, { body: {} }))}>
                        {t('Send for approval', 'U dir oggolaansho')}
                      </button>
                    ) : null}
                    {approver && o.status === 'PendingApproval' ? (
                      <button className="btn btn-primary h-8" onClick={() => run(() => guarded(() => api(`/procurement/orders/${o.id}/approve`, { body: {} })))}>
                        {t('Approve', 'Oggolow')}
                      </button>
                    ) : null}
                    {keeper && ['Approved', 'PartiallyReceived'].includes(o.status) ? (
                      <button
                        className="btn btn-primary h-8"
                        onClick={() => {
                          const lines = o.lines.map((l) => ({ itemId: l.itemId, ...g(o.id + l.itemId) })).filter((l) => l.quantity && l.batch && l.expiry).map((l) => ({ itemId: l.itemId, quantity: Number(l.quantity), batch: l.batch, expiry: l.expiry }));
                          if (lines.length) void run(() => api(`/procurement/orders/${o.id}/receipts`, { body: { lines } }), () => setGrn({}));
                        }}
                      >
                        <PackageCheck size={15} /> {t('Record delivery', 'Diiwaangeli keenista')}
                      </button>
                    ) : null}
                    {buyer && ['Draft', 'PendingApproval'].includes(o.status) ? (
                      <button className="btn h-8" onClick={() => { const reason = prompt(t('Why cancel this order?', 'Maxaa loo joojinayaa?')); if (reason) void run(() => api(`/procurement/orders/${o.id}/cancel`, { body: { reason } })); }}>
                        {t('Cancel', 'Jooji')}
                      </button>
                    ) : null}
                    <span className="ml-auto self-center text-[12px] text-ink-3">
                      {o.createdByName}
                      {o.approvedByName ? ` → ${o.approvedByName}` : ''}
                    </span>
                  </div>
                </li>
              ))}
              {!orders.length ? <li className="text-ink-3">{t('No orders yet.', 'Dalab weli ma jiro.')}</li> : null}
            </ul>
          </Card>

          <Card title={t('Supplier invoices', 'Biilasha alaab-qeybiyaha')}>
            <ul className="grid gap-2 px-4 pb-4 text-[13px]">
              {invoices.map((x) => (
                <li key={x.id} className="rounded-[10px] border border-line p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <b className="font-mono">{x.invoiceNo}</b>
                    <Pill tone={tone(x.status)}>{x.status}</Pill>
                    <span className="text-ink-2">
                      {x.supplierName} · {x.orderNumber}
                    </span>
                    <span className="num ml-auto font-semibold">{money(x.totalMinor, x.currency)}</span>
                  </div>
                  {x.exceptions.length ? (
                    <ul className="mt-1 list-disc pl-5 text-crit">
                      {x.exceptions.map((e) => (
                        <li key={e}>{e}</li>
                      ))}
                    </ul>
                  ) : null}
                  {payer && x.status === 'Matched' ? (
                    <button className="btn btn-primary mt-2 h-8" onClick={() => { const reference = prompt(t('Bank transfer reference', 'Tixraaca bangiga')); if (reference) void run(() => guarded(() => api(`/procurement/supplier-invoices/${x.id}/pay`, { body: { reference } }))); }}>
                      {t('Pay supplier', 'Bixi')}
                    </button>
                  ) : null}
                  {x.paidOn ? <p className="mt-1 text-ink-3">{t('Paid', 'La bixiyay')} {x.paidOn}</p> : null}
                </li>
              ))}
              {!invoices.length ? <li className="text-ink-3">{t('No supplier invoices yet.', 'Biil weli ma jiro.')}</li> : null}
            </ul>
          </Card>
        </div>

        <div className="grid gap-4">
          {buyer && stockView ? (
            <Card title={t('New purchase order', 'Dalab cusub')}>
              <form
                className="grid gap-2 px-4 pb-4 text-[13px]"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(
                    () => api('/procurement/orders', { body: { supplierId: po.supplierId, storeId: po.storeId, lines: po.lines.filter((l) => l.itemId).map((l) => ({ itemId: l.itemId, quantity: Number(l.quantity), unitPriceMinor: toMinor(l.price) })) } }),
                    () => setPo({ ...po, lines: [{ itemId: '', quantity: '', price: '' }] }),
                  );
                }}
              >
                <div className="grid gap-2 sm:grid-cols-2">
                  <Field label={t('Supplier', 'Alaab-qeybiye')}>
                    <select className="input h-9" required value={po.supplierId} onChange={(e) => setPo({ ...po, supplierId: e.target.value })}>
                      <option value="">—</option>
                      {suppliers.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t('Deliver to', 'Geyn')}>
                    <select className="input h-9" required value={po.storeId} onChange={(e) => setPo({ ...po, storeId: e.target.value })}>
                      <option value="">—</option>
                      {stores.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.code} · {s.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                {po.lines.map((l, i) => (
                  <div key={i} className="grid grid-cols-[1fr_72px_88px_32px] gap-2">
                    <select className="input h-9" aria-label="Item" value={l.itemId} onChange={(e) => setPo({ ...po, lines: po.lines.map((x, j) => (j === i ? { ...x, itemId: e.target.value } : x)) })}>
                      <option value="">{t('Item…', 'Shay…')}</option>
                      {items.map((it) => (
                        <option key={it.id} value={it.id}>
                          {it.name} ({it.unit})
                        </option>
                      ))}
                    </select>
                    <input className="input h-9" inputMode="numeric" placeholder={t('Qty', 'Tiro')} value={l.quantity} onChange={(e) => setPo({ ...po, lines: po.lines.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)) })} />
                    <input className="input h-9" inputMode="decimal" placeholder={t('Unit price', 'Qiimaha')} value={l.price} onChange={(e) => setPo({ ...po, lines: po.lines.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)) })} />
                    <button type="button" className="btn h-9 px-2" aria-label="Remove line" disabled={po.lines.length <= 1} onClick={() => setPo({ ...po, lines: po.lines.filter((_, j) => j !== i) })}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" className="btn h-8" onClick={() => setPo({ ...po, lines: [...po.lines, { itemId: '', quantity: '', price: '' }] })}>
                    <Plus size={14} /> {t('Line', 'Sadar')}
                  </button>
                  <span className="num ml-auto font-semibold">{money(poTotal)}</span>
                  <button className="btn btn-primary h-9">
                    <ShoppingCart size={15} /> {t('Create order', 'Samee dalab')}
                  </button>
                </div>
                {poTotal > 50_000 ? <p className="text-[12px] text-warn">{t('Above $500 — the finance director approves.', 'Ka badan $500 — agaasimaha maaliyadda ayaa oggolaanaya.')}</p> : null}
              </form>
            </Card>
          ) : null}

          {buyer ? (
            <Card title={t('Record a supplier invoice', 'Diiwaangeli biil')}>
              <form
                className="grid gap-2 px-4 pb-4 text-[13px]"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(
                    () => api('/procurement/supplier-invoices', { body: { orderId: si.orderId, invoiceNo: si.invoiceNo, invoiceDate: si.invoiceDate, lines: si.lines.map((l) => ({ itemId: l.itemId, quantity: Number(l.quantity), unitPriceMinor: toMinor(l.price) })) } }),
                    () => setSi({ ...si, orderId: '', invoiceNo: '', lines: [] }),
                  );
                }}
              >
                <Field label={t('Order', 'Dalab')}>
                  <select className="input h-9" required value={si.orderId} onChange={(e) => pickOrder(e.target.value)}>
                    <option value="">—</option>
                    {orders
                      .filter((o) => o.lines.some((l) => l.receivedQuantity > l.invoicedQuantity))
                      .map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.number} · {o.supplierName}
                        </option>
                      ))}
                  </select>
                </Field>
                <div className="grid grid-cols-2 gap-2">
                  <Field label={t('Invoice number', 'Lambarka biilka')} error={fe.invoiceNo}>
                    <input className="input h-9" required value={si.invoiceNo} onChange={(e) => setSi({ ...si, invoiceNo: e.target.value })} />
                  </Field>
                  <Field label={t('Invoice date', 'Taariikhda')}>
                    <input className="input h-9" type="date" required value={si.invoiceDate} onChange={(e) => setSi({ ...si, invoiceDate: e.target.value })} />
                  </Field>
                </div>
                {si.lines.map((l, i) => (
                  <div key={l.itemId} className="grid grid-cols-[1fr_72px_88px] items-center gap-2">
                    <span>{items.find((it) => it.id === l.itemId)?.name ?? l.itemId}</span>
                    <input className="input h-9" inputMode="numeric" value={l.quantity} onChange={(e) => setSi({ ...si, lines: si.lines.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)) })} aria-label="Quantity" />
                    <input className="input h-9" inputMode="decimal" value={l.price} onChange={(e) => setSi({ ...si, lines: si.lines.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)) })} aria-label="Unit price" />
                  </div>
                ))}
                <button className="btn btn-primary h-9 justify-self-start" disabled={!si.lines.length}>
                  {t('Match & record', 'Is-barbardhig')}
                </button>
              </form>
            </Card>
          ) : null}

          <Card title={t('Suppliers', 'Alaab-qeybiyayaasha')}>
            <div className="grid gap-3 px-4 pb-4 text-[13px]">
              <ul className="grid gap-1">
                {suppliers.map((s) => (
                  <li key={s.id} className="flex gap-2">
                    <span className="font-mono text-[11.5px] text-ink-3">{s.code}</span> {s.name} <span className="ml-auto text-ink-3">{s.currency}</span>
                  </li>
                ))}
              </ul>
              {buyer ? (
                <form
                  className="grid gap-2 sm:grid-cols-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void run(() => api('/procurement/suppliers', { body: { ...sup, phone: sup.phone || undefined } }), () => setSup({ code: '', name: '', currency: 'USD', phone: '' }));
                  }}
                >
                  <Field label={t('Code', 'Koodh')} error={fe.code}>
                    <input className="input h-9" required value={sup.code} onChange={(e) => setSup({ ...sup, code: e.target.value })} />
                  </Field>
                  <Field label={t('Name', 'Magaca')} error={fe.name}>
                    <input className="input h-9" required value={sup.name} onChange={(e) => setSup({ ...sup, name: e.target.value })} />
                  </Field>
                  <Field label={t('Phone', 'Telefoon')}>
                    <input className="input h-9" value={sup.phone} onChange={(e) => setSup({ ...sup, phone: e.target.value })} />
                  </Field>
                  <Field label={t('Currency', 'Lacagta')}>
                    <select className="input h-9" value={sup.currency} onChange={(e) => setSup({ ...sup, currency: e.target.value })}>
                      <option>USD</option>
                      <option>SOS</option>
                    </select>
                  </Field>
                  <button className="btn h-9 justify-self-start">{t('Add supplier', 'Ku dar')}</button>
                </form>
              ) : null}
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
