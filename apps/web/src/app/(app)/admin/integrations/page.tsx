'use client';

import { useCallback, useEffect, useState } from 'react';
import { FlaskConical, KeyRound, Plug, Power, PowerOff } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { canDo, useMe } from '@/lib/session';
import { useReauth } from '@/components/Reauth';
import { Card, ErrorNote, Field, PageHeader, Pill, fieldErrors, useAction } from '@/components/ui';

interface Client {
  id: string;
  clientId: string;
  name: string;
  scopes: string[];
  branchIds: string[];
  status: string;
  testReport: { at: string; checked: number; passed: boolean; errors: string[] } | null;
  lastTokenAt: string | null;
  history: { at: string; action: string; byName: string; note: string | null }[];
}
interface Branch { id: string; code: string; name: string }

const TYPES = ['Patient', 'Encounter', 'Condition', 'Observation', 'DiagnosticReport', 'ServiceRequest', 'MedicationRequest', 'Appointment', 'Practitioner'];
const tone = (s: string) => (s === 'Enabled' ? 'ok' : s === 'Suspended' ? 'crit' : s === 'Tested' ? 'info' : 'plain');

export default function IntegrationsPage() {
  const { me } = useMe();
  const { t } = useLang();
  const { guarded, dialog } = useReauth();
  const [clients, setClients] = useState<Client[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [form, setForm] = useState({ name: '', all: true, types: [] as string[], branchIds: [] as string[] });
  const [secret, setSecret] = useState<null | { clientId: string; secret: string }>(null);
  const load = useAction();
  const act = useAction();
  const admin = canDo(me, 'intg', 'A');

  const refresh = useCallback(async () => {
    await load.run(async () => {
      setClients(await api<Client[]>('/integrations/clients'));
      if (admin) setBranches(await api<Branch[]>('/integrations/branches'));
    });
  }, [admin]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const run = async (fn: () => Promise<unknown>) => {
    const out = await act.run(fn);
    if (out !== undefined) await refresh();
    return out;
  };
  const fe = fieldErrors(act.error);
  const base = typeof window !== 'undefined' ? `${window.location.origin}/api/v1/fhir/${me.tenant?.slug ?? '<hospital>'}` : '';

  return (
    <>
      {dialog}
      <PageHeader title={t('Integrations', 'Isku-xirka')}>
        {t('Partner systems that read hospital data.', 'Nidaamyada kale ee xogta akhriya.')}
      </PageHeader>
      <ErrorNote error={load.error ?? (Object.keys(fe).length ? null : act.error)} />
      {secret ? (
        <div role="alert" className="rounded-[12px] border border-warn bg-warn-soft p-4 text-[13px]">
          <b className="block">{t('Copy these now — the secret is shown once.', 'Hadda koobiyee — sirta mar keliya ayaa la muujiyaa.')}</b>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[12px]">
            <dt>client_id</dt>
            <dd className="break-all">{secret.clientId}</dd>
            <dt>client_secret</dt>
            <dd className="break-all">{secret.secret}</dd>
            <dt>token URL</dt>
            <dd className="break-all">{base}/auth/token</dd>
          </dl>
          <button className="btn mt-3 h-8" onClick={() => setSecret(null)}>
            {t('I have stored it', 'Waan kaydiyay')}
          </button>
        </div>
      ) : null}
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card title={t('API clients', 'Macaamiisha API')}>
          <ul className="grid gap-2 px-4 pb-4 text-[13px]">
            {clients.map((c) => (
              <li key={c.id} className="rounded-[10px] border border-line p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Plug size={15} />
                  <b>{c.name}</b>
                  <Pill tone={tone(c.status)}>{c.status}</Pill>
                  <span className="ml-auto font-mono text-[11px] text-ink-3">{c.clientId}</span>
                </div>
                <p className="mt-1 text-ink-2">
                  {c.scopes.join(' ')}
                  {c.branchIds.length ? ` · ${t('branches', 'laamaha')}: ${c.branchIds.map((b) => branches.find((x) => x.id === b)?.code ?? b.slice(-4)).join(', ')}` : ` · ${t('all branches', 'dhammaan laamaha')}`}
                  {c.lastTokenAt ? ` · ${t('last token', 'tokenkii u dambeeyay')} ${new Date(c.lastTokenAt).toLocaleString()}` : ''}
                </p>
                {c.testReport ? (
                  <p className={`mt-1 text-[12px] ${c.testReport.passed ? 'text-ok' : 'text-crit'}`}>
                    {t('Conformance', 'Hubinta')}: {c.testReport.passed ? t('passed', 'wuu gudbay') : t('failed', 'wuu fashilmay')} · {c.testReport.checked} {t('resources checked', 'kheyraad la hubiyay')}
                    {c.testReport.errors.slice(0, 3).map((e) => (
                      <span key={e} className="block font-mono text-[11px]">
                        {e}
                      </span>
                    ))}
                  </p>
                ) : null}
                {admin ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {c.status !== 'Enabled' ? (
                      <button className="btn h-8" onClick={() => run(() => api(`/integrations/clients/${c.id}/test`, { body: {} }))}>
                        <FlaskConical size={14} /> {t('Run conformance test', 'Tijaabi')}
                      </button>
                    ) : null}
                    {['Tested', 'Suspended'].includes(c.status) && c.testReport?.passed ? (
                      <button className="btn btn-primary h-8" onClick={() => run(() => guarded(() => api(`/integrations/clients/${c.id}/enable`, { body: {} })))}>
                        <Power size={14} /> {t('Enable', 'Shid')}
                      </button>
                    ) : null}
                    {c.status === 'Enabled' ? (
                      <button className="btn h-8 text-crit" onClick={() => { const reason = prompt(t('Why suspend this client?', 'Maxaa loo joojinayaa?')); if (reason) void run(() => api(`/integrations/clients/${c.id}/suspend`, { body: { reason } })); }}>
                        <PowerOff size={14} /> {t('Suspend', 'Jooji')}
                      </button>
                    ) : null}
                    <button
                      className="btn h-8"
                      onClick={async () => {
                        const r = await run(() => guarded(() => api<{ clientSecret: string }>(`/integrations/clients/${c.id}/rotate`, { body: {} })));
                        if (r) setSecret({ clientId: c.clientId, secret: (r as { clientSecret: string }).clientSecret });
                      }}
                    >
                      <KeyRound size={14} /> {t('Rotate secret', 'Beddel sirta')}
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
            {!clients.length ? <li className="text-ink-3">{t('No API clients yet.', 'Weli ma jiraan.')}</li> : null}
          </ul>
        </Card>

        {admin ? (
          <Card title={t('Register a client', 'Diiwaangeli macmiil')}>
            <form
              className="grid gap-3 px-4 pb-4 text-[13px]"
              onSubmit={async (e) => {
                e.preventDefault();
                const scopes = form.all ? ['system/*.read'] : form.types.map((x) => `system/${x}.read`);
                const r = await run(() => guarded(() => api<Client & { clientSecret: string }>('/integrations/clients', { body: { name: form.name, scopes, branchIds: form.branchIds } })));
                if (r) {
                  const c = r as Client & { clientSecret: string };
                  setSecret({ clientId: c.clientId, secret: c.clientSecret });
                  setForm({ name: '', all: true, types: [], branchIds: [] });
                }
              }}
            >
              <Field label={t('Name', 'Magaca')} error={fe.name}>
                <input className="input h-9" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Regional HIE" />
              </Field>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={form.all} onChange={(e) => setForm({ ...form, all: e.target.checked })} />
                {t('Read every resource type', 'Akhri dhammaan noocyada')}
              </label>
              {!form.all ? (
                <div className="flex flex-wrap gap-2">
                  {TYPES.map((x) => (
                    <label key={x} className="flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[12px]">
                      <input type="checkbox" checked={form.types.includes(x)} onChange={(e) => setForm({ ...form, types: e.target.checked ? [...form.types, x] : form.types.filter((y) => y !== x) })} />
                      {x}
                    </label>
                  ))}
                </div>
              ) : null}
              <div>
                <span className="text-[12.5px] font-medium text-ink-2">{t('Limit to branches (none = all)', 'Xaddid laamaha')}</span>
                <div className="mt-1 flex flex-wrap gap-2">
                  {branches.map((b) => (
                    <label key={b.id} className="flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[12px]">
                      <input type="checkbox" checked={form.branchIds.includes(b.id)} onChange={(e) => setForm({ ...form, branchIds: e.target.checked ? [...form.branchIds, b.id] : form.branchIds.filter((y) => y !== b.id) })} />
                      {b.code}
                    </label>
                  ))}
                </div>
              </div>
              <button className="btn btn-primary h-9 justify-self-start" disabled={!form.all && !form.types.length}>
                {t('Register', 'Diiwaangeli')}
              </button>
              <p className="text-[12px] text-ink-3">
                {t('FHIR base URL', 'Cinwaanka FHIR')}: <span className="break-all font-mono">{base}</span> · <span className="font-mono">/metadata</span> {t('describes what is served.', 'ayaa sharxaya.')}
              </p>
            </form>
          </Card>
        ) : null}
      </div>
    </>
  );
}
