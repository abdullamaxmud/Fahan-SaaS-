'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { CalendarPlus, FileText, Video } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { canDo, useMe } from '@/lib/session';
import { fullName, type PatientBrief } from '@/components/clinical';
import { Drawer, Facts } from '@/components/Dialog';
import { PatientPicker } from '@/components/PatientPicker';
import { Card, Empty, ErrorNote, Field, PageHeader, Pill, fieldErrors, useAction } from '@/components/ui';

interface Session {
  id: string;
  status: string;
  startsAt: string;
  minutes: number;
  reason: string;
  clinician: { id: string; name: string };
  patient: { id: string; mrn: string; names: PatientBrief['names'] } | null;
  consent: { video: boolean; recording: boolean; method: string } | null;
  encounterId: string | null;
  summary: string | null;
}

const STATUS: Record<string, [string, string, 'info' | 'acc' | 'ok' | 'plain' | 'warn']> = {
  Scheduled: ['Scheduled', 'La qorsheeyay', 'info'],
  Connected: ['In call', 'Wicitaan', 'acc'],
  Completed: ['Completed', 'Dhammaaday', 'ok'],
  Cancelled: ['Cancelled', 'La joojiyay', 'plain'],
  NoShow: ['Did not join', 'Ma soo galin', 'warn'],
};
const today = () => new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
const time = (d: string) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Mogadishu' }).format(new Date(d));

