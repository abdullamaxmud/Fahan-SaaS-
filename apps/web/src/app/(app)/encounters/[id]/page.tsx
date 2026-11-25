'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { CheckCircle2, PenLine, Plus, Trash2 } from 'lucide-react';
import { VITALS, VITAL_BY_CODE, searchIcd } from '@fahan/terminology';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { canDo, useMe } from '@/lib/session';
import { useReauth } from '@/components/Reauth';
import { PatientBand, type PatientBrief } from '@/components/clinical';
import { Card, ErrorNote, Field, Pill, fieldErrors, statusTone, useAction } from '@/components/ui';

interface Obs {
  id: string;
  code: string;
  value: number;
  unit: string;
  status: string;
  effectiveAt: string;
  source: string;
  correctionReason: string | null;
}
interface Note {
  id: string;
  kind: string;
  text: string;
  status: string;
  authorId: string;
  authorName: string;
  createdAt: string;
  signedAt: string | null;
  amendReason: string | null;
  version: number;
}
interface Dx {
  id: string;
  code: string;
  display: string;
  certainty: string;
  primary: boolean;
  version: number;
}
interface Encounter {
  id: string;
  status: string;
  queueNo: number | null;
  reason: string | null;
  startedAt: string;
  patient: PatientBrief;
  team: { id: string; name: string; roles: string[] }[];
  observations: Obs[];
  notes: Note[];
  diagnoses: Dx[];
}

const KINDS = ['history', 'examination', 'assessment', 'plan', 'progress'];

