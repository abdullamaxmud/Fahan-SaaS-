'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { canDo, useMe } from '@/lib/session';
import { useReauth } from './Reauth';
import { fmtDateTime } from './Dialog';
import { Card, ErrorNote, Pill, useAction } from './ui';

const PROVIDERS: [string, string][] = [
  ['evc-plus', 'EVC Plus'],
  ['zaad', 'ZAAD'],
  ['sahal', 'Sahal'],
  ['edahab', 'eDahab'],
  ['card-acquirer', 'Card payments'],
];

/** Mobile money and card providers: the signing secret is shown once, when it is created or replaced. */
export function PaymentProviders() {
  const { me } = useMe();
  const { t, lang } = useLang();
  const [list, setList] = useState<{ provider: string; active: boolean; rotatedAt: string }[]>([]);
  const [shown, setShown] = useState<{ provider: string; secret: string; webhookPath: string } | null>(null);
  const act = useAction();
  const { guarded, dialog } = useReauth();
  const load = useCallback(() => api<typeof list>('/billing/providers').then(setList).catch(() => {}), []);
  useEffect(() => {
    void load();
  }, [load]);
  const admin = canDo(me, 'bill', 'A');

  return (
    <Card title={t('Mobile money & card payments', 'Lacag-bixinta mobile-ka & kaarka')}>
      {dialog}
      <ul className="px-4 text-[13px]">
        {PROVIDERS.map(([k, label]) => {
          const p = list.find((x) => x.provider === k);
          return (
            <li key={k} className="flex flex-wrap items-center gap-2 border-t border-line py-2 first:border-t-0">
              <b className="flex-1">{label}</b>
              {p ? <span className="text-[12px] text-ink-3">{t('key set', 'furaha')} {fmtDateTime(p.rotatedAt, lang)}</span> : null}
              <Pill tone={p?.active ? 'ok' : 'plain'}>{p?.active ? t('Connected', 'Ku xiran') : t('Not set up', 'Lama dejin')}</Pill>
              {admin ? (
                <button
                  className="btn h-7 px-2.5 text-xs"
                  disabled={act.busy}
                  onClick={async () => {
                    if (p && !window.confirm(t('Replace the signing key? The provider must be given the new one.', 'Ma beddelaysaa furaha?'))) return;
                    const r = await act.run(() => guarded(() => api<{ provider: string; secret: string; webhookPath: string }>('/billing/providers', { body: { provider: k } })));
                    if (r) {
                      setShown(r);
                      await load();
                    }
                  }}
                >
                  {p ? t('Replace key', 'Beddel furaha') : t('Set up', 'Deji')}
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {shown ? (
        <div className="m-4 grid gap-1.5 rounded-lg bg-warn-soft p-3 text-[12.5px]">
          <b className="text-warn">{t('Give these to the provider now. The key is not shown again.', 'Sii bixiyaha hadda. Furaha mar kale lama tusi doono.')}</b>
          <span>{t('Callback address', 'Cinwaanka soo celinta')}:</span>
          <code className="break-all rounded bg-surface px-2 py-1 font-mono">{`${typeof window !== 'undefined' ? window.location.origin : ''}${shown.webhookPath}`}</code>
          <span>{t('Signing key', 'Furaha saxiixa')}:</span>
          <code className="break-all rounded bg-surface px-2 py-1 font-mono">{shown.secret}</code>
          <button className="btn h-7 justify-self-start px-2.5 text-xs" onClick={() => setShown(null)}>
            {t('I have saved it', 'Waan kaydiyay')}
          </button>
        </div>
      ) : null}
      <div className="px-4 pb-3">
        <ErrorNote error={act.error} />
      </div>
    </Card>
  );
}
