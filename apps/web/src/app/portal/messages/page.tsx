'use client';

import { useCallback, useEffect, useState } from 'react';
import { PenSquare, Send } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { when, type Thread } from '@/lib/portal';
import { usePortal } from '@/components/PortalShell';
import { Empty, ErrorNote, Field, Pill, useAction } from '@/components/ui';


export default function PortalMessages() {
  const { current } = usePortal();
  const { t, lang } = useLang();
  const [list, setList] = useState<Thread[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [compose, setCompose] = useState(false);
  const [draft, setDraft] = useState({ subject: '', text: '' });
  const [reply, setReply] = useState('');
  const act = useAction();

  const load = useCallback(async () => {
    if (current) await act.run(async () => setList(await api<Thread[]>(`/portal/${current.id}/messages`)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);
  useEffect(() => {
    void load();
  }, [load]);
  const thread = list.find((x) => x.id === open);

  return (
    <>
      <div className="flex items-center gap-3">
        <h1 className="flex-1 text-[24px] font-extrabold">{t('Messages', 'Fariimaha')}</h1>
        <button className="btn btn-primary" onClick={() => setCompose(true)}>
          <PenSquare size={16} />
          {t('New message', 'Fariin cusub')}
        </button>
      </div>
      <p className="-mt-2 text-[13px] text-ink-3">{t('For questions about appointments, bills or prescriptions. In an emergency, come to the hospital or call for help.', 'Su’aalaha ballamaha, biilasha ama daawooyinka. Xaalad degdeg ah, imow isbitaalka ama wac gargaar.')}</p>
      <ErrorNote error={act.error} />

      {compose && current ? (
        <form
          className="card grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 border-accent p-4"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await act.run(() => api(`/portal/${current.id}/messages`, { body: draft }))) {
              setDraft({ subject: '', text: '' });
              setCompose(false);
              await load();
            }
          }}
        >
          <Field label={t('Subject', 'Mawduuca')}>
            <input className="input" required minLength={3} value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} />
          </Field>
          <Field label={t('Message', 'Fariinta')}>
            <textarea className="input h-28 py-2" required value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
          </Field>
          <div className="flex gap-2">
            <button className="btn btn-primary" disabled={act.busy}>
              <Send size={16} />
              {t('Send', 'Dir')}
            </button>
            <button type="button" className="btn" onClick={() => setCompose(false)}>
              {t('Cancel', 'Jooji')}
            </button>
          </div>
        </form>
      ) : null}

      {thread && current ? (
        <section className="card grid gap-3 p-4">
          <div className="flex items-center gap-2">
            <button className="btn h-8 px-2.5 text-xs" onClick={() => setOpen(null)}>
              ← {t('All messages', 'Dhammaan')}
            </button>
            <b className="flex-1 truncate text-[15px]">{thread.subject}</b>
          </div>
          <ol className="grid gap-2">
            {thread.messages.map((m, i) => (
              <li key={i} className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-[14px] ${m.from === 'patient' ? 'justify-self-end bg-accent text-on-accent' : 'justify-self-start bg-surface-2'}`}>
                <p className="whitespace-pre-wrap">{m.text}</p>
                <span className={`mt-1 block text-[11px] ${m.from === 'patient' ? 'opacity-80' : 'text-ink-3'}`}>
                  {m.from === 'staff' ? `${m.byName} · ` : ''}
                  {when(m.at, lang)}
                </span>
              </li>
            ))}
          </ol>
          <form
            className="flex gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await act.run(() => api(`/portal/${current.id}/messages/${thread.id}/reply`, { body: { text: reply } }))) {
                setReply('');
                await load();
              }
            }}
          >
            <input className="input flex-1" required value={reply} onChange={(e) => setReply(e.target.value)} placeholder={t('Write a reply', 'Qor jawaab')} aria-label={t('Reply', 'Jawaab')} />
            <button className="btn btn-primary h-10" disabled={act.busy} aria-label={t('Send', 'Dir')}>
              <Send size={16} />
            </button>
          </form>
        </section>
      ) : list.length ? (
        <div className="card">
          <ul>
            {list.map((x) => (
              <li key={x.id} className="border-t border-line first:border-t-0">
                <button className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-2/60" onClick={() => setOpen(x.id)}>
                  <span className="min-w-0 flex-1">
                    <b className="block truncate text-[14px]">{x.subject}</b>
                    <span className="block truncate text-[12.5px] text-ink-3">{x.messages.at(-1)?.text}</span>
                  </span>
                  {x.awaiting === 'patient' ? <Pill tone="acc">{t('New reply', 'Jawaab cusub')}</Pill> : x.status === 'Closed' ? <Pill>{t('Closed', 'La xiray')}</Pill> : <Pill tone="info">{t('Sent', 'La diray')}</Pill>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : !compose ? (
        <div className="card">
          <Empty>{t('No messages yet.', 'Weli fariin ma jirto.')}</Empty>
        </div>
      ) : null}
    </>
  );
}
