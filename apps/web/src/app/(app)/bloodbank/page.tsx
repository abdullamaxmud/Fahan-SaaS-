'use client';

import { useCallback, useEffect, useState } from 'react';
import { Droplet } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { canDo, useMe } from '@/lib/session';
import { Card, ErrorNote, PageHeader, Pill, useAction } from '@/components/ui';

interface Unit {
  id: string;
  unitNumber: string;
  group: string;
  component: string;
  volumeMl: number;
  expiry: string;
  status: string;
  expired: boolean;
}
interface Req {
  id: string;
  component: string;
  units: number;
  indication: string;
  urgency: string;
  status: string;
  recipientGroup?: string;
  unitIds: string[];
}

const GROUPS = ['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+'];

export default function BloodBankPage() {
  const { me } = useMe();
  const { t } = useLang();
  const [units, setUnits] = useState<Unit[]>([]);
  const [reqs, setReqs] = useState<Req[]>([]);
  const [pick, setPick] = useState<Record<string, string[]>>({});
  const [form, setForm] = useState({ unitNumber: '', group: 'O+', component: 'red-cells', volumeMl: '280', collectedOn: '', expiry: '' });
  const load = useAction();
  const act = useAction();
  const staff = canDo(me, 'bb', 'S');

  const refresh = useCallback(async () => {
    await load.run(async () => {
      setUnits(await api<Unit[]>('/bloodbank/units'));
      if (staff) setReqs(await api<Req[]>('/bloodbank/requests'));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const run = async (fn: () => Promise<unknown>) => {
    if ((await act.run(fn)) !== undefined) await refresh();
  };
  const available = units.filter((u) => u.status === 'Available' && !u.expired);

  return (
    <>
      <PageHeader title={t('Blood bank', 'Bangiga dhiigga')}>
        {t('Blood units, crossmatch and transfusions.', 'Dhiigga, isku-eegidda iyo ku-shubidda.')}
      </PageHeader>
      <div className="grid grid-cols-4 gap-2 sm:grid-cols-8">
        {GROUPS.map((g) => (
          <div key={g} className="card grid justify-items-center p-2">
            <span className="font-display text-lg font-bold">{g}</span>
            <span className="num text-xs text-ink-2">{available.filter((u) => u.group === g).length}</span>
          </div>
        ))}
      </div>
      <ErrorNote error={load.error ?? act.error} />
      {act.error && (act.error as { body?: { details?: { path?: string; message: string }[] } }).body?.details?.length ? (
        <ul className="rounded-[10px] bg-warn-soft px-4 py-2.5 text-[13px] text-warn">
          {(act.error as { body: { details: { path?: string; message: string }[] } }).body.details.map((d) => (
            <li key={(d.path ?? '') + d.message}>
              • {d.path ? `${d.path}: ` : ''}
              {d.message}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        {staff ? (
          <Card title={t('Requests', 'Codsiyada')}>
            <ul className="grid text-[13px]">
              {reqs.map((r) => (
                <li key={r.id} className="grid gap-2 border-t border-line px-4 py-3 first:border-t-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Droplet size={16} className="text-crit" />
                    <b>
                      {r.units} × {r.component}
                    </b>
                    <Pill tone={r.urgency === 'emergency' ? 'crit' : r.urgency === 'urgent' ? 'warn' : 'plain'}>{r.urgency}</Pill>
                    {r.recipientGroup ? <Pill tone="acc">{r.recipientGroup}</Pill> : null}
                    <span className="ml-auto">
                      <Pill tone="info">{r.status}</Pill>
                    </span>
                  </div>
                  <span className="text-ink-2">{r.indication}</span>
                  {['Requested', 'Matched'].includes(r.status) ? (
                    <div className="flex flex-wrap gap-1.5">
                      {available
                        .filter((u) => u.component === r.component)
                        .map((u) => {
                          const on = (pick[r.id] ?? []).includes(u.id);
                          return (
                            <button key={u.id} className={`h-7 rounded-md border px-2 font-mono text-xs ${on ? 'border-accent bg-accent text-on-accent' : 'border-line-2'}`} onClick={() => setPick({ ...pick, [r.id]: on ? (pick[r.id] ?? []).filter((x) => x !== u.id) : [...(pick[r.id] ?? []), u.id] })}>
                              {u.group} · {u.unitNumber}
                            </button>
                          );
                        })}
                      <button className="btn btn-primary h-7 px-2.5 text-xs" disabled={!(pick[r.id] ?? []).length} onClick={() => run(() => api(`/bloodbank/requests/${r.id}/crossmatch`, { body: { unitIds: pick[r.id] } }))}>
                        {t('Crossmatch', 'Isku-eeg')}
                      </button>
                    </div>
                  ) : null}
                  {r.status === 'Matched' || r.status === 'Issued' ? (
                    <div className="flex flex-wrap gap-1.5">
                      {units
                        .filter((u) => r.unitIds.includes(u.id) && u.status === 'Reserved')
                        .map((u) => (
                          <button key={u.id} className="btn h-7 px-2.5 text-xs" onClick={() => run(() => api(`/bloodbank/requests/${r.id}/issue`, { body: { unitId: u.id } }))}>
                            {t('Issue', 'Bixi')} {u.unitNumber}
                          </button>
                        ))}
                    </div>
                  ) : null}
                </li>
              ))}
              {!reqs.length ? <li className="px-4 pb-4 text-ink-3">{t('No open requests.', 'Codsi furan ma jiro.')}</li> : null}
            </ul>
          </Card>
        ) : null}
        <div className="grid gap-4">
          <Card title={t('Units', 'Unugyada')}>
            <ul className="grid text-[13px]">
              {units.map((u) => (
                <li key={u.id} className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-1.5 first:border-t-0">
                  <span className="font-mono">{u.unitNumber}</span>
                  <b>{u.group}</b>
                  <span className="text-ink-2">{u.component}</span>
                  <span className="ml-auto flex items-center gap-2">
                    <span className={`num text-xs ${u.expired ? 'text-crit' : 'text-ink-3'}`}>{u.expiry}</span>
                    <Pill tone={u.status === 'Available' ? 'ok' : u.status === 'Transfused' ? 'plain' : 'info'}>{u.status}</Pill>
                  </span>
                </li>
              ))}
            </ul>
          </Card>
          {staff ? (
            <Card title={t('Receive unit', 'Qaabil unug')}>
              <form
                className="grid gap-2 px-4 pb-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(() => api('/bloodbank/units', { body: { ...form, volumeMl: Number(form.volumeMl) } }));
                }}
              >
                <input className="input h-9 font-mono uppercase" required placeholder={t('Unit number', 'Lambarka')} value={form.unitNumber} onChange={(e) => setForm({ ...form, unitNumber: e.target.value })} />
                <div className="grid grid-cols-3 gap-2">
                  <select className="input h-9" value={form.group} onChange={(e) => setForm({ ...form, group: e.target.value })} aria-label="Group">
                    {GROUPS.map((g) => (
                      <option key={g}>{g}</option>
                    ))}
                  </select>
                  <select className="input h-9" value={form.component} onChange={(e) => setForm({ ...form, component: e.target.value })} aria-label="Component">
                    {['red-cells', 'plasma', 'platelets', 'cryo', 'whole-blood'].map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                  <input className="input h-9" inputMode="numeric" value={form.volumeMl} onChange={(e) => setForm({ ...form, volumeMl: e.target.value })} aria-label="Volume ml" />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <input className="input h-9" type="date" required value={form.collectedOn} onChange={(e) => setForm({ ...form, collectedOn: e.target.value })} aria-label="Collected on" />
                  <input className="input h-9" type="date" required value={form.expiry} onChange={(e) => setForm({ ...form, expiry: e.target.value })} aria-label="Expiry" />
                </div>
                <button className="btn btn-primary justify-self-start">{t('Receive', 'Qaabil')}</button>
              </form>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
