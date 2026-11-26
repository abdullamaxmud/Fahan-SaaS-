'use client';

import { useCallback, useEffect, useState } from 'react';
import { PackagePlus } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { canDo, useMe } from '@/lib/session';
import { InventoryActions } from '@/components/InventoryActions';
import { Card, ErrorNote, Field, PageHeader, Pill, fieldErrors, useAction } from '@/components/ui';

interface Store {
  id: string;
  code: string;
  name: string;
  kind: string;
}
interface Row {
  itemId: string;
  code: string;
  name: string;
  unit: string;
  usable: number;
  expired: number;
  low: boolean;
  lots: { id: string; batch: string; expiry: string; quantity: number; status: string }[];
}
interface Item {
  id: string;
  code: string;
  name: string;
}

export default function InventoryPage() {
  const { me } = useMe();
  const { t } = useLang();
  const [stores, setStores] = useState<Store[]>([]);
  const [storeId, setStoreId] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [rcv, setRcv] = useState({ itemId: '', batch: '', expiry: '', quantity: '' });
  const [move, setMove] = useState({ itemId: '', toStoreId: '', quantity: '' });
  const load = useAction();
  const act = useAction();
  const editor = canDo(me, 'inv', 'E');

  const refresh = useCallback(async () => {
    await load.run(async () => {
      const s = await api<Store[]>('/inventory/stores');
      setStores(s);
      const sid = storeId || s[0]?.id || '';
      setStoreId(sid);
      if (sid) setRows(await api<Row[]>(`/inventory/stock?storeId=${sid}`));
      setItems(await api<Item[]>('/inventory/items'));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const run = async (fn: () => Promise<unknown>) => {
    if ((await act.run(fn)) !== undefined) await refresh();
  };
  const fe = fieldErrors(act.error);

  return (
    <>
      <PageHeader title={t('Inventory', 'Kaydka')}>
        {t('Stock by store, batch and expiry date.', 'Kaydka bakhaar, dufcad iyo taariikh dhicitaan.')}
      </PageHeader>
      <div className="flex flex-wrap gap-1.5" role="tablist">
        {stores.map((s) => (
          <button key={s.id} role="tab" aria-selected={storeId === s.id} onClick={() => setStoreId(s.id)} className={`h-9 rounded-[9px] border px-3 text-[13px] font-semibold ${storeId === s.id ? 'border-ink bg-ink text-surface' : 'border-line'}`}>
            {s.code} · {s.name}
          </button>
        ))}
      </div>
      <ErrorNote error={load.error ?? (Object.keys(fe).length ? null : act.error)} />
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card title={t('Stock', 'Kaydka')}>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className="th">{t('Item', 'Shayga')}</th>
                  <th className="th text-right">{t('Usable', 'La isticmaali karo')}</th>
                  <th className="th">{t('Batches', 'Dufcadaha')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.itemId}>
                    <td className="td">
                      <b className="block">{r.name}</b>
                      <span className="font-mono text-[11.5px] text-ink-3">{r.code}</span>
                      {r.low ? <Pill tone="warn">{t('low', 'yar')}</Pill> : null}
                      {r.expired ? <Pill tone="crit">{r.expired} {t('expired', 'dhacay')}</Pill> : null}
                    </td>
                    <td className="td num text-right font-semibold">
                      {r.usable} <span className="font-normal text-ink-3">{r.unit}</span>
                    </td>
                    <td className="td">
                      <div className="flex flex-wrap gap-1">
                        {r.lots.map((l) => (
                          <Pill key={l.id} tone={l.status === 'expired' ? 'crit' : l.status === 'expiring' ? 'warn' : 'plain'}>
                            {l.batch} · {l.expiry} · {l.quantity}
                          </Pill>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
                {!rows.length ? (
                  <tr>
                    <td className="td text-ink-3" colSpan={3}>
                      {t('This store is empty.', 'Bakhaarkan waa madhan yahay.')}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </Card>
        {editor ? (
          <div className="grid gap-4">
            <Card title={t('Receive stock', 'Qaabil kayd')}>
              <form
                className="grid gap-2 px-4 pb-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(() => api('/inventory/receive', { body: { storeId, itemId: rcv.itemId, batch: rcv.batch, expiry: rcv.expiry, quantity: Number(rcv.quantity) } }));
                }}
              >
                <select className="input h-9" required value={rcv.itemId} onChange={(e) => setRcv({ ...rcv, itemId: e.target.value })} aria-label="Item">
                  <option value="">{t('Choose item…', 'Dooro shay…')}</option>
                  {items.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.code} · {i.name}
                    </option>
                  ))}
                </select>
                <div className="grid grid-cols-3 gap-2">
                  <Field label={t('Batch', 'Dufcad')}>
                    <input className="input h-9" required value={rcv.batch} onChange={(e) => setRcv({ ...rcv, batch: e.target.value })} />
                  </Field>
                  <Field label={t('Expiry', 'Dhicitaan')} error={fe.expiry}>
                    <input className="input h-9" type="date" required value={rcv.expiry} onChange={(e) => setRcv({ ...rcv, expiry: e.target.value })} />
                  </Field>
                  <Field label={t('Quantity', 'Tiro')}>
                    <input className="input h-9" inputMode="numeric" required value={rcv.quantity} onChange={(e) => setRcv({ ...rcv, quantity: e.target.value })} />
                  </Field>
                </div>
                <button className="btn btn-primary justify-self-start">
                  <PackagePlus size={16} />
                  {t('Receive', 'Qaabil')}
                </button>
              </form>
            </Card>
            <Card title={t('Transfer to another store', 'U wareeji bakhaar kale')}>
              <form
                className="grid gap-2 px-4 pb-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(() => api('/inventory/transfer', { body: { fromStoreId: storeId, toStoreId: move.toStoreId, itemId: move.itemId, quantity: Number(move.quantity) } }));
                }}
              >
                <select className="input h-9" required value={move.itemId} onChange={(e) => setMove({ ...move, itemId: e.target.value })} aria-label="Item">
                  <option value="">{t('Choose item…', 'Dooro shay…')}</option>
                  {rows.map((r) => (
                    <option key={r.itemId} value={r.itemId}>
                      {r.name} ({r.usable})
                    </option>
                  ))}
                </select>
                <div className="grid grid-cols-2 gap-2">
                  <select className="input h-9" required value={move.toStoreId} onChange={(e) => setMove({ ...move, toStoreId: e.target.value })} aria-label="To store">
                    <option value="">{t('To store…', 'Bakhaarka…')}</option>
                    {stores.filter((s) => s.id !== storeId).map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.code}
                      </option>
                    ))}
                  </select>
                  <input className="input h-9" inputMode="numeric" required placeholder={t('Quantity', 'Tiro')} value={move.quantity} onChange={(e) => setMove({ ...move, quantity: e.target.value })} />
                </div>
                <button className="btn justify-self-start">{t('Transfer (earliest expiry first)', 'Wareeji')}</button>
              </form>
            </Card>
            <InventoryActions storeId={storeId} rows={rows} onDone={refresh} />
          </div>
        ) : null}
      </div>
    </>
  );
}
