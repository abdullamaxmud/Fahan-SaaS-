'use client';

import { MODULES, effectivePermissions, type Level } from '@fahan/policy';
import { useLang } from '@/lib/i18n';

export const LEVEL_WORDS: Record<Level, [string, string]> = {
  V: ['View', 'Arag'],
  E: ['Add & edit', 'Ku dar & beddel'],
  S: ['Sign, verify, dispense', 'Saxiix, xaqiiji, bixi'],
  A: ['Approve & set up', 'Ansixi & habee'],
};

/** What a set of roles may do, in plain words, grouped by area. */
export function AccessList({ roles }: { roles: string[] }) {
  const { lang } = useLang();
  const perms = effectivePermissions(roles);
  const mods = MODULES.filter((m) => perms[m.key]);
  if (!mods.length) return <p className="text-[13px] text-ink-3">—</p>;
  return (
    <ul className="grid gap-1 text-[13px]">
      {mods.map((m) => (
        <li key={m.key} className="flex items-center justify-between gap-3 rounded-md px-2 py-1 odd:bg-surface-2/60">
          <span>{lang === 'so' ? m.so : m.name}</span>
          <span className="text-[12px] font-semibold text-accent-2">{LEVEL_WORDS[perms[m.key]!][lang === 'so' ? 1 : 0]}</span>
        </li>
      ))}
    </ul>
  );
}
