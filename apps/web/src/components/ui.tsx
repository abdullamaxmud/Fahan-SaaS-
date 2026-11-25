'use client';

import { useState } from 'react';
import { ApiError } from '@/lib/api';

export function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1.5 text-[12.5px] font-medium text-ink-2">
      {label}
      {children}
      {error ? <span className="text-[12px] font-normal text-crit">{error}</span> : null}
    </label>
  );
}

const TONES = {
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  crit: 'bg-crit-soft text-crit',
  info: 'bg-info-soft text-info',
  acc: 'bg-accent-soft text-accent-2',
  plain: 'bg-surface-2 text-ink-2',
} as const;

export function Pill({ tone = 'plain', children }: { tone?: keyof typeof TONES; children: React.ReactNode }) {
  return <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11.5px] font-semibold ${TONES[tone]}`}>{children}</span>;
}

export const statusTone = (s: string): keyof typeof TONES =>
  /Active|success|allow/.test(s) ? 'ok' : /Suspend|Deactivat|deny|failure/.test(s) ? 'crit' : /Invited|Pending/.test(s) ? 'warn' : 'info';

export function Card({ title, actions, children }: { title?: string; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="card min-w-0">
      {title || actions ? (
        <div className="flex flex-wrap items-center gap-3 px-4 pb-2.5 pt-3.5">
          {title ? <h3 className="text-[15px] font-semibold">{title}</h3> : null}
          <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function PageHeader({ eyebrow, title, children }: { eyebrow: string; title: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="eyebrow">{eyebrow}</span>
      <h1 className="text-[clamp(26px,3.2vw,36px)] font-extrabold leading-tight">{title}</h1>
      {children ? <div className="max-w-[72ch] text-ink-2">{children}</div> : null}
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof ApiError ? error.message : 'Something went wrong. Try again.';
  const cid = error instanceof ApiError ? error.body.correlationId : undefined;
  return (
    <div role="alert" className="rounded-[10px] bg-crit-soft px-3 py-2.5 text-[13px] text-crit">
      {msg}
      {cid ? <span className="mt-0.5 block font-mono text-[11px] opacity-75">Ref {cid}</span> : null}
    </div>
  );
}

export const fieldErrors = (e: unknown): Record<string, string> =>
  e instanceof ApiError && e.body.details ? Object.fromEntries(e.body.details.filter((d) => d.path).map((d) => [d.path!, d.message])) : {};

/** Runs an async action and tracks busy + error state. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e);
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}