export default function TelemedicinePage() {
  const { me } = useMe();
  const { t, lang } = useLang();
  const [date, setDate] = useState(today());
  const [list, setList] = useState<Session[]>([]);
  const [open, setOpen] = useState<Session | null>(null);
  const [book, setBook] = useState(false);
  const load = useAction();
  const canBook = canDo(me, 'appt', 'E') || canDo(me, 'tele', 'S');

  const refresh = useCallback(async () => {
    await load.run(async () => setList(await api<Session[]>(`/telemedicine/sessions?date=${date}`)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <>
      <PageHeader
        title={t('Video visits', 'Booqasho fiidiyow')}
        actions={
          <>
            <input className="input h-9 w-auto" type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label={t('Date', 'Taariikh')} />
            {canBook ? (
              <button className="btn btn-primary" onClick={() => setBook(true)}>
                <CalendarPlus size={16} />
                {t('Book video visit', 'Qabso booqasho fiidiyow')}
              </button>
            ) : null}
          </>
        }
      >
        {t('Consult patients by video. The visit notes join the patient’s record.', 'La tasho bukaanka fiidiyow. Qoraallada booqashada waxay galaan diiwaanka bukaanka.')}
      </PageHeader>
      <ErrorNote error={load.error} />
      <Card>
        {list.length ? (
          <ul>
            {list.map((x) => (
              <li key={x.id}>
                <button className="flex w-full items-center gap-4 border-b border-line px-4 py-3 text-left hover:bg-surface-2/60" onClick={() => setOpen(x)}>
                  <b className="num w-14 font-display text-[18px]">{time(x.startsAt)}</b>
                  <span className="min-w-0 flex-1">
                    <b className="block truncate text-[14px]">{x.patient ? fullName(x.patient.names) : '—'}</b>
                    <span className="block truncate text-[12.5px] text-ink-3">
                      {x.reason} · {x.clinician.name} · {x.minutes} min
                    </span>
                  </span>
                  <Pill tone={STATUS[x.status]?.[2]}>{lang === 'so' ? STATUS[x.status]?.[1] : STATUS[x.status]?.[0]}</Pill>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>{load.busy ? '…' : t('No video visits on this day.', 'Booqasho fiidiyow ma jirto maalintan.')}</Empty>
        )}
      </Card>
      {open ? (
        <SessionPanel
          x={open}
          onClose={() => setOpen(null)}
          onChanged={async () => {
            const fresh = await api<Session[]>(`/telemedicine/sessions?date=${date}`);
            setList(fresh);
            setOpen(fresh.find((s) => s.id === open.id) ?? null);
          }}
        />
      ) : null}
      {book ? (
        <BookPanel
          date={date}
          onClose={() => setBook(false)}
          onDone={async () => {
            setBook(false);
            await refresh();
          }}
        />
      ) : null}
    </>
  );
}

function SessionPanel({ x, onClose, onChanged }: { x: Session; onClose: () => void; onChanged: () => Promise<void> }) {
  const { me } = useMe();
  const { t, lang } = useLang();
  const act = useAction();
  const [recording, setRecording] = useState(false);
  const [method, setMethod] = useState('verbal');
  const [summary, setSummary] = useState('');
  const [reason, setReason] = useState('');
  const mine = x.clinician.id === me.id && canDo(me, 'tele', 'S');
  const go = async (path: string, body: object = {}) => {
    const r = await act.run(() => api<{ url?: string }>(`/telemedicine/sessions/${x.id}/${path}`, { body }));
    if (r !== undefined) {
      if (r?.url) window.open(r.url, '_blank', 'noopener');
      await onChanged();
    }
  };
  const join = async () => {
    const r = await act.run(() => api<{ url: string }>(`/telemedicine/sessions/${x.id}/join`));
    if (r) window.open(r.url, '_blank', 'noopener');
  };

  return (
    <Drawer title={x.patient ? fullName(x.patient.names) : t('Video visit', 'Booqasho fiidiyow')} sub={<Pill tone={STATUS[x.status]?.[2]}>{lang === 'so' ? STATUS[x.status]?.[1] : STATUS[x.status]?.[0]}</Pill>} onClose={onClose}>
      <div className="grid gap-5">
        <Facts
          rows={[
            [t('Time', 'Waqtiga'), `${time(x.startsAt)} · ${x.minutes} min`],
            ['MRN', x.patient?.mrn],
            [t('Clinician', 'Dhakhtarka'), x.clinician.name],
            [t('Reason', 'Sababta'), x.reason],
            [t('Consent', 'Oggolaansho'), x.consent ? `${t('Video', 'Fiidiyow')} ✓ · ${x.consent.recording ? t('recording allowed', 'duubis waa la oggol yahay') : t('no recording', 'duubis la’aan')}` : t('Not recorded yet', 'Weli lama qorin')],
            [t('Summary', 'Soo koobid'), x.summary],
          ]}
        />

        {mine && x.status === 'Scheduled' && !x.consent ? (
          <div className="grid gap-3 rounded-xl border border-line p-3">
            <b className="text-[14px]">{t('Patient consent', 'Oggolaanshaha bukaanka')}</b>
            <p className="text-[13px] text-ink-2">{t('Ask the patient if they agree to a video consultation.', 'Weydii bukaanka inuu oggol yahay la-tashi fiidiyow.')}</p>
            <Field label={t('How was consent given?', 'Sidee loo oggolaaday?')}>
              <select className="input" value={method} onChange={(e) => setMethod(e.target.value)}>
                <option value="verbal">{t('Verbally', 'Af ahaan')}</option>
                <option value="written">{t('In writing', 'Qoraal ahaan')}</option>
                <option value="portal">{t('In the patient portal', 'Bogga bukaanka')}</option>
              </select>
            </Field>
            <label className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" checked={recording} onChange={(e) => setRecording(e.target.checked)} />
              {t('Patient also agrees to the call being recorded', 'Bukaanku wuxuu kale oo oggol yahay in la duubo')}
            </label>
            <button className="btn btn-primary justify-self-start" disabled={act.busy} onClick={() => go('consent', { video: true, recording, method })}>
              {t('Patient agrees', 'Bukaanku waa oggol yahay')}
            </button>
          </div>
        ) : null}

        {mine && x.status === 'Scheduled' && x.consent ? (
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-primary" disabled={act.busy} onClick={() => go('start')}>
              <Video size={16} />
              {t('Start video call', 'Bilow wicitaanka')}
            </button>
            <button className="btn" disabled={act.busy} onClick={() => go('no-show')}>
              {t('Patient did not join', 'Bukaanku ma soo galin')}
            </button>
          </div>
        ) : null}

        {mine && x.status === 'Connected' ? (
          <div className="grid gap-3">
            <div className="flex flex-wrap gap-2">
              <button className="btn btn-primary" onClick={join}>
                <Video size={16} />
                {t('Rejoin call', 'Dib u gal wicitaanka')}
              </button>
              {x.encounterId ? (
                <Link className="btn" href={`/encounters/${x.encounterId}`}>
                  <FileText size={16} />
                  {t('Open visit notes', 'Fur qoraallada booqashada')}
                </Link>
              ) : null}
            </div>
            <Field label={t('Short summary (optional)', 'Soo koobid gaaban (ikhtiyaari)')}>
              <textarea className="input h-20 py-2" value={summary} onChange={(e) => setSummary(e.target.value)} />
            </Field>
            <button className="btn justify-self-start" disabled={act.busy} onClick={() => go('complete', summary ? { summary } : {})}>
              {t('End visit', 'Dhammee booqashada')}
            </button>
          </div>
        ) : null}

        {x.status === 'Completed' && x.encounterId && mine ? (
          <Link className="btn justify-self-start" href={`/encounters/${x.encounterId}`}>
            <FileText size={16} />
            {t('Open visit notes', 'Fur qoraallada booqashada')}
          </Link>
        ) : null}

        {x.status === 'Scheduled' && (canDo(me, 'appt', 'E') || mine) ? (
          <div className="grid gap-2 rounded-xl border border-line p-3">
            <Field label={t('Cancel — reason', 'Jooji — sababta')}>
              <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <button className="btn justify-self-start" disabled={act.busy || reason.trim().length < 3} onClick={() => go('cancel', { reason })}>
              {t('Cancel visit', 'Jooji booqashada')}
            </button>
          </div>
        ) : null}
        <ErrorNote error={act.error} />
      </div>
    </Drawer>
  );
}

function BookPanel({ date, onClose, onDone }: { date: string; onClose: () => void; onDone: () => Promise<void> }) {
  const { me } = useMe();
  const { t } = useLang();
  const [patient, setPatient] = useState<PatientBrief | null>(null);
  const [docs, setDocs] = useState<{ id: string; name: string }[]>([]);
  const [f, setF] = useState({ clinicianId: '', date, time: '10:00', minutes: 20, reason: '' });
  const act = useAction();
  const fe = fieldErrors(act.error);
  useEffect(() => {
    api<{ id: string; name: string }[]>('/telemedicine/clinicians')
      .then((d) => {
        const list = canDo(me, 'appt', 'E') ? d : d.filter((x) => x.id === me.id);
        setDocs(list);
        setF((x) => ({ ...x, clinicianId: x.clinicianId || list[0]?.id || '' }));
      })
      .catch(() => {});
  }, [me]);
  return (
    <Drawer title={t('Book a video visit', 'Qabso booqasho fiidiyow')} onClose={onClose}>
      <form
        className="grid gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!patient) return;
          const r = await act.run(() => api('/telemedicine/sessions', { body: { ...f, patientId: patient.id } }));
          if (r) await onDone();
        }}
      >
        <Field label={t('Patient', 'Bukaanka')} error={fe.patientId}>
          <PatientPicker value={patient} onChange={setPatient} />
        </Field>
        <Field label={t('Clinician', 'Dhakhtarka')} error={fe.clinicianId}>
          <select className="input" required value={f.clinicianId} onChange={(e) => setF({ ...f, clinicianId: e.target.value })}>
            {docs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label={t('Date', 'Taariikh')}>
            <input className="input" type="date" required value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
          </Field>
          <Field label={t('Time', 'Saacad')} error={fe.time}>
            <input className="input" type="time" required value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} />
          </Field>
          <Field label={t('Minutes', 'Daqiiqo')}>
            <select className="input" value={f.minutes} onChange={(e) => setF({ ...f, minutes: Number(e.target.value) })}>
              {[10, 15, 20, 30, 45, 60].map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label={t('Reason', 'Sababta')} error={fe.reason}>
          <input className="input" required value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder={t('e.g. Follow-up of blood pressure', 'tus. Dabagal dhiig-karka')} />
        </Field>
        {Object.keys(fe).length ? null : <ErrorNote error={act.error} />}
        <button className="btn btn-primary justify-self-start" disabled={act.busy || !patient}>
          {t('Book visit', 'Qabso')}
        </button>
      </form>
    </Drawer>
  );
}
