'use client';

import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, ShieldX } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { useMe } from '@/lib/session';
import { Card, ErrorNote, PageHeader, Pill, statusTone, useAction } from '@/components/ui';

interface AuditEvent {
  seq: number;
  occurredAt: string;
  actorId: string | null;
  actorRoles?: string[];
  action: string;
  resource: string;
  outcome: string;
  hash: string;
  meta: Record<string, unknown>;
}

export default function AuditPage() {
  const { me } = useMe();
  const { t } = useLang();
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [chain, setChain] = useState<{ ok: boolean; count: number; brokenAtSeq?: number } | null>(null);
  const load = useAction();
  const isPlatform = me.kind === 'platform';

  const refresh = useCallback(async () => {
    await load.run(async () => {
      if (isPlatform) {
        setChain(await api('/platform/audit/verify'));
        return;
      }
      const [ev, ch] = await Promise.all([api<AuditEvent[]>('/audit/events?limit=100'), api<typeof chain>('/audit/verify')]);
      setEvents(ev);
      setChain(ch);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlatform]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <>
      <PageHeader eyebrow="Spec §5.35" title={t('Audit trail', 'Raadraaca hubinta')}>
        {t('Every sign-in, change and refused request is written here. Each entry is chained to the one before it, so any edit or deletion is detected.', 'Dhacdo kasta halkan ayaa lagu qoraa.')}
      </PageHeader>
      <ErrorNote error={load.error} />
      {!isPlatform ? (
        <a className="btn self-start" href="/admin/break-glass">
          {t('Review emergency access', 'Eeg gelitaanka degdegga')}
        </a>
      ) : null}
      {chain ? (
        <div className={`flex items-center gap-3 rounded-[12px] p-3.5 text-[13.5px] ${chain.ok ? 'bg-ok-soft text-ok' : 'bg-crit-soft text-crit'}`}>
          {chain.ok ? <ShieldCheck size={20} /> : <ShieldX size={20} />}
          {chain.ok
            ? `${t('Chain verified', 'Silsiladda waa la xaqiijiyay')} · ${chain.count} ${t('events intact', 'dhacdo')}`
            : `${t('Chain broken at event', 'Silsiladdu way go’day')} #${chain.brokenAtSeq}. ${t('Escalate to the security lead.', 'U gudbi hogaamiyaha amniga.')}`}
        </div>
      ) : null}
      {!isPlatform ? (
        <Card title={t('Latest events', 'Dhacdooyinkii ugu dambeeyay')}>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className="th">#</th>
                  <th className="th">{t('Time', 'Waqtiga')}</th>
                  <th className="th">{t('Action', 'Ficilka')}</th>
                  <th className="th">{t('Resource', 'Kheyraadka')}</th>
                  <th className="th">{t('Roles', 'Doorarka')}</th>
                  <th className="th">{t('Outcome', 'Natiijada')}</th>
                  <th className="th">Hash</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.seq}>
                    <td className="td num font-mono text-xs text-ink-3">{e.seq}</td>
                    <td className="td num whitespace-nowrap text-xs">{new Date(e.occurredAt).toLocaleString()}</td>
                    <td className="td font-mono text-xs">{e.action}</td>
                    <td className="td font-mono text-xs text-ink-2">{e.resource}</td>
                    <td className="td text-xs">{e.actorRoles?.join(', ') ?? '—'}</td>
                    <td className="td">
                      <Pill tone={statusTone(e.outcome)}>{e.outcome}</Pill>
                    </td>
                    <td className="td font-mono text-[11px] text-ink-3">
                      {e.hash.slice(0, 4)}…{e.hash.slice(-4)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
    </>
  );
}
