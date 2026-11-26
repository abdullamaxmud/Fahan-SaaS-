'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { age, fullName, type PatientBrief } from '@/components/clinical';
import { Card, ErrorNote, PageHeader, Pill, statusTone, useAction } from '@/components/ui';

interface Enc {
  id: string;
  status: string;
  queueNo: number | null;
  reason: string | null;
  startedAt: string;
  patient: PatientBrief | null;
}

export default function EncountersPage() {
  const { t } = useLang();
  const [tab, setTab] = useState<'active' | 'closed'>('active');
  const [list, setList] = useState<Enc[]>([]);
  const load = useAction();

  useEffect(() => {
    void load.run(async () => setList(await api<Enc[]>(`/encounters?status=${tab}`)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  return (
    <>
      <PageHeader title={t('Visits', 'Booqashooyinka')}>
        {t('Open a visit to record vitals, notes and diagnoses.', 'Fur booqasho si aad u qorto calaamadaha, qoraallada iyo ogaanshaha.')}
      </PageHeader>
      <div className="flex overflow-hidden rounded-[9px] border border-line self-start" role="tablist">
        {(['active', 'closed'] as const).map((x) => (
          <button key={x} role="tab" aria-selected={tab === x} onClick={() => setTab(x)} className={`h-9 px-3.5 text-[13px] font-semibold ${tab === x ? 'bg-ink text-surface' : 'text-ink-2'}`}>
            {x === 'active' ? t('In progress', 'Socda') : t('Closed', 'Xiran')}
          </button>
        ))}
      </div>
      <ErrorNote error={load.error} />
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <th className="th">#</th>
                <th className="th">{t('Patient', 'Bukaanka')}</th>
                <th className="th">{t('Reason', 'Sababta')}</th>
                <th className="th">{t('Started', 'Bilaabay')}</th>
                <th className="th">Status</th>
              </tr>
            </thead>
            <tbody>
              {list.map((e) => (
                <tr key={e.id} className="hover:bg-surface-2/50">
                  <td className="td num font-mono">{e.queueNo ?? '—'}</td>
                  <td className="td">
                    <Link className="font-semibold hover:text-accent-2 hover:underline" href={`/encounters/${e.id}`}>
                      {e.patient ? fullName(e.patient.names) : '—'}
                    </Link>
                    {e.patient ? (
                      <span className="block font-mono text-[11.5px] text-ink-3">
                        {e.patient.mrn} · {age(e.patient.dob)}
                      </span>
                    ) : null}
                  </td>
                  <td className="td text-ink-2">{e.reason ?? '—'}</td>
                  <td className="td num text-xs">{new Date(e.startedAt).toLocaleString()}</td>
                  <td className="td">
                    <Pill tone={statusTone(e.status === 'Closed' ? 'Active' : 'info')}>{e.status}</Pill>
                  </td>
                </tr>
              ))}
              {!list.length && !load.busy ? (
                <tr>
                  <td className="td text-ink-3" colSpan={5}>
                    {t('No visits here.', 'Booqasho ma jirto.')}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
