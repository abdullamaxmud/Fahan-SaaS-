'use client';

import { useCallback, useEffect, useState } from 'react';
import { Camera, Download, ShieldCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { canDo, useMe } from '@/lib/session';
import { Card, ErrorNote, Field, PageHeader, Pill, useAction } from '@/components/ui';
import { MetricTable, download, thisMonth, useMetricDefs } from '@/components/intel';

type Kind = 'operations' | 'finance' | 'disease';
interface Snap {
  id: string;
  kind: Kind;
  period: string;
  currency: string | null;
  seq: number;
  hash: string;
  capturedAt: string;
  capturedByName: string;
  facts?: {
    metrics?: Record<string, number | null>;
    unavailable?: Record<string, string>;
    rows?: { code: string; display: string; confirmedPatients: number | null; confirmedEncounters: number | null; newPatients: number | null; suspectedPatients: number | null }[];
    suppressedCells?: number;
  };
}

export default function ReportsPage() {
  const { me } = useMe();
  const { t } = useLang();
  const defs = useMetricDefs();
  const kinds = ([
    ['operations', canDo(me, 'bi', 'V') || canDo(me, 'ai360', 'V'), t('Operations', 'Hawlgallada')],
    ['finance', canDo(me, 'aifin', 'V') || canDo(me, 'acct', 'V'), t('Finance', 'Maaliyadda')],
    ['disease', canDo(me, 'aidis', 'V'), t('Disease', 'Cudurrada')],
  ] as [Kind, boolean, string][]).filter((k) => k[1]);
  const [kind, setKind] = useState<Kind>(kinds[0]?.[0] ?? 'operations');
  const [period, setPeriod] = useState(thisMonth());
  const [currency, setCurrency] = useState('USD');
  const [list, setList] = useState<Snap[]>([]);
  const [sel, setSel] = useState<Snap | null>(null);
  const [verify, setVerify] = useState<null | { intact: boolean; matchesLiveData: boolean }>(null);
  const load = useAction();
  const act = useAction();

  const refresh = useCallback(async () => {
    await load.run(async () => setList(await api<Snap[]>(`/intel/snapshots?kind=${kind}`)));
  }, [kind]);
  useEffect(() => {
    setSel(null);
    void refresh();
  }, [refresh]);

  const open = async (id: string) => {
    setVerify(null);
    const s = await load.run(() => api<Snap>(`/intel/snapshots/${id}`));
    if (s) setSel(s);
  };

  return (
    <>
      <PageHeader title={t('Reports', 'Warbixinnada')}>
        {t('Each month’s certified figures.', 'Tirooyinka bil kasta ee la hubiyay.')}
      </PageHeader>
      <div className="flex flex-wrap gap-1.5" role="tablist">
        {kinds.map(([k, , label]) => (
          <button key={k} role="tab" aria-selected={kind === k} onClick={() => setKind(k)} className={`h-9 rounded-[9px] border px-3 text-[13px] font-semibold ${kind === k ? 'border-ink bg-ink text-surface' : 'border-line'}`}>
            {label}
          </button>
        ))}
      </div>
      <ErrorNote error={load.error ?? act.error} />
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.7fr)]">
        <div className="grid gap-4">
          <Card title={t('Capture a month', 'Xafid bil')}>
            <form
              className="flex flex-wrap items-end gap-2 px-4 pb-4"
              onSubmit={async (e) => {
                e.preventDefault();
                const s = await act.run(() => api<Snap & { reused: boolean }>('/intel/snapshots', { body: { kind, period, currency } }));
                if (s) {
                  await refresh();
                  setSel(s);
                  setVerify(null);
                }
              }}
            >
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
              <button className="btn btn-primary h-9" disabled={act.busy}>
                <Camera size={15} /> {t('Capture', 'Xafid')}
              </button>
            </form>
          </Card>
          <Card title={t('Snapshots', 'Sawirada')}>
            <ul className="grid gap-1.5 px-4 pb-4 text-[13px]">
              {list.map((s) => (
                <li key={s.id}>
                  <button className={`flex w-full flex-wrap items-center gap-2 rounded-[10px] border p-2.5 text-left ${sel?.id === s.id ? 'border-ink' : 'border-line'}`} onClick={() => open(s.id)}>
                    <b>{s.period}</b> {s.currency ? <span className="text-ink-3">{s.currency}</span> : null}
                    <Pill>v{s.seq}</Pill>
                    <span className="ml-auto font-mono text-[11px] text-ink-3">{s.hash.slice(0, 10)}</span>
                  </button>
                </li>
              ))}
              {!list.length ? <li className="text-ink-3">{t('No snapshots yet.', 'Weli ma jiraan.')}</li> : null}
            </ul>
          </Card>
        </div>

        {sel?.facts ? (
          <Card
            title={`${sel.period} · v${sel.seq}`}
            actions={
              <>
                <button className="btn h-8" onClick={async () => setVerify(await api(`/intel/snapshots/${sel.id}/verify`))}>
                  <ShieldCheck size={14} /> {t('Verify', 'Hubi')}
                </button>
                <button className="btn h-8" onClick={() => act.run(() => download(`/intel/snapshots/${sel.id}/export.csv`, `fahan-${sel.kind}-${sel.period}-v${sel.seq}.csv`))}>
                  <Download size={14} /> CSV
                </button>
              </>
            }
          >
            <div className="grid gap-3 pb-4 text-[13px]">
              <p className="px-4 font-mono text-[11px] text-ink-3">
                {sel.hash} · {sel.capturedByName} · {new Date(sel.capturedAt).toLocaleString()}
              </p>
              {verify ? (
                <p className={`mx-4 rounded-[10px] px-3 py-2 text-[12.5px] ${verify.intact ? 'bg-ok-soft text-ok' : 'bg-crit-soft text-crit'}`}>
                  {verify.intact ? t('Stored figures match their fingerprint.', 'Tirooyinku waa saxan yihiin.') : t('Stored figures do NOT match their fingerprint.', 'Tirooyinku isma waafaqsana.')}{' '}
                  {verify.matchesLiveData ? t('No corrections since capture.', 'Isbeddel ma jiro.') : t('Records changed since; capture again for a new version.', 'Diiwaanka ayaa isbeddelay; mar kale xafid.')}
                </p>
              ) : null}
              {sel.facts.metrics ? <MetricTable rows={Object.entries(sel.facts.metrics)} defs={defs} currency={sel.currency ?? 'USD'} unavailable={sel.facts.unavailable} /> : null}
              {sel.facts.rows ? (
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr>
                        <th className="th">ICD-11</th>
                        <th className="th text-right">{t('Confirmed patients', 'Bukaan la xaqiijiyay')}</th>
                        <th className="th text-right">{t('Visits', 'Booqashooyin')}</th>
                        <th className="th text-right">{t('New', 'Cusub')}</th>
                        <th className="th text-right">{t('Suspected', 'La tuhunsan')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sel.facts.rows.map((r) => (
                        <tr key={r.code}>
                          <td className="td">
                            <span className="font-mono text-[11.5px] text-ink-3">{r.code}</span> {r.display}
                          </td>
                          {[r.confirmedPatients, r.confirmedEncounters, r.newPatients, r.suspectedPatients].map((v, i) => (
                            <td key={i} className="td num text-right">
                              {v === null ? <span className="text-ink-3">&lt;5</span> : v}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="px-4 pt-2 text-[12px] text-ink-3">
                    {sel.facts.suppressedCells} {t('small groups hidden (fewer than 5 patients).', 'kooxo yar ayaa la qariyay.')}
                  </p>
                </div>
              ) : null}
            </div>
          </Card>
        ) : null}
      </div>
    </>
  );
}
