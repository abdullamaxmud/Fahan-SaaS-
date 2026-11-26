'use client';

import { useCallback, useEffect, useState } from 'react';
import { ShieldAlert, UserCheck, UserX } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { canDo, useMe } from '@/lib/session';
import { useReauth } from '@/components/Reauth';
import { Card, ErrorNote, Field, PageHeader, Pill, fieldErrors, useAction } from '@/components/ui';

interface Review { id: string; title: string; status: string; startedAt: string; startedByName: string; items: { userId: string; name: string; email: string; roles: string[]; decision: string | null; decidedByName: string | null }[]; summary: { total: number; kept: number; revoked: number } }
interface Incident { id: string; number: string; title: string; severity: string; category: string; description: string; status: string; remediation: string | null; rootCause: string | null; reportedByName: string; detectedAt: string; history: { at: string; action: string; byName: string; note: string | null }[] }

const NEXT: Record<string, string> = { Detected: 'Investigated', Investigated: 'Remediated', Remediated: 'Closed' };
const sevTone = (s: string) => (s === 'critical' || s === 'high' ? 'crit' : s === 'medium' ? 'warn' : 'plain');

export default function SecurityPage() {
  const { me } = useMe();
  const { t } = useLang();
  const { guarded, dialog } = useReauth();
  const [reviews, setReviews] = useState<Review[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [title, setTitle] = useState('');
  const [report, setReport] = useState({ title: '', severity: 'medium', category: 'security', description: '' });
  const [step, setStep] = useState<Record<string, { note: string; text: string }>>({});
  const load = useAction();
  const act = useAction();
  const reviewer = canDo(me, 'iam', 'E');
  const starter = canDo(me, 'iam', 'A') || canDo(me, 'sec', 'E');
  const secView = canDo(me, 'sec', 'V');
  const secWork = canDo(me, 'sec', 'E');

  const refresh = useCallback(async () => {
    await load.run(async () => {
      if (reviewer || secView) setReviews(await api<Review[]>('/security/access-reviews'));
      if (secView) setIncidents(await api<Incident[]>('/security/incidents'));
    });
  }, [reviewer, secView]);
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
  const open = reviews.find((r) => r.status === 'Open');
  const s = (id: string) => step[id] ?? { note: '', text: '' };

  return (
    <>
      {dialog}
      <PageHeader eyebrow="Spec §5.35 · §11.1" title={t('Access reviews & security incidents', 'Dib-u-eegista gelitaanka & dhacdooyinka')}>
        {t('Every account is certified or revoked by someone other than its owner. Incidents are confidential to security roles and move from detected to closed with the fix and root cause written down.', 'Akoon kasta waxaa xaqiijiya qof kale.')}
      </PageHeader>
      <ErrorNote error={load.error ?? (Object.keys(fe).length ? null : act.error)} />

      <div className="grid items-start gap-4 xl:grid-cols-2">
        <Card
          title={t('Access review', 'Dib-u-eegista gelitaanka')}
          actions={open ? <Pill tone="warn">{open.summary.kept + open.summary.revoked}/{open.summary.total}</Pill> : null}
        >
          <div className="grid gap-3 px-4 pb-4 text-[13px]">
            {!open && starter ? (
              <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void run(() => api('/security/access-reviews', { body: { title } }), () => setTitle('')); }}>
                <Field label={t('Review name', 'Magaca')}>
                  <input className="input h-9 w-64" required minLength={3} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Q4 2026 access review" />
                </Field>
                <button className="btn btn-primary h-9">{t('Start review', 'Bilow')}</button>
              </form>
            ) : null}
            {open ? (
              <>
                <p className="text-ink-2">
                  <b>{open.title}</b> · {t('started by', 'waxaa bilaabay')} {open.startedByName} · {new Date(open.startedAt).toLocaleDateString()}
                </p>
                <ul className="grid gap-1.5">
                  {open.items.map((i) => (
                    <li key={i.userId} className="flex flex-wrap items-center gap-2 rounded-[10px] border border-line px-3 py-2">
                      <b>{i.name}</b> <span className="text-ink-3">{i.roles.join(', ')}</span>
                      <span className="ml-auto flex items-center gap-2">
                        {i.decision ? (
                          <Pill tone={i.decision === 'keep' ? 'ok' : 'crit'}>
                            {i.decision} · {i.decidedByName}
                          </Pill>
                        ) : reviewer && i.userId !== me.id ? (
                          <>
                            <button className="btn h-7 text-[12px]" onClick={() => run(() => guarded(() => api(`/security/access-reviews/${open.id}/items/${i.userId}/decide`, { body: { decision: 'keep' } })))}>
                              <UserCheck size={13} /> {t('Keep', 'Hay')}
                            </button>
                            <button className="btn h-7 text-[12px] text-crit" onClick={() => { const note = prompt(t('Why revoke this access? The account is suspended at once.', 'Maxaa loo joojinayaa?')); if (note) void run(() => guarded(() => api(`/security/access-reviews/${open.id}/items/${i.userId}/decide`, { body: { decision: 'revoke', note } }))); }}>
                              <UserX size={13} /> {t('Revoke', 'Jooji')}
                            </button>
                          </>
                        ) : (
                          <span className="text-[12px] text-ink-3">{i.userId === me.id ? t('someone else reviews you', 'qof kale ayaa ku eegaya') : t('waiting', 'sugaya')}</span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            <ul className="grid gap-1 border-t border-line pt-2 text-[12px] text-ink-2">
              {reviews.filter((r) => r.status !== 'Open').map((r) => (
                <li key={r.id}>
                  {r.title} · {r.summary.total} {t('accounts', 'akoon')}, {r.summary.revoked} {t('revoked', 'la joojiyay')} · <Pill tone="ok">{r.status}</Pill>
                </li>
              ))}
            </ul>
          </div>
        </Card>

        {secView ? (
          <Card title={t('Security incidents', 'Dhacdooyinka amniga')}>
            <div className="grid gap-3 px-4 pb-4 text-[13px]">
              <form className="grid gap-2 rounded-[10px] bg-surface-2 p-3" onSubmit={(e) => { e.preventDefault(); void run(() => api('/security/incidents', { body: report }), () => setReport({ ...report, title: '', description: '' })); }}>
                <b className="flex items-center gap-1.5">
                  <ShieldAlert size={15} /> {t('Report an incident', 'Soo sheeg dhacdo')}
                </b>
                <Field label={t('What happened', 'Maxaa dhacay')} error={fe.title}>
                  <input className="input h-9" required minLength={5} value={report.title} onChange={(e) => setReport({ ...report, title: e.target.value })} />
                </Field>
                <div className="grid grid-cols-2 gap-2">
                  <Field label={t('Severity', 'Darnaanta')}>
                    <select className="input h-9" value={report.severity} onChange={(e) => setReport({ ...report, severity: e.target.value })}>
                      {['low', 'medium', 'high', 'critical'].map((x) => (
                        <option key={x}>{x}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t('Kind', 'Nooca')}>
                    <select className="input h-9" value={report.category} onChange={(e) => setReport({ ...report, category: e.target.value })}>
                      {['security', 'privacy', 'clinical-data', 'availability', 'fraud'].map((x) => (
                        <option key={x}>{x}</option>
                      ))}
                    </select>
                  </Field>
                </div>
                <Field label={t('Details', 'Faahfaahin')} error={fe.description}>
                  <textarea className="input min-h-[70px] py-2" required minLength={10} value={report.description} onChange={(e) => setReport({ ...report, description: e.target.value })} />
                </Field>
                <button className="btn btn-primary h-9 justify-self-start">{t('Report', 'Soo sheeg')}</button>
              </form>
              <ul className="grid gap-2">
                {incidents.map((x) => (
                  <li key={x.id} className="rounded-[10px] border border-line p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <b className="font-mono">{x.number}</b> <b>{x.title}</b>
                      <Pill tone={sevTone(x.severity)}>{x.severity}</Pill>
                      <span className="ml-auto">
                        <Pill tone={x.status === 'Closed' ? 'ok' : 'warn'}>{x.status}</Pill>
                      </span>
                    </div>
                    <p className="mt-1 text-ink-2">{x.description}</p>
                    {x.remediation ? <p className="mt-1"><b>{t('Fix', 'Hagaajin')}:</b> {x.remediation}</p> : null}
                    {x.rootCause ? <p><b>{t('Root cause', 'Sababta asalka')}:</b> {x.rootCause}</p> : null}
                    <ol className="mt-1 grid gap-0.5 text-[11.5px] text-ink-3">
                      {x.history.map((h, i) => (
                        <li key={i}>
                          {new Date(h.at).toLocaleString()} · {h.action} · {h.byName}
                          {h.note ? ` — ${h.note}` : ''}
                        </li>
                      ))}
                    </ol>
                    {secWork && NEXT[x.status] ? (
                      <div className="mt-2 grid gap-2">
                        <input className="input h-8" placeholder={t('Note for the record', 'Qoraal')} value={s(x.id).note} onChange={(e) => setStep({ ...step, [x.id]: { ...s(x.id), note: e.target.value } })} />
                        {NEXT[x.status] !== 'Investigated' ? (
                          <textarea className="input min-h-[56px] py-1.5" placeholder={NEXT[x.status] === 'Remediated' ? t('What was done to fix it', 'Maxaa la sameeyay') : t('Root cause', 'Sababta asalka')} value={s(x.id).text} onChange={(e) => setStep({ ...step, [x.id]: { ...s(x.id), text: e.target.value } })} />
                        ) : null}
                        <button
                          className="btn btn-primary h-8 justify-self-start"
                          onClick={() =>
                            run(
                              () => api(`/security/incidents/${x.id}/advance`, { body: { note: s(x.id).note, ...(NEXT[x.status] === 'Remediated' ? { remediation: s(x.id).text } : NEXT[x.status] === 'Closed' ? { rootCause: s(x.id).text } : {}) } }),
                              () => setStep({ ...step, [x.id]: { note: '', text: '' } }),
                            )
                          }
                        >
                          {t('Mark', 'Calaamadee')} {NEXT[x.status]}
                        </button>
                      </div>
                    ) : null}
                  </li>
                ))}
                {!incidents.length ? <li className="text-ink-3">{t('No incidents recorded.', 'Dhacdo lama diiwaangelin.')}</li> : null}
              </ul>
            </div>
          </Card>
        ) : null}
      </div>
    </>
  );
}
