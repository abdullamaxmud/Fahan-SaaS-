'use client';

import Link from 'next/link';
import { LEVEL_LABEL, MODULES, ROLE_BY_ID, SCOPES, TIERS } from '@hospitalos/policy';
import { useLang } from '@/lib/i18n';
import { useMe } from '@/lib/session';
import { Card, PageHeader, Pill } from '@/components/ui';

function ScopeRings({ scope }: { scope: string }) {
  const at = SCOPES.indexOf(scope as (typeof SCOPES)[number]);
  return (
    <div className="card flex items-center gap-4 p-4">
      <svg viewBox="0 0 112 112" width="104" height="104" role="img" aria-label={`Access reach: ${scope}`}>
        {SCOPES.map((s, i) => (
          <circle
            key={s}
            cx="56"
            cy="56"
            r={52 - i * 7.2}
            fill={i >= at ? 'rgb(var(--accent))' : 'rgb(var(--surface-2))'}
            fillOpacity={i >= at ? 0.16 + (i - at) * 0.12 : 1}
            stroke={i === at ? 'rgb(var(--accent))' : 'rgb(var(--line-2))'}
            strokeWidth={i === at ? 2 : 1}
          />
        ))}
      </svg>
      <ol className="grid gap-0.5 text-xs">
        {SCOPES.map((s, i) => (
          <li key={s} className={`flex items-center gap-2 ${i === at ? 'font-bold text-accent-2' : i > at ? 'text-ink' : 'text-ink-3'}`}>
            <i className={`h-2 w-2 rounded-full border ${i >= at ? 'border-accent bg-accent' : 'border-line-2'}`} />
            {s}
          </li>
        ))}
      </ol>
    </div>
  );
}

export default function WorkspacePage() {
  const { me } = useMe();
  const { t, lang } = useLang();
  const roles = me.roles.map((r) => ROLE_BY_ID[r]).filter(Boolean);
  const mods = MODULES.filter((m) => me.perms[m.key]);
  return (
    <>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_auto]">
        <PageHeader eyebrow={roles[0] ? `L${roles[0].tier} · ${TIERS[roles[0].tier]?.[lang]}` : ''} title={`${t('Welcome', 'Soo dhawoow')}, ${me.name}`}>
          {roles.map((r) => r!.note).join(' ')}
        </PageHeader>
        <ScopeRings scope={me.scope} />
      </div>
      <Card title={t('What you can open', 'Waxaad furi karto')}>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <th className="th">{t('Module', 'Qaybta')}</th>
                <th className="th">Spec</th>
                <th className="th">{t('Your access', 'Gelitaankaaga')}</th>
              </tr>
            </thead>
            <tbody>
              {mods.map((m) => (
                <tr key={m.key} className="hover:bg-surface-2/50">
                  <td className="td font-medium">
                    <Link className="hover:text-accent-2 hover:underline" href={`/m/${m.key}`}>
                      {lang === 'so' ? m.so : m.name}
                    </Link>
                  </td>
                  <td className="td font-mono text-xs text-ink-3">§{m.spec}</td>
                  <td className="td">
                    <Pill tone="acc">
                      {me.perms[m.key]} · {LEVEL_LABEL[me.perms[m.key]!]}
                    </Pill>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
