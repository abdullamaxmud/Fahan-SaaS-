'use client';

import { useRouter } from 'next/navigation';
import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { Brand } from '@/components/Brand';
import { ErrorNote, useAction } from '@/components/ui';

export default function MfaPage() {
  const router = useRouter();
  const { t } = useLang();
  const [state, setState] = useState<'loading' | 'enroll' | 'pending'>('loading');
  const [qr, setQr] = useState('');
  const [secret, setSecret] = useState('');
  const [code, setCode] = useState('');
  const { busy, error, run } = useAction();

  const started = useRef(false);
  useEffect(() => {
    // Enrolment issues a new secret each call; run once even under React strict mode.
    if (started.current) return;
    started.current = true;
    (async () => {
      try {
        const me = await api<{ mfa: 'ok' | 'pending' | 'enroll' }>('/auth/me');
        if (me.mfa === 'ok') return router.replace('/');
        if (me.mfa === 'enroll') {
          const en = await api<{ otpauthUri: string; secret: string }>('/auth/mfa/enroll', { body: {} });
          setSecret(en.secret);
          setQr(await QRCode.toDataURL(en.otpauthUri, { margin: 1, width: 200 }));
        }
        setState(me.mfa);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) router.replace('/login');
      }
    })();
  }, [router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const r = await run(() => api('/auth/mfa/verify', { body: { code } }));
    if (r) router.replace('/');
  }

  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-[420px]">
        <div className="mb-6">
          <Brand />
        </div>
        <form onSubmit={submit} className="card grid gap-4 p-6">
          <div>
            <h1 className="text-2xl font-extrabold">{state === 'enroll' ? t('Set up your authenticator', 'Deji authenticator-kaaga') : t('Enter your code', 'Geli koodhkaaga')}</h1>
            <p className="mt-1 text-[13px] text-ink-2">
              {state === 'enroll'
                ? t('Your role needs two-step sign-in. Scan the code with an authenticator app, then enter the 6-digit code it shows.', 'Doorkaagu wuxuu u baahan yahay laba-tallaabo. Ku sawir koodhka app-ka, kadibna geli 6-da god.')
                : t('Open your authenticator app and enter the 6-digit code for HospitalOS.', 'Fur app-ka oo geli 6-da god ee HospitalOS.')}
            </p>
          </div>
          {state === 'enroll' && qr ? (
            <div className="grid justify-items-center gap-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={qr} alt="Authenticator QR code" width={200} height={200} className="rounded-lg border border-line bg-white p-2" />
              <span className="text-[11.5px] text-ink-3">{t("Can't scan? Enter this key:", 'Ma sawiri kartid? Geli furahan:')}</span>
              <code className="select-all break-all rounded-md bg-surface-2 px-2 py-1 font-mono text-[12px]">{secret}</code>
            </div>
          ) : null}
          <input
            autoFocus
            className="input text-center font-mono text-xl tracking-[0.45em]"
            inputMode="numeric"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            aria-label={t('6-digit code', 'Koodhka 6-da god')}
            disabled={state === 'loading'}
          />
          <ErrorNote error={error} />
          <button className="btn btn-primary h-10 justify-center" disabled={busy || code.length !== 6}>
            {t('Verify', 'Xaqiiji')}
          </button>
        </form>
      </div>
    </main>
  );
}
