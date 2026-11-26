'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { Brand } from '@/components/Brand';
import { ErrorNote, Field, fieldErrors, useAction } from '@/components/ui';

export default function AcceptInvitePage() {
  const router = useRouter();
  const { t } = useLang();
  const [form, setForm] = useState({ tenant: '', token: '', password: '', confirm: '' });
  const { busy, error, setError, run } = useAction();
  const fe = fieldErrors(error);
  // Links from the hospital carry the hospital and invitation codes, so people only choose a password.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const tenant = q.get('tenant') ?? '';
    const token = q.get('code') ?? '';
    if (tenant || token) setForm((f) => ({ ...f, tenant, token }));
  }, []);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (form.password !== form.confirm) return setError(new Error('mismatch'));
    const r = await run(() => api('/auth/accept-invite', { body: { tenant: form.tenant.trim().toLowerCase(), token: form.token.trim(), password: form.password } }));
    if (r) router.replace(`/login?tenant=${encodeURIComponent(form.tenant.trim().toLowerCase())}`);
  }

  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-[420px]">
        <div className="mb-6">
          <Brand />
        </div>
        <form onSubmit={submit} className="card grid gap-4 p-6">
          <div>
            <h1 className="text-2xl font-extrabold">{t('Activate your account', 'Hawlgeli akoonkaaga')}</h1>
            <p className="mt-1 text-[13px] text-ink-2">{t('Paste the invitation code and choose a password of at least 12 characters.', 'Geli koodhka casuumadda oo dooro fure sir ah oo ugu yaraan 12 xaraf ah.')}</p>
          </div>
          <Field label={t('Hospital code', 'Koodhka isbitaalka')} error={fe.tenant}>
            <input className="input font-mono" required value={form.tenant} onChange={set('tenant')} />
          </Field>
          <Field label={t('Invitation code', 'Koodhka casuumadda')} error={fe.token}>
            <input className="input font-mono text-[12px]" required value={form.token} onChange={set('token')} />
          </Field>
          <Field label={t('New password', 'Fure cusub')} error={fe.password}>
            <input className="input" type="password" required minLength={12} value={form.password} onChange={set('password')} autoComplete="new-password" />
          </Field>
          <Field label={t('Repeat password', 'Ku celi furaha')} error={error instanceof Error && error.message === 'mismatch' ? t('Passwords do not match', 'Furayaashu isma laha') : undefined}>
            <input className="input" type="password" required value={form.confirm} onChange={set('confirm')} autoComplete="new-password" />
          </Field>
          {error instanceof Error && error.message === 'mismatch' ? null : <ErrorNote error={error} />}
          <button className="btn btn-primary h-10 justify-center" disabled={busy}>
            {t('Activate account', 'Hawlgeli')}
          </button>
        </form>
      </div>
    </main>
  );
}
