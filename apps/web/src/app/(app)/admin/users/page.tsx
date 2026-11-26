'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Copy, Search, ShieldCheck, UserPlus } from 'lucide-react';
import { TIERS, canGrantRole, effectiveScope, isBranchBound, type Permissions } from '@fahan/policy';
import { AccessList } from '@/components/Access';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { canDo, useMe } from '@/lib/session';
import { useReauth } from '@/components/Reauth';
import { Drawer, Facts, fmtDate } from '@/components/Dialog';
import { Card, Empty, ErrorNote, Field, PageHeader, Pill, Tabs, fieldErrors, useAction } from '@/components/ui';

interface User {
  id: string;
  email: string;
  name: string;
  roles: string[];
  status: string;
  branchId: string | null;
  mfaEnrolled: boolean;
  mfaReset: { requestedByName: string; requestedAt: string; reason: string } | null;
  activatedAt?: string;
  version: number;
}
interface Role {
  id: string;
  tier: number;
  name: string;
  scope: string;
  mfa: boolean;
  note: string;
  perms: Permissions;
}
interface Branch {
  id: string;
  code: string;
  name: string;
}

const STATUS: Record<string, [string, string, 'ok' | 'warn' | 'crit' | 'plain']> = {
  Active: ['Active', 'Firfircoon', 'ok'],
  Invited: ['Invited', 'La casuumay', 'warn'],
  Suspended: ['Suspended', 'La hakiyay', 'crit'],
  Deactivated: ['Deactivated', 'La joojiyay', 'plain'],
};


