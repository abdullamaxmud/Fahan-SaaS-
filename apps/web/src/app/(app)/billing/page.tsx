'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Banknote, ReceiptText, Undo2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { money, newKey, patientName, toMinor } from '@/lib/money';
import { canDo, useMe } from '@/lib/session';
import { useReauth } from '@/components/Reauth';
import { PaymentProviders } from '@/components/PaymentProviders';
import { Card, ErrorNote, Field, PageHeader, Pill, fieldErrors, useAction } from '@/components/ui';

type Pat = { names?: { given?: string; family?: string }; mrn?: string } | null;
interface Charge { id: string; patientId: string; patient: Pat; serviceCode: string; description: string; quantity: number; unitPriceMinor: number; currency: string; status: string }
interface Line { serviceCode: string; description: string; quantity: number; unitPriceMinor: number; amountMinor: number }
interface Invoice {
  id: string; invoiceNumber: string | null; patientId: string; patient?: Pat; currency: string; lines: Line[]; subtotalMinor: number; discountMinor: number; totalMinor: number;
  paidMinor: number; refundedMinor: number; balanceMinor: number; insuranceHoldMinor: number; patientDueMinor: number; status: string; issuedOn: string | null;
  payments?: { receiptNo: string; amountMinor: number; method: string; receivedOn: string }[];
}
interface Till { id: string; currency: string; openingFloatMinor: number; totals: Record<string, { inMinor: number; outMinor: number }> }
interface Refund { id: string; invoiceId: string; amountMinor: number; currency: string; method: string; reason: string; requestedByName: string; needsFinanceDirector: boolean }
interface Price { code: string; name: string; category: string; priceMinor: number; currency: string; version: number }

const STATUSES = ['Draft', 'Issued', 'PartiallyPaid', 'Paid', 'Voided'] as const;
const METHODS = ['cash', 'mobile-money', 'card', 'bank'] as const;
const tone = (s: string) => (s === 'Paid' ? 'ok' : s === 'Voided' ? 'crit' : s === 'Draft' ? 'plain' : s === 'PartiallyPaid' ? 'warn' : 'info');