export default function EncounterPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { me } = useMe();
  const { t, lang } = useLang();
  const [e, setE] = useState<Encounter | null>(null);
  const [vital, setVital] = useState({ code: 'temperature', value: '' });
  const [note, setNote] = useState({ kind: 'history', text: '' });
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [amend, setAmend] = useState<{ id: string; text: string; reason: string } | null>(null);
  const [dx, setDx] = useState({ q: '', code: '', display: '', certainty: 'suspected', primary: true });
  const load = useAction();
  const act = useAction();
  const { guarded, dialog } = useReauth();

  const refresh = useCallback(async () => {
    await load.run(async () => setE(await api<Encounter>(`/encounters/${id}`)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!e) return <ErrorNote error={load.error} />;
  const closed = e.status === 'Closed';
  const canObs = !closed && (canDo(me, 'nur', 'E') || canDo(me, 'opd', 'E'));
  const canNote = !closed && canDo(me, 'opd', 'E');
  const canSign = canDo(me, 'opd', 'S');
  const fe = fieldErrors(act.error);
  const run = async (fn: () => Promise<unknown>) => {
    if ((await act.run(fn)) !== undefined) await refresh();
  };

  // Latest recorded value per vital for the summary row.
  const latest = VITALS.map((v) => ({ v, o: e.observations.find((o) => o.code === v.code && o.status === 'Recorded') })).filter((x) => x.o);
  const suggestions = dx.q ? searchIcd(dx.q).slice(0, 6) : [];

  return (
    <>
      {dialog}
      <PatientBand p={e.patient}>
        <Pill tone={statusTone(closed ? 'Active' : 'info')}>{e.status}</Pill>
        {e.queueNo ? <Pill tone="acc">Queue #{e.queueNo}</Pill> : null}
        {e.reason ? <span className="text-[13px] text-ink-2">{e.reason}</span> : null}
      </PatientBand>
      <ErrorNote error={Object.keys(fe).length ? null : act.error} />

      {latest.length ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
          {latest.map(({ v, o }) => (
            <div key={v.code} className="card p-3">
              <span className="block text-[11.5px] text-ink-2">{lang === 'so' ? v.so : v.name}</span>
              <span className="num font-display text-2xl font-semibold">
                {o!.value}
                <small className="ml-1 font-sans text-xs text-ink-3">{v.unit}</small>
              </span>
            </div>
          ))}
        </div>
      ) : null}

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="grid gap-4">
          <Card title={t('Notes', 'Qoraallada')}>
            <div className="grid gap-3 px-4 pb-4">
              {e.notes.map((n) => {
                const mine = n.authorId === me.id;
                const draftText = editing[n.id];
                return (
                  <article key={n.id} className={`rounded-[10px] border p-3 ${n.status === 'Amended' ? 'border-line opacity-60' : n.status === 'Draft' ? 'border-dashed border-line-2' : 'border-line'}`}>
                    <header className="mb-1.5 flex flex-wrap items-center gap-2 text-[12px]">
                      <b className="text-[13px] capitalize">{n.kind}</b>
                      <Pill tone={n.status === 'Signed' ? 'ok' : n.status === 'Draft' ? 'warn' : 'plain'}>{n.status}</Pill>
                      <span className="text-ink-3">
                        {n.authorName} · {new Date(n.signedAt ?? n.createdAt).toLocaleString()}
                      </span>
                      {n.amendReason ? <span className="text-ink-3">· {t('amended', 'la beddelay')}: {n.amendReason}</span> : null}
                    </header>
                    {n.status === 'Draft' && mine && draftText !== undefined ? (
                      <textarea className="input min-h-28 py-2" value={draftText} onChange={(x) => setEditing({ ...editing, [n.id]: x.target.value })} />
                    ) : (
                      <p className="whitespace-pre-wrap text-[14px] leading-relaxed">{n.text}</p>
                    )}
                    {!closed && n.status === 'Draft' && mine ? (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {draftText !== undefined ? (
                          <button
                            className="btn h-8 px-2.5 text-xs"
                            onClick={() =>
                              run(async () => {
                                const r = await api(`/encounters/${id}/notes/${n.id}`, { method: 'PATCH', body: { text: draftText, version: n.version } });
                                setEditing(({ [n.id]: _, ...rest }) => rest);
                                return r;
                              })
                            }
                          >
                            {t('Save draft', 'Kaydi')}
                          </button>
                        ) : (
                          <button className="btn h-8 px-2.5 text-xs" onClick={() => setEditing({ ...editing, [n.id]: n.text })}>
                            {t('Edit', 'Wax ka beddel')}
                          </button>
                        )}
                        {canSign ? (
                          <button className="btn btn-primary h-8 px-2.5 text-xs" onClick={() => run(() => guarded(() => api(`/encounters/${id}/notes/${n.id}/sign`, { body: {} })))}>
                            <PenLine size={14} />
                            {t('Sign', 'Saxiix')}
                          </button>
                        ) : null}
                        <button className="btn h-8 px-2.5 text-xs" onClick={() => run(() => api(`/encounters/${id}/notes/${n.id}`, { method: 'DELETE' }).then(() => true))}>
                          <Trash2 size={14} />
                          {t('Discard', 'Tirtir')}
                        </button>
                      </div>
                    ) : null}
                    {n.status === 'Signed' && canSign ? (
                      amend?.id === n.id ? (
                        <form
                          className="mt-2 grid gap-2"
                          onSubmit={(x) => {
                            x.preventDefault();
                            void run(async () => {
                              const r = await guarded(() => api(`/encounters/${id}/notes/${n.id}/amend`, { body: { text: amend.text, reason: amend.reason } }));
                              setAmend(null);
                              return r;
                            });
                          }}
                        >
                          <textarea className="input min-h-28 py-2" value={amend.text} onChange={(x) => setAmend({ ...amend, text: x.target.value })} />
                          <input className="input" required minLength={3} placeholder={t('Reason for amendment', 'Sababta')} value={amend.reason} onChange={(x) => setAmend({ ...amend, reason: x.target.value })} />
                          <span className="flex gap-2">
                            <button className="btn btn-primary h-8 px-2.5 text-xs">{t('Sign amendment', 'Saxiix')}</button>
                            <button type="button" className="btn h-8 px-2.5 text-xs" onClick={() => setAmend(null)}>
                              {t('Cancel', 'Jooji')}
                            </button>
                          </span>
                        </form>
                      ) : (
                        <button className="btn mt-2 h-8 px-2.5 text-xs" onClick={() => setAmend({ id: n.id, text: n.text, reason: '' })}>
                          {t('Amend', 'Beddel')}
                        </button>
                      )
                    ) : null}
                  </article>
                );
              })}
              {canNote ? (
                <form
                  className="grid gap-2"
                  onSubmit={(x) => {
                    x.preventDefault();
                    void run(async () => {
                      const r = await api(`/encounters/${id}/notes`, { body: note });
                      setNote({ ...note, text: '' });
                      return r;
                    });
                  }}
                >
                  <div className="flex flex-wrap gap-1.5" role="group" aria-label="Note type">
                    {KINDS.map((k) => (
                      <button type="button" key={k} aria-pressed={note.kind === k} onClick={() => setNote({ ...note, kind: k })} className={`h-7 rounded-lg border px-2.5 text-xs font-semibold capitalize ${note.kind === k ? 'border-ink bg-ink text-surface' : 'border-line-2'}`}>
                        {k}
                      </button>
                    ))}
                  </div>
                  <textarea className="input min-h-28 py-2" required value={note.text} onChange={(x) => setNote({ ...note, text: x.target.value })} placeholder={t('Write a draft. Only you can see it until you sign.', 'Qor qabyo.')} />
                  <button className="btn justify-self-start" disabled={act.busy}>
                    <Plus size={16} />
                    {t('Save draft', 'Kaydi qabyo')}
                  </button>
                </form>
              ) : null}
            </div>
          </Card>
        </div>

        <div className="grid gap-4">
          <Card title={t('Vital signs', 'Calaamadaha nolosha')}>
            {canObs ? (
              <form
                className="flex flex-wrap items-end gap-2 px-4 pb-3"
                onSubmit={(x) => {
                  x.preventDefault();
                  void run(async () => {
                    const r = await api(`/encounters/${id}/observations`, { body: { code: vital.code, value: Number(vital.value) } });
                    setVital({ ...vital, value: '' });
                    return r;
                  });
                }}
              >
                <Field label={t('Vital', 'Calaamad')}>
                  <select className="input h-9" value={vital.code} onChange={(x) => setVital({ ...vital, code: x.target.value })}>
                    {VITALS.map((v) => (
                      <option key={v.code} value={v.code}>
                        {lang === 'so' ? v.so : v.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={VITAL_BY_CODE[vital.code]!.unit} error={fe.value}>
                  <input className="input h-9 w-24" inputMode="decimal" required value={vital.value} onChange={(x) => setVital({ ...vital, value: x.target.value })} />
                </Field>
                <button className="btn btn-primary h-9">{t('Record', 'Qor')}</button>
              </form>
            ) : null}
            <ul className="grid text-[13px]">
              {e.observations.map((o) => (
                <li key={o.id} className={`flex items-center justify-between gap-2 border-t border-line px-4 py-1.5 ${o.status === 'Corrected' ? 'text-ink-3 line-through' : ''}`}>
                  <span>{VITAL_BY_CODE[o.code]?.[lang === 'so' ? 'so' : 'name'] ?? o.code}</span>
                  <span className="num font-mono">
                    {o.value} {o.unit}
                  </span>
                  <span className="num text-xs text-ink-3">{new Date(o.effectiveAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                </li>
              ))}
            </ul>
          </Card>

          <Card title={t('Diagnoses · ICD-11', 'Ogaanshaha · ICD-11')}>
            <ul className="grid text-[13px]">
              {e.diagnoses.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-2 first:border-t-0">
                  <span className="font-mono font-semibold">{d.code}</span>
                  <span className="min-w-0 flex-1">{d.display}</span>
                  {d.primary ? <Pill tone="acc">primary</Pill> : null}
                  {canSign && !closed ? (
                    <select
                      className="input h-7 w-auto px-2 text-xs"
                      value={d.certainty}
                      aria-label="Certainty"
                      onChange={(x) => run(() => api(`/encounters/${id}/diagnoses/${d.id}`, { method: 'PATCH', body: { certainty: x.target.value, ...(x.target.value === 'ruled_out' ? { primary: false } : {}), version: d.version } }))}
                    >
                      <option value="suspected">suspected</option>
                      <option value="confirmed">confirmed</option>
                      <option value="ruled_out">ruled out</option>
                    </select>
                  ) : (
                    <Pill tone={d.certainty === 'confirmed' ? 'ok' : d.certainty === 'ruled_out' ? 'crit' : 'warn'}>{d.certainty}</Pill>
                  )}
                </li>
              ))}
            </ul>
            {canSign && !closed ? (
              <form
                className="grid gap-2 border-t border-line px-4 py-3"
                onSubmit={(x) => {
                  x.preventDefault();
                  void run(async () => {
                    const r = await api(`/encounters/${id}/diagnoses`, { body: { code: dx.code, display: dx.display, certainty: dx.certainty, primary: dx.primary } });
                    setDx({ q: '', code: '', display: '', certainty: 'suspected', primary: false });
                    return r;
                  });
                }}
              >
                <Field label={t('Search or type an ICD-11 code', 'Raadi koodh ICD-11')} error={fe.code}>
                  <input className="input" value={dx.q} onChange={(x) => setDx({ ...dx, q: x.target.value, code: x.target.value.toUpperCase(), display: dx.display })} placeholder="malaria · BA00" />
                </Field>
                {suggestions.length ? (
                  <div className="flex flex-wrap gap-1.5">
                    {suggestions.map((s) => (
                      <button type="button" key={s.code} className="rounded-md border border-line-2 px-2 py-0.5 text-[12px] hover:border-accent" onClick={() => setDx({ ...dx, q: '', code: s.code, display: s.display })}>
                        <b className="font-mono">{s.code}</b> {s.display}
                      </button>
                    ))}
                  </div>
                ) : null}
                <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-2">
                  <input className="input font-mono" aria-label="Code" required value={dx.code} onChange={(x) => setDx({ ...dx, code: x.target.value.toUpperCase() })} />
                  <input className="input" aria-label="Description" required value={dx.display} onChange={(x) => setDx({ ...dx, display: x.target.value })} placeholder={t('Description', 'Sharaxaad')} />
                </div>
                <div className="flex flex-wrap items-center gap-3 text-[13px]">
                  <select className="input h-9 w-auto" value={dx.certainty} onChange={(x) => setDx({ ...dx, certainty: x.target.value })} aria-label="Certainty">
                    <option value="suspected">suspected</option>
                    <option value="confirmed">confirmed</option>
                  </select>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={dx.primary} onChange={(x) => setDx({ ...dx, primary: x.target.checked })} className="accent-[rgb(var(--accent))]" />
                    {t('Primary', 'Kan ugu muhiimsan')}
                  </label>
                  <button className="btn ml-auto h-9">{t('Add', 'Ku dar')}</button>
                </div>
              </form>
            ) : null}
          </Card>

          <Card title={t('Care team', 'Kooxda daryeelka')}>
            <ul className="grid px-4 pb-3 text-[13px]">
              {e.team.map((u) => (
                <li key={u.id} className="flex justify-between border-t border-line py-1.5 first:border-t-0">
                  <span>{u.name}</span>
                  <span className="text-xs text-ink-3">{u.roles.join(', ')}</span>
                </li>
              ))}
            </ul>
          </Card>

          {canSign && !closed ? (
            <button className="btn btn-primary h-10 justify-center" disabled={act.busy} onClick={() => run(() => api(`/encounters/${id}/close`, { body: {} }))}>
              <CheckCircle2 size={16} />
              {t('Close visit', 'Xir booqashada')}
            </button>
          ) : null}
          {act.error && (act.error as { code?: string }).code === 'ENCOUNTER_INCOMPLETE' ? (
            <ul className="rounded-[10px] bg-warn-soft px-4 py-2.5 text-[13px] text-warn">
              {((act.error as { body: { details: { message: string }[] } }).body.details ?? []).map((d) => (
                <li key={d.message}>• {d.message}</li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </>
  );
}
