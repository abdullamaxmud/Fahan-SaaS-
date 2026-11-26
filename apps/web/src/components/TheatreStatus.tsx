'use client';

import { useCallback, useEffect, useState } from 'react';
import { Scissors } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { canDo, useMe } from '@/lib/session';
import { Card, ErrorNote, Pill, useAction } from './ui';

/** Operating theatres can be taken out of service (and back) by equipment staff; booked cases then cannot use them. */
export function TheatreStatus() {
  const { me } = useMe();
  const { t } = useLang();
  const [list, setList] = useState<{ id: string; code: string; name: string; status: string; statusReason: string | null }[]>([]);
  const act = useAction();
  const load = useCallback(() => api<typeof list>('/surgery/theatres').then(setList).catch(() => {}), []);
  useEffect(() => {
    void load();
  }, [load]);
  if (!list.length) return null;
  const set = async (id: string, status: 'Available' | 'OutOfService') => {
    const reason = window.prompt(status === 'OutOfService' ? t('Why is this theatre out of service?', 'Maxaa qolkan u joogsaday?') : t('What was fixed?', 'Maxaa la hagaajiyay?'));
    if (!reason || reason.trim().length < 3) return;
    if ((await act.run(() => api(`/surgery/theatres/${id}/status`, { body: { status, reason } }))) !== undefined) await load();
  };
  return (
    <Card title={t('Operating theatres', 'Qolalka qalliinka')}>
      <ul className="px-4 pb-2 text-[13px]">
        {list.map((x) => (
          <li key={x.id} className="flex flex-wrap items-center gap-2 border-t border-line py-2 first:border-t-0">
            <Scissors size={15} className="text-ink-3" />
            <b className="font-mono">{x.code}</b>
            <span className="flex-1">
              {x.name}
              {x.statusReason && x.status !== 'Available' ? <span className="block text-[12px] text-crit">{x.statusReason}</span> : null}
            </span>
            <Pill tone={x.status === 'Available' ? 'ok' : 'crit'}>{x.status === 'Available' ? t('In use', 'Shaqaynaya') : t('Out of service', 'Ma shaqaynayo')}</Pill>
            {canDo(me, 'eq', 'E') ? (
              <button className="btn h-7 px-2 text-xs" disabled={act.busy} onClick={() => set(x.id, x.status === 'Available' ? 'OutOfService' : 'Available')}>
                {x.status === 'Available' ? t('Take out of service', 'Jooji') : t('Return to service', 'Dib u shaqee')}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      <div className="px-4 pb-3">
        <ErrorNote error={act.error} />
      </div>
    </Card>
  );
}
