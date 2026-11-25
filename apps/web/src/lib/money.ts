/** Money is stored in minor units (cents). These helpers are for display and input only. */
export type Currency = 'USD' | 'SOS';

export function money(minor: number | null | undefined, currency: Currency | string = 'USD'): string {
  const n = (minor ?? 0) / 100;
  const s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: currency === 'SOS' ? 0 : 2, maximumFractionDigits: currency === 'SOS' ? 0 : 2 });
  return `${n < 0 ? '−' : ''}${currency === 'SOS' ? 'Sh ' : '$'}${s}`;
}

/** "12.50" → 1250. Returns NaN for anything that is not a plain amount. */
export function toMinor(input: string): number {
  const t = input.trim().replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return NaN;
  return Math.round(Number(t) * 100);
}

export const newKey = (): string => (typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`);

export const patientName = (p?: { names?: { given?: string; family?: string }; mrn?: string } | null) =>
  p ? `${p.names?.given ?? ''} ${p.names?.family ?? ''}`.trim() + (p.mrn ? ` · ${p.mrn}` : '') : '—';
