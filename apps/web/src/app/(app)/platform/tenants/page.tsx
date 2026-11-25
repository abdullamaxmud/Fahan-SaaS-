'use client';

import { useCallback, useEffect, useState } from 'react';
import { Copy, Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { canDo, useMe } from '@/lib/session';
import { useReauth } from '@/components/Reauth';
import { Card, ErrorNote, Field, PageHeader, Pill, fieldErrors, statusTone, useAction } from '@/components/ui';

interface Tenant {
  id: string;
  slug: string;
  name: string;
  status: string;
  isolation: string;
  createdAt: string;
}

export default function TenantsPage() {
  const { me } = useMe();
  const { t } = useLang();
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [form, setForm] = useState({ slug: '', name: '', adminName: '', adminEmail: '' });
  const [invite, setInvite] = useState<{ slug: string; email: string; token: string } | null>(null);
  const load = useAction();
  const act = useAction();
  const { guarded, dialog } = useReauth();
  const fe = fieldErrors(act.error);

  const refresh = useCallback(async () => {
    await load.run(async () => setTenants(await api<Tenant[]>('/platform/tenants')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const r = await act.run(() =>
      guarded(() =>
        api<{ adminInvite: { email: string; token: string } }>('/platform/tenants', {
          body: { slug: form.slug.trim().toLowerCase(), name: form.name, admin: { name: form.adminName, email: form.adminEmail } },
        }),
      ),
    );
    if (r) {
      setInvite({ slug: form.slug.trim().toLowerCase(), ...r.adminInvite });
      setForm({ slug: '', name: '', adminName: '', adminEmail: '' });
      await refresh();
    }
  }

  async function setStatus(x: Tenant, status: 'Active' | 'Suspended') {
    if (await act.run(() => guarded(() => api(`/platform/tenants/${x.id}/status`, { method: 'PATCH', body: { status } })))) await refresh();
  }

  return (
    <>
      {dialog}
      <PageHeader eyebrow="Spec §3.1 · SaaS" title={t('Hospital tenants', 'Isbitaalada macaamiisha ah')}>
        {t('Each hospital gets its own database. You see names and status here, never patient records.', 'Isbitaal kastaa wuxuu leeyahay xog-keyd u gaar ah.')}
      </PageHeader>
      <ErrorNote error={load.error} />
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card title={`${t('Tenants', 'Macaamiisha')} · ${tenants.length}`}>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className="th">{t('Hospital', 'Isbitaalka')}</th>
                  <th className="th">Code</th>
                  <th className="th">{t('Isolation', 'Kala-saarka')}</th>
                  <th className="th">Status</th>
                  <th className="th" />
                </tr>
              </thead>
              <tbody>
                {tenants.map((x) => (
                  <tr key={x.id}>
                    <td className="td font-semibold">{x.name}</td>
                    <td className="td font-mono">{x.slug}</td>
                    <td className="td">
                      <span className="rounded-md border border-line bg-surface-2 px-1.5 font-mono text-[11.5px]">{x.isolation}</span>
                    </td>
                    <td className="td">
                      <Pill tone={statusTone(x.status)}>{x.status}</Pill>
                    </td>
                    <td className="td text-right">
                      {canDo(me, 'plat', 'A') ? (
                        <button className="btn h-7 px-2.5 text-xs" onClick={() => setStatus(x, x.status === 'Active' ? 'Suspended' : 'Active')}>
                          {x.status === 'Active' ? t('Suspend', 'Hakad') : t('Reactivate', 'Dib u hawlgeli')}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
                {!tenants.length && !load.busy ? (
                  <tr>
                    <td className="td text-ink-3" colSpan={5}>
                      {t('No hospitals yet. Create the first tenant to hand over to its Super Admin.', 'Weli isbitaal ma jiro.')}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </Card>
        {canDo(me, 'plat', 'A') ? (
          <Card title={t('New hospital', 'Isbitaal cusub')}>
            <form className="grid gap-3 px-4 pb-4" onSubmit={submit}>
              <Field label={t('Hospital name', 'Magaca isbitaalka')} error={fe.name}>
                <input className="input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Hiil Medical Group" />
              </Field>
              <Field label={t('Hospital code (used to sign in)', 'Koodhka isbitaalka')} error={fe.slug}>
                <input className="input font-mono" required value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} placeholder="hiil" />
              </Field>
              <Field label={t('First Super Admin · name', 'Maamulaha koowaad · magac')} error={fe['admin.name']}>
                <input className="input" required value={form.adminName} onChange={(e) => setForm({ ...form, adminName: e.target.value })} />
              </Field>
              <Field label={t('First Super Admin · email', 'Maamulaha koowaad · iimayl')} error={fe['admin.email']}>
                <input className="input" type="email" required value={form.adminEmail} onChange={(e) => setForm({ ...form, adminEmail: e.target.value })} />
              </Field>
              {Object.keys(fe).length ? null : <ErrorNote error={act.error} />}
              <button className="btn btn-primary justify-self-start" disabled={act.busy}>
                <Plus size={16} />
                {t('Create hospital', 'Samee isbitaal')}
              </button>
              {invite ? (
                <div className="grid gap-2 rounded-[10px] bg-accent-soft p-3 text-[13px]">
                  <b>
                    {t('Hospital created. Send these to', 'Isbitaalka waa la sameeyay. U dir')} {invite.email}:
                  </b>
                  <span>
                    {t('Hospital code', 'Koodhka')}: <code className="font-mono">{invite.slug}</code>
                  </span>
                  <div className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 select-all break-all rounded-md bg-surface px-2 py-1 font-mono text-[11.5px]">{invite.token}</code>
                    <button type="button" className="btn h-8 w-8 justify-center p-0" aria-label="Copy code" onClick={() => navigator.clipboard?.writeText(invite.token).catch(() => {})}>
                      <Copy size={14} />
                    </button>
                  </div>
                </div>
              ) : null}
            </form>
          </Card>
        ) : null}
      </div>
    </>
  );
}
