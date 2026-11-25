'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Ambulance, Send } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { canDo, useMe } from '@/lib/session';
import { Card, ErrorNote, Field, PageHeader, Pill, statusTone, useAction } from '@/components/ui';

interface Referral {
  id: string;
  direction: string;
  status: string;
  priority: string;
  fromFacility: string;
  toFacility: string;
  patientSummary?: string;
  reason?: string;
  vehicle: string | null;
  encounterId?: string | null;
}
interface Vehicle {
  id: string;
  code: string;
  kind: string;
  status: string;
}

export default function ReferralsPage() {
  const { me } = useMe();
  const { t } = useLang();
  const [list, setList] = useState<Referral[]>([]);
  const [fleet, setFleet] = useState<Vehicle[]>([]);
  const [form, setForm] = useState({ direction: 'inbound', patientSummary: '', fromFacility: '', toFacility: me.tenant?.name ?? '', reason: '', priority: 'urgent' });
  const [dispatch, setDispatch] = useState<{ id: string; vehicleId: string; crew: string; pickup: string } | null>(null);
  const [handover, setHandover] = useState<{ id: string; encounterId: string } | null>(null);
  const load = useAction();
  const act = useAction();
  const dispatcher = canDo(me, 'amb', 'E') && me.scope !== 'own-record';

  const refresh = useCallback(async () => {
    await load.run(async () => {
      setList(await api<Referral[]>('/referrals?status=all'));
      if (dispatcher) setFleet(await api<Vehicle[]>('/ambulance/vehicles'));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const run = async (fn: () => Promise<unknown>) => {
    if ((await act.run(fn)) !== undefined) await refresh();
  };

  return (
    <>
      <PageHeader eyebrow="Spec §5.25" title={t('Referrals & ambulance', 'Gudbinta & ambalaas')}>
        {me.scope === 'own-record'
          ? t('Referrals you sent and their status.', 'Gudbinta aad dirtay iyo xaaladdooda.')
          : t('A vehicle can only be on one run. Handover links the referral to the receiving emergency visit.', 'Gaari wuxuu qaadi karaa hal safar.')}
      </PageHeader>
      <ErrorNote error={load.error ?? act.error} />
      {dispatcher ? (
        <div className="flex flex-wrap gap-2">
          {fleet.map((v) => (
            <span key={v.id} className="card flex items-center gap-2 px-3 py-2 text-[13px]">
              <Ambulance size={16} />
              <b className="font-mono">{v.code}</b>
              <Pill tone={v.status === 'Available' ? 'ok' : v.status === 'OnRun' ? 'warn' : 'crit'}>{v.status}</Pill>
            </span>
          ))}
        </div>
      ) : null}
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card title={t('Referrals', 'Gudbinta')}>
          <ul className="grid text-[13px]">
            {list.map((r) => (
              <li key={r.id} className="grid gap-2 border-t border-line px-4 py-3 first:border-t-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Pill tone={r.priority === 'emergency' ? 'crit' : r.priority === 'urgent' ? 'warn' : 'plain'}>{r.priority}</Pill>
                  <b>
                    {r.fromFacility} → {r.toFacility}
                  </b>
                  <span className="ml-auto flex items-center gap-2">
                    {r.vehicle ? <span className="font-mono text-xs">{r.vehicle}</span> : null}
                    <Pill tone={statusTone(r.status === 'HandedOver' ? 'Active' : r.status === 'Cancelled' ? 'Suspended' : 'info')}>{r.status}</Pill>
                  </span>
                </div>
                {r.patientSummary ? (
                  <p className="text-ink-2">
                    {r.patientSummary} — {r.reason}
                  </p>
                ) : null}
                {dispatcher ? (
                  <div className="flex flex-wrap gap-1.5">
                    {r.status === 'Requested' ? (
                      <button className="btn btn-primary h-7 px-2.5 text-xs" onClick={() => setDispatch({ id: r.id, vehicleId: fleet.find((v) => v.status === 'Available')?.id ?? '', crew: '', pickup: r.fromFacility })}>
                        {t('Dispatch', 'Dir')}
                      </button>
                    ) : null}
                    {r.status === 'Dispatched' ? (
                      <button className="btn h-7 px-2.5 text-xs" onClick={() => run(() => api(`/referrals/${r.id}/arrive`, { body: {} }))}>
                        {t('Arrived', 'Wuu yimid')}
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {canDo(me, 'er', 'E') && ['Arrived', 'Requested'].includes(r.status) ? (
                  handover?.id === r.id ? (
                    <form
                      className="flex gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void run(() => api(`/referrals/${r.id}/handover`, { body: { encounterId: handover.encounterId } }));
                      }}
                    >
                      <input className="input h-8 font-mono text-xs" required placeholder={t('Emergency visit id', 'Aqoonsiga booqashada')} value={handover.encounterId} onChange={(e) => setHandover({ ...handover, encounterId: e.target.value })} />
                      <button className="btn h-8 text-xs">{t('Link handover', 'Xiriiri')}</button>
                    </form>
                  ) : (
                    <button className="btn h-7 justify-self-start px-2.5 text-xs" onClick={() => setHandover({ id: r.id, encounterId: '' })}>
                      {t('Receive in emergency', 'Ku soo dhowee gurmadka')}
                    </button>
                  )
                ) : null}
                {r.encounterId ? (
                  <Link className="text-xs text-accent-2 underline" href={`/encounters/${r.encounterId}`}>
                    {t('Open receiving visit', 'Fur booqashada')}
                  </Link>
                ) : null}
                {dispatch?.id === r.id ? (
                  <form
                    className="grid gap-2 rounded-[10px] bg-surface-2 p-3"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void run(async () => {
                        const res = await api(`/referrals/${r.id}/dispatch`, { body: { vehicleId: dispatch.vehicleId, crew: dispatch.crew.split(',').map((x) => x.trim()).filter(Boolean), pickup: dispatch.pickup } });
                        setDispatch(null);
                        return res;
                      });
                    }}
                  >
                    <select className="input h-8" value={dispatch.vehicleId} onChange={(e) => setDispatch({ ...dispatch, vehicleId: e.target.value })} aria-label="Vehicle">
                      {fleet.filter((v) => v.status === 'Available').map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.code} · {v.kind}
                        </option>
                      ))}
                    </select>
                    <input className="input h-8" required placeholder={t('Crew names, separated by commas', 'Shaqaalaha')} value={dispatch.crew} onChange={(e) => setDispatch({ ...dispatch, crew: e.target.value })} />
                    <input className="input h-8" required placeholder={t('Pickup point', 'Goobta')} value={dispatch.pickup} onChange={(e) => setDispatch({ ...dispatch, pickup: e.target.value })} />
                    <button className="btn btn-primary h-8 justify-self-start text-xs">{t('Send vehicle', 'Dir gaariga')}</button>
                  </form>
                ) : null}
              </li>
            ))}
            {!list.length ? <li className="px-4 pb-4 text-ink-3">{t('No referrals.', 'Gudbin ma jirto.')}</li> : null}
          </ul>
        </Card>
        {canDo(me, 'amb', 'E') ? (
          <Card title={t('New referral', 'Gudbin cusub')}>
            <form
              className="grid gap-2 px-4 pb-4"
              onSubmit={(e) => {
                e.preventDefault();
                void run(() => api('/referrals', { body: { ...form, branchId: me.branchId } }));
              }}
            >
              <Field label={t('Patient summary (no names needed)', 'Xog kooban')}>
                <input className="input h-9" required minLength={5} value={form.patientSummary} onChange={(e) => setForm({ ...form, patientSummary: e.target.value })} />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label={t('From', 'Laga')}>
                  <input className="input h-9" required value={form.fromFacility} onChange={(e) => setForm({ ...form, fromFacility: e.target.value })} />
                </Field>
                <Field label={t('To', 'Loo')}>
                  <input className="input h-9" required value={form.toFacility} onChange={(e) => setForm({ ...form, toFacility: e.target.value })} />
                </Field>
              </div>
              <Field label={t('Reason', 'Sababta')}>
                <input className="input h-9" required value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
              </Field>
              <select className="input h-9" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} aria-label="Priority">
                {['routine', 'urgent', 'emergency'].map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
              <button className="btn btn-primary justify-self-start" disabled={!me.branchId}>
                <Send size={16} />
                {t('Send referral', 'Dir gudbinta')}
              </button>
            </form>
          </Card>
        ) : null}
      </div>
    </>
  );
}
