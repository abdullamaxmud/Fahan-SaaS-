'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import type { PatientBrief } from './clinical';
import { PatientPicker } from './PatientPicker';
import { Card, ErrorNote, Field, useAction } from './ui';

const GROUPS = ['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+'];

/** Records a patient's blood group from one sample; two matching samples confirm it for crossmatch. */
export function BloodTyping() {
  const { t } = useLang();
  const [patient, setPatient] = useState<PatientBrief | null>(null);
  const [group, setGroup] = useState('O+');
  const [sampleRef, setSampleRef] = useState('');
  const [result, setResult] = useState<string | null | undefined>(undefined);
  const act = useAction();
  return (
    <Card title={t('Blood group of a patient', 'Kooxda dhiigga bukaanka')}>
      <form
        className="grid gap-2 px-4 pb-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!patient) return;
          const r = await act.run(() => api<{ confirmedGroup: string | null }>('/bloodbank/typing', { body: { patientId: patient.id, group, sampleRef } }));
          if (r) {
            setResult(r.confirmedGroup);
            setSampleRef('');
          }
        }}
      >
        <PatientPicker
          value={patient}
          onChange={(p) => {
            setPatient(p);
            setResult(undefined);
          }}
        />
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('Group found', 'Kooxda la helay')}>
            <select className="input h-9" value={group} onChange={(e) => setGroup(e.target.value)}>
              {GROUPS.map((g) => (
                <option key={g}>{g}</option>
              ))}
            </select>
          </Field>
          <Field label={t('Sample number', 'Lambarka muunadda')}>
            <input className="input h-9 font-mono" required minLength={3} value={sampleRef} onChange={(e) => setSampleRef(e.target.value)} />
          </Field>
        </div>
        <ErrorNote error={act.error} />
        <button className="btn btn-primary justify-self-start" disabled={act.busy || !patient}>
          {t('Record result', 'Kaydi natiijada')}
        </button>
        {result !== undefined ? (
          result ? (
            <p className="rounded-lg bg-ok-soft px-3 py-2 text-[13px] text-ok">{t(`Confirmed by two samples: ${result}. Crossmatch can go ahead.`, `Waa la xaqiijiyay laba muunad: ${result}.`)}</p>
          ) : (
            <p className="rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn">{t('Recorded. A second, separate sample is needed to confirm the group.', 'Waa la kaydiyay. Muunad labaad oo kale ayaa loo baahan yahay.')}</p>
          )
        ) : null}
      </form>
    </Card>
  );
}
