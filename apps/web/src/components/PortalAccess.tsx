'use client';

import { useCallback, useEffect, useState } from 'react';
import { Copy, Smartphone } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { canDo, useMe } from '@/lib/session';
import { Card, ErrorNote, Field, Pill, fieldErrors, useAction } from './ui';

interface Account {
  id: string;
  name: string;
  email: string;
  role: string;
  relationship: string;
  status: string;
  approved: boolean;
}
const REL: Record<string, [string, string]> = {
  self: ['The patient', 'Bukaanka'],
  parent: ['Parent', 'Waalid'],
  guardian: ['Guardian', 'Mas’uul'],
  spouse: ['Spouse', 'Xaas'],
  child: ['Adult child', 'Ilmo weyn'],
  other: ['Other carer', 'Daryeele kale'],
};

/** Patient portal access on the patient record: invite, approve caregiver access, revoke. */
export function PortalAccess({ patientId }: { patientId: string }) {
  const { me } = useMe();
  const { t, lang } = useLang();
  const [list, setList] = useState<Account[]>([]);
  const [form, setForm] = useState({ email: '', name: '', relationship: 'self' });
  const [invite, setInvite] = useState<{ token: string; expiresAt: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const act = useAction();
  const fe = fieldErrors(act.error);
  const canEdit = canDo(me, 'mpi', 'E');
  const canApprove = canDo(me, 'mpi', 'A');

  const load = useCallback(() => api<Account[]>(`/portal-accounts?patientId=${patientId}`).then(setList).catch(() => {}), [patientId]);
  useEffect(() => {
    void load();
  }, [load]);

  const link = invite && typeof window !== 'undefined' ? `${window.location.origin}/invite?tenant=${me.tenant?.slug ?? ''}&code=${invite.token}` : '';

  return (
    <Card title={t('Patient portal', 'Bogga bukaanka')}>
      <div className="grid gap-3 px-4 pb-4 text-[13px]">
        {list.length ? (
          <ul className="grid gap-1.5">
            {list.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-line px-3 py-2">
                <span className="min-w-0 flex-1">
                  <b className="block truncate">{a.name}</b>
                  <span className="text-[12px] text-ink-3">
                    {lang === 'so' ? REL[a.relationship]?.[1] : REL[a.relationship]?.[0]} · {a.email}
                  </span>
                </span>
                {!a.approved ? (
                  <Pill tone="warn">{t('Needs approval', 'Sugaya oggolaansho')}</Pill>
                ) : a.status === 'Active' ? (
                  <Pill tone="ok">{t('Active', 'Firfircoon')}</Pill>
                ) : (
                  <Pill tone="info">{t('Invited', 'La casuumay')}</Pill>
                )}
                {!a.approved && canApprove ? (
                  <button
                    className="btn h-7 px-2 text-xs"
                    disabled={act.busy}
                    onClick={async () => {
                      const r = await act.run(() => api<{ invite: { token: string; expiresAt: string } | null }>(`/portal-accounts/${a.id}/approve`, { body: { patientId } }));
                      if (r) {
                        setInvite(r.invite);
                        await load();
                      }
                    }}
                  >
                    {t('Approve', 'Oggolow')}
                  </button>
                ) : null}
                {canEdit ? (
                  <button
                    className="btn h-7 px-2 text-xs"
                    disabled={act.busy}
                    onClick={async () => {
                      if (!window.confirm(t('Remove this person’s access to the record?', 'Ka saar gelitaanka qofkan?'))) return;
                      if ((await act.run(() => api(`/portal-accounts/${a.id}/revoke`, { body: { patientId } }))) !== undefined) await load();
                    }}
                  >
                    {t('Remove', 'Ka saar')}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-ink-3">{t('No portal access yet.', 'Weli gelitaan bog ma jiro.')}</p>
        )}

        {invite ? (
          <div className="grid gap-2 rounded-lg bg-accent-soft/50 p-3">
            <b>{t('Give this activation link to the person', 'Sii qofka xiriirkan hawlgelinta')}</b>
            <code className="break-all rounded bg-surface px-2 py-1.5 font-mono text-[11.5px]">{link}</code>
            <button className="btn h-8 justify-self-start px-2.5 text-xs" onClick={() => void navigator.clipboard?.writeText(link)}>
              <Copy size={14} />
              {t('Copy link', 'Koobi garee')}
            </button>
            <span className="text-[12px] text-ink-3">{t('Valid for 7 days. It works once.', 'Wuxuu shaqaynayaa 7 maalmood, hal mar.')}</span>
          </div>
        ) : null}

        {canEdit && adding ? (
          <form
            className="grid gap-2.5 rounded-lg border border-line p-3"
            onSubmit={async (e) => {
              e.preventDefault();
              const r = await act.run(() => api<{ invite: { token: string; expiresAt: string } | null; needsApproval: boolean }>('/portal-accounts', { body: { ...form, patientId } }));
              if (r) {
                setInvite(r.invite);
                setAdding(false);
                setForm({ email: '', name: '', relationship: 'self' });
                await load();
              }
            }}
          >
            <Field label={t('Who is it for?', 'Yaa leh?')}>
              <select className="input" value={form.relationship} onChange={(e) => setForm({ ...form, relationship: e.target.value })}>
                {Object.entries(REL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {lang === 'so' ? v[1] : v[0]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('Full name', 'Magaca oo buuxa')} error={fe.name}>
              <input className="input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label={t('Email', 'Iimayl')} error={fe.email}>
              <input className="input" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </Field>
            {form.relationship !== 'self' ? <p className="text-[12px] text-warn">{t('Carer access must be approved by a records officer before it works.', 'Gelitaanka daryeelaha waa in sarkaalka diiwaanka uu oggolaado.')}</p> : null}
            {Object.keys(fe).length ? null : <ErrorNote error={act.error} />}
            <div className="flex gap-2">
              <button className="btn btn-primary h-8 px-3 text-xs" disabled={act.busy}>
                {t('Send invitation', 'Dir casuumadda')}
              </button>
              <button type="button" className="btn h-8 px-3 text-xs" onClick={() => setAdding(false)}>
                {t('Cancel', 'Jooji')}
              </button>
            </div>
          </form>
        ) : canEdit ? (
          <button className="btn h-8 justify-self-start px-2.5 text-xs" onClick={() => setAdding(true)}>
            <Smartphone size={14} />
            {t('Give portal access', 'Sii gelitaanka bogga')}
          </button>
        ) : null}
        {!adding ? <ErrorNote error={act.error} /> : null}
      </div>
    </Card>
  );
}
