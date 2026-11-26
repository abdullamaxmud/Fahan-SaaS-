'use client';

import { useCallback, useEffect, useState } from 'react';
import { Download, FileCheck2, Printer, ShieldCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { money } from '@/lib/money';
import { canDo, useMe } from '@/lib/session';
import { useReauth } from '@/components/Reauth';
import { Card, ErrorNote, Field, PageHeader, Pill, useAction } from '@/components/ui';
import { download, fmtMetric, statusTone, thisMonth } from '@/components/intel';

interface CellT { metricId: string; label: string; unit: string; value: number | null; snapshotId: string; unavailable?: string }
interface Sentence { text: string; cites: string[] }
interface Narr { sections: { heading: string; sentences: Sentence[] }[] }
interface Report {
  id: string;
  period: string;
  currency: string;
  version: number;
  status: string;
  contentHash: string;
  signature: string | null;
  signoffs: { finance: { byName: string; at: string } | null; clinical: { byName: string; at: string } | null; owner: { byName: string; at: string } | null };
  check: { ok: boolean };
  history: { at: string; action: string; byName: string; note: string | null }[];
  content?: {
    cover: { organisation: string; facilities: string[]; period: string; currency: string; timezone: string };
    executive: CellT[];
    financial: { metrics: CellT[]; revenueMix: { accountCode: string; name: string; amountMinor: number }[]; expenseMix: { accountCode: string; name: string; amountMinor: number }[]; budget: { unavailable: string } };
    clinical: { topConditions: { code: string; display: string; confirmedPatients: number; newPatients: number | null; suspectedPatients: number | null }[]; countingMethod: string; suppressedCells: number; readmissions: { unavailable: string } };
    operations: CellT[];
    quality: CellT[];
    narrative: { disclosure: string; finance: Narr; clinical: Narr };
    sources: { snapshotId: string; kind: string; seq: number; hash: string; metricVersion: string }[];
  };
}

function Cells({ cells, currency }: { cells: CellT[]; currency: string }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {cells.map((c) => (
        <div key={c.metricId} className="rounded-[10px] border border-line px-3 py-2" title={`${c.metricId} · snapshot ${c.snapshotId}`}>
          <span className="block text-[11.5px] text-ink-3">{c.label}</span>
          {c.value === null ? <span className="text-[12px] text-warn">{c.unavailable}</span> : <b className="num text-[18px]">{fmtMetric(c.unit, c.value, currency)}</b>}
          <span className="block font-mono text-[10px] text-ink-3">{c.metricId}</span>
        </div>
      ))}
    </div>
  );
}

function NarrativeBlock({ n }: { n: Narr }) {
  return (
    <>
      {n.sections.map((s) => (
        <div key={s.heading} className="mb-2">
          <h5 className="text-[12px] font-semibold text-ink-2">{s.heading}</h5>
          {s.sentences.map((x, i) => (
            <p key={i}>
              {x.text}
              {x.cites.length ? <sup className="ml-1 font-mono text-[10px] text-ink-3">[{x.cites.join(', ')}]</sup> : null}
            </p>
          ))}
        </div>
      ))}
    </>
  );
}

