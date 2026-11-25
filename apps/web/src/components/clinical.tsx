'use client';

export interface PatientBrief {
  id: string;
  mrn: string;
  names: { given: string; middle?: string; family: string };
  dob: string;
  sexAtBirth?: string | null;
  status?: string;
}

export const fullName = (n: PatientBrief['names']) => [n.given, n.middle, n.family].filter(Boolean).join(' ');

export function age(dob: string, at = new Date()): string {
  const d = new Date(`${dob}T00:00:00Z`);
  let y = at.getUTCFullYear() - d.getUTCFullYear();
  const m = at.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && at.getUTCDate() < d.getUTCDate())) y--;
  if (y >= 2) return `${y}y`;
  const months = (at.getUTCFullYear() - d.getUTCFullYear()) * 12 + at.getUTCMonth() - d.getUTCMonth();
  return `${Math.max(0, months)}m`;
}

const sex = (s?: string | null) => (s === 'female' ? 'F' : s === 'male' ? 'M' : '—');

/** Deterministic barcode bars from the MRN (visual only — printing labels is a Phase 3 task). */
function Barcode({ value }: { value: string }) {
  const bars: { w: number; on: boolean }[] = [];
  for (const ch of value) {
    const c = ch.charCodeAt(0);
    bars.push({ w: (c % 3) + 1, on: true }, { w: 1, on: false }, { w: ((c >> 2) % 2) + 1, on: true }, { w: (c % 2) + 1, on: false });
  }
  return (
    <div className="flex h-10 items-stretch gap-px" aria-hidden="true">
      {bars.map((b, i) => (
        <i key={i} style={{ width: b.w }} className={b.on ? 'bg-ink' : ''} />
      ))}
    </div>
  );
}

/** Patient identity band (prototype "wristband"): name, sex/age, MRN, status, allergies slot. */
export function PatientBand({ p, children }: { p: PatientBrief; children?: React.ReactNode }) {
  const initials = (p.names.given[0] ?? '') + (p.names.family[0] ?? '');
  return (
    <div className="card relative grid grid-cols-1 items-center gap-4 overflow-hidden p-4 pl-6 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
      <span aria-hidden="true" className="absolute inset-y-0 left-0 w-1.5 bg-[repeating-linear-gradient(180deg,rgb(var(--accent))_0_10px,rgb(var(--accent-2))_10px_20px)]" />
      <span className="hidden h-12 w-12 place-items-center rounded-full bg-accent-soft font-display text-base font-bold text-accent-2 sm:grid">{initials}</span>
      <div className="min-w-0">
        <h2 className="truncate text-2xl font-extrabold">{fullName(p.names)}</h2>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-ink-2">
          <span>
            {sex(p.sexAtBirth)} · {age(p.dob)} · DOB {p.dob}
          </span>
          <span className="font-mono">{p.mrn}</span>
          {p.status ? <span>{p.status}</span> : null}
        </div>
        {children ? <div className="mt-2 flex flex-wrap gap-2">{children}</div> : null}
      </div>
      <div className="grid justify-items-start gap-1 sm:justify-items-center">
        <Barcode value={p.mrn} />
        <span className="font-mono text-[11px] text-ink-3">{p.mrn}</span>
      </div>
    </div>
  );
}
