'use client';

import { useCallback, useEffect, useState } from 'react';
import { Droplet } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { canDo, useMe } from '@/lib/session';
import { ErrorNote, Pill, useAction } from './ui';

interface Req {
  id: string;
  component: string;
  units: number;
  indication: string;
  urgency: string;
  status: string;
  recipientGroup?: string;
  issuedUnits?: { id: string; unitNumber: string; group: string }[];
}

const COMPONENTS: [string, string, string][] = [
  ['red-cells', 'Red cells', 'Unugyada cas'],
  ['plasma', 'Plasma', 'Balasma'],
  ['platelets', 'Platelets', 'Platelets'],
  ['cryo', 'Cryoprecipitate', 'Cryo'],
  ['whole-blood', 'Whole blood', 'Dhiig dhan'],
];

/** Blood inside a visit: request units, and give an issued unit at the bedside with a second checker. */
export function BloodOrders({ encounterId, closed }: { encounterId: string; closed: boolean }) {
  const { me } = useMe();
  const { t, lang } = useLang();
  const [list, setList] = useState<Req[]>([]);
  const [f, setF] = useState({ component: 'red-cells', units: 1, indication: '', urgency: 'routine' });
  const [staff, setStaff] = useState<{ id: string; name: string }[]>([]);
  const [give, setGive] = useState<Record<string, { unitId: string; checkedBy: string; reaction: string }>>({});
  const act = useAction();
  const load = useCallback(() => api<Req[]>(`/bloodbank/requests?encounterId=${encounterId}`).then(setList), [encounterId]);
  useEffect(() => {
    void load().catch(() => {});
    api<{ id: string; name: string }[]>('/lookup/clinical-staff').then((s) => setStaff(s.filter((x) => x.id !== me.id))).catch(() => {});
  }, [load, me.id]);
  const run = async (fn: () => Promise<unknown>) => {
    if ((await act.run(fn)) !== undefined) await load();
  };
  const canRequest = canDo(me, 'bb', 'E') && !closed;

  if (!list.length && !canRequest) return null;
  return (
    <section className="grid gap-1.5">
      <b className="flex items-center gap-2">
        <Droplet size={15} />
        {t('Blood', 'Dhiig')}
      </b>
      {list.map((r) => (
        <div key={r.id} className="grid gap-1.5 rounded-lg border border-line p-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">
              {r.units} × {COMPONENTS.find((c) => c[0] === r.component)?.[lang === 'so' ? 2 : 1] ?? r.component}
            </span>
            {r.recipientGroup ? <span className="rounded bg-surface-2 px-1.5 font-mono text-xs">{r.recipientGroup}</span> : null}
            <Pill tone={r.status === 'Transfused' ? 'ok' : r.status === 'Issued' ? 'acc' : 'info'}>{r.status}</Pill>
            <span className="text-ink-3">{r.indication}</span>
          </div>
          {r.status === 'Issued' && (r.issuedUnits ?? []).length && canDo(me, 'nur', 'E') ? (
            <div className="grid gap-1.5 rounded-md bg-surface-2/60 p-2">
              <b className="text-[12.5px]">{t('Bedside check before giving', 'Hubinta sariirta ka hor')}</b>
              <div className="grid gap-1.5 sm:grid-cols-3">
                <select className="input h-8 text-xs" value={give[r.id]?.unitId ?? ''} onChange={(e) => setGive({ ...give, [r.id]: { checkedBy: give[r.id]?.checkedBy ?? '', reaction: give[r.id]?.reaction ?? 'none', unitId: e.target.value } })} aria-label={t('Unit', 'Unug')}>
                  <option value="">{t('Unit…', 'Unug…')}</option>
                  {(r.issuedUnits ?? []).map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.unitNumber} · {u.group}
                    </option>
                  ))}
                </select>
                <select className="input h-8 text-xs" value={give[r.id]?.checkedBy ?? ''} onChange={(e) => setGive({ ...give, [r.id]: { unitId: give[r.id]?.unitId ?? '', reaction: give[r.id]?.reaction ?? 'none', checkedBy: e.target.value } })} aria-label={t('Second checker', 'Hubiyaha labaad')}>
                  <option value="">{t('Second checker…', 'Hubiyaha labaad…')}</option>
                  {staff.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <select className="input h-8 text-xs" value={give[r.id]?.reaction ?? 'none'} onChange={(e) => setGive({ ...give, [r.id]: { unitId: give[r.id]?.unitId ?? '', checkedBy: give[r.id]?.checkedBy ?? '', reaction: e.target.value } })} aria-label={t('Reaction', 'Falcelin')}>
                  <option value="none">{t('No reaction', 'Falcelin ma jirto')}</option>
                  <option value="mild">{t('Mild reaction', 'Falcelin fudud')}</option>
                  <option value="severe">{t('Severe reaction', 'Falcelin daran')}</option>
                </select>
              </div>
              <button className="btn btn-primary h-7 justify-self-start px-2.5 text-xs" disabled={!give[r.id]?.unitId || !give[r.id]?.checkedBy || act.busy} onClick={() => run(() => api(`/bloodbank/requests/${r.id}/administer`, { body: give[r.id] }))}>
                {t('Unit given', 'Waa la siiyay')}
              </button>
            </div>
          ) : null}
        </div>
      ))}
      {canRequest ? (
        <form
          className="grid gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const r = await api('/bloodbank/requests', { body: { encounterId, ...f } });
              setF({ ...f, indication: '' });
              return r;
            });
          }}
        >
          <div className="grid grid-cols-[1.4fr_70px_1fr] gap-1.5">
            <select className="input h-8 text-xs" value={f.component} onChange={(e) => setF({ ...f, component: e.target.value })} aria-label={t('Component', 'Nooca')}>
              {COMPONENTS.map(([k, en, so]) => (
                <option key={k} value={k}>
                  {lang === 'so' ? so : en}
                </option>
              ))}
            </select>
            <input className="input h-8 text-xs" type="number" min={1} max={10} value={f.units} onChange={(e) => setF({ ...f, units: Number(e.target.value) })} aria-label={t('Units', 'Unugyo')} />
            <select className="input h-8 text-xs" value={f.urgency} onChange={(e) => setF({ ...f, urgency: e.target.value })} aria-label={t('Urgency', 'Degdegga')}>
              <option value="routine">{t('Routine', 'Caadi')}</option>
              <option value="urgent">{t('Urgent', 'Degdeg')}</option>
              <option value="emergency">{t('Emergency', 'Gurmad')}</option>
            </select>
          </div>
          <input className="input h-8 text-xs" required minLength={5} placeholder={t('Why: e.g. Hb 6.1 with bleeding', 'Sababta: tus. Hb 6.1 dhiig bax')} value={f.indication} onChange={(e) => setF({ ...f, indication: e.target.value })} />
          <button className="btn h-7 justify-self-start px-2.5 text-xs" disabled={act.busy}>
            {t('Request blood', 'Codso dhiig')}
          </button>
        </form>
      ) : null}
      <ErrorNote error={act.error} />
    </section>
  );
}
