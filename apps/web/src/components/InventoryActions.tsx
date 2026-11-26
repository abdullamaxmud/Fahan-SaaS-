'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { useMe } from '@/lib/session';
import { Card, ErrorNote, Field, Tabs, fieldErrors, useAction } from './ui';

interface Row {
  itemId: string;
  name: string;
  unit: string;
  usable: number;
  lots: { id: string; batch: string; expiry: string; quantity: number }[];
}

type Tab = 'issue' | 'adjust' | 'item' | 'store';

/** Using stock, correcting counts, and adding items or stores. Every movement is kept in the stock history. */
export function InventoryActions({ storeId, rows, onDone }: { storeId: string; rows: Row[]; onDone: () => Promise<void> }) {
  const { me } = useMe();
  const { t } = useLang();
  const [tab, setTab] = useState<Tab>('issue');
  const [issue, setIssue] = useState({ itemId: '', quantity: '', reason: '' });
  const [adj, setAdj] = useState({ lotId: '', delta: '', reason: '' });
  const [item, setItem] = useState({ code: '', name: '', unit: 'each', kind: 'consumable', reorderLevel: '0', ingredient: '', strength: '', form: 'tablet', route: 'oral' });
  const [store, setStore] = useState({ branchId: me.branchId ?? '', code: '', name: '', kind: 'ward' });
  const [branches, setBranches] = useState<{ id: string; code: string; name: string }[]>([]);
  const [ok, setOk] = useState('');
  const act = useAction();
  const fe = fieldErrors(act.error);
  useEffect(() => {
    api<{ id: string; code: string; name: string }[]>('/lookup/branches')
      .then((b) => {
        setBranches(b);
        setStore((s) => ({ ...s, branchId: s.branchId || b[0]?.id || '' }));
      })
      .catch(() => {});
  }, []);
  const go = async (fn: () => Promise<unknown>, msg: string) => {
    setOk('');
    if ((await act.run(fn)) !== undefined) {
      setOk(msg);
      await onDone();
    }
  };
  const lots = rows.flatMap((r) => r.lots.map((l) => ({ ...l, name: r.name })));

  return (
    <Card title={t('More stock actions', 'Tallaabooyin kale')}>
      <div className="grid gap-3 px-4 pb-4">
        <Tabs<Tab>
          value={tab}
          onChange={(v) => {
            setTab(v);
            setOk('');
            act.setError(null);
          }}
          items={[
            { id: 'issue', label: t('Use', 'Isticmaal') },
            { id: 'adjust', label: t('Correct count', 'Sax tirada') },
            { id: 'item', label: t('New item', 'Shay cusub') },
            { id: 'store', label: t('New store', 'Bakhaar cusub') },
          ]}
        />
        {tab === 'issue' ? (
          <form
            className="grid gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void go(() => api('/inventory/issue', { body: { storeId, itemId: issue.itemId, quantity: Number(issue.quantity), reason: issue.reason } }), t('Stock taken out.', 'Kaydka waa la bixiyay.'));
            }}
          >
            <select className="input h-9" required value={issue.itemId} onChange={(e) => setIssue({ ...issue, itemId: e.target.value })} aria-label={t('Item', 'Shay')}>
              <option value="">{t('Choose item…', 'Dooro shay…')}</option>
              {rows.map((r) => (
                <option key={r.itemId} value={r.itemId}>
                  {r.name} ({r.usable} {r.unit})
                </option>
              ))}
            </select>
            <div className="grid grid-cols-[100px_1fr] gap-2">
              <input className="input h-9" inputMode="numeric" required placeholder={t('Qty', 'Tiro')} value={issue.quantity} onChange={(e) => setIssue({ ...issue, quantity: e.target.value })} />
              <input className="input h-9" required minLength={3} placeholder={t('What for, e.g. Ward 3B weekly use', 'Maxaa loo isticmaalay')} value={issue.reason} onChange={(e) => setIssue({ ...issue, reason: e.target.value })} />
            </div>
            <button className="btn justify-self-start" disabled={act.busy}>
              {t('Take out (earliest expiry first)', 'Bixi')}
            </button>
          </form>
        ) : null}
        {tab === 'adjust' ? (
          <form
            className="grid gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void go(() => api('/inventory/adjust', { body: { lotId: adj.lotId, delta: Number(adj.delta), reason: adj.reason } }), t('Count corrected.', 'Tirada waa la saxay.'));
            }}
          >
            <select className="input h-9" required value={adj.lotId} onChange={(e) => setAdj({ ...adj, lotId: e.target.value })} aria-label={t('Batch', 'Dufcad')}>
              <option value="">{t('Choose batch…', 'Dooro dufcad…')}</option>
              {lots.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} · {l.batch} · {l.quantity}
                </option>
              ))}
            </select>
            <div className="grid grid-cols-[120px_1fr] gap-2">
              <input className="input h-9" inputMode="numeric" required placeholder={t('+5 or -3', '+5 ama -3')} value={adj.delta} onChange={(e) => setAdj({ ...adj, delta: e.target.value })} />
              <input className="input h-9" required minLength={5} placeholder={t('Reason, e.g. stock count 26 Nov', 'Sababta')} value={adj.reason} onChange={(e) => setAdj({ ...adj, reason: e.target.value })} />
            </div>
            <button className="btn justify-self-start" disabled={act.busy}>
              {t('Correct count', 'Sax')}
            </button>
          </form>
        ) : null}
        {tab === 'item' ? (
          <form
            className="grid gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const body = {
                code: item.code,
                name: item.name,
                unit: item.unit,
                kind: item.kind,
                reorderLevel: Number(item.reorderLevel) || 0,
                ...(item.kind === 'medicine' ? { medicine: { ingredient: item.ingredient, strength: item.strength, form: item.form, route: item.route, classes: [] } } : {}),
              };
              void go(() => api('/inventory/items', { body }), t('Item added.', 'Shayga waa la daray.'));
            }}
          >
            <div className="grid grid-cols-[120px_1fr] gap-2">
              <Field label={t('Code', 'Koodh')} error={fe.code}>
                <input className="input h-9 font-mono uppercase" required value={item.code} onChange={(e) => setItem({ ...item, code: e.target.value })} />
              </Field>
              <Field label={t('Name', 'Magaca')} error={fe.name}>
                <input className="input h-9" required value={item.name} onChange={(e) => setItem({ ...item, name: e.target.value })} />
              </Field>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <Field label={t('Type', 'Nooca')}>
                <select className="input h-9" value={item.kind} onChange={(e) => setItem({ ...item, kind: e.target.value })}>
                  <option value="medicine">{t('Medicine', 'Daawo')}</option>
                  <option value="consumable">{t('Consumable', 'Agab')}</option>
                  <option value="reagent">{t('Lab reagent', 'Kiimiko')}</option>
                  <option value="other">{t('Other', 'Kale')}</option>
                </select>
              </Field>
              <Field label={t('Unit', 'Halbeeg')}>
                <input className="input h-9" required value={item.unit} onChange={(e) => setItem({ ...item, unit: e.target.value })} />
              </Field>
              <Field label={t('Reorder below', 'Dalbo marka ka yaraado')}>
                <input className="input h-9" inputMode="numeric" value={item.reorderLevel} onChange={(e) => setItem({ ...item, reorderLevel: e.target.value })} />
              </Field>
            </div>
            {item.kind === 'medicine' ? (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <input className="input h-9" required placeholder={t('Ingredient', 'Walaxda')} value={item.ingredient} onChange={(e) => setItem({ ...item, ingredient: e.target.value })} />
                <input className="input h-9" required placeholder={t('Strength, e.g. 500 mg', 'Xoogga')} value={item.strength} onChange={(e) => setItem({ ...item, strength: e.target.value })} />
                <select className="input h-9" value={item.form} onChange={(e) => setItem({ ...item, form: e.target.value })} aria-label={t('Form', 'Qaabka')}>
                  {['tablet', 'capsule', 'syrup', 'injection', 'infusion', 'cream', 'drops', 'inhaler', 'other'].map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
                <select className="input h-9" value={item.route} onChange={(e) => setItem({ ...item, route: e.target.value })} aria-label={t('Route', 'Jidka')}>
                  {['oral', 'iv', 'im', 'sc', 'topical', 'inhaled', 'rectal', 'other'].map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
              </div>
            ) : null}
            <button className="btn justify-self-start" disabled={act.busy}>
              {t('Add item', 'Ku dar')}
            </button>
          </form>
        ) : null}
        {tab === 'store' ? (
          <form
            className="grid gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void go(() => api('/inventory/stores', { body: store }), t('Store added.', 'Bakhaarka waa la daray.'));
            }}
          >
            {branches.length > 1 ? (
              <select className="input h-9" value={store.branchId} onChange={(e) => setStore({ ...store, branchId: e.target.value })} aria-label={t('Branch', 'Laanta')}>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.code} · {b.name}
                  </option>
                ))}
              </select>
            ) : null}
            <div className="grid grid-cols-[120px_1fr_140px] gap-2">
              <input className="input h-9 font-mono uppercase" required placeholder={t('Code', 'Koodh')} value={store.code} onChange={(e) => setStore({ ...store, code: e.target.value })} />
              <input className="input h-9" required placeholder={t('Name', 'Magaca')} value={store.name} onChange={(e) => setStore({ ...store, name: e.target.value })} />
              <select className="input h-9" value={store.kind} onChange={(e) => setStore({ ...store, kind: e.target.value })} aria-label={t('Type', 'Nooca')}>
                <option value="main">{t('Main store', 'Bakhaarka weyn')}</option>
                <option value="pharmacy">{t('Pharmacy', 'Farmashiye')}</option>
                <option value="ward">{t('Ward', 'Qol')}</option>
                <option value="laboratory">{t('Laboratory', 'Shaybaar')}</option>
                <option value="theatre">{t('Theatre', 'Qalliin')}</option>
              </select>
            </div>
            <button className="btn justify-self-start" disabled={act.busy}>
              {t('Add store', 'Ku dar')}
            </button>
          </form>
        ) : null}
        {ok ? <p className="text-[13px] text-ok">{ok}</p> : null}
        {Object.keys(fe).length ? null : <ErrorNote error={act.error} />}
      </div>
    </Card>
  );
}
