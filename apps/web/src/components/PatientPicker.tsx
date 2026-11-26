'use client';

import { useEffect, useState } from 'react';
import { Search, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { age, fullName, type PatientBrief } from './clinical';

/** Search-as-you-type patient chooser (name, MRN or phone). */
export function PatientPicker({ value, onChange }: { value: PatientBrief | null; onChange: (p: PatientBrief | null) => void }) {
  const { t } = useLang();
  const [q, setQ] = useState('');
  const [list, setList] = useState<PatientBrief[]>([]);
  useEffect(() => {
    if (value || q.trim().length < 2) return setList([]);
    const timer = setTimeout(() => {
      api<PatientBrief[]>(`/patients?q=${encodeURIComponent(q.trim())}`)
        .then((l) => setList(l.slice(0, 8)))
        .catch(() => setList([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [q, value]);

  if (value) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-accent bg-accent-soft/40 px-3 py-2">
        <span className="min-w-0 flex-1">
          <b className="block truncate text-[13.5px]">{fullName(value.names)}</b>
          <span className="font-mono text-[11.5px] text-ink-3">
            {value.mrn} · {age(value.dob)}
          </span>
        </span>
        <button type="button" className="btn h-7 w-7 justify-center p-0" onClick={() => onChange(null)} aria-label={t('Change patient', 'Beddel bukaanka')}>
          <X size={14} />
        </button>
      </div>
    );
  }
  return (
    <div className="relative">
      <label className="flex h-10 items-center gap-2 rounded-lg border border-line-2 bg-surface-2 px-3">
        <Search size={16} className="text-ink-3" />
        <input className="min-w-0 flex-1 bg-transparent text-[14px] outline-none" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Name, MRN or phone', 'Magac, MRN ama telefoon')} aria-label={t('Find a patient', 'Raadi bukaan')} />
      </label>
      {list.length ? (
        <ul className="absolute inset-x-0 top-11 z-10 max-h-64 overflow-y-auto rounded-lg border border-line bg-surface shadow-lg">
          {list.map((p) => (
            <li key={p.id}>
              <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-2" onClick={() => onChange(p)}>
                <span className="min-w-0 flex-1">
                  <b className="block truncate text-[13.5px]">{fullName(p.names)}</b>
                  <span className="font-mono text-[11.5px] text-ink-3">
                    {p.mrn} · {age(p.dob)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
