'use client';

import { useState } from 'react';
import { Send } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { CATEGORY, SEVERITY } from '@/lib/quality';
import { ErrorNote, Field, fieldErrors, useAction } from './ui';

const nowLocal = () => {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

/** Short incident report any member of staff can fill in. */
export function IncidentForm({ onDone }: { onDone: (r: { number: string }) => void }) {
  const { t, lang } = useLang();
  const empty = { category: 'fall', severity: 'no-harm', occurredAt: nowLocal(), location: '', description: '', immediateAction: '', patientMrn: '' };
  const [f, setF] = useState(empty);
  const act = useAction();
  const fe = fieldErrors(act.error);
  const set = (k: keyof typeof empty) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const r = await act.run(() =>
      api<{ number: string }>('/quality/incidents', {
        body: {
          category: f.category,
          severity: f.severity,
          occurredAt: new Date(f.occurredAt).toISOString(),
          location: f.location,
          description: f.description,
          ...(f.immediateAction ? { immediateAction: f.immediateAction } : {}),
          ...(f.patientMrn ? { patientMrn: f.patientMrn } : {}),
        },
      }),
    );
    if (r) {
      setF({ ...empty, occurredAt: nowLocal() });
      onDone(r);
    }
  }

  return (
    <form className="grid gap-3" onSubmit={submit}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('What kind of event?', 'Nooca dhacdada')}>
          <select className="input" value={f.category} onChange={set('category')}>
            {Object.entries(CATEGORY).map(([k, v]) => (
              <option key={k} value={k}>
                {lang === 'so' ? v[1] : v[0]}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('Harm to the patient', 'Dhaawaca bukaanka')}>
          <select className="input" value={f.severity} onChange={set('severity')}>
            {Object.entries(SEVERITY).map(([k, v]) => (
              <option key={k} value={k}>
                {lang === 'so' ? v[1] : v[0]}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('When', 'Goorma')} error={fe.occurredAt}>
          <input className="input" type="datetime-local" required value={f.occurredAt} onChange={set('occurredAt')} />
        </Field>
        <Field label={t('Where', 'Halkee')} error={fe.location}>
          <input className="input" required value={f.location} onChange={set('location')} placeholder={t('e.g. Ward 3B, bed 4', 'tus. Qolka 3B, sariirta 4')} />
        </Field>
      </div>
      <Field label={t('What happened?', 'Maxaa dhacay?')} error={fe.description}>
        <textarea className="input h-28 py-2" required minLength={10} value={f.description} onChange={set('description')} />
      </Field>
      <Field label={t('What was done straight away? (optional)', 'Maxaa isla markiiba la sameeyay? (ikhtiyaari)')}>
        <textarea className="input h-20 py-2" value={f.immediateAction} onChange={set('immediateAction')} />
      </Field>
      <Field label={t('Patient MRN, if a patient was involved (optional)', 'MRN-ka bukaanka haddii uu ku lug lahaa (ikhtiyaari)')} error={fe.patientMrn}>
        <input className="input font-mono" value={f.patientMrn} onChange={set('patientMrn')} placeholder="MGD-26-000001" />
      </Field>
      {Object.keys(fe).length ? null : <ErrorNote error={act.error} />}
      <button className="btn btn-primary justify-self-start" disabled={act.busy}>
        <Send size={16} />
        {t('Send report', 'Dir warbixinta')}
      </button>
    </form>
  );
}