export default function BillingPage() {
  const { me } = useMe();
  const { t } = useLang();
  const { guarded, dialog } = useReauth();
  const [charges, setCharges] = useState<Charge[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [status, setStatus] = useState<string>('Issued');
  const [sel, setSel] = useState<Invoice | null>(null);
  const [till, setTill] = useState<Till | null>(null);
  const [refunds, setRefunds] = useState<Refund[]>([]);
  const [prices, setPrices] = useState<Price[]>([]);
  const [pay, setPay] = useState({ amount: '', method: 'cash' as string, reference: '' });
  const [refund, setRefund] = useState({ amount: '', method: 'cash', reason: '' });
  const [disc, setDisc] = useState({ amount: '', reason: '' });
  const [open, setOpen] = useState({ currency: 'USD', float: '' });
  const [counted, setCounted] = useState('');
  const [closed, setClosed] = useState<null | { expectedCashMinor: number; discrepancyMinor: number; status: string }>(null);
  const [price, setPrice] = useState({ code: '', name: '', category: 'consultation', amount: '', currency: 'USD' });
  const load = useAction();
  const act = useAction();
  const supervisor = canDo(me, 'bill', 'S');
  const finance = canDo(me, 'bill', 'A');

  const refresh = useCallback(async () => {
    await load.run(async () => {
      const [c, u, inv, tl, p] = await Promise.all([
        api<Charge[]>('/billing/charges?status=unbilled'),
        api<Charge[]>('/billing/charges?status=unpriced'),
        api<Invoice[]>(`/billing/invoices?status=${status}`),
        api<Till | null>('/billing/cashier/current'),
        api<Price[]>('/billing/prices'),
      ]);
      setCharges([...u, ...c]);
      setInvoices(inv);
      setTill(tl);
      setPrices(p);
      if (supervisor) setRefunds(await api<Refund[]>('/billing/refunds'));
    });
  }, [status, supervisor]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openInvoice = async (id: string) => {
    const inv = await load.run(() => api<Invoice>(`/billing/invoices/${id}`));
    if (inv) {
      setSel(inv);
      setPay({ amount: (inv.patientDueMinor / 100).toFixed(2), method: 'cash', reference: '' });
    }
  };
  const run = async (fn: () => Promise<unknown>, after?: () => void) => {
    const out = await act.run(fn);
    if (out !== undefined) {
      after?.();
      await refresh();
      if (sel) await openInvoice(sel.id);
    }
    return out;
  };
  const fe = fieldErrors(act.error);

  const byPatient = useMemo(() => {
    const m = new Map<string, Charge[]>();
    for (const c of charges) m.set(c.patientId, [...(m.get(c.patientId) ?? []), c]);
    return [...m.entries()];
  }, [charges]);

  return (
    <>
      {dialog}
      <PageHeader title={t('Billing & cashier', 'Biilasha & khasnajiga')}>
        {t('Invoices, payments and the cash till.', 'Biilasha, lacag-bixinta iyo khasnadda.')}
      </PageHeader>
      <ErrorNote error={load.error ?? (Object.keys(fe).length ? null : act.error)} />

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="grid gap-4">
          <Card title={t('Waiting to be invoiced', 'Sugaya biil')}>
            <div className="grid gap-2 px-4 pb-4">
              {byPatient.map(([pid, list]) => {
                const ready = list.filter((c) => c.status === 'unbilled');
                const total = ready.reduce((n, c) => n + c.quantity * c.unitPriceMinor, 0);
                return (
                  <div key={pid} className="rounded-[10px] border border-line p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <b>{patientName(list[0]!.patient)}</b>
                      <span className="num ml-auto font-semibold">{money(total, ready[0]?.currency ?? 'USD')}</span>
                      {ready.length ? (
                        <button className="btn btn-primary h-8" disabled={act.busy} onClick={() => run(() => api<{ id: string }>('/billing/invoices', { body: { patientId: pid } }), () => setStatus('Draft'))}>
                          <ReceiptText size={15} /> {t('Create invoice', 'Samee biil')}
                        </button>
                      ) : null}
                    </div>
                    <ul className="mt-2 grid gap-1 text-[13px]">
                      {list.map((c) => (
                        <li key={c.id} className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-[11.5px] text-ink-3">{c.serviceCode}</span>
                          {c.description} × {c.quantity}
                          {c.status === 'unpriced' ? (
                            <>
                              <Pill tone="warn">{t('no price', 'qiimo la’aan')}</Pill>
                              {supervisor ? (
                                <button className="btn h-7 text-[12px]" onClick={() => run(() => api(`/billing/charges/${c.id}/price`, { body: {} }))}>
                                  {t('Apply current price', 'Qiimaha hadda')}
                                </button>
                              ) : null}
                            </>
                          ) : (
                            <span className="num ml-auto">{money(c.quantity * c.unitPriceMinor, c.currency)}</span>
                          )}
                          {supervisor ? (
                            <button
                              className="btn h-7 px-2 text-[12px]"
                              title={t('Remove a charge entered by mistake', 'Ka saar kharash qalad ah')}
                              onClick={() => {
                                const reason = window.prompt(t('Why remove this charge?', 'Maxaa loo saarayaa kharashkan?'));
                                if (reason && reason.trim().length >= 3) void run(() => api(`/billing/charges/${c.id}/cancel`, { body: { reason } }));
                              }}
                            >
                              {t('Remove', 'Ka saar')}
                            </button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
              {!byPatient.length ? <p className="text-ink-3">{t('Nothing waiting.', 'Waxba ma sugayaan.')}</p> : null}
            </div>
          </Card>

          <Card
            title={t('Invoices', 'Biilasha')}
            actions={STATUSES.map((s) => (
              <button key={s} onClick={() => setStatus(s)} aria-pressed={status === s} className={`h-8 rounded-[9px] border px-2.5 text-[12.5px] font-semibold ${status === s ? 'border-ink bg-ink text-surface' : 'border-line'}`}>
                {s}
              </button>
            ))}
          >
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr>
                    <th className="th">{t('Invoice', 'Biil')}</th>
                    <th className="th">{t('Patient', 'Bukaan')}</th>
                    <th className="th text-right">{t('Total', 'Wadarta')}</th>
                    <th className="th text-right">{t('Patient owes', 'Bukaanku waa leeyahay')}</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((i) => (
                    <tr key={i.id} className={`cursor-pointer hover:bg-surface-2 ${sel?.id === i.id ? 'bg-surface-2' : ''}`} onClick={() => openInvoice(i.id)}>
                      <td className="td font-mono">{i.invoiceNumber ?? t('draft', 'qabyo')}</td>
                      <td className="td">{patientName(i.patient)}</td>
                      <td className="td num text-right">{money(i.totalMinor, i.currency)}</td>
                      <td className="td num text-right font-semibold">{money(i.patientDueMinor, i.currency)}</td>
                    </tr>
                  ))}
                  {!invoices.length ? (
                    <tr>
                      <td className="td text-ink-3" colSpan={4}>
                        {t('No invoices with this status.', 'Biil xaaladdan leh ma jiro.')}
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </Card>
        </div>

        <div className="grid gap-4">
          <Card title={t('My till', 'Sanduuqayga')} actions={till ? <Pill tone="ok">{t('open', 'furan')} · {till.currency}</Pill> : <Pill>{t('closed', 'xiran')}</Pill>}>
            <div className="grid gap-3 px-4 pb-4">
              {till ? (
                <>
                  <dl className="grid grid-cols-2 gap-1 text-[13px]">
                    <dt className="text-ink-3">{t('Opening float', 'Lacagta furitaanka')}</dt>
                    <dd className="num text-right">{money(till.openingFloatMinor, till.currency)}</dd>
                    {METHODS.map((m) => (
                      <div key={m} className="contents">
                        <dt className="text-ink-3">{m}</dt>
                        <dd className="num text-right">
                          +{money(till.totals[m]?.inMinor, till.currency)} / −{money(till.totals[m]?.outMinor, till.currency)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  <form
                    className="flex flex-wrap items-end gap-2"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      const r = await act.run(() => api<{ expectedCashMinor: number; discrepancyMinor: number; status: string }>('/billing/cashier/close', { body: { countedCashMinor: toMinor(counted) } }));
                      if (r) {
                        setClosed(r);
                        setCounted('');
                        await refresh();
                      }
                    }}
                  >
                    <Field label={t('Cash counted', 'Lacagta la tiriyay')} error={fe.countedCashMinor}>
                      <input className="input h-9 w-36" inputMode="decimal" required value={counted} onChange={(e) => setCounted(e.target.value)} />
                    </Field>
                    <button className="btn h-9">{t('Close till', 'Xir sanduuqa')}</button>
                  </form>
                </>
              ) : (
                <form
                  className="flex flex-wrap items-end gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void run(() => api('/billing/cashier/open', { body: { currency: open.currency, openingFloatMinor: toMinor(open.float || '0') } }), () => setClosed(null));
                  }}
                >
                  <Field label={t('Currency', 'Lacagta')}>
                    <select className="input h-9" value={open.currency} onChange={(e) => setOpen({ ...open, currency: e.target.value })}>
                      <option>USD</option>
                      <option>SOS</option>
                    </select>
                  </Field>
                  <Field label={t('Opening float', 'Lacagta furitaanka')}>
                    <input className="input h-9 w-32" inputMode="decimal" value={open.float} onChange={(e) => setOpen({ ...open, float: e.target.value })} placeholder="0.00" />
                  </Field>
                  <button className="btn btn-primary h-9">
                    <Banknote size={15} /> {t('Open till', 'Fur sanduuqa')}
                  </button>
                </form>
              )}
              {closed ? (
                <p className={`rounded-[10px] px-3 py-2 text-[13px] ${closed.discrepancyMinor ? 'bg-warn-soft text-warn' : 'bg-ok-soft text-ok'}`}>
                  {t('Expected', 'La filayay')} {money(closed.expectedCashMinor)} ·{' '}
                  {closed.discrepancyMinor ? `${t('difference', 'farqi')} ${money(closed.discrepancyMinor)} — ${t('waiting for finance approval', 'sugaya oggolaanshaha maaliyadda')}` : t('balanced', 'waa isku dheellitiran yahay')}
                </p>
              ) : null}
            </div>
          </Card>

          {sel ? (
            <Card title={`${sel.invoiceNumber ?? t('Draft invoice', 'Biil qabyo ah')}`} actions={<Pill tone={tone(sel.status)}>{sel.status}</Pill>}>
              <div className="grid gap-3 px-4 pb-4 text-[13px]">
                <ul className="grid gap-1">
                  {sel.lines.map((l, i) => (
                    <li key={i} className="flex gap-2">
                      {l.description} × {l.quantity}
                      <span className="num ml-auto">{money(l.amountMinor, sel.currency)}</span>
                    </li>
                  ))}
                </ul>
                <dl className="grid grid-cols-2 gap-1 border-t border-line pt-2">
                  <dt className="text-ink-3">{t('Discount', 'Dhimis')}</dt>
                  <dd className="num text-right">−{money(sel.discountMinor, sel.currency)}</dd>
                  <dt className="font-semibold">{t('Total', 'Wadarta')}</dt>
                  <dd className="num text-right font-semibold">{money(sel.totalMinor, sel.currency)}</dd>
                  <dt className="text-ink-3">{t('Paid', 'La bixiyay')}</dt>
                  <dd className="num text-right">{money(sel.paidMinor, sel.currency)}</dd>
                  {sel.insuranceHoldMinor ? (
                    <>
                      <dt className="text-ink-3">{t('Expected from insurer', 'Laga filayo caymiska')}</dt>
                      <dd className="num text-right">{money(sel.insuranceHoldMinor, sel.currency)}</dd>
                    </>
                  ) : null}
                  <dt className="font-semibold">{t('Patient owes', 'Bukaanku waa leeyahay')}</dt>
                  <dd className="num text-right font-semibold">{money(sel.patientDueMinor, sel.currency)}</dd>
                </dl>

                {sel.status === 'Draft' ? (
                  <div className="grid gap-2">
                    {supervisor ? (
                      <form
                        className="flex flex-wrap items-end gap-2"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void run(() => api(`/billing/invoices/${sel.id}/discount`, { body: { amountMinor: toMinor(disc.amount), reason: disc.reason } }), () => setDisc({ amount: '', reason: '' }));
                        }}
                      >
                        <Field label={t('Discount', 'Dhimis')} error={fe.amountMinor}>
                          <input className="input h-9 w-24" inputMode="decimal" required value={disc.amount} onChange={(e) => setDisc({ ...disc, amount: e.target.value })} />
                        </Field>
                        <Field label={t('Reason', 'Sababta')} error={fe.reason}>
                          <input className="input h-9" required minLength={5} value={disc.reason} onChange={(e) => setDisc({ ...disc, reason: e.target.value })} />
                        </Field>
                        <button className="btn h-9">{t('Apply', 'Codso')}</button>
                      </form>
                    ) : null}
                    <button className="btn btn-primary justify-self-start" disabled={act.busy} onClick={() => run(() => api(`/billing/invoices/${sel.id}/issue`, { body: {} }), () => setStatus('Issued'))}>
                      {t('Issue invoice', 'Soo saar biilka')}
                    </button>
                  </div>
                ) : null}

                {['Issued', 'PartiallyPaid'].includes(sel.status) && sel.patientDueMinor > 0 ? (
                  <form
                    className="grid gap-2 rounded-[10px] bg-surface-2 p-3"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void run(() => api(`/billing/invoices/${sel.id}/payments`, { body: { amountMinor: toMinor(pay.amount), method: pay.method, reference: pay.reference || undefined }, headers: { 'Idempotency-Key': newKey() } }));
                    }}
                  >
                    <b>{t('Take payment', 'Qaado lacag')}</b>
                    <div className="flex flex-wrap items-end gap-2">
                      <Field label={t('Amount', 'Qadarka')} error={fe.amountMinor}>
                        <input className="input h-9 w-28" inputMode="decimal" required value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} />
                      </Field>
                      <Field label={t('Method', 'Habka')}>
                        <select className="input h-9" value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}>
                          {METHODS.map((m) => (
                            <option key={m}>{m}</option>
                          ))}
                        </select>
                      </Field>
                      {pay.method !== 'cash' ? (
                        <Field label={t('Reference', 'Tixraac')}>
                          <input className="input h-9 w-32" value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} />
                        </Field>
                      ) : null}
                      <button className="btn btn-primary h-9" disabled={act.busy}>
                        {t('Record payment', 'Diiwaangeli')}
                      </button>
                    </div>
                  </form>
                ) : null}

                {sel.payments?.length ? (
                  <ul className="grid gap-1">
                    {sel.payments.map((p) => (
                      <li key={p.receiptNo} className="flex gap-2">
                        <span className="font-mono">{p.receiptNo}</span> {p.method} · {p.receivedOn}
                        <span className="num ml-auto">{money(p.amountMinor, sel.currency)}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}

                {sel.paidMinor - sel.refundedMinor > 0 ? (
                  <form
                    className="flex flex-wrap items-end gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void run(() => api(`/billing/invoices/${sel.id}/refunds`, { body: { amountMinor: toMinor(refund.amount), method: refund.method, reason: refund.reason } }), () => setRefund({ amount: '', method: 'cash', reason: '' }));
                    }}
                  >
                    <Field label={t('Refund', 'Celin')}>
                      <input className="input h-9 w-24" inputMode="decimal" required value={refund.amount} onChange={(e) => setRefund({ ...refund, amount: e.target.value })} />
                    </Field>
                    <Field label={t('Reason', 'Sababta')}>
                      <input className="input h-9" required minLength={5} value={refund.reason} onChange={(e) => setRefund({ ...refund, reason: e.target.value })} />
                    </Field>
                    <button className="btn h-9">
                      <Undo2 size={15} /> {t('Request refund', 'Codso celin')}
                    </button>
                  </form>
                ) : null}
                {supervisor && ['Draft', 'Issued'].includes(sel.status) && !sel.paidMinor ? (
                  <button className="btn justify-self-start text-crit" onClick={() => { const reason = prompt(t('Why is this invoice being voided?', 'Maxaa biilkan loo buriyay?')); if (reason) void run(() => api(`/billing/invoices/${sel.id}/void`, { body: { reason } })); }}>
                    {t('Void invoice', 'Burin biilka')}
                  </button>
                ) : null}
              </div>
            </Card>
          ) : null}

          {supervisor ? (
            <Card title={t('Refunds waiting for approval', 'Celinno sugaya oggolaansho')}>
              <ul className="grid gap-2 px-4 pb-4 text-[13px]">
                {refunds.map((x) => (
                  <li key={x.id} className="rounded-[10px] border border-line p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <b className="num">{money(x.amountMinor, x.currency)}</b> {x.method} · {x.requestedByName}
                      {x.needsFinanceDirector ? <Pill tone="warn">{t('finance director', 'agaasimaha maaliyadda')}</Pill> : null}
                    </div>
                    <p className="text-ink-2">{x.reason}</p>
                    <div className="mt-2 flex gap-2">
                      <button className="btn btn-primary h-8" disabled={x.needsFinanceDirector && !finance} onClick={() => run(() => guarded(() => api(`/billing/refunds/${x.id}/approve`, { body: {} })))}>
                        {t('Approve & pay', 'Oggolow')}
                      </button>
                      <button className="btn h-8" onClick={() => { const reason = prompt(t('Reason for rejecting', 'Sababta diidmada')); if (reason) void run(() => api(`/billing/refunds/${x.id}/reject`, { body: { reason } })); }}>
                        {t('Reject', 'Diid')}
                      </button>
                    </div>
                  </li>
                ))}
                {!refunds.length ? <li className="text-ink-3">{t('No refunds waiting.', 'Celin sugaysa ma jirto.')}</li> : null}
              </ul>
            </Card>
          ) : null}

          <Card title={t('Price list', 'Liiska qiimaha')}>
            <div className="grid gap-3 px-4 pb-4 text-[13px]">
              <ul className="grid gap-1">
                {prices.map((p) => (
                  <li key={p.code} className="flex gap-2">
                    <span className="font-mono text-[11.5px] text-ink-3">{p.code}</span> {p.name}
                    <span className="num ml-auto">{money(p.priceMinor, p.currency)}</span>
                    <span className="text-ink-3">v{p.version}</span>
                  </li>
                ))}
              </ul>
              {finance ? (
                <form
                  className="grid gap-2 sm:grid-cols-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void run(() => api('/billing/prices', { body: { code: price.code, name: price.name, category: price.category, priceMinor: toMinor(price.amount), currency: price.currency } }), () => setPrice({ ...price, code: '', name: '', amount: '' }));
                  }}
                >
                  <Field label={t('Code', 'Koodh')} error={fe.code}>
                    <input className="input h-9" required value={price.code} onChange={(e) => setPrice({ ...price, code: e.target.value })} placeholder="LAB-CBC" />
                  </Field>
                  <Field label={t('Name', 'Magaca')} error={fe.name}>
                    <input className="input h-9" required value={price.name} onChange={(e) => setPrice({ ...price, name: e.target.value })} />
                  </Field>
                  <Field label={t('Category', 'Qaybta')}>
                    <select className="input h-9" value={price.category} onChange={(e) => setPrice({ ...price, category: e.target.value })}>
                      {['consultation', 'laboratory', 'imaging', 'pharmacy', 'inpatient', 'procedure', 'other'].map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t('Price', 'Qiimaha')} error={fe.priceMinor}>
                    <div className="flex gap-2">
                      <input className="input h-9 w-full" inputMode="decimal" required value={price.amount} onChange={(e) => setPrice({ ...price, amount: e.target.value })} />
                      <select className="input h-9" value={price.currency} onChange={(e) => setPrice({ ...price, currency: e.target.value })}>
                        <option>USD</option>
                        <option>SOS</option>
                      </select>
                    </div>
                  </Field>
                  <button className="btn btn-primary h-9 justify-self-start">{t('Save price (new version)', 'Kaydi qiimaha')}</button>
                </form>
              ) : null}
            </div>
          </Card>
          {supervisor ? <PaymentProviders /> : null}
        </div>
      </div>
    </>
  );
}