export default function UsersPage() {
  const { me } = useMe();
  const { t, lang } = useLang();
  const [tab, setTab] = useState<'people' | 'roles'>('people');
  const [users, setUsers] = useState<User[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState<User | null>(null);
  const [inviting, setInviting] = useState(false);
  const [roleOpen, setRoleOpen] = useState<Role | null>(null);
  const load = useAction();
  const { guarded, dialog } = useReauth();

  const refresh = useCallback(async () => {
    await load.run(async () => {
      const [u, r, b] = await Promise.all([api<User[]>('/users'), api<Role[]>('/roles'), api<Branch[]>('/lookup/branches').catch(() => [])]);
      setUsers(u);
      setRoles(r);
      setBranches(b);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const roleName = (id: string) => roles.find((r) => r.id === id)?.name ?? id;
  const branchCode = (id: string | null) => branches.find((b) => b.id === id)?.code ?? '';
  const shown = users.filter((u) => (!status || u.status === status) && (!q || `${u.name} ${u.email} ${u.roles.map(roleName).join(' ')}`.toLowerCase().includes(q.toLowerCase())));
  const pendingResets = users.filter((u) => u.mfaReset).length;

  return (
    <>
      {dialog}
      <PageHeader
        title={t('Users & roles', 'Isticmaalayaasha & doorarka')}
        actions={
          canDo(me, 'iam', 'E') ? (
            <button className="btn btn-primary" onClick={() => setInviting(true)}>
              <UserPlus size={16} />
              {t('Invite staff', 'Casuun shaqaale')}
            </button>
          ) : null
        }
      >
        {t('Invite staff and choose what each person can do.', 'Casuun shaqaalaha oo dooro waxa qof walba samayn karo.')}
      </PageHeader>
      <ErrorNote error={load.error} />
      <Tabs<'people' | 'roles'>
        value={tab}
        onChange={setTab}
        items={[
          { id: 'people', label: t('People', 'Dadka'), count: users.length },
          { id: 'roles', label: t('Roles', 'Doorarka'), count: roles.length },
        ]}
      />

      {tab === 'people' ? (
        <Card>
          <div className="flex flex-wrap gap-2 px-4 pb-3 pt-4">
            <label className="flex h-9 min-w-[220px] flex-1 items-center gap-2 rounded-lg border border-line-2 bg-surface-2 px-3">
              <Search size={15} className="text-ink-3" />
              <input className="min-w-0 flex-1 bg-transparent text-[13.5px] outline-none" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Search name, email or role', 'Raadi magac, iimayl ama door')} aria-label={t('Search', 'Raadi')} />
            </label>
            <select className="input h-9 w-auto" value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t('Status', 'Xaalad')}>
              <option value="">{t('Everyone', 'Dhammaan')}</option>
              {Object.entries(STATUS).map(([k, v]) => (
                <option key={k} value={k}>
                  {lang === 'so' ? v[1] : v[0]}
                </option>
              ))}
            </select>
          </div>
          {pendingResets ? (
            <div className="mx-4 mb-3 flex items-center gap-2 rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn">
              <ShieldCheck size={16} />
              {t(`${pendingResets} authenticator reset waiting for a second administrator`, `${pendingResets} dib-u-dejin sugaysa maamule labaad`)}
            </div>
          ) : null}
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className="th">{t('Person', 'Qofka')}</th>
                  <th className="th">{t('Role', 'Doorka')}</th>
                  <th className="th">{t('Branch', 'Laanta')}</th>
                  <th className="th">{t('Status', 'Xaalad')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((u) => (
                  <tr key={u.id} className="cursor-pointer hover:bg-surface-2/60" onClick={() => setOpen(u)}>
                    <td className="td">
                      <b className="block">{u.name}</b>
                      <span className="text-[12px] text-ink-3">{u.email}</span>
                    </td>
                    <td className="td">{u.roles.map(roleName).join(', ')}</td>
                    <td className="td font-mono text-xs">{branchCode(u.branchId) || '—'}</td>
                    <td className="td">
                      <span className="flex flex-wrap gap-1">
                        <Pill tone={STATUS[u.status]?.[2]}>{lang === 'so' ? STATUS[u.status]?.[1] : STATUS[u.status]?.[0]}</Pill>
                        {u.mfaReset ? <Pill tone="warn">{t('Reset pending', 'Dib-u-dejin')}</Pill> : null}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!shown.length && !load.busy ? <Empty>{t('Nobody matches.', 'Qofna kuma habboona.')}</Empty> : null}
          </div>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {Object.entries(TIERS)
            .filter(([tier]) => roles.some((r) => String(r.tier) === tier))
            .map(([tier, label]) => (
              <Card key={tier} title={lang === 'so' ? label.so : label.en}>
                <ul className="pb-2">
                  {roles
                    .filter((r) => String(r.tier) === tier)
                    .map((r) => (
                      <li key={r.id}>
                        <button className="flex w-full items-center gap-3 border-t border-line px-4 py-2.5 text-left hover:bg-surface-2/60" onClick={() => setRoleOpen(r)}>
                          <span className="min-w-0 flex-1">
                            <b className="block text-[13.5px]">{r.name}</b>
                            <span className="block truncate text-[12px] text-ink-3">{r.note}</span>
                          </span>
                          <span className="text-[12px] text-ink-3">{users.filter((u) => u.roles.includes(r.id)).length}</span>
                        </button>
                      </li>
                    ))}
                </ul>
              </Card>
            ))}
        </div>
      )}

      {open ? (
        <UserPanel
          u={open}
          roles={roles}
          branches={branches}
          guarded={guarded}
          onClose={() => setOpen(null)}
          onChanged={async () => {
            await refresh();
            const fresh = (await api<User[]>('/users')).find((x) => x.id === open.id);
            setOpen(fresh ?? null);
          }}
        />
      ) : null}
      {inviting ? <InvitePanel roles={roles} branches={branches} guarded={guarded} onClose={() => setInviting(false)} onDone={refresh} /> : null}
      {roleOpen ? (
        <Drawer title={roleOpen.name} sub={roleOpen.note} onClose={() => setRoleOpen(null)}>
          <div className="grid gap-4">
            <Facts
              rows={[
                [t('Works across', 'Wuxuu ka shaqeeyaa'), roleOpen.scope],
                [t('Authenticator app', 'Barnaamijka xaqiijinta'), roleOpen.mfa ? t('Required', 'Waa khasab') : t('Optional', 'Ikhtiyaari')],
                [t('People with this role', 'Dadka doorkan leh'), String(users.filter((u) => u.roles.includes(roleOpen.id)).length)],
              ]}
            />
            <div>
              <h3 className="mb-2 text-[14px] font-bold">{t('What this role can do', 'Waxa doorkan samayn karo')}</h3>
              <AccessList roles={[roleOpen.id]} />
            </div>
          </div>
        </Drawer>
      ) : null}
    </>
  );
}

type Guard = <T>(fn: () => Promise<T>) => Promise<T>;

function RolePicker({ roles, value, onChange }: { roles: Role[]; value: string[]; onChange: (v: string[]) => void }) {
  const { me } = useMe();
  const { lang, t } = useLang();
  const [q, setQ] = useState('');
  const grantable = useMemo(() => roles.filter((r) => canGrantRole(me.perms, r.id).ok && !['patient', 'caregiver'].includes(r.id)), [roles, me.perms]);
  const list = grantable.filter((r) => !q || r.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="grid gap-2">
      <input className="input h-9" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Filter roles', 'Shaandhee doorarka')} aria-label={t('Filter roles', 'Shaandhee doorarka')} />
      <div className="max-h-64 overflow-y-auto rounded-lg border border-line">
        {Object.entries(TIERS).map(([tier, label]) => {
          const items = list.filter((r) => String(r.tier) === tier);
          if (!items.length) return null;
          return (
            <div key={tier}>
              <span className="block bg-surface-2 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3">{lang === 'so' ? label.so : label.en}</span>
              {items.map((r) => (
                <label key={r.id} className="flex cursor-pointer items-center gap-2 border-t border-line px-3 py-2 text-[13px] hover:bg-surface-2/50">
                  <input type="checkbox" checked={value.includes(r.id)} onChange={(e) => onChange(e.target.checked ? [...value, r.id] : value.filter((x) => x !== r.id))} />
                  <span className="flex-1">{r.name}</span>
                </label>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function InvitePanel({ roles, branches, guarded, onClose, onDone }: { roles: Role[]; branches: Branch[]; guarded: Guard; onClose: () => void; onDone: () => Promise<void> }) {
  const { me } = useMe();
  const { t } = useLang();
  const [f, setF] = useState({ email: '', name: '', roles: [] as string[], branchId: me.branchId ?? '' });
  const [invite, setInvite] = useState<{ token: string; expiresAt: string } | null>(null);
  const act = useAction();
  const fe = fieldErrors(act.error);
  const needsBranch = f.roles.length ? isBranchBound(effectiveScope(f.roles)) : false;
  const link = invite ? `${window.location.origin}/invite?tenant=${me.tenant?.slug ?? ''}&code=${invite.token}` : '';
  return (
    <Drawer title={t('Invite staff', 'Casuun shaqaale')} onClose={onClose} wide>
      {invite ? (
        <div className="grid gap-3 text-[13.5px]">
          <b>{t(`Invitation ready for ${f.name}`, `Casuumadda ${f.name} waa diyaar`)}</b>
          <p className="text-ink-2">{t('Send them this link. It works once and expires in 3 days.', 'U dir xiriirkan. Hal mar ayuu shaqeeyaa, 3 maalmood kadib wuu dhacayaa.')}</p>
          <code className="break-all rounded-lg bg-surface-2 px-3 py-2 font-mono text-[12px]">{link}</code>
          <div className="flex gap-2">
            <button className="btn" onClick={() => void navigator.clipboard?.writeText(link)}>
              <Copy size={15} />
              {t('Copy link', 'Koobi garee')}
            </button>
            <button
              className="btn btn-primary"
              onClick={() => {
                setInvite(null);
                setF({ email: '', name: '', roles: f.roles, branchId: f.branchId });
              }}
            >
              {t('Invite another', 'Casuun mid kale')}
            </button>
          </div>
        </div>
      ) : (
        <form
          className="grid gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await act.run(() => guarded(() => api<{ invite: { token: string; expiresAt: string } }>('/users', { body: { email: f.email, name: f.name, roles: f.roles, ...(f.branchId && needsBranch ? { branchId: f.branchId } : f.branchId ? { branchId: f.branchId } : {}) } })));
            if (r) {
              setInvite(r.invite);
              await onDone();
            }
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('Full name', 'Magaca oo buuxa')} error={fe.name}>
              <input className="input" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            </Field>
            <Field label={t('Email', 'Iimayl')} error={fe.email}>
              <input className="input" type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
            </Field>
          </div>
          <Field label={t('Role', 'Doorka')} error={fe.roles}>
            <RolePicker roles={roles} value={f.roles} onChange={(v) => setF({ ...f, roles: v })} />
          </Field>
          {needsBranch || branches.length > 1 ? (
            <Field label={t('Branch', 'Laanta')} error={fe.branchId}>
              <select className="input" value={f.branchId} onChange={(e) => setF({ ...f, branchId: e.target.value })} required={needsBranch}>
                <option value="">{needsBranch ? t('Choose…', 'Dooro…') : t('Whole hospital', 'Isbitaalka oo dhan')}</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.code} · {b.name}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          {f.roles.length ? (
            <div className="rounded-lg border border-line p-3">
              <b className="mb-2 block text-[13px]">{t('They will be able to', 'Waxay awoodi doonaan')}</b>
              <AccessList roles={f.roles} />
            </div>
          ) : null}
          {Object.keys(fe).length ? null : <ErrorNote error={act.error} />}
          <button className="btn btn-primary justify-self-start" disabled={act.busy || !f.roles.length}>
            <UserPlus size={16} />
            {t('Create invitation', 'Samee casuumad')}
          </button>
        </form>
      )}
    </Drawer>
  );
}

function UserPanel({ u, roles, branches, guarded, onClose, onChanged }: { u: User; roles: Role[]; branches: Branch[]; guarded: Guard; onClose: () => void; onChanged: () => Promise<void> }) {
  const { me } = useMe();
  const { t, lang } = useLang();
  const [editing, setEditing] = useState(false);
  const [sel, setSel] = useState(u.roles);
  const [branchId, setBranchId] = useState(u.branchId ?? '');
  const [reason, setReason] = useState('');
  const [invite, setInvite] = useState<string | null>(null);
  const act = useAction();
  const canEdit = canDo(me, 'iam', 'E') && u.id !== me.id;
  const go = async <T,>(fn: () => Promise<T>) => {
    const r = await act.run(() => guarded(fn));
    if (r !== undefined) await onChanged();
    return r;
  };
  const roleName = (id: string) => roles.find((r) => r.id === id)?.name ?? id;

  return (
    <Drawer title={u.name} sub={u.email} onClose={onClose} wide>
      <div className="grid gap-5 text-[13px]">
        <Facts
          rows={[
            [t('Roles', 'Doorarka'), u.roles.map(roleName).join(', ')],
            [t('Branch', 'Laanta'), branches.find((b) => b.id === u.branchId)?.name ?? t('Whole hospital', 'Isbitaalka oo dhan')],
            [t('Status', 'Xaalad'), lang === 'so' ? STATUS[u.status]?.[1] : STATUS[u.status]?.[0]],
            [t('Authenticator', 'Xaqiijiye'), u.mfaEnrolled ? t('Set up', 'Waa la dejiyay') : t('Not set up', 'Lama dejin')],
            [t('Active since', 'Laga bilaabo'), u.activatedAt ? fmtDate(u.activatedAt, lang) : null],
          ]}
        />
        <div>
          <h3 className="mb-2 text-[14px] font-bold">{t('What they can do', 'Waxa ay samayn karaan')}</h3>
          <AccessList roles={u.roles} />
        </div>

        {canEdit && editing ? (
          <div className="grid gap-3 rounded-xl border border-line p-3">
            <b>{t('Change roles', 'Beddel doorarka')}</b>
            <RolePicker roles={roles} value={sel} onChange={setSel} />
            {isBranchBound(effectiveScope(sel)) ? (
              <select className="input" value={branchId} onChange={(e) => setBranchId(e.target.value)} aria-label={t('Branch', 'Laanta')}>
                <option value="">{t('Choose branch…', 'Dooro laan…')}</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.code} · {b.name}
                  </option>
                ))}
              </select>
            ) : null}
            <div className="flex gap-2">
              <button
                className="btn btn-primary"
                disabled={!sel.length || act.busy}
                onClick={async () => {
                  if ((await go(() => api(`/users/${u.id}/roles`, { method: 'PUT', body: { roles: sel, version: u.version, ...(branchId ? { branchId } : {}) } }))) !== undefined) setEditing(false);
                }}
              >
                {t('Save roles', 'Kaydi')}
              </button>
              <button className="btn" onClick={() => setEditing(false)}>
                {t('Cancel', 'Jooji')}
              </button>
            </div>
          </div>
        ) : null}

        {canEdit && !editing ? (
          <div className="flex flex-wrap gap-2">
            {u.status !== 'Invited' ? (
              <button className="btn" onClick={() => setEditing(true)}>
                {t('Change roles', 'Beddel doorarka')}
              </button>
            ) : null}
            {u.status === 'Active' ? (
              <button className="btn" disabled={act.busy} onClick={() => go(() => api(`/users/${u.id}/suspend`, { body: {} }))}>
                {t('Suspend access', 'Hakad gelinta')}
              </button>
            ) : null}
            {u.status === 'Suspended' ? (
              <button className="btn btn-primary" disabled={act.busy} onClick={() => go(() => api(`/users/${u.id}/reactivate`, { body: {} }))}>
                {t('Give access back', 'Dib u celi gelitaanka')}
              </button>
            ) : null}
            {u.status === 'Invited' ? (
              <button
                className="btn"
                disabled={act.busy}
                onClick={async () => {
                  const r = await act.run(() => guarded(() => api<{ invite: { token: string } }>(`/users/${u.id}/reinvite`, { body: {} })));
                  if (r) setInvite(`${window.location.origin}/invite?tenant=${me.tenant?.slug ?? ''}&code=${r.invite.token}`);
                }}
              >
                {t('New invitation link', 'Xiriir casuumad cusub')}
              </button>
            ) : null}
          </div>
        ) : null}
        {invite ? <code className="break-all rounded-lg bg-surface-2 px-3 py-2 font-mono text-[12px]">{invite}</code> : null}

        {canEdit && u.mfaEnrolled ? (
          <div className="grid gap-2 rounded-xl border border-line p-3">
            <b>{t('Lost authenticator', 'Xaqiijiye lumay')}</b>
            {u.mfaReset ? (
              <>
                <p className="text-ink-2">
                  {t('Reset asked by', 'Waxaa codsaday')} {u.mfaReset.requestedByName}: “{u.mfaReset.reason}”
                </p>
                <div className="flex gap-2">
                  <button className="btn btn-primary" disabled={act.busy} onClick={() => go(() => api(`/users/${u.id}/mfa-reset/approve`, { body: {} }))}>
                    {t('Approve reset', 'Ansixi')}
                  </button>
                  <button className="btn" disabled={act.busy} onClick={() => go(() => api(`/users/${u.id}/mfa-reset/cancel`, { body: {} }))}>
                    {t('Cancel request', 'Jooji codsiga')}
                  </button>
                </div>
                <span className="text-[12px] text-ink-3">{t('A different administrator from the one who asked must approve.', 'Maamule ka duwan kii codsaday ayaa ansixinaya.')}</span>
              </>
            ) : (
              <div className="flex gap-2">
                <input className="input h-9 flex-1" placeholder={t('Reason, e.g. lost phone', 'Sababta, tus. telefoon lumay')} value={reason} onChange={(e) => setReason(e.target.value)} />
                <button className="btn" disabled={reason.trim().length < 3 || act.busy} onClick={() => go(() => api(`/users/${u.id}/mfa-reset`, { body: { reason } }))}>
                  {t('Ask for reset', 'Codso')}
                </button>
              </div>
            )}
          </div>
        ) : null}
        <ErrorNote error={act.error} />
      </div>
    </Drawer>
  );
}
