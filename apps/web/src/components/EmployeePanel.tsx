'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { money, toMinor } from '@/lib/money';
import { useReauth } from './Reauth';
import { Drawer, Facts } from './Dialog';
import { ErrorNote, Field, fieldErrors, useAction } from './ui';

export interface Emp {
  id: string;
  staffNumber: string;
  name: string;
  jobTitle: string;
  hireDate: string;
  salary?: { currency: string; baseMinor: number; allowancesMinor: number; deductionsMinor: number } | null;
}

const KINDS: [string, string, string][] = [
  ['medical-licence', 'Medical licence', 'Shatiga dhakhtarka'],
  ['nursing-licence', 'Nursing licence', 'Shatiga kalkaalinta'],
  ['pharmacy-licence', 'Pharmacy licence', 'Shatiga farmashiyaha'],
  ['midwifery-licence', 'Midwifery licence', 'Shatiga umulisada'],
  ['bls', 'Basic life support', 'BLS'],
  ['acls', 'Advanced life support', 'ACLS'],
  ['radiation-safety', 'Radiation safety', 'Badbaadada shucaaca'],
  ['other', 'Other', 'Kale'],
];

/** HR: one employee's licences and pay (pay changes need a fresh authenticator code). */
export function EmployeePanel({ e, onClose, onDone }: { e: Emp; onClose: () => void; onDone: () => Promise<void> }) {
  const { t, lang } = useLang();
  const [cred, setCred] = useState({ kind: 'medical-licence', number: '', issuer: '', expiresOn: '' });
  const [pay, setPay] = useState({ currency: e.salary?.currency ?? 'USD', base: e.salary ? String(e.salary.baseMinor / 100) : '', allowances: e.salary ? String(e.salary.allowancesMinor / 100) : '0', deductions: e.salary ? String(e.salary.deductionsMinor / 100) : '0' });
  const [ok, setOk] = useState('');
  const act = useAction();
  const fe = fieldErrors(act.error);
  const { guarded, dialog } = useReauth();

  return (
    <Drawer title={e.name} sub={`${e.jobTitle} · ${e.staffNumber}`} onClose={onClose}>
      {dialog}
      <div className="grid gap-5 text-[13px]">
        <Facts
          rows={[
            [t('Started', 'Bilaabay'), e.hireDate],
            [t('Monthly gross', 'Mushaharka'), e.salary ? money(e.salary.baseMinor + e.salary.allowancesMinor, e.salary.currency) : null],
          ]}
        />
        <form
          className="grid gap-2 rounded-xl border border-line p-3"
          onSubmit={async (ev) => {
            ev.preventDefault();
            setOk('');
            if (await act.run(() => api(`/hr/employees/${e.id}/credentials`, { body: cred }))) {
              setOk(t('Licence saved. You will be warned before it expires.', 'Shatiga waa la kaydiyay.'));
              setCred({ ...cred, number: '', issuer: '', expiresOn: '' });
              await onDone();
            }
          }}
        >
          <b>{t('Add a licence or certificate', 'Ku dar shatiga')}</b>
          <select className="input h-9" value={cred.kind} onChange={(ev) => setCred({ ...cred, kind: ev.target.value })} aria-label={t('Kind', 'Nooca')}>
            {KINDS.map(([k, en, so]) => (
              <option key={k} value={k}>
                {lang === 'so' ? so : en}
              </option>
            ))}
          </select>
          <div className="grid grid-cols-2 gap-2">
            <input className="input h-9" required placeholder={t('Number', 'Lambar')} value={cred.number} onChange={(ev) => setCred({ ...cred, number: ev.target.value })} />
            <input className="input h-9" type="date" required value={cred.expiresOn} onChange={(ev) => setCred({ ...cred, expiresOn: ev.target.value })} aria-label={t('Expires on', 'Wuxuu dhacayaa')} />
          </div>
          <input className="input h-9" required placeholder={t('Issued by, e.g. Somali Medical Council', 'Bixiyaha')} value={cred.issuer} onChange={(ev) => setCred({ ...cred, issuer: ev.target.value })} />
          <button className="btn justify-self-start" disabled={act.busy}>
            {t('Save licence', 'Kaydi')}
          </button>
        </form>

        <form
          className="grid gap-2 rounded-xl border border-line p-3"
          onSubmit={async (ev) => {
            ev.preventDefault();
            setOk('');
            const body = { currency: pay.currency, baseMinor: toMinor(pay.base), allowancesMinor: toMinor(pay.allowances || '0'), deductionsMinor: toMinor(pay.deductions || '0') };
            if ([body.baseMinor, body.allowancesMinor, body.deductionsMinor].some(Number.isNaN)) return act.setError(new Error(t('Enter amounts like 1200 or 1200.50', 'Geli lacag sida 1200')));
            if (await act.run(() => guarded(() => api(`/hr/employees/${e.id}/salary`, { body })))) {
              setOk(t('Pay changed. The previous pay is kept in the history.', 'Mushaharka waa la beddelay.'));
              await onDone();
            }
          }}
        >
          <b>{t('Change monthly pay', 'Beddel mushaharka')}</b>
          <div className="grid grid-cols-4 gap-2">
            <Field label={t('Currency', 'Lacagta')}>
              <select className="input h-9" value={pay.currency} onChange={(ev) => setPay({ ...pay, currency: ev.target.value })}>
                <option>USD</option>
                <option>SOS</option>
              </select>
            </Field>
            <Field label={t('Base', 'Asaas')} error={fe.baseMinor}>
              <input className="input h-9" inputMode="decimal" required value={pay.base} onChange={(ev) => setPay({ ...pay, base: ev.target.value })} />
            </Field>
            <Field label={t('Allowances', 'Gunno')}>
              <input className="input h-9" inputMode="decimal" value={pay.allowances} onChange={(ev) => setPay({ ...pay, allowances: ev.target.value })} />
            </Field>
            <Field label={t('Deductions', 'Goynta')}>
              <input className="input h-9" inputMode="decimal" value={pay.deductions} onChange={(ev) => setPay({ ...pay, deductions: ev.target.value })} />
            </Field>
          </div>
          <button className="btn justify-self-start" disabled={act.busy}>
            {t('Save pay', 'Kaydi')}
          </button>
        </form>
        {ok ? <p className="text-ok">{ok}</p> : null}
        {act.error instanceof Error && !('status' in act.error) ? <p className="text-crit">{act.error.message}</p> : <ErrorNote error={act.error} />}
      </div>
    </Drawer>
  );
}
