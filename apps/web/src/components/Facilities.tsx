'use client';

import { useCallback, useEffect, useState } from 'react';
import { Ambulance, Scissors } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { canDo, useMe } from '@/lib/session';
import { Card, ErrorNote, Pill, fieldErrors, useAction } from './ui';

interface Facilities {
  theatres: { id: string; code: string; name: string; status: string; branchId: string }[];
  vehicles: { id: string; code: string; kind: string; status: string; branchId: string }[];
}

/** Operating theatres and ambulances: added here by the people who set the hospital up. */
export function FacilitiesSetup() {
  const { me } = useMe();
  const { t } = useLang();
  const [d, setD] = useState<Facilities | null>(null);
  const [branches, setBranches] = useState<{ id: string; code: string; name: string }[]>([]);
  const [th, setTh] = useState({ branchId: me.branchId ?? '', code: '', name: '' });
  const [veh, setVeh] = useState({ branchId: me.branchId ?? '', code: '', kind: 'basic' });
  const act = useAction();
  const fe = fieldErrors(act.error);
  const canEdit = canDo(me, 'org', 'E');
  const load = useCallback(() => api<Facilities>('/facilities').then(setD), []);
  useEffect(() => {
    void load().catch(() => {});
    api<{ id: string; code: string; name: string }[]>('/lookup/branches')
      .then((b) => {
        setBranches(b);
        setTh((x) => ({ ...x, branchId: x.branchId || b[0]?.id || '' }));
        setVeh((x) => ({ ...x, branchId: x.branchId || b[0]?.id || '' }));
      })
      .catch(() => {});
  }, [load]);
  const code = (id: string) => branches.find((b) => b.id === id)?.code ?? '';
  const branchSelect = (value: string, onChange: (v: string) => void) =>
    branches.length > 1 ? (
      <select className="input h-9 w-auto" value={value} onChange={(e) => onChange(e.target.value)} aria-label={t('Branch', 'Laanta')}>
        {branches.map((b) => (
          <option key={b.id} value={b.id}>
            {b.code}
          </option>
        ))}
      </select>
    ) : null;

  return (
    <div className="grid items-start gap-4 lg:grid-cols-2">
      <Card title={t('Operating theatres', 'Qolalka qalliinka')}>
        <ul className="px-4 text-[13px]">
          {d?.theatres.map((x) => (
            <li key={x.id} className="flex items-center gap-2 border-t border-line py-2 first:border-t-0">
              <Scissors size={15} className="text-ink-3" />
              <b className="font-mono">{x.code}</b>
              <span className="flex-1">{x.name}</span>
              <span className="font-mono text-xs text-ink-3">{code(x.branchId)}</span>
              <Pill tone={x.status === 'Available' ? 'ok' : 'crit'}>{x.status === 'Available' ? t('In use', 'Shaqaynaya') : t('Out of service', 'Ma shaqaynayo')}</Pill>
            </li>
          ))}
          {d && !d.theatres.length ? <li className="py-2 text-ink-3">{t('No theatres yet.', 'Weli qol qalliin ma jiro.')}</li> : null}
        </ul>
        {canEdit ? (
          <form
            className="flex flex-wrap gap-2 p-4"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await act.run(() => api('/surgery/theatres', { body: th }))) {
                setTh({ ...th, code: '', name: '' });
                await load();
              }
            }}
          >
            {branchSelect(th.branchId, (v) => setTh({ ...th, branchId: v }))}
            <input className="input h-9 w-24 font-mono uppercase" required placeholder="OT-3" value={th.code} onChange={(e) => setTh({ ...th, code: e.target.value })} aria-label={t('Code', 'Koodh')} />
            <input className="input h-9 min-w-0 flex-1" required placeholder={t('Name, e.g. Main theatre 3', 'Magaca')} value={th.name} onChange={(e) => setTh({ ...th, name: e.target.value })} aria-label={t('Name', 'Magaca')} />
            <button className="btn h-9" disabled={act.busy}>
              {t('Add theatre', 'Ku dar')}
            </button>
          </form>
        ) : null}
      </Card>
      <Card title={t('Ambulances', 'Ambalaasyada')}>
        <ul className="px-4 text-[13px]">
          {d?.vehicles.map((x) => (
            <li key={x.id} className="flex items-center gap-2 border-t border-line py-2 first:border-t-0">
              <Ambulance size={15} className="text-ink-3" />
              <b className="flex-1 font-mono">{x.code}</b>
              <span className="text-ink-2">{x.kind === 'advanced' ? t('Advanced life support', 'Taageero heer sare') : x.kind === 'neonatal' ? t('Newborn', 'Dhallaan') : t('Basic', 'Caadi')}</span>
              <span className="font-mono text-xs text-ink-3">{code(x.branchId)}</span>
              <Pill tone={x.status === 'Available' ? 'ok' : x.status === 'OnRun' ? 'acc' : 'crit'}>{x.status === 'Available' ? t('Ready', 'Diyaar') : x.status === 'OnRun' ? t('On a run', 'Safar ku jira') : t('Out of service', 'Ma shaqaynayo')}</Pill>
            </li>
          ))}
          {d && !d.vehicles.length ? <li className="py-2 text-ink-3">{t('No ambulances yet.', 'Weli ambalaas ma jiro.')}</li> : null}
        </ul>
        {canEdit ? (
          <form
            className="flex flex-wrap gap-2 p-4"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await act.run(() => api('/ambulance/vehicles', { body: veh }))) {
                setVeh({ ...veh, code: '' });
                await load();
              }
            }}
          >
            {branchSelect(veh.branchId, (v) => setVeh({ ...veh, branchId: v }))}
            <input className="input h-9 w-28 font-mono uppercase" required placeholder="AMB-09" value={veh.code} onChange={(e) => setVeh({ ...veh, code: e.target.value })} aria-label={t('Code', 'Koodh')} />
            <select className="input h-9 w-auto" value={veh.kind} onChange={(e) => setVeh({ ...veh, kind: e.target.value })} aria-label={t('Type', 'Nooca')}>
              <option value="basic">{t('Basic', 'Caadi')}</option>
              <option value="advanced">{t('Advanced life support', 'Heer sare')}</option>
              <option value="neonatal">{t('Newborn', 'Dhallaan')}</option>
            </select>
            <button className="btn h-9" disabled={act.busy}>
              {t('Add ambulance', 'Ku dar')}
            </button>
          </form>
        ) : null}
      </Card>
      <div className="lg:col-span-2">
        <ErrorNote error={act.error} />
        {fe.code ? <p className="mt-1 text-[12.5px] text-crit">{fe.code}</p> : null}
      </div>
    </div>
  );
}
