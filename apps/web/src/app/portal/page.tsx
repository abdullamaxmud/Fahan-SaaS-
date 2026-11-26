'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { CalendarDays, CalendarPlus, ChevronRight, FlaskConical, MessageSquare, Receipt, Video } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { money } from '@/lib/money';
import { useMe } from '@/lib/session';
import { when } from '@/lib/portal';
import { usePortal } from '@/components/PortalShell';
import { ErrorNote, useAction } from '@/components/ui';

interface Summary {
  nextAppointment: { id: string; startsAt: string; clinician: string | null; status: string } | null;
  videoVisit: { id: string; startsAt: string; clinician: string; status: string; consent: boolean } | null;
  sharedResults: number;
  amountDueMinor: number;
  currency: string;
  repliesWaiting: number;
}

export default function PortalHome() {
  const { me } = useMe();
  const { current } = usePortal();
  const { t, lang } = useLang();
  const [s, setS] = useState<Summary | null>(null);
  const act = useAction();

  useEffect(() => {
    if (!current) return;
    void act.run(async () => setS(await api<Summary>(`/portal/${current.id}/summary`)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  async function joinVideo() {
    if (!current || !s?.videoVisit) return;
    if (!s.videoVisit.consent) {
      await act.run(() => api(`/portal/${current.id}/video-visits/${s.videoVisit!.id}/consent`, { body: { recording: false } }));
    }
    const r = await act.run(() => api<{ url: string }>(`/portal/${current.id}/video-visits/${s.videoVisit!.id}/join`));
    if (r) window.open(r.url, '_blank', 'noopener');
    else setS(await api<Summary>(`/portal/${current.id}/summary`));
  }

  const first = me.name.split(' ')[0];
  return (
    <>
      <div>
        <h1 className="text-[26px] font-extrabold leading-tight">{t(`Hello, ${first}`, `Soo dhawoow, ${first}`)}</h1>
        {current && current.relationship !== 'self' ? <p className="text-[13.5px] text-ink-3">{t(`You are viewing ${current.name}’s record`, `Waxaad eegaysaa diiwaanka ${current.name}`)}</p> : null}
      </div>
      <ErrorNote error={act.error} />

      {s?.videoVisit ? (
        <section className="card flex flex-wrap items-center gap-3 border-accent p-4">
          <span className="grid h-11 w-11 place-items-center rounded-xl bg-accent text-on-accent">
            <Video size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <b className="block text-[15px]">{t('Video visit', 'Booqasho fiidiyow')}</b>
            <span className="text-[13px] text-ink-2">
              {when(s.videoVisit.startsAt, lang)} · {s.videoVisit.clinician}
            </span>
          </div>
          <button className="btn btn-primary" onClick={joinVideo} disabled={act.busy}>
            {s.videoVisit.status === 'Connected' ? t('Join now', 'Hadda gal') : t('I agree, join when ready', 'Waan oggolahay, gal marka la diyaariyo')}
          </button>
          {s.videoVisit.status !== 'Connected' ? <p className="w-full text-[12.5px] text-ink-3">{t('The Join button works once your clinician starts the call.', 'Badhanka galitaanka wuxuu shaqeeyaa marka dhakhtarku bilaabo wicitaanka.')}</p> : null}
        </section>
      ) : null}

      <section className="card p-4">
        <div className="flex items-center gap-3">
          <span className="grid h-11 w-11 place-items-center rounded-xl bg-accent-soft text-accent-2">
            <CalendarDays size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <span className="text-[12.5px] font-medium text-ink-3">{t('Next appointment', 'Ballanta xigta')}</span>
            {s?.nextAppointment ? (
              <b className="block text-[15px]">
                {when(s.nextAppointment.startsAt, lang)}
                {s.nextAppointment.clinician ? <span className="font-medium text-ink-2"> · {s.nextAppointment.clinician}</span> : null}
              </b>
            ) : (
              <b className="block text-[15px]">{t('No upcoming appointment', 'Ballan soo socota ma jirto')}</b>
            )}
          </div>
        </div>
        <Link href="/portal/appointments?book=1" className="btn btn-primary mt-3 w-full justify-center sm:w-auto">
          <CalendarPlus size={16} />
          {t('Book an appointment', 'Qabso ballan')}
        </Link>
      </section>

      <div className="grid gap-3 sm:grid-cols-3">
        <Tile href="/portal/results" icon={<FlaskConical size={18} />} label={t('Results', 'Natiijooyinka')} value={s ? String(s.sharedResults) : '—'} hint={t('shared by your doctor', 'uu wadaagay dhakhtarkaagu')} />
        <Tile href="/portal/bills" icon={<Receipt size={18} />} label={t('To pay', 'Lacag bixin')} value={s ? money(s.amountDueMinor, s.currency) : '—'} hint={s && s.amountDueMinor ? t('pay at the cashier or by mobile money', 'ku bixi khasnajiga ama lacag mobile') : t('nothing due', 'wax lagu leh ma jiro')} />
        <Tile href="/portal/messages" icon={<MessageSquare size={18} />} label={t('Messages', 'Fariimaha')} value={s ? String(s.repliesWaiting) : '—'} hint={t('new replies', 'jawaabo cusub')} />
      </div>
    </>
  );
}

function Tile({ href, icon, label, value, hint }: { href: string; icon: React.ReactNode; label: string; value: string; hint: string }) {
  return (
    <Link href={href} className="card flex items-center gap-3 p-4 hover:border-accent">
      <span className="grid h-10 w-10 place-items-center rounded-xl bg-surface-2 text-accent-2">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[12.5px] font-medium text-ink-3">{label}</span>
        <b className="num block font-display text-[22px] leading-tight">{value}</b>
        <span className="block truncate text-[12px] text-ink-3">{hint}</span>
      </span>
      <ChevronRight size={16} className="text-ink-3" />
    </Link>
  );
}
