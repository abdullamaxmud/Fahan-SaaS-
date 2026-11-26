'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { money } from '@/lib/money';
import { usePortal } from '@/components/PortalShell';
import { Empty, ErrorNote, Pill, useAction } from '@/components/ui';

interface Bill {
  id: string;
  number: string;
  issuedOn: string | null;
  currency: string;
  totalMinor: number;
  paidMinor: number;
  insuranceMinor: number;
  dueMinor: number;
  status: string;
  lines: { description: string; qty: number; amountMinor: number }[];
}

export default function PortalBills() {
  const { current } = usePortal();
  const { t } = useLang();
  const [list, setList] = useState<Bill[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const act = useAction();
  useEffect(() => {
    if (current) void act.run(async () => setList(await api<Bill[]>(`/portal/${current.id}/invoices`)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);
  const due = list.reduce((s, b) => s + b.dueMinor, 0);

  return (
    <>
      <h1 className="text-[24px] font-extrabold">{t('Bills', 'Biilasha')}</h1>
      <ErrorNote error={act.error} />
      <section className="card flex flex-wrap items-center gap-3 p-4">
        <span className="flex-1">
          <span className="block text-[12.5px] font-medium text-ink-3">{t('Total to pay', 'Wadarta la bixinayo')}</span>
          <b className="num font-display text-[28px]">{money(due, list[0]?.currency ?? 'USD')}</b>
        </span>
        <p className="w-full text-[13px] text-ink-2 sm:w-auto sm:max-w-[40ch]">{t('Pay at the hospital cashier or by mobile money. Your bill updates as soon as the payment arrives.', 'Ku bixi khasnajiga isbitaalka ama lacag mobile. Biilkaagu wuu cusboonaanayaa marka lacagtu timaado.')}</p>
      </section>
      {list.length ? (
        <div className="card">
          <ul>
            {list.map((b) => (
              <li key={b.id} className="border-t border-line first:border-t-0">
                <button className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-2/60" onClick={() => setOpen(open === b.id ? null : b.id)} aria-expanded={open === b.id}>
                  <span className="min-w-0 flex-1">
                    <b className="block font-mono text-[13px]">{b.number}</b>
                    <span className="text-[12.5px] text-ink-3">{b.issuedOn}</span>
                  </span>
                  <span className="text-right">
                    <b className="num block">{money(b.totalMinor, b.currency)}</b>
                    {b.dueMinor ? <Pill tone="warn">{t(`${money(b.dueMinor, b.currency)} due`, `${money(b.dueMinor, b.currency)} lagu leeyahay`)}</Pill> : <Pill tone="ok">{t('Paid', 'La bixiyay')}</Pill>}
                  </span>
                </button>
                {open === b.id ? (
                  <div className="bg-surface-2/50 px-4 pb-3 pt-1 text-[13px]">
                    {b.lines.map((l, i) => (
                      <div key={i} className="flex justify-between gap-3 border-b border-line py-1.5 last:border-0">
                        <span>
                          {l.description}
                          {l.qty > 1 ? <span className="text-ink-3"> × {l.qty}</span> : null}
                        </span>
                        <span className="num">{money(l.amountMinor, b.currency)}</span>
                      </div>
                    ))}
                    {b.insuranceMinor ? (
                      <div className="flex justify-between py-1.5 text-ink-2">
                        <span>{t('Covered by insurance', 'Caymiska ayaa bixinaya')}</span>
                        <span className="num">−{money(b.insuranceMinor, b.currency)}</span>
                      </div>
                    ) : null}
                    {b.paidMinor ? (
                      <div className="flex justify-between py-1.5 text-ink-2">
                        <span>{t('Paid', 'La bixiyay')}</span>
                        <span className="num">−{money(b.paidMinor, b.currency)}</span>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="card">
          <Empty>{t('You have no bills.', 'Biil ma lihid.')}</Empty>
        </div>
      )}
    </>
  );
}