export default function Hospital360Page() {
  const { me } = useMe();
  const { t } = useLang();
  const { guarded, dialog } = useReauth();
  const [list, setList] = useState<Report[]>([]);
  const [sel, setSel] = useState<Report | null>(null);
  const [period, setPeriod] = useState(thisMonth());
  const [currency, setCurrency] = useState('USD');
  const [verify, setVerify] = useState<null | { contentIntact: boolean; signatureValid: boolean }>(null);
  const load = useAction();
  const act = useAction();
  const builder = canDo(me, 'ai360', 'S');
  const owner = canDo(me, 'ai360', 'A');
  const financeSigner = builder && canDo(me, 'acct', 'S');
  const clinicalSigner = builder && canDo(me, 'aidis', 'V');

  const refresh = useCallback(async () => {
    await load.run(async () => setList(await api<Report[]>('/intel/h360')));
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const open = async (id: string) => {
    setVerify(null);
    const r = await load.run(() => api<Report>(`/intel/h360/${id}`));
    if (r) setSel(r);
  };
  const run = async (fn: () => Promise<unknown>) => {
    if ((await act.run(fn)) !== undefined && sel) {
      await open(sel.id);
      await refresh();
    }
  };
  const c = sel?.content;

  return (
    <>
      {dialog}
      <div className="print:hidden">
        <PageHeader title={t('Monthly report', 'Warbixinta bisha')}>
          {t('The signed monthly report for leadership.', 'Warbixinta bisha ee saxiixan.')}
        </PageHeader>
      </div>
      <ErrorNote error={load.error ?? act.error} />
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,2fr)]">
        <div className="grid gap-4 print:hidden">
          {builder ? (
            <Card title={t('Build a report', 'Dhis warbixin')}>
              <form
                className="flex flex-wrap items-end gap-2 px-4 pb-4"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const r = await act.run(() => api<Report>('/intel/h360', { body: { period, currency } }));
                  if (r) {
                    await refresh();
                    setSel(r);
                  }
                }}
              >
                <Field label={t('Month', 'Bisha')}>
                  <input className="input h-9" type="month" value={period} onChange={(e) => setPeriod(e.target.value)} />
                </Field>
                <Field label={t('Currency', 'Lacagta')}>
                  <select className="input h-9" value={currency} onChange={(e) => setCurrency(e.target.value)}>
                    <option>USD</option>
                    <option>SOS</option>
                  </select>
                </Field>
                <button className="btn btn-primary h-9" disabled={act.busy}>
                  <FileCheck2 size={15} /> {t('Build', 'Dhis')}
                </button>
              </form>
            </Card>
          ) : null}
          <Card title={t('Reports', 'Warbixinnada')}>
            <ul className="grid gap-1.5 px-4 pb-4 text-[13px]">
              {list.map((r) => (
                <li key={r.id}>
                  <button className={`flex w-full flex-wrap items-center gap-2 rounded-[10px] border p-2.5 text-left ${sel?.id === r.id ? 'border-ink' : 'border-line'}`} onClick={() => open(r.id)}>
                    <b>{r.period}</b> <span className="text-ink-3">{r.currency}</span> <Pill>v{r.version}</Pill>
                    <span className="ml-auto">
                      <Pill tone={statusTone(r.status)}>{r.status}</Pill>
                    </span>
                  </button>
                </li>
              ))}
              {!list.length ? <li className="text-ink-3">{t('No reports yet.', 'Weli ma jiraan.')}</li> : null}
            </ul>
          </Card>
        </div>

        {sel && c ? (
          <article className="card grid gap-5 p-5 text-[13.5px] print:border-0 print:shadow-none">
            <header className="flex flex-wrap items-start gap-3 border-b border-line pb-3">
              <div>
                <span className="eyebrow">Hospital 360 · {c.cover.period}</span>
                <h2 className="text-[22px] font-extrabold">{c.cover.organisation}</h2>
                <p className="text-ink-2">
                  {c.cover.facilities.join(' · ')} · {c.cover.currency} · {c.cover.timezone} · v{sel.version}
                </p>
              </div>
              <div className="ml-auto flex flex-wrap gap-2 print:hidden">
                <Pill tone={statusTone(sel.status)}>{sel.status}</Pill>
                <button className="btn h-8" onClick={async () => setVerify(await api(`/intel/h360/${sel.id}/verify`))}>
                  <ShieldCheck size={14} /> {t('Verify', 'Hubi')}
                </button>
                <button className="btn h-8" onClick={() => window.print()}>
                  <Printer size={14} /> {t('Print / PDF', 'Daabac')}
                </button>
                {['Published', 'Superseded'].includes(sel.status) ? (
                  <button className="btn h-8" onClick={() => act.run(() => download(`/intel/h360/${sel.id}/export`, `hospital-360-${sel.period}-v${sel.version}.json`))}>
                    <Download size={14} /> {t('Export', 'Soo dejiso')}
                  </button>
                ) : null}
              </div>
            </header>
            {verify ? (
              <p className={`rounded-[10px] px-3 py-2 text-[12.5px] print:hidden ${verify.contentIntact ? 'bg-ok-soft text-ok' : 'bg-crit-soft text-crit'}`}>
                {verify.contentIntact ? t('Content matches its fingerprint.', 'Waa saxan yahay.') : t('Content does NOT match its fingerprint.', 'Isma waafaqsana.')} {sel.signature ? (verify.signatureValid ? t('Signature valid.', 'Saxiixu waa sax.') : t('Signature invalid.', 'Saxiixu waa khalad.')) : ''}
              </p>
            ) : null}

            <section>
              <h3 className="mb-2 text-[15px] font-bold">{t('Executive dashboard', 'Guudmar')}</h3>
              <Cells cells={c.executive} currency={sel.currency} />
            </section>
            <section>
              <h3 className="mb-2 text-[15px] font-bold">{t('Financial', 'Maaliyadda')}</h3>
              <Cells cells={c.financial.metrics} currency={sel.currency} />
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                {[
                  [t('Revenue mix', 'Dakhliga'), c.financial.revenueMix],
                  [t('Expenses', 'Kharashyada'), c.financial.expenseMix],
                ].map(([label, rows]) => (
                  <div key={label as string}>
                    <h5 className="text-[12px] font-semibold text-ink-2">{label as string}</h5>
                    <ul>
                      {(rows as { accountCode: string; name: string; amountMinor: number }[]).map((r) => (
                        <li key={r.accountCode} className="flex gap-2">
                          {r.name} <span className="num ml-auto">{money(r.amountMinor, sel.currency)}</span>
                        </li>
                      ))}
                      {!(rows as unknown[]).length ? <li className="text-ink-3">—</li> : null}
                    </ul>
                  </div>
                ))}
              </div>
              <p className="mt-1 text-[12px] text-warn">{c.financial.budget.unavailable}</p>
            </section>
            <section>
              <h3 className="mb-2 text-[15px] font-bold">{t('Clinical', 'Caafimaadka')}</h3>
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <th className="th">ICD-11</th>
                    <th className="th text-right">{t('Confirmed patients', 'La xaqiijiyay')}</th>
                    <th className="th text-right">{t('New', 'Cusub')}</th>
                    <th className="th text-right">{t('Suspected', 'La tuhunsan')}</th>
                  </tr>
                </thead>
                <tbody>
                  {c.clinical.topConditions.map((x) => (
                    <tr key={x.code}>
                      <td className="td">
                        <span className="font-mono text-[11.5px] text-ink-3">{x.code}</span> {x.display}
                      </td>
                      <td className="td num text-right">{x.confirmedPatients}</td>
                      <td className="td num text-right">{x.newPatients ?? '<5'}</td>
                      <td className="td num text-right">{x.suspectedPatients ?? '<5'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-1 text-[12px] text-ink-3">
                {c.clinical.countingMethod} {c.clinical.suppressedCells} {t('small groups hidden.', 'kooxo yar ayaa la qariyay.')}
              </p>
            </section>
            <section>
              <h3 className="mb-2 text-[15px] font-bold">{t('Operations', 'Hawlgallada')}</h3>
              <Cells cells={c.operations} currency={sel.currency} />
            </section>
            <section>
              <h3 className="mb-2 text-[15px] font-bold">{t('Quality & patient safety', 'Tayada & badbaadada')}</h3>
              <Cells cells={c.quality} currency={sel.currency} />
            </section>
            <section className="rounded-[12px] bg-surface-2 p-4">
              <h3 className="mb-1 text-[15px] font-bold">{t('AI narrative', 'Qoraalka AI')}</h3>
              <p className="mb-2 text-[12px] text-accent-2">{c.narrative.disclosure}</p>
              <NarrativeBlock n={c.narrative.finance} />
              <NarrativeBlock n={c.narrative.clinical} />
            </section>
            <section>
              <h3 className="mb-2 text-[15px] font-bold">{t('Sign-off', 'Saxiixyada')}</h3>
              <ul className="grid gap-1">
                {(['finance', 'clinical', 'owner'] as const).map((k) => (
                  <li key={k} className="flex flex-wrap items-center gap-2">
                    <b className="w-24 capitalize">{k}</b>
                    {sel.signoffs[k] ? (
                      <span>
                        {sel.signoffs[k]!.byName} · {new Date(sel.signoffs[k]!.at).toLocaleString()}
                      </span>
                    ) : (
                      <span className="text-ink-3">{t('not yet', 'weli')}</span>
                    )}
                    {k !== 'owner' && !sel.signoffs[k] && sel.status === 'Built' && (k === 'finance' ? financeSigner : clinicalSigner) ? (
                      <button className="btn btn-primary h-8 print:hidden" onClick={() => run(() => api(`/intel/h360/${sel.id}/signoff`, { body: { section: k } }))}>
                        {t('Sign this section', 'Saxiix qaybtan')}
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
              <div className="mt-2 flex flex-wrap gap-2 print:hidden">
                {owner && sel.status === 'Reviewed' ? (
                  <button className="btn btn-primary h-9" onClick={() => run(() => guarded(() => api(`/intel/h360/${sel.id}/approve`, { body: {} })))}>
                    {t('Approve as owner', 'Oggolow')}
                  </button>
                ) : null}
                {owner && sel.status === 'Approved' ? (
                  <button className="btn btn-primary h-9" onClick={() => run(() => guarded(() => api(`/intel/h360/${sel.id}/publish`, { body: {} })))}>
                    {t('Publish & sign', 'Daabac & saxiix')}
                  </button>
                ) : null}
                {builder && ['Built', 'Reviewed', 'Approved'].includes(sel.status) ? (
                  <button className="btn h-9 text-crit" onClick={() => { const note = prompt(t('Why is this report rejected?', 'Maxaa loo diiday?')); if (note) void run(() => api(`/intel/h360/${sel.id}/reject`, { body: { note } })); }}>
                    {t('Reject', 'Diid')}
                  </button>
                ) : null}
              </div>
            </section>
            <footer className="border-t border-line pt-2 font-mono text-[10.5px] text-ink-3">
              {t('Fingerprint', 'Faraha')} {sel.contentHash}
              {sel.signature ? ` · ${t('signature', 'saxiix')} ${sel.signature.slice(0, 24)}…` : ''}
              <br />
              {c.sources.map((s) => `${s.kind} v${s.seq} (${s.metricVersion}) ${s.hash.slice(0, 12)}`).join(' · ')}
            </footer>
          </article>
        ) : null}
      </div>
    </>
  );
}
