'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, Send, X } from 'lucide-react';
import type { Level, ModuleKey } from '@fahan/policy';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { canDo, useMe } from '@/lib/session';
import { Card, ErrorNote, PageHeader, Pill, fieldErrors, useAction } from '@/components/ui';
import { FormFields, typedAnswers, type FormDef } from '@/components/forms';

interface Submission { id: string; formVersion: number; status: string; submittedByName: string; submittedAt: string; answers: { key: string; label: string; value: unknown }[] }

export default function MyFormsPage() {
  const { me } = useMe();
  const { t, lang } = useLang();
  const [forms, setForms] = useState<FormDef[]>([]);
  const [sel, setSel] = useState<FormDef | null>(null);
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [subs, setSubs] = useState<Submission[]>([]);
  const [done, setDone] = useState<string | null>(null);
  const load = useAction();
  const act = useAction();

  useEffect(() => {
    void load.run(async () => {
      const list = await api<FormDef[]>('/studio/published');
      setForms(list);
      setSel((s) => s ?? list[0] ?? null);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const loadSubs = useCallback(async () => {
    if (sel) setSubs((await api<Submission[]>(`/studio/forms/by-key/${sel.key}/submissions`).catch(() => [])) ?? []);
  }, [sel]);
  useEffect(() => {
    setValues({});
    setDone(null);
    void loadSubs();
  }, [loadSubs]);
  const fe = fieldErrors(act.error);
  const approver = sel?.approval ? canDo(me, sel.approval.module as ModuleKey, sel.approval.level as Level) : false;

  return (
    <>
      <PageHeader title={t('My forms', 'Foomamkayga')}>
        {t('Forms your hospital published for your role.', 'Foomamka loo daabacay doorkaaga.')}
      </PageHeader>
      <ErrorNote error={load.error ?? (Object.keys(fe).length ? null : act.error)} />
      {!forms.length && !load.busy ? <p className="text-ink-3">{t('No forms have been published for your role yet.', 'Weli foom laguma daabicin doorkaaga.')}</p> : null}
      <div className="flex flex-wrap gap-1.5" role="tablist">
        {forms.map((f) => (
          <button key={f.id} role="tab" aria-selected={sel?.id === f.id} onClick={() => setSel(f)} className={`h-9 rounded-[9px] border px-3 text-[13px] font-semibold ${sel?.id === f.id ? 'border-ink bg-ink text-surface' : 'border-line'}`}>
            {f.name}
          </button>
        ))}
      </div>
      {sel ? (
        <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          <Card title={`${sel.name} · v${sel.version}`} actions={sel.approval ? <Pill tone="warn">{t('needs approval', 'oggolaansho ayuu u baahan yahay')}</Pill> : null}>
            <form
              className="grid gap-3 px-4 pb-4 text-[13px]"
              onSubmit={async (e) => {
                e.preventDefault();
                const r = await act.run(() => api<{ status: string }>(`/studio/forms/by-key/${sel.key}/submissions`, { body: { data: typedAnswers(sel.fields, values) } }));
                if (r) {
                  setDone(r.status === 'Pending' ? t('Sent for approval.', 'Waxaa loo diray oggolaansho.') : t('Recorded.', 'Waa la diiwaangeliyay.'));
                  setValues({});
                  await loadSubs();
                }
              }}
            >
              <FormFields fields={sel.fields} values={values} onChange={setValues} errors={fe} />
              <div className="flex items-center gap-3">
                <button className="btn btn-primary h-9" disabled={act.busy}>
                  <Send size={15} /> {t('Submit', 'Gudbi')}
                </button>
                {done ? <span className="text-ok">{done}</span> : null}
              </div>
            </form>
          </Card>
          <Card title={t('Recent submissions', 'Gudbintii dhowaa')}>
            <ul className="grid gap-2 px-4 pb-4 text-[13px]">
              {subs.map((s) => (
                <li key={s.id} className="rounded-[10px] border border-line p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <b>{s.submittedByName}</b>
                    <span className="text-ink-3">
                      {new Date(s.submittedAt).toLocaleString()} · v{s.formVersion}
                    </span>
                    <span className="ml-auto">
                      <Pill tone={s.status === 'Approved' || s.status === 'Recorded' ? 'ok' : s.status === 'Rejected' ? 'crit' : 'warn'}>{s.status}</Pill>
                    </span>
                  </div>
                  <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 text-[12.5px]">
                    {s.answers.map((a) => (
                      <div key={a.key} className="contents">
                        <dt className="text-ink-3">{a.label}</dt>
                        <dd>{typeof a.value === 'boolean' ? (a.value ? (lang === 'so' ? 'haa' : 'yes') : lang === 'so' ? 'maya' : 'no') : String(a.value)}</dd>
                      </div>
                    ))}
                  </dl>
                  {approver && s.status === 'Pending' && s.submittedByName !== me.name ? (
                    <div className="mt-2 flex gap-2">
                      <button className="btn btn-primary h-8" onClick={async () => { if (await act.run(() => api(`/studio/submissions/${s.id}/decide`, { body: { decision: 'approve' } }))) await loadSubs(); }}>
                        <Check size={14} /> {t('Approve', 'Oggolow')}
                      </button>
                      <button className="btn h-8" onClick={async () => { if (await act.run(() => api(`/studio/submissions/${s.id}/decide`, { body: { decision: 'reject' } }))) await loadSubs(); }}>
                        <X size={14} /> {t('Reject', 'Diid')}
                      </button>
                    </div>
                  ) : null}
                </li>
              ))}
              {!subs.length ? <li className="text-ink-3">{t('Nothing submitted yet.', 'Weli waxba lama gudbin.')}</li> : null}
            </ul>
          </Card>
        </div>
      ) : null}
    </>
  );
}
