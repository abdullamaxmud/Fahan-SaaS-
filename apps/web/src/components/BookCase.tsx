'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import type { PatientBrief } from './clinical';
import { Drawer } from './Dialog';
import { PatientPicker } from './PatientPicker';
import { ErrorNote, Field, fieldErrors, useAction } from './ui';

interface Team {
  surgeons: { id: string; name: string }[];
  anesthetists: { id: string; name: string }[];
}

/** Booking a theatre case: the API refuses clashes of room or surgeon and out-of-service theatres. */
export function BookCase({ date, theatres, onClose, onDone }: { date: string; theatres: { id: string; code: string; name: string; status: string }[]; onClose: () => void; onDone: () => Promise<void> }) {
  const { t } = useLang();
  const [patient, setPatient] = useState<PatientBrief | null>(null);
  const [team, setTeam] = useState<Team>({ surgeons: [], anesthetists: [] });
  const [f, setF] = useState({ procedure: '', side: 'not-applicable', surgeonId: '', anesthetistId: '', theatreId: theatres.find((x) => x.status === 'Available')?.id ?? '', date, time: '09:00', minutes: 60 });
  const act = useAction();
  const fe = fieldErrors(act.error);
  useEffect(() => {
    api<Team>('/surgery/team')
      .then((d) => {
        setTeam(d);
        setF((x) => ({ ...x, surgeonId: x.surgeonId || d.surgeons[0]?.id || '' }));
      })
      .catch(() => {});
  }, []);
  return (
    <Drawer title={t('Book a case', 'Qabso qalliin')} onClose={onClose} wide>
      <form
        className="grid gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!patient) return;
          const startsAt = new Date(`${f.date}T${f.time}:00+03:00`).toISOString();
          const body = { patientId: patient.id, procedure: f.procedure, side: f.side, surgeonId: f.surgeonId, theatreId: f.theatreId, startsAt, minutes: f.minutes, ...(f.anesthetistId ? { anesthetistId: f.anesthetistId } : {}) };
          if (await act.run(() => api('/surgery/cases', { body }))) await onDone();
        }}
      >
        <Field label={t('Patient', 'Bukaanka')} error={fe.patientId}>
          <PatientPicker value={patient} onChange={setPatient} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-[1fr_180px]">
          <Field label={t('Operation', 'Qalliinka')} error={fe.procedure}>
            <input className="input" required minLength={3} value={f.procedure} onChange={(e) => setF({ ...f, procedure: e.target.value })} placeholder={t('e.g. Laparoscopic appendicectomy', 'tus. Qalliinka xiidmaha')} />
          </Field>
          <Field label={t('Side', 'Dhinaca')}>
            <select className="input" value={f.side} onChange={(e) => setF({ ...f, side: e.target.value })}>
              <option value="not-applicable">{t('Not applicable', 'Ma khuseyso')}</option>
              <option value="left">{t('Left', 'Bidix')}</option>
              <option value="right">{t('Right', 'Midig')}</option>
              <option value="bilateral">{t('Both sides', 'Labada dhinac')}</option>
            </select>
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('Surgeon', 'Dhakhtarka qalliinka')} error={fe.surgeonId}>
            <select className="input" value={f.surgeonId} onChange={(e) => setF({ ...f, surgeonId: e.target.value })}>
              {team.surgeons.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('Anaesthetist', 'Dhakhtarka suuxdinta')} error={fe.anesthetistId}>
            <select className="input" value={f.anesthetistId} onChange={(e) => setF({ ...f, anesthetistId: e.target.value })}>
              <option value="">{t('Not yet chosen', 'Weli lama dooran')}</option>
              {team.anesthetists.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label={t('Theatre', 'Qolka')} error={fe.theatreId}>
            <select className="input" value={f.theatreId} onChange={(e) => setF({ ...f, theatreId: e.target.value })}>
              {theatres.map((x) => (
                <option key={x.id} value={x.id} disabled={x.status !== 'Available'}>
                  {x.code}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('Date', 'Taariikh')}>
            <input className="input" type="date" required value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
          </Field>
          <Field label={t('Start', 'Bilow')} error={fe.startsAt}>
            <input className="input" type="time" required value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} />
          </Field>
          <Field label={t('Minutes', 'Daqiiqo')} error={fe.minutes}>
            <input className="input" type="number" min={15} max={720} step={15} value={f.minutes} onChange={(e) => setF({ ...f, minutes: Number(e.target.value) })} />
          </Field>
        </div>
        {Object.keys(fe).length ? null : <ErrorNote error={act.error} />}
        <button className="btn btn-primary justify-self-start" disabled={act.busy || !patient}>
          {t('Book case', 'Qabso')}
        </button>
        <p className="text-[12.5px] text-ink-3">{t('Consent and the WHO safety checklist are completed on the case page before surgery starts.', 'Oggolaanshaha iyo liiska badbaadada WHO waxaa la buuxiyaa bogga kiiska ka hor qalliinka.')}</p>
      </form>
    </Drawer>
  );
}
