'use client';

import { useCallback, useEffect, useState } from 'react';
import { CalendarPlus, Video, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { usePortal } from '@/components/PortalShell';
import { Card, Empty, ErrorNote, Field, Pill, useAction } from '@/components/ui';
import { when } from '@/lib/portal';

interface Appt {
  id: string;
  startsAt: string;
  status: string;
  reason: string | null;
  clinician: string | null;
  canCancel: boolean;
}
interface VideoVisit {
  id: string;
  startsAt: string;
  clinician: string;
  reason: string;
  status: string;
  consent: boolean;
  canJoin: boolean;
}
const STATUS: Record<string, [string, string, 'info' | 'ok' | 'plain' | 'warn' | 'acc']> = {
  Confirmed: ['Booked', 'La qabsaday', 'info'],
  CheckedIn: ['Arrived', 'Yimid', 'acc'],
  Completed: ['Done', 'Dhammaaday', 'ok'],
  Cancelled: ['Cancelled', 'La joojiyay', 'plain'],
  NoShow: ['Missed', 'Lama iman', 'warn'],
  Scheduled: ['Booked', 'La qabsaday', 'info'],
  Connected: ['In progress', 'Socda', 'acc'],
};
const ymd = (d: Date) => d.toISOString().slice(0, 10);

export default function PortalAppointments() {
  const { current } = usePortal();
  const { t, lang } = useLang();
  const [list, setList] = useState<Appt[]>([]);
  const [videos, setVideos] = useState<VideoVisit[]>([]);
  const [booking, setBooking] = useState(false);
  const act = useAction();

  const load = useCallback(async () => {
    if (!current) return;
    await act.run(async () => {
      const [a, v] = await Promise.all([api<Appt[]>(`/portal/${current.id}/appointments`), api<VideoVisit[]>(`/portal/${current.id}/video-visits`)]);
      setList(a);
      setVideos(v);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);
  useEffect(() => {
    void load();
    if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('book')) setBooking(true);
  }, [load]);

  const now = Date.now();
  const upcoming = list.filter((x) => new Date(x.startsAt).getTime() >= now && x.status === 'Confirmed');
  const past = list.filter((x) => !upcoming.includes(x));

  async function cancel(id: string) {
    if (!current) return;
    if (!window.confirm(t('Cancel this appointment?', 'Ma joojinaysaa ballantan?'))) return;
    if ((await act.run(() => api(`/portal/${current.id}/appointments/${id}/cancel`, { body: {} }))) !== undefined) await load();
  }
  async function join(v: VideoVisit) {
    if (!current) return;
    if (!v.consent) await act.run(() => api(`/portal/${current.id}/video-visits/${v.id}/consent`, { body: { recording: false } }));
    const r = await act.run(() => api<{ url: string }>(`/portal/${current.id}/video-visits/${v.id}/join`));
    if (r) window.open(r.url, '_blank', 'noopener');
    await load();
  }
  const S = (k: string) => STATUS[k] ?? [k, k, 'plain' as const];

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="flex-1 text-[24px] font-extrabold">{t('Appointments', 'Ballamaha')}</h1>
        <button className="btn btn-primary" onClick={() => setBooking(true)}>
          <CalendarPlus size={16} />
          {t('Book', 'Qabso')}
        </button>
      </div>
      <ErrorNote error={act.error} />
      {booking && current ? (
        <BookCard
          pid={current.id}
          onClose={() => setBooking(false)}
          onDone={async () => {
            setBooking(false);
            await load();
          }}
        />
      ) : null}

      {videos.filter((v) => v.status === 'Scheduled' || v.status === 'Connected').length ? (
        <Card title={t('Video visits', 'Booqashooyinka fiidiyowga')}>
          <ul>
            {videos
              .filter((v) => v.status === 'Scheduled' || v.status === 'Connected')
              .map((v) => (
                <li key={v.id} className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3">
                  <Video size={18} className="text-accent-2" />
                  <span className="min-w-0 flex-1">
                    <b className="block text-[14px]">{when(v.startsAt, lang)}</b>
                    <span className="text-[12.5px] text-ink-3">
                      {v.clinician} · {v.reason}
                    </span>
                  </span>
                  <button className="btn btn-primary h-9" onClick={() => join(v)} disabled={act.busy}>
                    {v.canJoin ? t('Join now', 'Hadda gal') : t('Agree & wait', 'Oggolow oo sug')}
                  </button>
                </li>
              ))}
          </ul>
        </Card>
      ) : null}

      <Card title={t('Coming up', 'Soo socda')}>
        {upcoming.length ? (
          <ul>
            {upcoming.map((x) => (
              <li key={x.id} className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3">
                <span className="min-w-0 flex-1">
                  <b className="block text-[14px]">{when(x.startsAt, lang)}</b>
                  <span className="text-[12.5px] text-ink-3">
                    {x.clinician}
                    {x.reason ? ` · ${x.reason}` : ''}
                  </span>
                </span>
                {x.canCancel ? (
                  <button className="btn h-8 px-2.5 text-xs" onClick={() => cancel(x.id)}>
                    <X size={14} />
                    {t('Cancel', 'Jooji')}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <Empty>{t('No upcoming appointments.', 'Ballan soo socota ma jirto.')}</Empty>
        )}
      </Card>

      {past.length ? (
        <Card title={t('Earlier', 'Hore')}>
          <ul>
            {past.map((x) => (
              <li key={x.id} className="flex items-center gap-3 border-t border-line px-4 py-3">
                <span className="min-w-0 flex-1">
                  <b className="block text-[14px]">{when(x.startsAt, lang)}</b>
                  <span className="text-[12.5px] text-ink-3">{x.clinician}</span>
                </span>
                <Pill tone={S(x.status)[2]}>{lang === 'so' ? S(x.status)[1] : S(x.status)[0]}</Pill>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </>
  );
}

function BookCard({ pid, onClose, onDone }: { pid: string; onClose: () => void; onDone: () => Promise<void> }) {
  const { t, lang } = useLang();
  const [docs, setDocs] = useState<{ id: string; name: string }[]>([]);
  const [doc, setDoc] = useState('');
  const [date, setDate] = useState(ymd(new Date()));
  const [slots, setSlots] = useState<{ startsAt: string; time: string }[] | null>(null);
  const [pick, setPick] = useState('');
  const [reason, setReason] = useState('');
  const act = useAction();

  useEffect(() => {
    api<{ id: string; name: string }[]>(`/portal/${pid}/clinicians`)
      .then((d) => {
        setDocs(d);
        setDoc(d[0]?.id ?? '');
      })
      .catch(() => {});
  }, [pid]);
  useEffect(() => {
    if (!doc) return;
    setPick('');
    setSlots(null);
    api<{ startsAt: string; time: string }[]>(`/portal/${pid}/slots?providerId=${doc}&date=${date}`)
      .then(setSlots)
      .catch(() => setSlots([]));
  }, [pid, doc, date]);

  const days = Array.from({ length: 14 }, (_, i) => ymd(new Date(Date.now() + i * 86_400_000)));
  return (
    <section className="card grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 border-accent p-4">
      <div className="flex items-center">
        <h2 className="flex-1 text-[17px] font-bold">{t('Book an appointment', 'Qabso ballan')}</h2>
        <button className="btn h-8 w-8 justify-center p-0" onClick={onClose} aria-label={t('Close', 'Xir')}>
          <X size={16} />
        </button>
      </div>
      <Field label={t('Doctor', 'Dhakhtarka')}>
        <select className="input" value={doc} onChange={(e) => setDoc(e.target.value)}>
          {docs.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </Field>
      <div>
        <span className="mb-1.5 block text-[12.5px] font-medium text-ink-2">{t('Day', 'Maalinta')}</span>
        <div className="flex gap-2 overflow-x-auto pb-1">
          {days.map((d) => {
            const dt = new Date(`${d}T12:00:00Z`);
            return (
              <button key={d} onClick={() => setDate(d)} className={`flex w-14 flex-none flex-col items-center rounded-lg border py-2 ${d === date ? 'border-accent bg-accent-soft text-accent-2' : 'border-line'}`}>
                <span className="text-[11px] uppercase">{new Intl.DateTimeFormat(lang === 'so' ? 'so-SO' : 'en-GB', { weekday: 'short' }).format(dt)}</span>
                <b className="text-[16px]">{dt.getUTCDate()}</b>
              </button>
            );
          })}
        </div>
      </div>
      <div>
        <span className="mb-1.5 block text-[12.5px] font-medium text-ink-2">{t('Time', 'Waqtiga')}</span>
        {slots === null ? (
          <span className="text-[13px] text-ink-3">…</span>
        ) : slots.length ? (
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
            {slots.map((s) => (
              <button key={s.startsAt} onClick={() => setPick(s.startsAt)} className={`rounded-lg border py-2 text-[13.5px] font-semibold ${pick === s.startsAt ? 'border-accent bg-accent text-on-accent' : 'border-line hover:border-accent'}`}>
                {s.time}
              </button>
            ))}
          </div>
        ) : (
          <span className="text-[13px] text-ink-3">{t('No free times this day. Try another day.', 'Waqti bannaan ma jiro maalintan. Isku day maalin kale.')}</span>
        )}
      </div>
      <Field label={t('Reason (optional)', 'Sababta (ikhtiyaari)')}>
        <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <ErrorNote error={act.error} />
      <button
        className="btn btn-primary justify-self-start"
        disabled={!pick || act.busy}
        onClick={async () => {
          if (await act.run(() => api(`/portal/${pid}/appointments`, { body: { providerId: doc, startsAt: pick, ...(reason ? { reason } : {}) } }))) await onDone();
        }}
      >
        {t('Confirm booking', 'Xaqiiji ballanta')}
      </button>
    </section>
  );
}
