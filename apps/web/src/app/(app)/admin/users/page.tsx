'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Copy, UserPlus } from 'lucide-react';
import { TIERS, canGrantRole, effectiveScope, isBranchBound } from '@fahan/policy';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { canDo, useMe } from '@/lib/session';
import { useReauth } from '@/components/Reauth';
import { Card, ErrorNote, Field, PageHeader, Pill, fieldErrors, statusTone, useAction } from '@/components/ui';

interface User {
  id: string;
  email: string;
  name: string;
  roles: string[];
  status: string;
  branchId: string | null;
  mfaEnrolled: boolean;
  version: number;
}
interface Role {
  id: string;
  tier: number;
  name: string;
  scope: string;
  mfa: boolean;
}
interface Branch {
  id: string;
  code: string;
  name: string;
}

export default function UsersPage() {
  const { me } = useMe();
  const { t, lang } = useLang();
  const [users, setUsers] = useState<User[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [form, setForm] = useState({ email: '', name: '', role: '', branchId: '' });
  const [invite, setInvite] = useState<{ email: string; token: string; expiresAt: string } | null>(null);
  const load = useAction();
  const act = useAction();
  const { guarded, dialog } = useReauth();
  const canEdit = canDo(me, 'iam', 'E');

  const refresh = useCallback(async () => {
    await load.run(async () => {
      const [u, r, b] = await Promise.all([api<User[]>('/users'), api<Role[]>('/roles'), api<Branch[]>('/branches').catch(() => [])]);
      setUsers(u);
      setRoles(r);
      setBranches(b);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Only offer roles this admin may grant (the API enforces the same ceiling).
  const grantable = useMemo(() => roles.filter((r) => canGrantRole(me.perms, r.id).ok), [roles, me.perms]);
  const needsBranch = form.role ? isBranchBound(effectiveScope([form.role])) : false;
  const roleName = (id: string) => roles.find((r) => r.id === id)?.name ?? id;
  const branchCode = (id: string | null) => branches.find((b) => b.id === id)?.code ?? '—';
  const fe = fieldErrors(act.error);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setInvite(null);
    const r = await act.run(() =>
      guarded(() =>
        api<{ invite: { token: string; expiresAt: string } }>('/users', {
          body: { email: form.email, name: form.name, roles: [form.role], ...(form.branchId ? { branchId: form.branchId } : {}) },
        }),
      ),
    );
    if (r) {
      setInvite({ email: form.email, ...r.invite });
      setForm({ email: '', name: '', role: form.role, branchId: form.branchId });
      await refresh();
    }
  }

  async function setStatus(u: User, path: 'suspend' | 'reactivate') {
    if (await act.run(() => guarded(() => api(`/users/${u.id}/${path}`, { body: {} })))) await refresh();
  }

  return (
    <>
      {dialog}
      <PageHeader title={t('Users & roles', 'Isticmaalayaasha & doorarka')}>
        {t('Invite staff and choose what each person can do.', 'Casuun shaqaalaha oo dooro waxa qof walba samayn karo.')}
      </PageHeader>
      <ErrorNote error={load.error} />
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card title={`${t('People', 'Dadka')} · ${users.length}`}>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className="th">{t('Name', 'Magaca')}</th>
                  <th className="th">{t('Role', 'Doorka')}</th>
                  <th className="th">{t('Branch', 'Laanta')}</th>
                  <th className="th">MFA</th>
                  <th className="th">Status</th>
                  {canEdit ? <th className="th" /> : null}
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td className="td">
                      <b className="block">{u.name}</b>
                      <span className="text-xs text-ink-3">{u.email}</span>
                    </td>
                    <td className="td">{u.roles.map(roleName).join(', ')}</td>
                    <td className="td font-mono text-xs">{branchCode(u.branchId)}</td>
                    <td className="td">{u.mfaEnrolled ? <Pill tone="ok">On</Pill> : <Pill>Off</Pill>}</td>
                    <td className="td">
                      <Pill tone={statusTone(u.status)}>{u.status}</Pill>
                    </td>
                    {canEdit ? (
                      <td className="td text-right">
                        {u.id !== me.id && u.status === 'Active' ? (
                          <button className="btn h-7 px-2.5 text-xs" onClick={() => setStatus(u, 'suspend')}>
                            {t('Suspend', 'Hakad')}
                          </button>
                        ) : null}
                        {u.status === 'Suspended' ? (
                          <button className="btn h-7 px-2.5 text-xs" onClick={() => setStatus(u, 'reactivate')}>
                            {t('Reactivate', 'Dib u hawlgeli')}
                          </button>
                        ) : null}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        {canEdit ? (
          <Card title={t('Invite someone', 'Casuun qof')}>
            <form className="grid gap-3 px-4 pb-4" onSubmit={submit}>
              <Field label={t('Full name', 'Magaca oo buuxa')} error={fe.name}>
                <input className="input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </Field>
              <Field label={t('Email', 'Iimayl')} error={fe.email}>
                <input className="input" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </Field>
              <Field label={t('Role', 'Doorka')} error={fe.roles}>
                <select className="input" required value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                  <option value="">{t('Choose a role…', 'Dooro door…')}</option>
                  {Object.entries(TIERS)
                    .filter(([tier]) => tier !== '1')
                    .map(([tier, label]) => (
                      <optgroup key={tier} label={`L${tier} · ${label[lang]}`}>
                        {grantable
                          .filter((r) => String(r.tier) === tier)
                          .map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.name}
                              {r.mfa ? ' · MFA' : ''}
                            </option>
                          ))}
                      </optgroup>
                    ))}
                </select>
              </Field>
              {needsBranch ? (
                <Field label={t('Branch', 'Laanta')} error={fe.branchId}>
                  <select className="input" required value={form.branchId} onChange={(e) => setForm({ ...form, branchId: e.target.value })}>
                    <option value="">{t('Choose a branch…', 'Dooro laan…')}</option>
                    {branches.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.code} · {b.name}
                      </option>
                    ))}
                  </select>
                </Field>
              ) : null}
              {Object.keys(fe).length ? null : <ErrorNote error={act.error} />}
              <button className="btn btn-primary justify-self-start" disabled={act.busy}>
                <UserPlus size={16} />
                {t('Send invitation', 'Dir casuumad')}
              </button>
              {invite ? (
                <div className="grid gap-2 rounded-[10px] bg-accent-soft p-3 text-[13px]">
                  <b>{t('Invitation created for', 'Casuumad loo sameeyay')} {invite.email}</b>
                  <span className="text-ink-2">
                    {t('Give them the hospital code', 'Sii koodhka isbitaalka')} <code className="font-mono">{me.tenant?.slug}</code> {t('and this one-time code. It expires', 'iyo koodhkan. Wuxuu dhacayaa')}{' '}
                    {new Date(invite.expiresAt).toLocaleString()}.
                  </span>
                  <div className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 select-all break-all rounded-md bg-surface px-2 py-1 font-mono text-[11.5px]">{invite.token}</code>
                    <button
                      type="button"
                      className="btn h-8 w-8 justify-center p-0"
                      aria-label="Copy code"
                      onClick={() => navigator.clipboard?.writeText(invite.token).catch(() => {})}
                    >
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
