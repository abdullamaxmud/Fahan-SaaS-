'use client';

import { useCallback, useEffect, useState } from 'react';
import { Wrench } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { canDo, useMe } from '@/lib/session';
import { Card, ErrorNote, PageHeader, Pill, useAction } from '@/components/ui';

interface Asset {
  id: string;
  code: string;
  name: string;
  kind: string;
  modality: string | null;
  status: string;
  nextCalibrationDue: string | null;
  usable: boolean;
  blockedReason: string | null;
}

export default function EquipmentPage() {
  const { me } = useMe();
  const { t } = useLang();
  const [list, setList] = useState<Asset[]>([]);
  const [reason, setReason] = useState<Record<string, string>>({});
  const load = useAction();
  const act = useAction();

  const refresh = useCallback(async () => {
    await load.run(async () => setList(await api<Asset[]>('/equipment/assets')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const run = async (fn: () => Promise<unknown>) => {
    if ((await act.run(fn)) !== undefined) await refresh();
  };

  return (
    <>
      <PageHeader title={t('Equipment', 'Qalabka')}>
        {t('Devices, maintenance and sterilisation.', 'Qalabka, dayactirka iyo nadiifinta.')}
      </PageHeader>
      <ErrorNote error={load.error ?? act.error} />
      <Card>
        <ul className="grid text-[13px]">
          {list.map((a) => (
            <li key={a.id} className="grid gap-2 border-t border-line px-4 py-3 first:border-t-0">
              <div className="flex flex-wrap items-center gap-2">
                <Wrench size={16} className="text-ink-3" />
                <b className="font-mono">{a.code}</b>
                <span>{a.name}</span>
                {a.modality ? <span className="rounded bg-surface-2 px-1.5 font-mono text-xs">{a.modality}</span> : null}
                <span className="ml-auto flex items-center gap-2">
                  {a.nextCalibrationDue ? <span className="text-xs text-ink-3">{t('calibration due', 'cabbir')} {a.nextCalibrationDue}</span> : null}
                  <Pill tone={a.usable ? 'ok' : 'crit'}>{a.usable ? a.status : t('Blocked', 'Xiran')}</Pill>
                </span>
              </div>
              {a.blockedReason ? <span className="text-crit">{a.blockedReason}</span> : null}
              <div className="flex flex-wrap gap-1.5">
                <input className="input h-8 min-w-0 flex-1 text-xs" placeholder={t('Reason', 'Sababta')} value={reason[a.id] ?? ''} onChange={(e) => setReason({ ...reason, [a.id]: e.target.value })} />
                {a.status !== 'OutOfService' && canDo(me, 'eq', 'E') ? (
                  <button className="btn h-8 text-xs" disabled={(reason[a.id] ?? '').length < 3} onClick={() => run(() => api(`/equipment/assets/${a.id}/out-of-service`, { body: { reason: reason[a.id] } }))}>
                    {t('Take out of service', 'Jooji')}
                  </button>
                ) : null}
                {a.status === 'OutOfService' && canDo(me, 'eq', 'A') ? (
                  <button className="btn btn-primary h-8 text-xs" disabled={(reason[a.id] ?? '').length < 3} onClick={() => run(() => api(`/equipment/assets/${a.id}/release`, { body: { reason: reason[a.id] } }))}>
                    {t('Return to service', 'Dib u shaqeysii')}
                  </button>
                ) : null}
              </div>
            </li>
          ))}
          {!list.length ? <li className="px-4 py-4 text-ink-3">{t('No equipment registered.', 'Qalab lama diiwaangelin.')}</li> : null}
        </ul>
      </Card>
    </>
  );
}
