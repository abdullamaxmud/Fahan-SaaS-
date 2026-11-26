'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { CalendarPlus, ChevronLeft, ChevronRight, LogIn, Search } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { canDo, useMe } from '@/lib/session';
import { fullName, type PatientBrief } from '@/components/clinical';
import { Card, ErrorNote, Field, PageHeader, Pill, fieldErrors, statusTone, useAction } from '@/components/ui';

interface Provider {
  id: string;
  name: string;
  branchId: string | null;
}
interface Slot {
  startsAt: string;
  time: string;
  free: boolean;
}
interface Appt {
  id: string;
  time: string;
  status: string;
  reason: string | null;
  queueNo: number | null;
  encounterId: string | null;
  patient: PatientBrief | null;
  provider: { id: string; name: string };
}

const today = () => new Date().toLocaleDateString('en-CA');
const shift = (d: string, n: number) => {
  const x = new Date(`${d}T12:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function AppointmentsPage() {
  const { me } = useMe();
  const { t } = useLang();
  const [date, setDate] = useState(today());
  const [providers, setProviders] = useState<Provider[]>([]);
  const [providerId, setProviderId] = useState('');
  const [slots, setSlots] = useState<Slot[]>([]);
  const [day, setDay] = useState<Appt[]>([]);
  const [pick, setPick] = useState<Slot | null>(null);
  const [pq, setPq] = useState('');
  const [found, setFound] = useState<PatientBrief[]>([]);
  const [reason, setReason] = useState('');
  const [wq, setWq] = useState('');
  const [wFound, setWFound] = useState<PatientBrief[]>([]);
  const [walkIn, setWalkIn] = useState<string | null>(null);
  const [walkDoc, setWalkDoc] = useState('');
  const [sched, setSched] = useState({ weekdays: [1, 2, 3, 4, 6], start: '08:00', end: '12:00', slotMinutes: 20 });
  const load = useAction();
  const act = useAction();
  const canBook = canDo(me, 'appt', 'E');

  const refresh = useCallback(async () => {
    await load.run(async () => {
      setDay(await api<Appt[]>(`/appointments?date=${date}`));
      if (providerId) setSlots(await api<Slot[]>(`/appointments/slots?providerId=${providerId}&date=${date}`));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, providerId]);

  useEffect(() => {
    if (!canBook) return;
    api<Provider[]>('/appointments/providers')
      .then((p) => {
        setProviders(p);
        setProviderId((x) => x || p[0]?.id || '');
      })
      .catch(() => {});
  }, [canBook]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function book(p: PatientBrief) {
    if (!pick) return;
    const ok = await act.run(() => api('/appointments', { body: { patientId: p.id, providerId, startsAt: pick.startsAt, ...(reason ? { reason } : {}) } }));
    if (ok) {
      setPick(null);
      setFound([]);
      setPq('');
      setReason('');
      await refresh();
    }
  }

  async function action(a: Appt, path: 'check-in' | 'cancel' | 'no-show') {
    const body = path === 'cancel' ? { reason: 'Cancelled at front desk' } : {};
    if (await act.run(() => api(`/appointments/${a.id}/${path}`, { body }))) await refresh();
  }

  const branchId = providers.find((p) => p.id === providerId)?.branchId ?? me.branchId ?? '';
  const fe = fieldErrors(act.error);

  return (
    <>
      <PageHeader title={t('Appointments', 'Ballamaha')}>
        {t('Book, check in and run the queue.', 'Qabso ballan, diiwaangeli imaanshaha, maamul safka.')}
      </PageHeader>
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn h-9 w-9 justify-center p-0" onClick={() => setDate(shift(date, -1))} aria-label="Previous day">
          <ChevronLeft size={16} />
        </button>
        <input className="input h-9 w-auto" type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" />
        <button className="btn h-9 w-9 justify-center p-0" onClick={() => setDate(shift(date, 1))} aria-label="Next day">
          <ChevronRight size={16} />
        </button>
        <button className="btn h-9" onClick={() => setDate(today())}>
          {t('Today', 'Maanta')}
        </button>
        {canBook && providers.length ? (
          <select className="input h-9 w-auto" value={providerId} onChange={(e) => setProviderId(e.target.value)} aria-label="Clinician">
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      <ErrorNote error={load.error ?? (Object.keys(fe).length ? null : act.error)} />

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Card title={`${t('Day list', 'Liiska maalinta')} · ${day.length}`}>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className="th">{t('Time', 'Waqti')}</th>
                  <th className="th">{t('Patient', 'Bukaanka')}</th>
                  <th className="th">{t('Clinician', 'Dhakhtarka')}</th>
                  <th className="th">Status</th>
                  <th className="th" />
                </tr>
              </thead>
              <tbody>
                {day.map((a) => (
                  <tr key={a.id}>
                    <td className="td num font-mono font-semibold">
                      {a.time}
                      {a.queueNo ? <span className="ml-2 rounded bg-accent-soft px-1.5 text-[11px] text-accent-2">#{a.queueNo}</span> : null}
                    </td>
                    <td className="td">
                      {a.patient ? (
                        <Link href={`/patients/${a.patient.id}`} className="hover:underline">
                          <b className="block">{fullName(a.patient.names)}</b>
                          <span className="font-mono text-[11.5px] text-ink-3">{a.patient.mrn}</span>
                        </Link>
                      ) : (
                        '—'
                      )}
                      {a.reason ? <span className="block text-xs text-ink-2">{a.reason}</span> : null}
                    </td>
                    <td className="td">{a.provider.name}</td>
                    <td className="td">
                      <Pill tone={statusTone(a.status === 'Completed' || a.status === 'CheckedIn' ? 'Active' : a.status === 'Confirmed' ? 'info' : a.status === 'NoShow' ? 'Suspended' : a.status)}>{a.status}</Pill>
                    </td>
                    <td className="td whitespace-nowrap text-right">
                      {canBook && a.status === 'Confirmed' ? (
                        <span className="flex justify-end gap-1.5">
                          <button className="btn btn-primary h-7 px-2.5 text-xs" disabled={act.busy} onClick={() => action(a, 'check-in')}>
                            <LogIn size={14} />
                            {t('Check in', 'Gali')}
                          </button>
                          <button className="btn h-7 px-2.5 text-xs" disabled={act.busy} onClick={() => action(a, 'no-show')}>
                            {t('No-show', 'Ma iman')}
                          </button>
                          <button className="btn h-7 px-2.5 text-xs" disabled={act.busy} onClick={() => action(a, 'cancel')}>
                            {t('Cancel', 'Jooji')}
                          </button>
                        </span>
                      ) : null}
                      {a.encounterId && canDo(me, 'opd', 'V') ? (
                        <Link className="btn h-7 px-2.5 text-xs" href={`/encounters/${a.encounterId}`}>
                          {t('Open visit', 'Fur booqashada')}
                        </Link>
                      ) : null}
                    </td>
                  </tr>
                ))}
                {!day.length && !load.busy ? (
                  <tr>
                    <td className="td text-ink-3" colSpan={5}>
                      {t('No appointments on this day.', 'Ballan ma jiro maalintan.')}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </Card>

        {canBook ? (
          <div className="grid gap-4">
            <Card title={t('Walk-in (no booking)', 'Imaatin aan ballan lahayn')}>
              <form
                className="grid gap-2 px-4 pb-4"
                onSubmit={async (e) => {
                  e.preventDefault();
                  setWFound(await api<PatientBrief[]>(`/patients?q=${encodeURIComponent(wq)}`).catch(() => []));
                }}
              >
                <select className="input h-9" required value={walkDoc} onChange={(e) => setWalkDoc(e.target.value)} aria-label="Walk-in clinician">
                  <option value="">{t('See which clinician?', 'Dhakhtarkee?')}</option>
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <span className="flex gap-2">
                  <input className="input h-9" value={wq} onChange={(e) => setWq(e.target.value)} placeholder={t('Name, MRN or phone', 'Magac, MRN ama telefoon')} aria-label="Walk-in patient" />
                  <button className="btn h-9 w-9 justify-center p-0" aria-label="Search">
                    <Search size={16} />
                  </button>
                </span>
                {wFound.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    disabled={!walkDoc || act.busy}
                    className="flex items-center justify-between rounded-lg border border-line p-2 text-left hover:border-accent disabled:opacity-50"
                    onClick={async () => {
                      const r = await act.run(() => api<{ encounterId: string; queueNo: number }>('/appointments/walk-in', { body: { patientId: p.id, providerId: walkDoc } }));
                      if (r) {
                        setWalkIn(`${fullName(p.names)} · #${r.queueNo} · ${providers.find((x) => x.id === walkDoc)?.name ?? ''}`);
                        setWFound([]);
                        setWq('');
                        await refresh();
                      }
                    }}
                  >
                    <span>
                      <b className="block text-[13px]">{fullName(p.names)}</b>
                      <span className="font-mono text-[11.5px] text-ink-3">{p.mrn}</span>
                    </span>
                    <LogIn size={16} className="text-accent-2" />
                  </button>
                ))}
                {walkIn ? (
                  <span className="rounded-lg bg-accent-soft px-3 py-2 text-[13px] text-accent-2">
                    {t('Checked in', 'Waa la galiyay')}: {walkIn}
                  </span>
                ) : null}
              </form>
            </Card>
            <Card title={t('Book a slot', 'Qabso waqti')}>
              <div className="grid gap-3 px-4 pb-4">
                <div className="flex flex-wrap gap-1.5">
                  {slots.map((s) => (
                    <button
                      key={s.startsAt}
                      disabled={!s.free}
                      onClick={() => setPick(s)}
                      className={`h-8 rounded-lg border px-2.5 font-mono text-[12.5px] ${pick?.startsAt === s.startsAt ? 'border-accent bg-accent text-on-accent' : s.free ? 'border-line-2 hover:border-accent' : 'cursor-not-allowed border-line bg-surface-2 text-ink-3 line-through'}`}
                    >
                      {s.time}
                    </button>
                  ))}
                  {!slots.length ? <p className="text-[13px] text-ink-3">{t('No clinic session on this day. Add one below.', 'Fadhi ma jiro maalintan.')}</p> : null}
                </div>
                {pick ? (
                  <form
                    className="grid gap-2"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      setFound(await api<PatientBrief[]>(`/patients?q=${encodeURIComponent(pq)}`).catch(() => []));
                    }}
                  >
                    <Field label={`${t('Patient for', 'Bukaanka')} ${pick.time}`}>
                      <span className="flex gap-2">
                        <input className="input" value={pq} onChange={(e) => setPq(e.target.value)} placeholder={t('Name, MRN or phone', 'Magac, MRN ama telefoon')} />
                        <button className="btn h-10 w-10 justify-center p-0" aria-label="Search">
                          <Search size={16} />
                        </button>
                      </span>
                    </Field>
                    <Field label={t('Reason (optional)', 'Sababta')}>
                      <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
                    </Field>
                    {found.map((p) => (
                      <button key={p.id} type="button" className="flex items-center justify-between rounded-lg border border-line p-2 text-left hover:border-accent" onClick={() => book(p)}>
                        <span>
                          <b className="block text-[13px]">{fullName(p.names)}</b>
                          <span className="font-mono text-[11.5px] text-ink-3">
                            {p.mrn} · {p.dob}
                          </span>
                        </span>
                        <CalendarPlus size={16} className="text-accent-2" />
                      </button>
                    ))}
                  </form>
                ) : null}
              </div>
            </Card>
            {providerId ? (
              <Card title={t('Clinic session', 'Fadhiga rugta')}>
                <form
                  className="grid gap-3 px-4 pb-4"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (await act.run(() => api('/appointments/schedules', { body: { providerId, branchId, ...sched } }))) await refresh();
                  }}
                >
                  <div className="flex flex-wrap gap-1.5" role="group" aria-label="Weekdays">
                    {DAYS.map((d, i) => (
                      <button
                        type="button"
                        key={d}
                        aria-pressed={sched.weekdays.includes(i)}
                        onClick={() => setSched({ ...sched, weekdays: sched.weekdays.includes(i) ? sched.weekdays.filter((x) => x !== i) : [...sched.weekdays, i].sort() })}
                        className={`h-8 rounded-lg border px-2.5 text-xs font-semibold ${sched.weekdays.includes(i) ? 'border-ink bg-ink text-surface' : 'border-line-2'}`}
                      >
                        {d}
                      </button>
                    ))}
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <Field label={t('From', 'Laga')} error={fe.start}>
                      <input className="input" type="time" value={sched.start} onChange={(e) => setSched({ ...sched, start: e.target.value })} />
                    </Field>
                    <Field label={t('To', 'Ilaa')} error={fe.end}>
                      <input className="input" type="time" value={sched.end} onChange={(e) => setSched({ ...sched, end: e.target.value })} />
                    </Field>
                    <Field label={t('Minutes', 'Daqiiqo')} error={fe.slotMinutes}>
                      <input className="input" type="number" min={5} max={240} value={sched.slotMinutes} onChange={(e) => setSched({ ...sched, slotMinutes: Number(e.target.value) })} />
                    </Field>
                  </div>
                  <button className="btn justify-self-start" disabled={act.busy}>
                    {t('Add session', 'Ku dar fadhi')}
                  </button>
                </form>
              </Card>
            ) : null}
          </div>
        ) : null}
      </div>
    </>
  );
}
