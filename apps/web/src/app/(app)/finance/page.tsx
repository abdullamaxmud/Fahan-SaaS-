'use client';

import { useCallback, useEffect, useState } from 'react';
import { Lock, Plus, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { money, toMinor } from '@/lib/money';
import { canDo, useMe } from '@/lib/session';
import { useReauth } from '@/components/Reauth';
import { Card, ErrorNote, Field, PageHeader, Pill, fieldErrors, useAction } from '@/components/ui';

interface Account { code: string; name: string; type: string }
interface Summary { grossBilledMinor: number; netBilledMinor: number; cashCollectedMinor: number; accountsReceivableMinor: number; recognizedRevenueMinor: number; operatingExpensesMinor: number; operatingResultMinor: number; metricVersion: string }
interface Row { accountCode: string; debitMinor: number; creditMinor: number }
interface JLine { accountCode: string; debitMinor: number; creditMinor: number }
interface Entry { id: string; entryNo: string; postingDate: string; memo: string; totalMinor: number; state: string; source: { type: string; kind: string }; reversalOf: string | null; lines: JLine[] }
interface Draft { id: string; postingDate: string; memo: string; totalMinor: number; mine: boolean; createdByName: string | null; lines: JLine[] }
interface Period { key: string; status: string }

const thisMonth = () => new Date().toISOString().slice(0, 7);
const prevMonth = (k: string) => {
  const [y, m] = k.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 2, 1)).toISOString().slice(0, 7);
};

