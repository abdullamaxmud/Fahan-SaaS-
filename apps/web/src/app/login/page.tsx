'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { ErrorNote, Field, useAction } from '@/components/ui';
import { Brand } from '@/components/Brand';

export default function LoginPage() {
  const router = useRouter();
  const { t, lang, setLang } = useLang();
  const [tenant, setTenant] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { busy, error, run } = useAction();
  // Remember the hospital code so people type only their email and password next time.
  useEffect(() => {
    try {
      const fromLink = new URLSearchParams(window.location.search).get('tenant');
      setTenant(fromLink ?? localStorage.getItem('fahan-tenant') ?? '');
    } catch {}
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const r = await run(() =>
      api<{ mfa: string }>('/auth/login', { body: { email, password, ...(tenant.trim() ? { tenant: tenant.trim().toLowerCase() } : {}) } }),
    );
    if (r) {
      try {
        localStorage.setItem('fahan-tenant', tenant.trim().toLowerCase());
      } catch {}
      router.replace(r.mfa === 'ok' ? '/' : '/mfa');
    }
  }

  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-[400px]">
        <div className="mb-6 flex items-center justify-between">
          <Brand />
          <button className="btn h-8 px-2.5 text-xs" onClick={() => setLang(lang === 'en' ? 'so' : 'en')}>
            {lang === 'en' ? 'Soomaali' : 'English'}
          </button>
        </div>
        <form onSubmit={submit} className="card grid gap-4 p-6">
          <div>
            <h1 className="text-2xl font-extrabold">{t('Sign in', 'Gal')}</h1>
            <p className="mt-1 text-[13px] text-ink-2">{t('Use the hospital code your administrator gave you.', 'Isticmaal koodhka isbitaalka maamulahaagu ku siiyay.')}</p>
          </div>
          <Field label={t('Hospital code', 'Koodhka isbitaalka')}>
            <input className="input font-mono" value={tenant} onChange={(e) => setTenant(e.target.value)} placeholder="hiil" autoComplete="organization" />
            <span className="text-[11.5px] font-normal text-ink-3">{t('Leave empty for the platform console.', 'Ka tag madhan haddii aad tahay maamulka madasha.')}</span>
          </Field>
          <Field label={t('Email', 'Iimayl')}>
            <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
          </Field>
          <Field label={t('Password', 'Furaha sirta')}>
            <input className="input" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </Field>
          <ErrorNote error={error} />
          <button className="btn btn-primary h-10 justify-center" disabled={busy}>
            {busy ? t('Signing in…', 'Waa la gelayaa…') : t('Sign in', 'Gal')}
          </button>
          <a href="/invite" className="text-center text-[13px] font-medium text-accent-2 hover:underline">
            {t('I have an invitation', 'Waxaan haystaa casuumad')}
          </a>
        </form>
      </div>
    </main>
  );
}
