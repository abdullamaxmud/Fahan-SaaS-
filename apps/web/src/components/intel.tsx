'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, Sparkles, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { money } from '@/lib/money';
import { canDo, useMe } from '@/lib/session';
import { useReauth } from './Reauth';
import { Card, ErrorNote, Field, Pill, useAction } from './ui';

export interface MetricDef { id: string; version: string; label: string; unit: 'minor' | 'count' | 'percent' | 'minutes' | 'days'; definition: string }

export const thisMonth = () => new Date().toISOString().slice(0, 7);

export function fmtMetric(unit: string, value: number | null | undefined, currency = 'USD'): string {
  if (value === null || value === undefined) return '—';
  if (unit === 'minor') return money(value, currency);
  if (unit === 'percent') return `${value}%`;
  if (unit === 'minutes') return `${value} min`;
  if (unit === 'days') return `${value} d`;
  return value.toLocaleString('en-US');
}

export function useMetricDefs() {
  const [defs, setDefs] = useState<MetricDef[]>([]);
  useEffect(() => {
    void api<{ metrics: MetricDef[] }>('/intel/metrics')
      .then((d) => setDefs(d.metrics))
      .catch(() => setDefs([]));
  }, []);
  return defs;
}

/** Downloads an authenticated file (CSV/JSON) through the same-origin API proxy. */
export async function download(path: string, filename: string) {
  const res = await fetch(`/api/v1${path}`, { credentials: 'same-origin' });
  if (!res.ok) throw new Error('Download refused');
  const blob = new Blob([await res.text()], { type: res.headers.get('content-type') ?? 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function MetricTable({ rows, defs, currency, unavailable }: { rows: [string, number | null][]; defs: MetricDef[]; currency?: string; unavailable?: Record<string, string> }) {
  const { t } = useLang();
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            <th className="th">{t('Metric', 'Cabbirka')}</th>
            <th className="th text-right">{t('Value', 'Qiimaha')}</th>
            <th className="th">{t('Definition', 'Qeexidda')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([id, v]) => {
            const d = defs.find((x) => x.id === id);
            return (
              <tr key={id}>
                <td className="td">
                  <b className="block">{d?.label ?? id}</b>
                  <span className="font-mono text-[11px] text-ink-3">
                    {id} · {d?.version}
                  </span>
                </td>
                <td className="td num text-right font-semibold">{v === null ? <Pill tone="warn">{t('unavailable', 'lama hayo')}</Pill> : fmtMetric(d?.unit ?? 'count', v, currency)}</td>
                <td className="td text-[12px] text-ink-2">{unavailable?.[id] ?? d?.definition}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface Sentence { text: string; cites: string[] }
interface Insight {
  id: string;
  kind: 'finance' | 'disease';
  period: string;
  currency: string | null;
  status: string;
  snapshotSeq: number;
  snapshotHash: string;
  provider: string;
  template: string;
  disclosure: string;
  sections: { heading: string; sentences: Sentence[] }[];
  citedFacts: { id: string; label: string; value: number; unit: string; currency?: string }[];
  check: { ok: boolean; unsupported: string[]; uncited: string[] };
  history: { at: string; action: string; byName: string; note: string | null }[];
}

const FLOW = {
  finance: [
    { from: 'Generated', to: 'Reviewed', m: 'acct', l: 'S' },
    { from: 'Reviewed', to: 'Published', m: 'acct', l: 'S' },
  ],
  disease: [
    { from: 'Generated', to: 'Validated', m: 'aidis', l: 'S' },
    { from: 'Validated', to: 'Reviewed', m: 'aidis', l: 'A' },
  ],
} as const;
export const statusTone = (s: string) => (['Published', 'Reviewed', 'Approved'].includes(s) ? 'ok' : ['Rejected', 'Failed', 'Superseded'].includes(s) ? 'crit' : s === 'Generated' || s === 'Built' ? 'info' : 'warn');

/** The review board for AI summaries (spec §5.30, §5.31): generate from a snapshot, read with citations, review, release. */
export function InsightBoard({ kind }: { kind: 'finance' | 'disease' }) {
  const { me } = useMe();
  const { t } = useLang();
  const { guarded, dialog } = useReauth();
  const [period, setPeriod] = useState(thisMonth());
  const [currency, setCurrency] = useState('USD');
  const [list, setList] = useState<Insight[]>([]);
  const [sel, setSel] = useState<Insight | null>(null);
  const [note, setNote] = useState('');
  const load = useAction();
  const act = useAction();
  const canGenerate = canDo(me, kind === 'finance' ? 'aifin' : 'aidis', 'V');

  const refresh = useCallback(async () => {
    await load.run(async () => setList(await api<Insight[]>(`/intel/insights?kind=${kind}`)));
  }, [kind]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const generate = async () => {
    const out = await act.run(async () => {
      const snap = await api<{ id: string }>('/intel/snapshots', { body: { kind, period, currency } });
      return api<Insight>('/intel/insights', { body: { snapshotId: snap.id } });
    });
    if (out) {
      setSel(out);
      await refresh();
    }
  };
  const move = async (path: 'advance' | 'reject') => {
    if (!sel) return;
    const out = await act.run(() => guarded(() => api<{ status: string }>(`/intel/insights/${sel.id}/${path}`, { body: path === 'reject' ? { note } : { note: note || undefined } })));
    if (out) {
      setNote('');
      setSel(await api<Insight>(`/intel/insights/${sel.id}`));
      await refresh();
    }
  };
  const step = sel ? FLOW[kind].find((s) => s.from === sel.status) : undefined;
  const canStep = step ? canDo(me, step.m, step.l) : false;

  return (
    <>
      {dialog}
      <ErrorNote error={load.error ?? act.error} />
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
        <div className="grid gap-4">
          {canGenerate ? (
            <Card title={t('Write a summary', 'Qor soo koobid')}>
              <div className="flex flex-wrap items-end gap-2 px-4 pb-4">
                <Field label={t('Month', 'Bisha')}>
                  <input className="input h-9" type="month" value={period} onChange={(e) => setPeriod(e.target.value)} />
                </Field>
                {kind === 'finance' ? (
                  <Field label={t('Currency', 'Lacagta')}>
                    <select className="input h-9" value={currency} onChange={(e) => setCurrency(e.target.value)}>
                      <option>USD</option>
                      <option>SOS</option>
                    </select>
                  </Field>
                ) : null}
                <button className="btn btn-primary h-9" disabled={act.busy} onClick={generate}>
                  <Sparkles size={15} /> {t('Generate from certified figures', 'Ka samee tirooyinka la hubiyay')}
                </button>
              </div>
            </Card>
          ) : null}
          <Card title={t('Summaries', 'Soo koobidyada')}>
            <ul className="grid gap-1.5 px-4 pb-4 text-[13px]">
              {list.map((x) => (
                <li key={x.id}>
                  <button className={`flex w-full flex-wrap items-center gap-2 rounded-[10px] border p-2.5 text-left ${sel?.id === x.id ? 'border-ink' : 'border-line'}`} onClick={() => setSel(x)}>
                    <b>{x.period}</b>
                    {x.currency ? <span className="text-ink-3">{x.currency}</span> : null}
                    <span className="text-ink-3">snapshot v{x.snapshotSeq}</span>
                    <span className="ml-auto">
                      <Pill tone={statusTone(x.status)}>{x.status}</Pill>
                    </span>
                  </button>
                </li>
              ))}
              {!list.length ? <li className="text-ink-3">{t('No summaries yet.', 'Weli ma jiro.')}</li> : null}
            </ul>
          </Card>
        </div>

        {sel ? (
          <Card title={`${sel.period}${sel.currency ? ` · ${sel.currency}` : ''}`} actions={<Pill tone={statusTone(sel.status)}>{sel.status}</Pill>}>
            <div className="grid gap-4 px-4 pb-4 text-[13.5px]">
              <p className="flex items-start gap-2 rounded-[10px] bg-accent-soft px-3 py-2 text-[12.5px] text-accent-2">
                <Sparkles size={15} className="mt-0.5 flex-none" /> {sel.disclosure}
              </p>
              {!sel.check.ok ? (
                <div role="alert" className="rounded-[10px] bg-crit-soft px-3 py-2 text-[12.5px] text-crit">
                  {t('The number check failed; this draft cannot be released.', 'Hubinta tirooyinka way fashilantay.')}
                  <ul className="mt-1 list-disc pl-5">
                    {[...sel.check.unsupported, ...sel.check.uncited].map((u) => (
                      <li key={u}>{u}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {sel.sections.map((s) => (
                <section key={s.heading}>
                  <h4 className="eyebrow mb-1">{s.heading}</h4>
                  {s.sentences.map((x, i) => (
                    <p key={i} className="leading-relaxed">
                      {x.text}
                      {x.cites.length ? <sup className="ml-1 font-mono text-[10px] text-ink-3">[{x.cites.join(', ')}]</sup> : null}
                    </p>
                  ))}
                </section>
              ))}
              <div>
                <h4 className="eyebrow mb-1">{t('Figures cited', 'Tirooyinka la xigtay')}</h4>
                <table className="w-full border-collapse text-[12.5px]">
                  <tbody>
                    {sel.citedFacts.map((f) => (
                      <tr key={f.id}>
                        <td className="td font-mono text-[11px] text-ink-3">{f.id}</td>
                        <td className="td">{f.label}</td>
                        <td className="td num text-right font-semibold">{fmtMetric(f.unit, f.value, f.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-1 font-mono text-[10.5px] text-ink-3">
                  {sel.template} · {sel.provider} · snapshot {sel.snapshotHash.slice(0, 16)}…
                </p>
              </div>
              <ol className="grid gap-1 border-t border-line pt-2 text-[12px] text-ink-2">
                {sel.history.map((h, i) => (
                  <li key={i}>
                    {new Date(h.at).toLocaleString()} · <b>{h.action}</b> · {h.byName}
                    {h.note ? ` — ${h.note}` : ''}
                  </li>
                ))}
              </ol>
              {step && canStep && sel.check.ok ? (
                <div className="flex flex-wrap items-end gap-2">
                  <Field label={t('Note', 'Qoraal')}>
                    <input className="input h-9 w-64" value={note} onChange={(e) => setNote(e.target.value)} />
                  </Field>
                  <button className="btn btn-primary h-9" disabled={act.busy} onClick={() => move('advance')}>
                    <Check size={15} /> {t('Mark', 'Calaamadee')} {step.to}
                  </button>
                  <button className="btn h-9 text-crit" disabled={act.busy || note.trim().length < 5} onClick={() => move('reject')} title={t('Write a reason first', 'Qor sabab')}>
                    <X size={15} /> {t('Reject', 'Diid')}
                  </button>
                </div>
              ) : null}
            </div>
          </Card>
        ) : null}
      </div>
    </>
  );
}
