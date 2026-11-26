'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Siren, UserPlus } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { canDo, useMe } from '@/lib/session';
import { useReauth } from '@/components/Reauth';
import { fullName, type PatientBrief } from '@/components/clinical';
import { Card, ErrorNote, Field, PageHeader, Pill, useAction } from '@/components/ui';

interface Row {
  id: string;
  state: string;
  esi: number | null;
  mode: string;
  complaint: string;
  waitingMinutes: number;
  patient: (PatientBrief & { unidentified: boolean }) | null;
}
interface Doctor {
  id: string;
  name: string;
}

/** ESI colours follow the common triage convention: 1 red … 5 blue. */
const ESI = ['', 'bg-crit text-white', 'bg-[#d2611d] text-white', 'bg-[#b8950a] text-white', 'bg-ok text-white', 'bg-info text-white'];

export default function EmergencyPage() {
  const { me } = useMe();
  const { t } = useLang();
  const [rows, setRows] = useState<Row[]>([]);
  const [meta, setMeta] = useState<{ byEsi: number[]; untriaged: number }>({ byEsi: [0, 0, 0, 0, 0], untriaged: 0 });
  const [arr, setArr] = useState({ q: '', mode: 'walk-in', complaint: '', sex: 'unknown', age: '30', description: '' });
  const [found, setFound] = useState<PatientBrief[]>([]);
  const [dispo, setDispo] = useState<{ id: string; disposition: string; note: string; attendingId: string; reason: string } | null>(null);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const load = useAction();
  const act = useAction();
  const { guarded, dialog } = useReauth();
  const clinician = canDo(me, 'er', 'S');

  const refresh = useCallback(async () => {
    await load.run(async () => {
      const r = await fetch('/api/v1/emergency/board', { credentials: 'same-origin' }).then((x) => x.json());
      setRows(r.data ?? []);
      if (r.meta) setMeta(r.meta);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    void refresh();
    const iv = setInterval(() => void refresh(), 30_000);
    // Only clinicians choose an admitting doctor; don't make calls other roles are refused.
    if (clinician) api<Doctor[]>('/appointments/providers').then(setDoctors).catch(() => {});
    return () => clearInterval(iv);
  }, [refresh, clinician]);

  const run = async (fn: () => Promise<unknown>) => {
    if ((await act.run(fn)) !== undefined) await refresh();
  };

  async function arrive(patientId?: string) {
    await run(async () => {
      const r = await api('/emergency/arrivals', {
        body: patientId
          ? { patientId, mode: arr.mode, complaint: arr.complaint }
          : { unknown: { sexAtBirth: arr.sex, estimatedAge: Number(arr.age), description: arr.description }, mode: arr.mode, complaint: arr.complaint },
      });
      setArr({ ...arr, q: '', complaint: '', description: '' });
      setFound([]);
      return r;
    });
  }

  return (
    <>
      {dialog}
      <PageHeader title={t('Emergency', 'Gurmadka')}>
        {t('Live board, most urgent first.', 'Liiska tooska ah, kan ugu degdegsan marka hore.')}
      </PageHeader>
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
        {[1, 2, 3, 4, 5].map((n) => (
          <div key={n} className="card flex items-center gap-3 p-3">
            <span className={`grid h-9 w-9 place-items-center rounded-lg font-display text-lg font-bold ${ESI[n]}`}>{n}</span>
            <span className="num font-display text-2xl font-semibold">{meta.byEsi[n - 1]}</span>
          </div>
        ))}
        <div className="card flex items-center gap-3 p-3">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-surface-3 font-display text-lg font-bold">?</span>
          <span className="num font-display text-2xl font-semibold">{meta.untriaged}</span>
        </div>
      </div>
      <ErrorNote error={load.error ?? act.error} />

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card title={`${t('Tracking board', 'Shaxda')} · ${rows.length}`}>
          <ul className="grid">
            {rows.map((r) => (
              <li key={r.id} className="grid gap-2 border-t border-line px-4 py-3 first:border-t-0">
                <div className="flex flex-wrap items-center gap-3">
                  <span className={`grid h-9 w-9 flex-none place-items-center rounded-lg font-display text-lg font-bold ${r.esi ? ESI[r.esi] : 'bg-surface-3'}`}>{r.esi ?? '?'}</span>
                  <div className="min-w-0 flex-1">
                    <b className="block truncate">{r.patient ? fullName(r.patient.names) : '—'}</b>
                    <span className="text-[12.5px] text-ink-2">
                      {r.complaint} · {r.mode} · <span className="font-mono">{r.patient?.mrn}</span>
                    </span>
                  </div>
                  <Pill tone={r.state === 'Treating' ? 'acc' : r.state === 'Triaged' ? 'info' : 'warn'}>{r.state}</Pill>
                  <span className={`num font-mono text-sm ${r.waitingMinutes > 60 ? 'text-crit' : 'text-ink-2'}`}>{r.waitingMinutes}′</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button
                      key={n}
                      className={`h-7 w-8 rounded-md border text-xs font-bold ${r.esi === n ? ESI[n] : 'border-line-2'}`}
                      onClick={() => {
                        if (r.esi === n) return;
                        const overrideReason = r.esi ? window.prompt?.(`Reason for changing ESI ${r.esi} → ${n}`) : undefined;
                        void run(() => api(`/emergency/${r.id}/triage`, { body: { esi: n, ...(overrideReason ? { overrideReason } : {}) } }));
                      }}
                      aria-label={`Triage ESI ${n}`}
                    >
                      {n}
                    </button>
                  ))}
                  {clinician && r.state !== 'Treating' ? (
                    <button className="btn btn-primary h-7 px-2.5 text-xs" onClick={() => run(() => api(`/emergency/${r.id}/take`, { body: {} }))}>
                      {t('Take patient', 'Qaado bukaanka')}
                    </button>
                  ) : null}
                  <Link className="btn h-7 px-2.5 text-xs" href={`/encounters/${r.id}`}>
                    {t('Notes & vitals', 'Qoraallo')}
                  </Link>
                  {clinician ? (
                    <button className="btn h-7 px-2.5 text-xs" onClick={() => setDispo({ id: r.id, disposition: 'discharged', note: '', attendingId: doctors[0]?.id ?? '', reason: '' })}>
                      {t('Disposition', 'Go’aanka')}
                    </button>
                  ) : null}
                </div>
                {dispo?.id === r.id ? (
                  <form
                    className="grid gap-2 rounded-[10px] bg-surface-2 p-3"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void run(async () => {
                        const res = await guarded(() =>
                          api(`/emergency/${r.id}/disposition`, {
                            body: { disposition: dispo.disposition, note: dispo.note, ...(dispo.disposition === 'admitted' ? { admission: { attendingId: dispo.attendingId, reason: dispo.reason } } : {}) },
                          }),
                        );
                        setDispo(null);
                        return res;
                      });
                    }}
                  >
                    <select className="input h-9" value={dispo.disposition} onChange={(e) => setDispo({ ...dispo, disposition: e.target.value })} aria-label="Disposition">
                      {['discharged', 'admitted', 'transferred', 'left-without-being-seen', 'deceased'].map((d) => (
                        <option key={d}>{d}</option>
                      ))}
                    </select>
                    {dispo.disposition === 'admitted' ? (
                      <div className="grid grid-cols-2 gap-2">
                        <select className="input h-9" value={dispo.attendingId} onChange={(e) => setDispo({ ...dispo, attendingId: e.target.value })} aria-label="Admitting doctor">
                          {doctors.map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.name}
                            </option>
                          ))}
                        </select>
                        <input className="input h-9" required placeholder={t('Reason for admission', 'Sababta')} value={dispo.reason} onChange={(e) => setDispo({ ...dispo, reason: e.target.value })} />
                      </div>
                    ) : null}
                    <textarea className="input min-h-20 py-2" required minLength={10} placeholder={t('Disposition note (signed)', 'Qoraal')} value={dispo.note} onChange={(e) => setDispo({ ...dispo, note: e.target.value })} />
                    <span className="flex gap-2">
                      <button className="btn btn-primary h-8 text-xs">{t('Sign and close visit', 'Saxiix')}</button>
                      <button type="button" className="btn h-8 text-xs" onClick={() => setDispo(null)}>
                        {t('Cancel', 'Jooji')}
                      </button>
                    </span>
                  </form>
                ) : null}
              </li>
            ))}
            {!rows.length ? <li className="px-4 pb-4 text-[13px] text-ink-3">{t('Nobody in the department.', 'Qof ma joogo.')}</li> : null}
          </ul>
        </Card>

        {canDo(me, 'er', 'E') ? (
          <Card title={t('New arrival', 'Imaatin cusub')}>
            <div className="grid gap-3 px-4 pb-4">
              <div className="grid grid-cols-2 gap-2">
                <Field label={t('Arrived by', 'Ku yimid')}>
                  <select className="input h-9" value={arr.mode} onChange={(e) => setArr({ ...arr, mode: e.target.value })}>
                    {['walk-in', 'ambulance', 'police', 'referral'].map((m) => (
                      <option key={m}>{m}</option>
                    ))}
                  </select>
                </Field>
                <Field label={t('Complaint', 'Cabashada')}>
                  <input className="input h-9" required value={arr.complaint} onChange={(e) => setArr({ ...arr, complaint: e.target.value })} />
                </Field>
              </div>
              <form
                className="grid gap-2"
                onSubmit={async (e) => {
                  e.preventDefault();
                  setFound(await api<PatientBrief[]>(`/patients?q=${encodeURIComponent(arr.q)}`).catch(() => []));
                }}
              >
                <Field label={t('Registered patient', 'Bukaan diiwaangashan')}>
                  <input className="input h-9" value={arr.q} onChange={(e) => setArr({ ...arr, q: e.target.value })} placeholder={t('Name, MRN or phone', 'Magac, MRN, telefoon')} />
                </Field>
                {found.map((p) => (
                  <button key={p.id} type="button" disabled={!arr.complaint} onClick={() => arrive(p.id)} className="flex items-center justify-between rounded-lg border border-line p-2 text-left hover:border-accent disabled:opacity-50">
                    <span>
                      <b className="block text-[13px]">{fullName(p.names)}</b>
                      <span className="font-mono text-[11.5px] text-ink-3">{p.mrn}</span>
                    </span>
                    <UserPlus size={16} className="text-accent-2" />
                  </button>
                ))}
              </form>
              <div className="grid gap-2 rounded-[10px] border border-dashed border-line-2 p-3">
                <b className="text-[13px]">{t('Unidentified patient', 'Bukaan aan la aqoon')}</b>
                <div className="grid grid-cols-2 gap-2">
                  <select className="input h-9" value={arr.sex} onChange={(e) => setArr({ ...arr, sex: e.target.value })} aria-label="Sex">
                    <option value="female">female</option>
                    <option value="male">male</option>
                    <option value="unknown">unknown</option>
                  </select>
                  <input className="input h-9" type="number" min={0} max={120} value={arr.age} onChange={(e) => setArr({ ...arr, age: e.target.value })} aria-label="Estimated age" />
                </div>
                <input className="input h-9" placeholder={t('Description (clothing, circumstances)', 'Sharaxaad')} value={arr.description} onChange={(e) => setArr({ ...arr, description: e.target.value })} />
                <button className="btn btn-primary justify-self-start" disabled={!arr.complaint || arr.description.length < 3} onClick={() => arrive()}>
                  <Siren size={16} />
                  {t('Register arrival', 'Diiwaangeli')}
                </button>
              </div>
            </div>
          </Card>
        ) : null}
      </div>
    </>
  );
}
