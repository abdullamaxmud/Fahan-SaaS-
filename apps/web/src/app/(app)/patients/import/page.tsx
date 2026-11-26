'use client';

import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, FileUp, RotateCcw, ScanSearch, ShieldCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { useMe } from '@/lib/session';
import { useReauth } from '@/components/Reauth';
import { Card, ErrorNote, Field, PageHeader, Pill, useAction } from '@/components/ui';

interface Batch { id: string; source: string; status: string; counts: Record<string, number>; report: { expectedRows: number; expectedFingerprint: string } | null; createdByName: string; history: { at: string; action: string; byName: string; note: string | null }[] }
interface Row { id: string; rowNo: number; raw: Record<string, string>; status: string; errors: string[]; candidates: { mrn?: string; names?: { given?: string; family?: string }; dob?: string; score: number; inBatchRow?: number }[]; resolution: string | null }
interface Branch { id: string; code: string; name: string }
type Verification = { expectedRows: number; actualRows: number; expectedFingerprint: string; actualFingerprint: string; verified: boolean };

const CHUNK = 80_000;
/** Splits a CSV into chunks under the request limit, repeating the header on each; never splits inside a quoted field. */
function chunks(text: string): string[] {
  const lines: string[] = [];
  let cur = '';
  let q = false;
  for (const ch of text) {
    if (ch === '"') q = !q;
    if (ch === '\n' && !q) {
      lines.push(cur.replace(/\r$/, ''));
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) lines.push(cur);
  const [header, ...body] = lines;
  const out: string[] = [];
  let buf: string[] = [];
  let size = 0;
  for (const l of body) {
    if (size + l.length > CHUNK && buf.length) {
      out.push([header, ...buf].join('\n'));
      buf = [];
      size = 0;
    }
    buf.push(l);
    size += l.length + 1;
  }
  if (buf.length) out.push([header, ...buf].join('\n'));
  return out;
}
const tone = (s: string) => (s === 'Committed' || s === 'imported' || s === 'ok' ? 'ok' : s === 'error' || s.includes('Rolled') ? 'crit' : s === 'duplicate' ? 'warn' : 'info');

export default function ImportPage() {
  const { me } = useMe();
  const { t } = useLang();
  const { guarded, dialog } = useReauth();
  const [batches, setBatches] = useState<Batch[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [sel, setSel] = useState<Batch | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [filter, setFilter] = useState('error');
  const [form, setForm] = useState({ source: 'legacy-his', branchId: '' });
  const [progress, setProgress] = useState('');
  const [verification, setVerification] = useState<Verification | null>(null);
  const load = useAction();
  const act = useAction();

  const refresh = useCallback(async () => {
    await load.run(async () => {
      const list = await api<Batch[]>('/migrations/batches');
      setBatches(list);
      setBranches(await api<Branch[]>('/migrations/branches'));
      setSel((s) => (s ? (list.find((b) => b.id === s.id) ?? null) : null));
    });
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (sel) void load.run(async () => setRows(await api<Row[]>(`/migrations/batches/${sel.id}/rows?status=${filter}`)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel?.id, sel?.status, filter]);
  const run = async (fn: () => Promise<unknown>) => {
    const out = await act.run(fn);
    if (out !== undefined) await refresh();
    return out;
  };
  const c = sel?.counts ?? {};

  return (
    <>
      {dialog}
      <PageHeader eyebrow="Phase 7 · data migration" title={t('Import patients from a legacy system', 'Ka soo dhoofi bukaanka nidaamkii hore')}>
        {t(
          'Upload the legacy list as CSV (legacy_id, given_name, middle_name, family_name, dob, sex, phone). A dry run checks every row and finds likely duplicates without writing anything; a second records officer commits; the result is reconciled by count and fingerprint and can be rolled back while unused.',
          'Soo geli liiska CSV; tijaabo ayaa la sameeyaa; sarkaal kale ayaa xaqiijiya.',
        )}
      </PageHeader>
      <ErrorNote error={load.error ?? act.error} />
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,2fr)]">
        <div className="grid gap-4">
          <Card title={t('New batch', 'Dufcad cusub')}>
            <form
              className="grid gap-2 px-4 pb-4 text-[13px]"
              onSubmit={async (e) => {
                e.preventDefault();
                const b = await run(() => api<Batch>('/migrations/batches', { body: { source: form.source, branchId: form.branchId } }));
                if (b) setSel(b as Batch);
              }}
            >
              <Field label={t('Source system code', 'Koodhka nidaamka')}>
                <input className="input h-9" required value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} />
              </Field>
              <Field label={t('Home branch for the records', 'Laanta')}>
                <select className="input h-9" required value={form.branchId} onChange={(e) => setForm({ ...form, branchId: e.target.value })}>
                  <option value="">—</option>
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.code} · {b.name}
                    </option>
                  ))}
                </select>
              </Field>
              <button className="btn btn-primary h-9 justify-self-start">{t('Create batch', 'Samee dufcad')}</button>
            </form>
          </Card>
          <Card title={t('Batches', 'Dufcadaha')}>
            <ul className="grid gap-1.5 px-4 pb-4 text-[13px]">
              {batches.map((b) => (
                <li key={b.id}>
                  <button className={`flex w-full flex-wrap items-center gap-2 rounded-[10px] border p-2.5 text-left ${sel?.id === b.id ? 'border-ink' : 'border-line'}`} onClick={() => { setSel(b); setVerification(null); }}>
                    <b>{b.source}</b> <span className="text-ink-3">{b.counts.total ?? 0} {t('rows', 'saf')}</span>
                    <span className="ml-auto">
                      <Pill tone={tone(b.status)}>{b.status}</Pill>
                    </span>
                  </button>
                </li>
              ))}
              {!batches.length ? <li className="text-ink-3">{t('No batches yet.', 'Weli ma jiraan.')}</li> : null}
            </ul>
          </Card>
        </div>

        {sel ? (
          <Card title={`${sel.source} · ${sel.createdByName}`} actions={<Pill tone={tone(sel.status)}>{sel.status}</Pill>}>
            <div className="grid gap-3 px-4 pb-4 text-[13px]">
              <div className="flex flex-wrap gap-2">
                {['total', 'ok', 'error', 'duplicate', 'imported', 'skipped', 'rolled-back'].filter((k) => c[k]).map((k) => (
                  <Pill key={k} tone={tone(k)}>
                    {k}: {c[k]}
                  </Pill>
                ))}
              </div>
              {['Draft', 'Validated'].includes(sel.status) ? (
                <div className="flex flex-wrap items-center gap-2">
                  <label className="btn h-9 cursor-pointer">
                    <FileUp size={15} /> {t('Add CSV file', 'Ku dar fayl CSV')}
                    <input
                      type="file"
                      accept=".csv,text/csv"
                      className="hidden"
                      onChange={async (e) => {
                        const f = e.target.files?.[0];
                        e.target.value = '';
                        if (!f) return;
                        const parts = chunks(await f.text());
                        for (const [i, csv] of parts.entries()) {
                          setProgress(`${t('Uploading', 'Waa la soo gelinayaa')} ${i + 1}/${parts.length}`);
                          if ((await act.run(() => api(`/migrations/batches/${sel.id}/rows`, { body: { csv } }))) === undefined) break;
                        }
                        setProgress('');
                        await refresh();
                      }}
                    />
                  </label>
                  {progress ? <span className="text-ink-3">{progress}</span> : null}
                  <button className="btn btn-primary h-9" disabled={!c.total} onClick={() => run(() => api(`/migrations/batches/${sel.id}/validate`, { body: {} }))}>
                    <ScanSearch size={15} /> {t('Dry run', 'Tijaabi')}
                  </button>
                  {sel.status === 'Validated' && sel.createdByName !== me.name ? (
                    <button className="btn btn-primary h-9" onClick={async () => { const r = await run(() => guarded(() => api<{ verification: Verification }>(`/migrations/batches/${sel.id}/commit`, { body: {} }))); if (r) setVerification((r as { verification: Verification }).verification); }}>
                      <CheckCircle2 size={15} /> {t('Commit to patient index', 'Xaqiiji')}
                    </button>
                  ) : null}
                  {sel.status === 'Validated' && sel.createdByName === me.name ? <span className="text-[12px] text-ink-3">{t('Another records officer commits this batch.', 'Sarkaal kale ayaa xaqiijiya.')}</span> : null}
                </div>
              ) : null}
              {sel.status === 'Committed' ? (
                <div className="flex flex-wrap gap-2">
                  <button className="btn h-9" onClick={async () => setVerification((await api<{ verification: Verification }>(`/migrations/batches/${sel.id}/verify`)).verification)}>
                    <ShieldCheck size={15} /> {t('Verify against the patient index', 'Hubi')}
                  </button>
                  <button className="btn h-9 text-crit" onClick={() => { const reason = prompt(t('Why roll this import back?', 'Maxaa loo celinayaa?')); if (reason) void run(() => guarded(() => api(`/migrations/batches/${sel.id}/rollback`, { body: { reason } }))); }}>
                    <RotateCcw size={15} /> {t('Roll back unused records', 'Celi')}
                  </button>
                </div>
              ) : null}
              {verification ? (
                <p className={`rounded-[10px] px-3 py-2 text-[12.5px] ${verification.verified ? 'bg-ok-soft text-ok' : 'bg-crit-soft text-crit'}`}>
                  {verification.verified ? t('Verified', 'La hubiyay') : t('NOT verified', 'Lama hubin')}: {verification.actualRows}/{verification.expectedRows} {t('records', 'diiwaan')} · {t('fingerprint', 'faraha')} {verification.actualFingerprint.slice(0, 16)}… {verification.verified ? '=' : '≠'} {verification.expectedFingerprint.slice(0, 16)}…
                </p>
              ) : null}

              <div className="flex flex-wrap gap-1.5" role="tablist">
                {['error', 'duplicate', 'ok', 'imported', 'skipped'].map((s) => (
                  <button key={s} role="tab" aria-selected={filter === s} onClick={() => setFilter(s)} className={`h-8 rounded-[9px] border px-2.5 text-[12.5px] font-semibold ${filter === s ? 'border-ink bg-ink text-surface' : 'border-line'}`}>
                    {s}
                  </button>
                ))}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[12.5px]">
                  <thead>
                    <tr>
                      <th className="th">#</th>
                      <th className="th">{t('Legacy record', 'Diiwaanka hore')}</th>
                      <th className="th">{t('Finding', 'Natiijada')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id}>
                        <td className="td num">{r.rowNo}</td>
                        <td className="td">
                          <span className="font-mono text-[11px] text-ink-3">{r.raw.legacy_id}</span> {r.raw.given_name} {r.raw.family_name} · {r.raw.dob} · {r.raw.sex}
                        </td>
                        <td className="td">
                          {r.errors.length ? <span className="text-crit">{r.errors.join('; ')}</span> : null}
                          {r.status === 'duplicate' ? (
                            <div className="grid gap-1">
                              {r.candidates.map((m, i) => (
                                <span key={i} className="text-warn">
                                  {m.inBatchRow ? `${t('same person as row', 'isla qofka safka')} ${m.inBatchRow}` : `${t('matches', 'wuxuu la mid yahay')} ${m.mrn} ${m.names?.given ?? ''} ${m.names?.family ?? ''} ${m.dob ?? ''} (${Math.round(m.score * 100)}%)`}
                                </span>
                              ))}
                              {sel.status === 'Validated' ? (
                                <div className="flex gap-2">
                                  {(['skip', 'create'] as const).map((a) => (
                                    <button key={a} className={`btn h-7 text-[12px] ${r.resolution === a ? 'border-ink' : ''}`} onClick={async () => { if (await act.run(() => api(`/migrations/batches/${sel.id}/rows/${r.id}/resolve`, { body: { action: a } }))) setRows(await api<Row[]>(`/migrations/batches/${sel.id}/rows?status=${filter}`)); }}>
                                      {a === 'skip' ? t('Same person — skip', 'Waa isla qof — ka bood') : t('Different person — create', 'Qof kale — samee')}
                                    </button>
                                  ))}
                                </div>
                              ) : null}
                            </div>
                          ) : null}
                          {r.status === 'ok' || r.status === 'imported' ? <Pill tone="ok">{r.status}</Pill> : null}
                        </td>
                      </tr>
                    ))}
                    {!rows.length ? (
                      <tr>
                        <td className="td text-ink-3" colSpan={3}>
                          {t('Nothing here.', 'Waxba ma jiraan.')}
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </div>
          </Card>
        ) : null}
      </div>
    </>
  );
}
