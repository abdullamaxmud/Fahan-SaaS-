'use client';

import { useEffect } from 'react';
import { X } from 'lucide-react';

/** Side panel on wide screens, full sheet on phones. Escape or the backdrop closes it. */
export function Drawer({ title, sub, onClose, children, footer, wide }: { title: string; sub?: React.ReactNode; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-ink/40" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside role="dialog" aria-modal="true" aria-label={title} className={`flex h-full w-full flex-col border-l border-line bg-surface shadow-2xl ${wide ? 'sm:max-w-[640px]' : 'sm:max-w-[480px]'}`}>
        <header className="flex items-start gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-[18px] font-bold leading-tight">{title}</h2>
            {sub ? <div className="mt-0.5 text-[13px] text-ink-3">{sub}</div> : null}
          </div>
          <button className="btn h-8 w-8 justify-center p-0" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? <footer className="flex flex-wrap gap-2 border-t border-line px-5 py-3">{footer}</footer> : null}
      </aside>
    </div>
  );
}

/** Label / value rows for detail panels. */
export function Facts({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(110px,auto)_1fr] gap-x-4 gap-y-2 text-[13.5px]">
      {rows
        .filter(([, v]) => v !== null && v !== undefined && v !== '')
        .map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-ink-3">{k}</dt>
            <dd className="min-w-0 break-words">{v}</dd>
          </div>
        ))}
    </dl>
  );
}

/** Tiny bar chart for monthly counts. */
export function Bars({ labels, values, tone = 'accent' }: { labels: string[]; values: number[]; tone?: 'accent' | 'crit' | 'warn' }) {
  const max = Math.max(1, ...values);
  const color = tone === 'crit' ? 'bg-crit' : tone === 'warn' ? 'bg-warn' : 'bg-accent';
  return (
    <div className="flex h-32 items-end gap-2" role="img" aria-label={labels.map((l, i) => `${l}: ${values[i]}`).join(', ')}>
      {values.map((v, i) => (
        <div key={labels[i]} className="flex min-w-0 flex-1 flex-col items-center gap-1">
          <span className="num text-[11px] font-semibold text-ink-2">{v || ''}</span>
          <div className={`w-full max-w-[36px] rounded-t-md ${v ? color : 'bg-surface-3'}`} style={{ height: `${Math.max(4, (v / max) * 88)}px` }} />
          <span className="text-[11px] text-ink-3">{labels[i]}</span>
        </div>
      ))}
    </div>
  );
}

export const fmtDate = (d: string | Date | null | undefined, lang: 'en' | 'so' = 'en') =>
  d ? new Intl.DateTimeFormat(lang === 'so' ? 'so-SO' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(d)) : '—';
export const fmtDateTime = (d: string | Date | null | undefined, lang: 'en' | 'so' = 'en') =>
  d ? new Intl.DateTimeFormat(lang === 'so' ? 'so-SO' : 'en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(d)) : '—';
export const monthLabel = (ym: string, lang: 'en' | 'so' = 'en') => new Intl.DateTimeFormat(lang === 'so' ? 'so-SO' : 'en-GB', { month: 'short' }).format(new Date(`${ym}-15T00:00:00Z`));
