'use client';

import { useCallback, useEffect, useState } from 'react';
import { Pill as PillIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { fullName, type PatientBrief } from '@/components/clinical';
import { Card, ErrorNote, PageHeader, Pill, Tabs, useAction } from '@/components/ui';

interface Rx {
  id: string;
  status: string;
  drug: { name: string; strength: string; form: string };
  dose: string;
  frequency: string;
  durationDays: number;
  quantity: number;
  prescriberName: string;
  override: { reason: string; issues: string[] } | null;
  patient: Pick<PatientBrief, 'mrn' | 'names'> | null;
}
interface Store {
  id: string;
  code: string;
  name: string;
  kind: string;
}

function newKey() {
  try {
    return `disp-${crypto.randomUUID()}`;
  } catch {
    return `disp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export default function PharmacyPage() {
  const { t } = useLang();
  const [queue, setQueue] = useState<Rx[]>([]);
  const [tab, setTab] = useState<'open' | 'dispensed'>('open');
  const [ret, setRet] = useState<Record<string, { quantity: string; reason: string }>>({});
  const [stores, setStores] = useState<Store[]>([]);
  const [storeId, setStoreId] = useState('');
  // One idempotency key per prescription, kept across retries so a double click never dispenses twice.
  const [keys, setKeys] = useState<Record<string, string>>({});
  const load = useAction();
  const act = useAction();

  const refresh = useCallback(async () => {
    await load.run(async () => {
      setQueue(await api<Rx[]>(`/pharmacy/queue?status=${tab}`));
      const s = (await api<Store[]>('/inventory/stores')).filter((x) => x.kind === 'pharmacy');
      setStores(s);
      setStoreId((v) => v || s[0]?.id || '');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const run = async (fn: () => Promise<unknown>) => {
    if ((await act.run(fn)) !== undefined) await refresh();
  };

  async function dispense(rx: Rx) {
    const key = keys[rx.id] ?? newKey();
    setKeys({ ...keys, [rx.id]: key });
    await run(() => api(`/pharmacy/prescriptions/${rx.id}/dispense`, { body: { storeId }, headers: { 'idempotency-key': key } }));
  }

  return (
    <>
      <PageHeader title={t('Pharmacy', 'Farmashiyaha')}>
        {t('Verify and dispense prescriptions.', 'Xaqiiji oo bixi daawooyinka.')}
      </PageHeader>
      <div className="flex items-center gap-2 self-start">
        <span className="text-[13px] text-ink-2">{t('Dispense from', 'Laga bixinayo')}</span>
        <select className="input h-9 w-auto" value={storeId} onChange={(e) => setStoreId(e.target.value)} aria-label="Store">
          {stores.map((s) => (
            <option key={s.id} value={s.id}>
              {s.code} · {s.name}
            </option>
          ))}
        </select>
      </div>
      <Tabs<'open' | 'dispensed'>
        value={tab}
        onChange={setTab}
        items={[
          { id: 'open', label: t('To verify and dispense', 'La xaqiijiyo oo la bixiyo') },
          { id: 'dispensed', label: t('Dispensed (returns)', 'La bixiyay (celin)') },
        ]}
      />
      <ErrorNote error={load.error ?? act.error} />
      <Card title={`${tab === 'open' ? t('Queue', 'Safka') : t('Dispensed in the last 7 days', 'La bixiyay 7-dii maalmood')} · ${queue.length}`}>
        <ul className="grid text-[13px]">
          {queue.map((rx) => (
            <li key={rx.id} className="grid gap-1.5 border-t border-line px-4 py-3 first:border-t-0">
              <div className="flex flex-wrap items-center gap-2">
                <PillIcon size={16} className="text-ink-3" />
                <b>
                  {rx.drug.name}
                </b>
                <span className="text-ink-2">
                  {rx.dose} · {rx.frequency} · {rx.durationDays} d · {t('qty', 'tiro')} {rx.quantity}
                </span>
                <span className="ml-auto">
                  <Pill tone={rx.status === 'Verified' ? 'ok' : 'info'}>{rx.status}</Pill>
                </span>
              </div>
              <span className="text-ink-2">
                {rx.patient ? fullName(rx.patient.names) : ''} · <span className="font-mono">{rx.patient?.mrn}</span> · {rx.prescriberName}
              </span>
              {rx.override ? (
                <span className="rounded-md bg-crit-soft px-2 py-1 text-crit">
                  {t('Safety override', 'Ka gudub badbaado')}: {rx.override.issues.join('; ')} — “{rx.override.reason}”
                </span>
              ) : null}
              <div className="flex gap-1.5">
                {rx.status === 'Signed' ? (
                  <button className="btn btn-primary h-7 px-2.5 text-xs" onClick={() => run(() => api(`/pharmacy/prescriptions/${rx.id}/verify`, { body: {} }))}>
                    {t('Verify', 'Xaqiiji')}
                  </button>
                ) : null}
                {rx.status === 'Verified' ? (
                  <button className="btn btn-primary h-7 px-2.5 text-xs" disabled={!storeId || act.busy} onClick={() => dispense(rx)}>
                    {t('Dispense', 'Bixi')}
                  </button>
                ) : null}
                {rx.status === 'Dispensed' ? (
                  <>
                    <input className="input h-7 w-20 text-xs" inputMode="numeric" placeholder={t('Qty', 'Tiro')} value={ret[rx.id]?.quantity ?? ''} onChange={(e) => setRet({ ...ret, [rx.id]: { reason: ret[rx.id]?.reason ?? '', quantity: e.target.value } })} aria-label={t('Quantity returned', 'Tirada la celiyay')} />
                    <input className="input h-7 min-w-0 flex-1 text-xs" placeholder={t('Why returned', 'Sababta celinta')} value={ret[rx.id]?.reason ?? ''} onChange={(e) => setRet({ ...ret, [rx.id]: { quantity: ret[rx.id]?.quantity ?? '', reason: e.target.value } })} />
                    <button className="btn h-7 px-2.5 text-xs" disabled={!Number(ret[rx.id]?.quantity) || (ret[rx.id]?.reason ?? '').length < 3 || act.busy} onClick={() => run(() => api(`/pharmacy/prescriptions/${rx.id}/return`, { body: { quantity: Number(ret[rx.id]!.quantity), reason: ret[rx.id]!.reason } }))}>
                      {t('Return to stock', 'Ku celi kaydka')}
                    </button>
                  </>
                ) : null}
              </div>
            </li>
          ))}
          {!queue.length ? <li className="px-4 pb-4 text-ink-3">{tab === 'open' ? t('Nothing to verify or dispense.', 'Waxba ma sugayaan.') : t('Nothing dispensed in the last 7 days.', 'Waxba lama bixin 7-dii maalmood.')}</li> : null}
        </ul>
      </Card>
    </>
  );
}
