'use client';

import { useCallback, useEffect, useState } from 'react';
import { MODULES, MODULE_GROUPS, type ModuleGroup } from '@fahan/policy';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { canDo, useMe } from '@/lib/session';
import { useReauth } from './Reauth';
import { fmtDateTime } from './Dialog';
import { Card, ErrorNote, Field, fieldErrors, useAction } from './ui';

interface Settings {
  profile: { displayName: string; phone: string | null; address: string | null; currency: 'USD' | 'SOS'; receiptFooter: string | null };
  disabled: string[];
  alwaysOn: string[];
  history: { at: string; byName: string; disabled: string[]; reason: string }[];
}

/** Hospital profile and the module switchboard (spec §3.3). */
export function HospitalSettings({ tab }: { tab: 'profile' | 'modules' }) {
  const { me, refresh: refreshMe } = useMe();
  const { t, lang } = useLang();
  const [s, setS] = useState<Settings | null>(null);
  const [p, setP] = useState({ displayName: '', phone: '', address: '', currency: 'USD', receiptFooter: '' });
  const [off, setOff] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [saved, setSaved] = useState(false);
  const act = useAction();
  const { guarded, dialog } = useReauth();
  const fe = fieldErrors(act.error);

  const load = useCallback(async () => {
    const d = await api<Settings>('/settings');
    setS(d);
    setP({ displayName: d.profile.displayName ?? '', phone: d.profile.phone ?? '', address: d.profile.address ?? '', currency: d.profile.currency, receiptFooter: d.profile.receiptFooter ?? '' });
    setOff(d.disabled);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (!s) return null;

  if (tab === 'profile') {
    const canEdit = canDo(me, 'org', 'E');
    return (
      <Card title={t('Hospital profile', 'Xogta isbitaalka')}>
        <form
          className="grid max-w-[640px] gap-3 px-4 pb-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setSaved(false);
            const body = { displayName: p.displayName, currency: p.currency, ...(p.phone ? { phone: p.phone } : {}), ...(p.address ? { address: p.address } : {}), ...(p.receiptFooter ? { receiptFooter: p.receiptFooter } : {}) };
            if (await act.run(() => api('/settings/profile', { method: 'PUT', body }))) {
              setSaved(true);
              await load();
            }
          }}
        >
          <Field label={t('Name shown on reports and receipts', 'Magaca warbixinnada iyo rasiidhada')} error={fe.displayName}>
            <input className="input" required disabled={!canEdit} value={p.displayName} onChange={(e) => setP({ ...p, displayName: e.target.value })} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('Phone', 'Telefoon')}>
              <input className="input" disabled={!canEdit} value={p.phone} onChange={(e) => setP({ ...p, phone: e.target.value })} />
            </Field>
            <Field label={t('Main currency', 'Lacagta ugu weyn')}>
              <select className="input" disabled={!canEdit} value={p.currency} onChange={(e) => setP({ ...p, currency: e.target.value })}>
                <option value="USD">US dollar (USD)</option>
                <option value="SOS">Somali shilling (SOS)</option>
              </select>
            </Field>
          </div>
          <Field label={t('Address', 'Cinwaanka')}>
            <input className="input" disabled={!canEdit} value={p.address} onChange={(e) => setP({ ...p, address: e.target.value })} />
          </Field>
          <Field label={t('Line printed at the bottom of receipts', 'Qoraalka hoose ee rasiidhada')}>
            <input className="input" disabled={!canEdit} value={p.receiptFooter} onChange={(e) => setP({ ...p, receiptFooter: e.target.value })} placeholder={t('e.g. Thank you. Get well soon.', 'tus. Mahadsanid. Caafimaad.')} />
          </Field>
          {Object.keys(fe).length ? null : <ErrorNote error={act.error} />}
          {canEdit ? (
            <div className="flex items-center gap-3">
              <button className="btn btn-primary" disabled={act.busy}>
                {t('Save', 'Kaydi')}
              </button>
              {saved ? <span className="text-[13px] text-ok">{t('Saved', 'Waa la kaydiyay')}</span> : null}
            </div>
          ) : null}
        </form>
      </Card>
    );
  }

  const canSwitch = canDo(me, 'org', 'A');
  const changed = off.slice().sort().join() !== s.disabled.slice().sort().join();
  const groups = (Object.keys(MODULE_GROUPS) as ModuleGroup[]).filter((g) => g !== 'platform');
  return (
    <>
      {dialog}
      <Card title={t('Modules in use', 'Qaybaha la isticmaalo')}>
        <p className="px-4 text-[13px] text-ink-3">{t('Switch off what this hospital does not offer. Staff stop seeing it and the system refuses it straight away. Records already kept stay safe.', 'Dami waxa isbitaalkani aanu bixin. Shaqaaluhu ma arkayaan, nidaamkuna wuu diidaa isla markiiba. Diiwaannada hore way badbaadsan yihiin.')}</p>
        <div className="grid gap-4 p-4 md:grid-cols-2 xl:grid-cols-3">
          {groups.map((g) => (
            <div key={g}>
              <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-ink-3">{lang === 'so' ? MODULE_GROUPS[g].so : MODULE_GROUPS[g].en}</span>
              <ul className="grid gap-1">
                {MODULES.filter((m) => m.group === g).map((m) => {
                  const locked = s.alwaysOn.includes(m.key);
                  const on = !off.includes(m.key);
                  return (
                    <li key={m.key}>
                      <label className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-[13px] ${on ? 'border-line' : 'border-dashed border-line-2 text-ink-3'}`}>
                        <span>{lang === 'so' ? m.so : m.name}</span>
                        <input
                          type="checkbox"
                          role="switch"
                          aria-checked={on}
                          className="h-4 w-4 accent-[rgb(var(--accent))]"
                          checked={on}
                          disabled={locked || !canSwitch}
                          onChange={(e) => setOff(e.target.checked ? off.filter((x) => x !== m.key) : [...off, m.key])}
                        />
                      </label>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
        {canSwitch && changed ? (
          <div className="flex flex-wrap items-end gap-2 border-t border-line px-4 py-3">
            <Field label={t('Why this change?', 'Maxaa loo beddelay?')}>
              <input className="input w-[min(420px,80vw)]" value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <button
              className="btn btn-primary"
              disabled={reason.trim().length < 3 || act.busy}
              onClick={async () => {
                if (await act.run(() => guarded(() => api('/settings/features', { method: 'PUT', body: { disabled: off, reason } })))) {
                  setReason('');
                  await load();
                  await refreshMe();
                }
              }}
            >
              {t('Apply', 'Dhaqangeli')}
            </button>
            <button className="btn" onClick={() => setOff(s.disabled)}>
              {t('Undo', 'Ka noqo')}
            </button>
          </div>
        ) : null}
        <div className="px-4 pb-3">
          <ErrorNote error={act.error} />
        </div>
      </Card>
      {s.history.length ? (
        <Card title={t('Changes', 'Isbeddellada')}>
          <ul className="px-4 pb-3 text-[13px]">
            {[...s.history].reverse().map((h, i) => (
              <li key={i} className="border-t border-line py-2 first:border-t-0">
                <b>{h.byName}</b> <span className="text-ink-3">· {fmtDateTime(h.at, lang)}</span>
                <p className="text-ink-2">
                  {h.disabled.length ? `${t('Off', 'Dansan')}: ${h.disabled.map((k) => MODULES.find((m) => m.key === k)?.[lang === 'so' ? 'so' : 'name'] ?? k).join(', ')}` : t('Everything on', 'Dhammaan way shidan yihiin')} — {h.reason}
                </p>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </>
  );
}
