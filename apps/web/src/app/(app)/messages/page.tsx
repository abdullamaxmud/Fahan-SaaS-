'use client';

import { useCallback, useEffect, useState } from 'react';
import { CheckCheck, Send } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { when, type Thread } from '@/lib/portal';
import { canDo, useMe } from '@/lib/session';
import { Card, Empty, ErrorNote, PageHeader, Pill, Tabs, useAction } from '@/components/ui';

/** Front-desk inbox for messages patients send from the portal. */
export default function MessagesPage() {
  const { me } = useMe();
  const { t, lang } = useLang();
  const [status, setStatus] = useState<'open' | 'all'>('open');
  const [list, setList] = useState<Thread[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const load = useAction();
  const act = useAction();
  const allowed = canDo(me, 'portal', 'E');

  const refresh = useCallback(async () => {
    if (!allowed) return;
    await load.run(async () => setList(await api<Thread[]>(`/portal-inbox?status=${status}`)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, allowed]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const thread = list.find((x) => x.id === open) ?? null;

  if (!allowed) {
    return (
      <>
        <PageHeader title={t('Patient messages', 'Fariimaha bukaanka')} />
        <Card>
          <Empty>{t('Your role can see that patients write, but replies are handled by the front desk.', 'Jawaabaha waxaa bixiya soo-dhoweynta.')}</Empty>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title={t('Patient messages', 'Fariimaha bukaanka')}>{t('Questions patients send from the portal.', 'Su’aalaha bukaanku ka soo diro bogga bukaanka.')}</PageHeader>
      <Tabs<'open' | 'all'>
        value={status}
        onChange={setStatus}
        items={[
          { id: 'open', label: t('Open', 'Furan'), count: list.filter((x) => x.awaiting === 'staff').length },
          { id: 'all', label: t('All', 'Dhammaan') },
        ]}
      />
      <ErrorNote error={load.error ?? act.error} />
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        <Card>
          {list.length ? (
            <ul>
              {list.map((x) => (
                <li key={x.id} className="border-t border-line first:border-t-0">
                  <button className={`flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-2/60 ${open === x.id ? 'bg-accent-soft/40' : ''}`} onClick={() => setOpen(x.id)}>
                    <span className="min-w-0 flex-1">
                      <b className="block truncate text-[14px]">{x.subject}</b>
                      <span className="block truncate text-[12.5px] text-ink-3">
                        {x.patient?.name} · {x.patient?.mrn}
                      </span>
                    </span>
                    {x.awaiting === 'staff' ? <Pill tone="warn">{t('Waiting', 'Sugaya')}</Pill> : x.status === 'Closed' ? <Pill>{t('Closed', 'La xiray')}</Pill> : <Pill tone="ok">{t('Answered', 'La jawaabay')}</Pill>}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>{t('No messages waiting.', 'Fariin sugaysa ma jirto.')}</Empty>
          )}
        </Card>
        {thread ? (
          <Card title={thread.subject} actions={thread.status === 'Open' ? (
            <button className="btn h-8 px-2.5 text-xs" disabled={act.busy} onClick={async () => { if ((await act.run(() => api(`/portal-inbox/${thread.id}/close`, { body: {} }))) !== undefined) await refresh(); }}>
              <CheckCheck size={14} />
              {t('Close', 'Xir')}
            </button>
          ) : null}>
            <div className="grid gap-3 px-4 pb-4">
              <span className="text-[12.5px] text-ink-3">
                {thread.patient?.name} · {thread.patient?.mrn}
              </span>
              <ol className="grid gap-2">
                {thread.messages.map((m, i) => (
                  <li key={i} className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-[14px] ${m.from === 'staff' ? 'justify-self-end bg-accent text-on-accent' : 'justify-self-start bg-surface-2'}`}>
                    <p className="whitespace-pre-wrap">{m.text}</p>
                    <span className={`mt-1 block text-[11px] ${m.from === 'staff' ? 'opacity-80' : 'text-ink-3'}`}>
                      {m.byName} · {when(m.at, lang)}
                    </span>
                  </li>
                ))}
              </ol>
              <form
                className="flex gap-2"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (await act.run(() => api(`/portal-inbox/${thread.id}/reply`, { body: { text: reply } }))) {
                    setReply('');
                    await refresh();
                  }
                }}
              >
                <input className="input flex-1" required value={reply} onChange={(e) => setReply(e.target.value)} placeholder={t('Write a reply', 'Qor jawaab')} aria-label={t('Reply', 'Jawaab')} />
                <button className="btn btn-primary h-10" disabled={act.busy}>
                  <Send size={16} />
                  {t('Send', 'Dir')}
                </button>
              </form>
            </div>
          </Card>
        ) : (
          <Card>
            <Empty>{t('Choose a conversation.', 'Dooro wada-hadal.')}</Empty>
          </Card>
        )}
      </div>
    </>
  );
}
