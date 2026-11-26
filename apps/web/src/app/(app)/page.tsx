'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ChevronRight, CircleCheck } from 'lucide-react';
import { ROLE_BY_ID, can } from '@fahan/policy';
import { api } from '@/lib/api';
import { QUICK, STATS, TASKS } from '@/lib/home';
import { useLang } from '@/lib/i18n';
import { useMe } from '@/lib/session';
import { Icon } from '@/components/Icon';
import { ErrorNote, useAction } from '@/components/ui';

const TONE = {
  crit: 'bg-crit-soft text-crit',
  warn: 'bg-warn-soft text-warn',
  info: 'bg-info-soft text-info',
  acc: 'bg-accent-soft text-accent-2',
} as const;

function greeting(lang: 'en' | 'so') {
  const h = new Date().getHours();
  if (lang === 'so') return h < 12 ? 'Subax wanaagsan' : h < 17 ? 'Galab wanaagsan' : 'Habeen wanaagsan';
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

export default function HomePage() {
  const { me } = useMe();
  const { t, lang } = useLang();
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const load = useAction();

  useEffect(() => {
    const get = () => load.run(async () => setCounts((await api<{ counts: Record<string, number> }>('/home')).counts));
    void get();
    const timer = setInterval(get, 60_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const role = ROLE_BY_ID[me.roles[0] ?? ''];
  const first = me.name.replace(/^(Dr\.|Eng\.)\s*/, '').split(' ')[0];
  const title = me.name.startsWith('Dr.') ? `Dr. ${first}` : first;
  const ownPatients = me.scope === 'assigned-patient' || me.scope === 'own-record';
  const tasks = Object.keys(TASKS).filter((k) => (counts?.[k] ?? 0) > 0);
  const stats = Object.keys(STATS).filter((k) => counts && k in counts);
  const quick = QUICK.filter((q) => can(me.perms, q.need[0], q.need[1]) && !(q.staffOnly && ownPatients) && !me.disabledModules?.includes(q.need[0])).slice(0, 6);
  const beds = counts && 'bedsFree' in counts ? (counts.bedsFree ?? 0) + (counts.bedsOccupied ?? 0) + (counts.bedsCleaning ?? 0) : 0;
  const date = new Intl.DateTimeFormat(lang === 'so' ? 'so-SO' : 'en-GB', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());

  return (
    <>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-ink-3">{date}</p>
          <h1 className="text-[clamp(24px,2.8vw,32px)] font-extrabold leading-tight">
            {greeting(lang)}, {title}
          </h1>
          <p className="mt-0.5 text-[13.5px] text-ink-3">{role?.name}</p>
        </div>
        {quick.length ? (
          <div className="flex flex-wrap gap-2">
            {quick.slice(0, 3).map((q, i) => (
              <Link key={q.href + q.en} href={q.href} className={`btn ${i === 0 ? 'btn-primary' : ''}`}>
                <Icon name={q.icon} size={16} />
                {lang === 'so' ? q.so : q.en}
              </Link>
            ))}
          </div>
        ) : null}
      </div>

      <ErrorNote error={load.error} />

      {stats.length ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
          {stats.map((k) => {
            const s = STATS[k]!;
            return (
              <Link key={k} href={s.href} className="card group flex flex-col gap-2 p-4 transition-colors hover:border-accent">
                <span className="flex items-center justify-between text-ink-3">
                  <span className="text-[12.5px] font-medium">{lang === 'so' ? s.so : s.en}</span>
                  <Icon name={s.icon} size={16} className="group-hover:text-accent-2" />
                </span>
                <b className="num font-display text-[30px] font-extrabold leading-none">{counts?.[k] ?? '—'}</b>
                {k === 'bedsFree' && beds ? (
                  <span className="flex items-center gap-2 text-[12px] text-ink-3">
                    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3">
                      <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.round(((counts?.bedsOccupied ?? 0) / beds) * 100)}%` }} />
                    </span>
                    {Math.round(((counts?.bedsOccupied ?? 0) / beds) * 100)}% {t('full', 'buuxa')}
                  </span>
                ) : null}
              </Link>
            );
          })}
        </div>
      ) : null}

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <section className="card min-w-0">
          <div className="flex items-center gap-2 px-4 pb-2 pt-4">
            <h2 className="text-[16px] font-bold">{t('Needs your attention', 'Waxa kaa sugaya')}</h2>
            {tasks.length ? <span className="rounded-full bg-surface-3 px-2 text-[12px] font-semibold text-ink-2">{tasks.length}</span> : null}
          </div>
          {counts === null ? (
            <div className="grid gap-2 p-4">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-12 animate-pulse rounded-lg bg-surface-2" />
              ))}
            </div>
          ) : tasks.length ? (
            <ul className="pb-2">
              {tasks.map((k) => {
                const x = TASKS[k]!;
                return (
                  <li key={k}>
                    <Link href={x.href} className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-2/60">
                      <span className={`grid h-9 w-9 flex-none place-items-center rounded-lg ${TONE[x.tone]}`}>
                        <Icon name={x.icon} size={17} />
                      </span>
                      <span className="min-w-0 flex-1 text-[14px] font-medium">{lang === 'so' ? x.so : x.en}</span>
                      <b className="num font-display text-[18px]">{k === 'tillClosed' ? '' : counts[k]}</b>
                      <ChevronRight size={16} className="text-ink-3" />
                    </Link>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="flex flex-col items-center gap-2 px-4 pb-10 pt-6 text-center">
              <CircleCheck size={34} className="text-ok" strokeWidth={1.5} />
              <b className="text-[15px]">{t('All caught up', 'Wax kaa sugaya ma jiraan')}</b>
              <span className="text-[13px] text-ink-3">{t('New work will appear here as it arrives.', 'Shaqo cusub halkan ayay ka soo muuqan doontaa.')}</span>
            </div>
          )}
        </section>

        {quick.length > 3 ? (
          <section className="card min-w-0">
            <h2 className="px-4 pb-2 pt-4 text-[16px] font-bold">{t('Shortcuts', 'Gaaba-yaal')}</h2>
            <div className="grid grid-cols-2 gap-2 p-4 pt-1">
              {quick.map((q) => (
                <Link key={q.href + q.en} href={q.href} className="flex items-center gap-2.5 rounded-lg border border-line px-3 py-3 text-[13px] font-semibold hover:border-accent hover:bg-accent-soft/40">
                  <Icon name={q.icon} size={17} className="text-accent-2" />
                  {lang === 'so' ? q.so : q.en}
                </Link>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </>
  );
}
