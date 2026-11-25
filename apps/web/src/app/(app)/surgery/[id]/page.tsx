'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Circle } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { canDo, useMe } from '@/lib/session';
import { useReauth } from '@/components/Reauth';
import { PatientBand, type PatientBrief } from '@/components/clinical';
import { Card, ErrorNote, Pill, useAction } from '@/components/ui';

type Phase = 'sign-in' | 'time-out' | 'sign-out';
interface Case {
  id: string;
  status: string;
  procedure: string;
  side: string;
  startsAt: string;
  surgeon: { id: string; name: string };
  patient: PatientBrief;
  allergies: { substance: string; severity: string }[];
  consent: { method: string; signedBy: string; recordedByName: string; at: string } | null;
  checklist: Record<Phase, { at: string; byName: string } | null>;
  checklistItems: Record<Phase, string[]>;
  operativeNote: { text: string; signedByName: string; signedAt: string } | null;
  timeline: { status: string; at: string }[];
}
const NEXT: Record<string, string> = { Planned: 'Prepared', Prepared: 'InProcedure', InProcedure: 'Recovery', Recovery: 'Completed' };
const label = (k: string) => k.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());

export default function SurgeryCasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { me } = useMe();
  const { t } = useLang();
  const [c, setC] = useState<Case | null>(null);
  const [ticks, setTicks] = useState<Record<string, boolean>>({});
  const [note, setNote] = useState('');
  const load = useAction();
  const act = useAction();
  const { guarded, dialog } = useReauth();

  const refresh = useCallback(async () => {
    await load.run(async () => setC(await api<Case>(`/surgery/cases/${id}`)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  if (!c) return <ErrorNote error={load.error} />;

  const run = async (fn: () => Promise<unknown>) => {
    if ((await act.run(fn)) !== undefined) await refresh();
  };
  const sign = canDo(me, 'sx', 'S');
  const nurse = canDo(me, 'sx', 'E');
  const isSurgeon = c.surgeon.id === me.id;

  return (
    <>
      {dialog}
      <PatientBand p={c.patient}>
        <Pill tone={c.status === 'Completed' ? 'ok' : c.status === 'InProcedure' ? 'acc' : 'info'}>{c.status}</Pill>
        {c.allergies.map((a) => (
          <Pill key={a.substance} tone="crit">
            {a.substance} · {a.severity}
          </Pill>
        ))}
      </PatientBand>
      <div className="card p-4">
        <span className="eyebrow">{t('Procedure', 'Qalliinka')}</span>
        <h2 className="mt-1 text-xl font-bold">
          {c.procedure} <span className="text-ink-3">· {c.side}</span>
        </h2>
        <p className="text-[13px] text-ink-2">
          {c.surgeon.name} · {new Date(c.startsAt).toLocaleString()}
        </p>
      </div>
      <ErrorNote error={act.error} />
      {act.error && (act.error as { body?: { details?: { message: string; path?: string }[] } }).body?.details?.length ? (
        <ul className="rounded-[10px] bg-warn-soft px-4 py-2.5 text-[13px] text-warn">
          {(act.error as { body: { details: { message: string; path?: string }[] } }).body.details.map((d) => (
            <li key={(d.path ?? '') + d.message}>• {d.path ? `${label(d.path)}: ` : ''}{d.message}</li>
          ))}
        </ul>
      ) : null}

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Card title={t('WHO surgical safety checklist', 'Liiska badbaadada')}>
          <div className="grid gap-4 px-4 pb-4">
            {(['sign-in', 'time-out', 'sign-out'] as Phase[]).map((ph) => {
              const done = c.checklist[ph];
              return (
                <section key={ph}>
                  <header className="mb-1.5 flex items-center gap-2">
                    {done ? <CheckCircle2 size={18} className="text-ok" /> : <Circle size={18} className="text-ink-3" />}
                    <b className="text-[14px] capitalize">{ph.replace('-', ' ')}</b>
                    {done ? <span className="text-xs text-ink-3">· {done.byName} · {new Date(done.at).toLocaleTimeString()}</span> : null}
                  </header>
                  {!done ? (
                    <div className="grid gap-1 pl-7">
                      {c.checklistItems[ph].map((k) => (
                        <label key={k} className="flex items-center gap-2 text-[13px]">
                          <input type="checkbox" className="h-4 w-4 accent-[rgb(var(--accent))]" checked={Boolean(ticks[`${ph}:${k}`])} onChange={(e) => setTicks({ ...ticks, [`${ph}:${k}`]: e.target.checked })} />
                          {label(k)}
                        </label>
                      ))}
                      {nurse ? (
                        <button
                          className="btn mt-1 h-8 justify-self-start text-xs"
                          onClick={() => run(() => api(`/surgery/cases/${id}/checklist/${ph}`, { body: { items: Object.fromEntries(c.checklistItems[ph].map((k) => [k, Boolean(ticks[`${ph}:${k}`])])) } }))}
                        >
                          {t('Confirm', 'Xaqiiji')} {ph}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </section>
              );
            })}
          </div>
        </Card>

        <div className="grid gap-4">
          <Card title={t('Consent', 'Oggolaanshaha')}>
            <div className="px-4 pb-4 text-[13px]">
              {c.consent ? (
                <p>
                  <Pill tone="ok">{c.consent.method}</Pill> {c.consent.signedBy} · {c.consent.recordedByName}
                </p>
              ) : sign ? (
                <button className="btn h-8 text-xs" onClick={() => run(() => api(`/surgery/cases/${id}/consent`, { body: { method: 'written', signedBy: 'patient', risksExplained: true } }))}>
                  {t('Record written consent (risks explained)', 'Diiwaangeli oggolaanshaha')}
                </button>
              ) : (
                <span className="text-ink-3">{t('Not recorded yet', 'Lama diiwaangelin')}</span>
              )}
            </div>
          </Card>

          <Card title={t('Operative note', 'Qoraalka qalliinka')}>
            <div className="grid gap-2 px-4 pb-4 text-[13px]">
              {c.operativeNote ? (
                <>
                  <p className="whitespace-pre-wrap">{c.operativeNote.text}</p>
                  <span className="text-xs text-ink-3">
                    {t('Signed by', 'Saxiixay')} {c.operativeNote.signedByName} · {new Date(c.operativeNote.signedAt).toLocaleString()}
                  </span>
                </>
              ) : isSurgeon && c.status === 'InProcedure' ? (
                <>
                  <textarea className="input min-h-28 py-2" value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('Procedure, findings, closure…', 'Qalliinka, natiijooyinka…')} />
                  <button className="btn btn-primary h-8 justify-self-start text-xs" onClick={() => run(() => guarded(() => api(`/surgery/cases/${id}/operative-note`, { body: { text: note } })))}>
                    {t('Sign note', 'Saxiix')}
                  </button>
                </>
              ) : (
                <span className="text-ink-3">{t('Written by the operating surgeon during the procedure.', 'Dhakhtarka qalliinka ayaa qora.')}</span>
              )}
            </div>
          </Card>

          {sign && NEXT[c.status] ? (
            <button className="btn btn-primary h-10 justify-center" disabled={act.busy} onClick={() => run(() => api(`/surgery/cases/${id}/advance`, { body: { to: NEXT[c.status] } }))}>
              {t('Move to', 'U gudub')} {NEXT[c.status]}
            </button>
          ) : null}

          <Card title={t('Timeline', 'Jadwalka')}>
            <ol className="grid px-4 pb-4 text-[13px]">
              {c.timeline.map((x) => (
                <li key={x.status + x.at} className="flex justify-between border-t border-line py-1.5 first:border-t-0">
                  <span>{x.status}</span>
                  <span className="num text-xs text-ink-3">{new Date(x.at).toLocaleTimeString()}</span>
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>
    </>
  );
}
