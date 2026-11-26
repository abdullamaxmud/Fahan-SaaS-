'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { fullName, type PatientBrief } from '@/components/clinical';
import { Card, ErrorNote, PageHeader, Pill, useAction } from '@/components/ui';

interface Theatre {
  id: string;
  code: string;
  name: string;
  status: string;
  statusReason: string | null;
  cases: { id: string; procedure: string; status: string; start: string; end: string; surgeonName: string; patient: Pick<PatientBrief, 'mrn' | 'names'> | null }[];
}

const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
const DAY_START = 7 * 60;
const DAY_LEN = 12 * 60;
const TONE: Record<string, string> = { Planned: 'bg-info-soft text-info', Prepared: 'bg-info-soft text-info', InProcedure: 'bg-accent text-on-accent', Recovery: 'bg-warn-soft text-warn', Completed: 'bg-surface-3 text-ink-2' };

export default function SurgeryPage() {
  const { t } = useLang();
  const [date, setDate] = useState(new Date().toLocaleDateString('en-CA'));
  const [theatres, setTheatres] = useState<Theatre[]>([]);
  const load = useAction();

  const refresh = useCallback(async () => {
    await load.run(async () => setTheatres(await api<Theatre[]>(`/surgery/schedule?date=${date}`)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <>
      <PageHeader title={t('Theatres', 'Qalliinka')}>
        {t('Theatre schedule and surgical cases.', 'Jadwalka qolalka qalliinka iyo kiisaska.')}
      </PageHeader>
      <input className="input h-9 w-auto self-start" type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" />
      <ErrorNote error={load.error} />
      <Card title={t('Day schedule · 07:00–19:00', 'Jadwalka maalinta')}>
        <div className="grid gap-2 overflow-x-auto px-4 pb-4">
          {theatres.map((th) => (
            <div key={th.id} className="grid min-w-[560px] grid-cols-[72px_minmax(0,1fr)] items-center gap-3">
              <b className="text-[13px]">{th.code}</b>
              <div className="relative h-14 rounded-[9px] border border-line bg-[repeating-linear-gradient(90deg,rgb(var(--surface-2))_0_1px,transparent_1px_8.33%)]">
                {th.status === 'OutOfService' ? (
                  <div className="absolute inset-1 grid place-items-center rounded-md bg-[repeating-linear-gradient(135deg,rgb(var(--crit-soft))_0_8px,transparent_8px_16px)] text-xs font-semibold text-crit">
                    {t('Out of service', 'Shaqayn maayo')}
                    {th.statusReason ? ` — ${th.statusReason}` : ''}
                  </div>
                ) : null}
                {th.cases.map((c) => {
                  const left = ((Math.max(toMin(c.start), DAY_START) - DAY_START) / DAY_LEN) * 100;
                  const width = ((Math.min(toMin(c.end), DAY_START + DAY_LEN) - Math.max(toMin(c.start), DAY_START)) / DAY_LEN) * 100;
                  return (
                    <Link key={c.id} href={`/surgery/${c.id}`} style={{ left: `${left}%`, width: `${Math.max(width, 6)}%` }} className={`absolute inset-y-1 overflow-hidden rounded-md px-2 py-1 text-[11.5px] leading-tight ${TONE[c.status] ?? 'bg-surface-3'}`}>
                      <b className="block truncate">{c.procedure}</b>
                      {c.start}–{c.end} · {c.patient ? fullName(c.patient.names) : ''}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
          {!theatres.length ? <p className="text-[13px] text-ink-3">{t('No theatres set up yet.', 'Qol qalliin lama dejin.')}</p> : null}
        </div>
      </Card>
      <Card title={t('Cases', 'Kiisaska')}>
        <ul className="grid text-[13px]">
          {theatres.flatMap((th) =>
            th.cases.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-2 first:border-t-0">
                <span className="font-mono">{c.start}</span>
                <span className="font-semibold">{th.code}</span>
                <Link className="min-w-0 flex-1 hover:underline" href={`/surgery/${c.id}`}>
                  {c.procedure} · {c.patient ? fullName(c.patient.names) : ''} <span className="text-ink-3">· {c.surgeonName}</span>
                </Link>
                <Pill tone={c.status === 'Completed' ? 'ok' : c.status === 'InProcedure' ? 'acc' : 'info'}>{c.status}</Pill>
              </li>
            )),
          )}
        </ul>
      </Card>
    </>
  );
}
