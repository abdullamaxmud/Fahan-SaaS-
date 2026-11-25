'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Baby } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { canDo, useMe } from '@/lib/session';
import { fullName, type PatientBrief } from '@/components/clinical';
import { Card, ErrorNote, Field, PageHeader, Pill, useAction } from '@/components/ui';

interface Pregnancy {
  id: string;
  edd: string;
  gravida: number;
  para: number;
  gestation: { weeks: number; days: number } | null;
  mother: (PatientBrief & { _id: string }) | null;
}

export default function MaternityPage() {
  const { me } = useMe();
  const { t } = useLang();
  const [list, setList] = useState<Pregnancy[]>([]);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<PatientBrief[]>([]);
  const [form, setForm] = useState({ lmp: '', gravida: '1', para: '0' });
  const load = useAction();
  const act = useAction();

  const refresh = useCallback(async () => {
    await load.run(async () => setList(await api<Pregnancy[]>('/maternity/pregnancies')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <>
      <PageHeader eyebrow="Spec §5.17" title={t('Maternity', 'Umulaha')}>
        {t('Active pregnancies by due date. Each live birth gets its own record linked to the mother.', 'Uurka socda, sida taariikhda dhalashada.')}
      </PageHeader>
      <ErrorNote error={load.error ?? act.error} />
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card title={`${t('Active pregnancies', 'Uurka socda')} · ${list.length}`}>
          <ul className="grid text-[13px]">
            {list.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-2.5 first:border-t-0">
                <Link href={`/maternity/${p.id}`} className="min-w-0 flex-1 hover:underline">
                  <b className="block">{p.mother ? fullName(p.mother.names) : '—'}</b>
                  <span className="font-mono text-[11.5px] text-ink-3">
                    {p.mother?.mrn} · G{p.gravida} P{p.para}
                  </span>
                </Link>
                {p.gestation ? (
                  <Pill tone={p.gestation.weeks >= 37 ? 'warn' : 'info'}>
                    {p.gestation.weeks}+{p.gestation.days} {t('weeks', 'toddobaad')}
                  </Pill>
                ) : null}
                <span className="num text-xs text-ink-2">EDD {p.edd}</span>
              </li>
            ))}
            {!list.length ? <li className="px-4 pb-4 text-ink-3">{t('No active pregnancies in your care.', 'Uur socda ma jiro.')}</li> : null}
          </ul>
        </Card>
        {canDo(me, 'mat', 'E') ? (
          <Card title={t('Open a pregnancy record', 'Fur diiwaanka uurka')}>
            <div className="grid gap-3 px-4 pb-4">
              <form
                className="flex gap-2"
                onSubmit={async (e) => {
                  e.preventDefault();
                  setFound(await api<PatientBrief[]>(`/patients?q=${encodeURIComponent(q)}`).catch(() => []));
                }}
              >
                <input className="input h-9" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Find the mother', 'Raadi hooyada')} aria-label="Find the mother" />
                <button className="btn h-9">{t('Find', 'Raadi')}</button>
              </form>
              <div className="grid grid-cols-3 gap-2">
                <Field label={t('Last period (LMP)', 'Caadada u dambeysay')}>
                  <input className="input h-9" type="date" value={form.lmp} onChange={(e) => setForm({ ...form, lmp: e.target.value })} />
                </Field>
                <Field label="Gravida">
                  <input className="input h-9" type="number" min={1} value={form.gravida} onChange={(e) => setForm({ ...form, gravida: e.target.value })} />
                </Field>
                <Field label="Para">
                  <input className="input h-9" type="number" min={0} value={form.para} onChange={(e) => setForm({ ...form, para: e.target.value })} />
                </Field>
              </div>
              {found.map((p) => (
                <button
                  key={p.id}
                  disabled={!form.lmp}
                  className="flex items-center justify-between rounded-lg border border-line p-2 text-left hover:border-accent disabled:opacity-50"
                  onClick={async () => {
                    if (await act.run(() => api('/maternity/pregnancies', { body: { patientId: p.id, lmp: form.lmp, gravida: Number(form.gravida), para: Number(form.para) } }))) {
                      setFound([]);
                      await refresh();
                    }
                  }}
                >
                  <span>
                    <b className="block text-[13px]">{fullName(p.names)}</b>
                    <span className="font-mono text-[11.5px] text-ink-3">{p.mrn}</span>
                  </span>
                  <Baby size={16} className="text-accent-2" />
                </button>
              ))}
            </div>
          </Card>
        ) : null}
      </div>
    </>
  );
}
