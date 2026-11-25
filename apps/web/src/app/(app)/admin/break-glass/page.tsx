'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { canDo, useMe } from '@/lib/session';
import { Card, ErrorNote, PageHeader, Pill, useAction } from '@/components/ui';

interface Grant {
  id: string;
  user: { id: string; name: string; roles: string[] };
  patient: { id: string; mrn: string };
  reason: string;
  createdAt: string;
  expiresAt: string;
  eventsOnPatient: number;
  review: { outcome: string; note: string } | null;
}

export default function BreakGlassPage() {
  const { me } = useMe();
  const { t } = useLang();
  const [tab, setTab] = useState<'pending' | 'reviewed'>('pending');
  const [list, setList] = useState<Grant[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const load = useAction();
  const act = useAction();

  const refresh = useCallback(async () => {
    await load.run(async () => setList(await api<Grant[]>(`/security/break-glass?status=${tab}`)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function review(g: Grant, outcome: 'justified' | 'unjustified') {
    if (await act.run(() => api(`/security/break-glass/${g.id}/review`, { body: { outcome, note: notes[g.id] || outcome } }))) await refresh();
  }

  return (
    <>
      <PageHeader eyebrow="Spec §3.4" title={t('Emergency access review', 'Dib-u-eegista gelitaanka degdegga')}>
        {t('Every break-glass use is reviewed after the fact. Reviewing also ends any access still open.', 'Gelitaan kasta oo degdeg ah waa la eegaa.')}
      </PageHeader>
      <div className="flex self-start overflow-hidden rounded-[9px] border border-line" role="tablist">
        {(['pending', 'reviewed'] as const).map((x) => (
          <button key={x} role="tab" aria-selected={tab === x} onClick={() => setTab(x)} className={`h-9 px-3.5 text-[13px] font-semibold ${tab === x ? 'bg-ink text-surface' : 'text-ink-2'}`}>
            {x === 'pending' ? t('To review', 'La eegayo') : t('Reviewed', 'La eegay')}
          </button>
        ))}
      </div>
      <ErrorNote error={load.error ?? act.error} />
      <Card>
        <ul className="grid text-[13px]">
          {list.map((g) => (
            <li key={g.id} className="grid gap-2 border-t border-line px-4 py-3 first:border-t-0">
              <div className="flex flex-wrap items-center gap-2">
                <b>{g.user.name}</b>
                <span className="text-ink-3">{g.user.roles.join(', ')}</span>
                <span className="font-mono text-xs">{g.patient.mrn}</span>
                <span className="ml-auto num text-xs text-ink-3">{new Date(g.createdAt).toLocaleString()}</span>
              </div>
              <p className="rounded-lg bg-crit-soft px-3 py-2 text-crit">“{g.reason}”</p>
              <span className="text-xs text-ink-2">
                {g.eventsOnPatient} {t('recorded actions on this patient by this user', 'ficil oo lagu sameeyay bukaankan')} ·{' '}
                <Link className="underline" href="/admin/audit">
                  {t('audit trail', 'raadraaca')}
                </Link>
              </span>
              {g.review ? (
                <Pill tone={g.review.outcome === 'justified' ? 'ok' : 'crit'}>
                  {g.review.outcome} — {g.review.note}
                </Pill>
              ) : canDo(me, 'sec', 'A') ? (
                <div className="flex flex-wrap gap-2">
                  <input className="input h-8 min-w-0 flex-1" placeholder={t('Review note', 'Qoraal')} value={notes[g.id] ?? ''} onChange={(e) => setNotes({ ...notes, [g.id]: e.target.value })} />
                  <button className="btn h-8 text-xs" onClick={() => review(g, 'justified')}>
                    {t('Justified', 'Waa la xaqiijiyay')}
                  </button>
                  <button className="btn h-8 border-crit/40 text-xs text-crit" onClick={() => review(g, 'unjustified')}>
                    {t('Not justified', 'Lama xaqiijin')}
                  </button>
                </div>
              ) : null}
            </li>
          ))}
          {!list.length && !load.busy ? <li className="px-4 py-4 text-ink-3">{t('Nothing here.', 'Waxba ma jiraan.')}</li> : null}
        </ul>
      </Card>
    </>
  );
}