export default function FinancePage() {
  const { me } = useMe();
  const { t } = useLang();
  const { guarded, dialog } = useReauth();
  const [currency, setCurrency] = useState<'USD' | 'SOS'>('USD');
  const [period, setPeriod] = useState(thisMonth());
  const [summary, setSummary] = useState<Summary | null>(null);
  const [tb, setTb] = useState<{ rows: Row[]; totalDebitMinor: number; totalCreditMinor: number; balanced: boolean } | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [periods, setPeriods] = useState<Period[]>([]);
  const [jr, setJr] = useState({ postingDate: new Date().toISOString().slice(0, 10), memo: '', lines: [{ accountCode: '', debit: '', credit: '' }, { accountCode: '', debit: '', credit: '' }] });
  const load = useAction();
  const act = useAction();
  const preparer = canDo(me, 'acct', 'E');
  const approver = canDo(me, 'acct', 'S');
  const admin = canDo(me, 'acct', 'A');

  const refresh = useCallback(async () => {
    await load.run(async () => {
      const [s, b, a, e, d, p] = await Promise.all([
        api<Summary>(`/accounting/summary?period=${period}&currency=${currency}`),
        api<typeof tb>(`/accounting/trial-balance?currency=${currency}`),
        api<Account[]>('/accounting/accounts'),
        api<Entry[]>(`/accounting/journals?period=${period}&currency=${currency}`),
        api<Draft[]>('/accounting/journals/drafts'),
        api<Period[]>('/accounting/periods'),
      ]);
      setSummary(s);
      setTb(b);
      setAccounts(a);
      setEntries(e);
      setDrafts(d);
      setPeriods(p);
    });
  }, [period, currency]);
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
  const name = (code: string) => accounts.find((a) => a.code === code)?.name ?? code;
  const drTotal = jr.lines.reduce((n, l) => n + (toMinor(l.debit || '0') || 0), 0);
  const crTotal = jr.lines.reduce((n, l) => n + (toMinor(l.credit || '0') || 0), 0);
  const closeable = prevMonth(thisMonth());
  const isClosed = (k: string) => periods.some((p) => p.key === k && p.status === 'closed');

  const tiles: [string, string, number | undefined][] = [
    [t('Gross billed', 'Biilka guud'), t('invoices issued this month, before discounts', 'biilasha bishan'), summary?.grossBilledMinor],
    [t('Recognised revenue', 'Dakhliga la aqoonsaday'), t('after discounts, refunds and write-offs', 'kadib dhimista'), summary?.recognizedRevenueMinor],
    [t('Cash collected', 'Lacagta la ururiyay'), t('payments less refunds paid', 'lacag bixinta'), summary?.cashCollectedMinor],
    [t('Receivable', 'Deynta'), t('owed by patients and insurers at month end', 'deynta bukaanka iyo caymiska'), summary?.accountsReceivableMinor],
    [t('Operating expenses', 'Kharashyada'), t('salaries, supplies, other', 'mushaharka iyo agabka'), summary?.operatingExpensesMinor],
    [t('Operating result', 'Natiijada'), t('revenue less expenses', 'dakhliga ka jar kharashka'), summary?.operatingResultMinor],
  ];

  return (
    <>
      {dialog}
      <PageHeader title={t('Finance', 'Maaliyadda')}>
        {t('Ledger, journals and month-end close.', 'Buugga xisaabta, qoraallada iyo xiritaanka bisha.')}
      </PageHeader>
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t('Month', 'Bisha')}>
          <input className="input h-9" type="month" value={period} onChange={(e) => setPeriod(e.target.value)} />
        </Field>
        <Field label={t('Currency', 'Lacagta')}>
          <select className="input h-9" value={currency} onChange={(e) => setCurrency(e.target.value as 'USD' | 'SOS')}>
            <option>USD</option>
            <option>SOS</option>
          </select>
        </Field>
        {isClosed(period) ? (
          <Pill tone="info">
            <Lock size={12} /> {t('closed', 'xiran')}
          </Pill>
        ) : null}
      </div>
      <ErrorNote error={load.error ?? (Object.keys(fe).length ? null : act.error)} />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {tiles.map(([label, hint, v]) => (
          <div key={label} className="card px-4 py-3">
            <span className="eyebrow">{label}</span>
            <b className="num block text-[24px]">{money(v, currency)}</b>
            <span className="text-[12px] text-ink-3">{hint}</span>
          </div>
        ))}
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="grid gap-4">
          <Card title={t('Journal entries', 'Qorista buugga')}>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr>
                    <th className="th">{t('Entry', 'Qoraal')}</th>
                    <th className="th">{t('Date', 'Taariikh')}</th>
                    <th className="th">{t('Memo', 'Faahfaahin')}</th>
                    <th className="th text-right">{t('Amount', 'Qadarka')}</th>
                    <th className="th" />
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => (
                    <tr key={e.id}>
                      <td className="td font-mono text-[12px]">{e.entryNo}</td>
                      <td className="td">{e.postingDate}</td>
                      <td className="td">
                        {e.memo}
                        <span className="block text-[11.5px] text-ink-3">
                          {e.source.type} · {e.lines.map((l) => `${l.accountCode} ${l.debitMinor ? 'Dr' : 'Cr'}`).join(', ')}
                        </span>
                      </td>
                      <td className="td num text-right">{money(e.totalMinor, currency)}</td>
                      <td className="td">
                        {e.state === 'reversed' ? <Pill tone="crit">{t('reversed', 'la celiyay')}</Pill> : e.reversalOf ? <Pill tone="info">{t('reversal', 'celin')}</Pill> : null}
                        {approver && e.state === 'posted' && !e.reversalOf && e.source.type === 'manual' ? (
                          <button className="btn h-7 text-[12px]" onClick={() => { const reason = prompt(t('Why reverse this entry?', 'Maxaa loo celinayaa?')); if (reason) void run(() => guarded(() => api(`/accounting/journals/${e.id}/reverse`, { body: { reason } }))); }}>
                            {t('Reverse', 'Celi')}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                  {!entries.length ? (
                    <tr>
                      <td className="td text-ink-3" colSpan={5}>
                        {t('Nothing posted this month.', 'Bishan waxba lama qorin.')}
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </Card>

          {preparer ? (
            <Card title={t('New manual journal', 'Qoraal cusub')}>
              <form
                className="grid gap-3 px-4 pb-4 text-[13px]"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(
                    () => api('/accounting/journals', { body: { postingDate: jr.postingDate, currency, memo: jr.memo, lines: jr.lines.filter((l) => l.accountCode).map((l) => ({ accountCode: l.accountCode, debitMinor: toMinor(l.debit || '0') || 0, creditMinor: toMinor(l.credit || '0') || 0 })) } }),
                    () => setJr({ ...jr, memo: '', lines: [{ accountCode: '', debit: '', credit: '' }, { accountCode: '', debit: '', credit: '' }] }),
                  );
                }}
              >
                <div className="grid gap-2 sm:grid-cols-[160px_1fr]">
                  <Field label={t('Posting date', 'Taariikhda')}>
                    <input className="input h-9" type="date" required value={jr.postingDate} onChange={(e) => setJr({ ...jr, postingDate: e.target.value })} />
                  </Field>
                  <Field label={t('Memo', 'Faahfaahin')} error={fe.memo}>
                    <input className="input h-9" required minLength={3} value={jr.memo} onChange={(e) => setJr({ ...jr, memo: e.target.value })} />
                  </Field>
                </div>
                {jr.lines.map((l, i) => (
                  <div key={i} className="grid grid-cols-[1fr_96px_96px_32px] items-center gap-2">
                    <select className="input h-9" aria-label="Account" value={l.accountCode} onChange={(e) => setJr({ ...jr, lines: jr.lines.map((x, j) => (j === i ? { ...x, accountCode: e.target.value } : x)) })}>
                      <option value="">{t('Account…', 'Akoon…')}</option>
                      {accounts.map((a) => (
                        <option key={a.code} value={a.code}>
                          {a.code} · {a.name}
                        </option>
                      ))}
                    </select>
                    <input className="input h-9" inputMode="decimal" placeholder={t('Debit', 'Deyn')} value={l.debit} onChange={(e) => setJr({ ...jr, lines: jr.lines.map((x, j) => (j === i ? { ...x, debit: e.target.value, credit: '' } : x)) })} />
                    <input className="input h-9" inputMode="decimal" placeholder={t('Credit', 'Amaah')} value={l.credit} onChange={(e) => setJr({ ...jr, lines: jr.lines.map((x, j) => (j === i ? { ...x, credit: e.target.value, debit: '' } : x)) })} />
                    <button type="button" className="btn h-9 px-2" aria-label="Remove line" disabled={jr.lines.length <= 2} onClick={() => setJr({ ...jr, lines: jr.lines.filter((_, j) => j !== i) })}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" className="btn h-8" onClick={() => setJr({ ...jr, lines: [...jr.lines, { accountCode: '', debit: '', credit: '' }] })}>
                    <Plus size={14} /> {t('Line', 'Sadar')}
                  </button>
                  <span className={`num ml-auto ${drTotal === crTotal && drTotal > 0 ? 'text-ok' : 'text-crit'}`}>
                    Dr {money(drTotal, currency)} · Cr {money(crTotal, currency)}
                  </span>
                  <button className="btn btn-primary h-9" disabled={drTotal !== crTotal || !drTotal}>
                    {t('Save for approval', 'U kaydi oggolaansho')}
                  </button>
                </div>
              </form>
            </Card>
          ) : null}
        </div>

        <div className="grid gap-4">
          <Card title={t('Waiting for a second person', 'Sugaya qof labaad')}>
            <ul className="grid gap-2 px-4 pb-4 text-[13px]">
              {drafts.map((d) => (
                <li key={d.id} className="rounded-[10px] border border-line p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <b>{d.memo}</b>
                    <span className="num ml-auto">{money(d.totalMinor)}</span>
                  </div>
                  <p className="text-ink-3">
                    {d.postingDate} · {d.createdByName} · {d.lines.map((l) => `${l.accountCode} ${name(l.accountCode)}`).join(' / ')}
                  </p>
                  {approver ? (
                    d.mine ? (
                      <p className="mt-1 text-[12px] text-ink-3">{t('You prepared this; someone else approves it.', 'Adaa diyaariyay; qof kale ayaa oggolaanaya.')}</p>
                    ) : (
                      <button className="btn btn-primary mt-2 h-8" onClick={() => run(() => guarded(() => api(`/accounting/journals/${d.id}/approve`, { body: {} })))}>
                        {t('Approve & post', 'Oggolow')}
                      </button>
                    )
                  ) : null}
                </li>
              ))}
              {!drafts.length ? <li className="text-ink-3">{t('Nothing waiting.', 'Waxba ma sugayaan.')}</li> : null}
            </ul>
          </Card>

          <Card title={t('Trial balance', 'Isu-dheellitirka')} actions={tb ? <Pill tone={tb.balanced ? 'ok' : 'crit'}>{tb.balanced ? t('balanced', 'dheellitiran') : t('out of balance', 'aan dheellitirnayn')}</Pill> : null}>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr>
                    <th className="th">{t('Account', 'Akoon')}</th>
                    <th className="th text-right">Dr</th>
                    <th className="th text-right">Cr</th>
                  </tr>
                </thead>
                <tbody>
                  {tb?.rows
                    .filter((r) => r.debitMinor !== r.creditMinor)
                    .map((r) => {
                      const net = r.debitMinor - r.creditMinor;
                      return (
                        <tr key={r.accountCode}>
                          <td className="td">
                            <span className="font-mono text-[11.5px] text-ink-3">{r.accountCode}</span> {name(r.accountCode)}
                          </td>
                          <td className="td num text-right">{net > 0 ? money(net, currency) : ''}</td>
                          <td className="td num text-right">{net < 0 ? money(-net, currency) : ''}</td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </Card>

          {admin ? (
            <Card title={t('Close a month', 'Xir bil')}>
              <div className="grid gap-2 px-4 pb-4 text-[13px]">
                <p className="text-ink-2">{t('A closed month accepts no more postings. Corrections land in the open month by reversal.', 'Bil xiran wax dambe laguma qoro.')}</p>
                {isClosed(closeable) ? (
                  <Pill tone="info">
                    {closeable} {t('is closed', 'waa xiran')}
                  </Pill>
                ) : (
                  <button className="btn justify-self-start" onClick={() => run(() => guarded(() => api(`/accounting/periods/${closeable}/close`, { body: {} })))}>
                    <Lock size={14} /> {t('Close', 'Xir')} {closeable}
                  </button>
                )}
              </div>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
