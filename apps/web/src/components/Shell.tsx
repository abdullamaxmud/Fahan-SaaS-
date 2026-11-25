'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import * as Icons from 'lucide-react';
import { LayoutDashboard, LogOut, Menu, Moon, Sun, X } from 'lucide-react';
import { MODULES, MODULE_GROUPS, ROLE_BY_ID, TIERS, type ModuleGroup } from '@fahan/policy';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { useMe } from '@/lib/session';
import { Brand } from './Brand';

/** Routes that exist in Phase 1. Every other module opens its "coming in phase N" page. */
const ROUTES: Record<string, string> = {
  plat: '/platform/tenants',
  org: '/admin/branches',
  iam: '/admin/users',
  sec: '/admin/audit',
  mpi: '/patients',
  appt: '/appointments',
  opd: '/encounters',
  er: '/emergency',
  adm: '/wards',
  bed: '/wards',
  nur: '/wards',
  icu: '/wards',
  sx: '/surgery',
  mat: '/maternity',
  amb: '/referrals',
  lab: '/lab',
  rad: '/radiology',
  dx: '/diagnostics',
  rx: '/pharmacy',
  inv: '/inventory',
  bb: '/bloodbank',
  eq: '/equipment',
};

function Icon({ name }: { name: string }) {
  const key = name.replace(/(^|-)(\w)/g, (_, __, c: string) => c.toUpperCase()).replace(/-/g, '') as keyof typeof Icons;
  const C = (Icons[key] ?? Icons.Circle) as React.ComponentType<{ size?: number; strokeWidth?: number }>;
  return <C size={18} strokeWidth={1.75} />;
}

export function Shell({ children }: { children: React.ReactNode }) {
  const { me } = useMe();
  const { t, lang, setLang } = useLang();
  const path = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const primary = ROLE_BY_ID[me.roles[0] ?? ''];
  const initials = me.name
    .replace(/^(Dr\.|Eng\.)\s*/, '')
    .split(' ')
    .slice(0, 2)
    .map((w) => w[0])
    .join('');

  const groups = (Object.keys(MODULE_GROUPS) as ModuleGroup[])
    .map((g) => ({ g, items: MODULES.filter((m) => m.group === g && me.perms[m.key]) }))
    .filter((x) => x.items.length);

  async function logout() {
    await api('/auth/logout', { body: {} }).catch(() => {});
    router.replace('/login');
  }

  function toggleTheme() {
    const root = document.documentElement;
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
  }

  const linkCls = (active: boolean) =>
    `flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[13.5px] font-medium ${active ? 'bg-accent-soft text-accent-2' : 'text-ink-2 hover:bg-surface-2 hover:text-ink'}`;

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[268px_minmax(0,1fr)]">
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-[min(300px,86vw)] flex-col border-r border-line bg-surface transition-transform lg:sticky lg:top-0 lg:h-screen lg:w-auto lg:translate-x-0 ${open ? 'translate-x-0 shadow-xl' : '-translate-x-full'}`}
        aria-label="Main navigation"
      >
        <div className="flex items-center justify-between px-[18px] pb-3.5 pt-[18px]">
          <Brand sub={me.tenant?.name ?? t('Platform console', 'Maamulka madasha')} />
          <button className="lg:hidden" onClick={() => setOpen(false)} aria-label="Close navigation">
            <X size={20} />
          </button>
        </div>
        <div className="mx-3 mb-2 flex items-center gap-2.5 rounded-xl border border-line bg-surface-2 p-2.5">
          <span className="grid h-[34px] w-[34px] flex-none place-items-center rounded-full bg-accent-soft font-display text-xs font-bold text-accent-2">{initials}</span>
          <span className="min-w-0">
            <b className="block truncate text-[13px]">{me.name}</b>
            <span className="block truncate text-xs text-ink-2">{primary?.name ?? me.roles.join(', ')}</span>
          </span>
        </div>
        <nav className="flex-1 overflow-y-auto px-2.5 pb-3">
          <Link href="/" className={linkCls(path === '/')} onClick={() => setOpen(false)}>
            <LayoutDashboard size={18} strokeWidth={1.75} />
            {t('My workspace', 'Goobta shaqadayda')}
          </Link>
          {(() => {
            // Several modules can open the same page (e.g. wards); highlight only the first of them.
            const lit = new Set<string>();
            return groups.map(({ g, items }) => (
            <div key={g} className="mt-3.5">
              <span className="eyebrow block px-2.5 pb-1.5">{MODULE_GROUPS[g][lang]}</span>
              {items.map((m) => {
                // Platform users only have the tenant console and the control-plane audit check.
                const platformOk = me.kind !== 'platform' || m.key === 'plat' || m.key === 'sec';
                const href = (platformOk && ROUTES[m.key]) || `/m/${m.key}`;
                return (
                  <Link
                    key={m.key}
                    href={href}
                    className={linkCls(path.startsWith(href) && !lit.has(href) && Boolean(lit.add(href)))}
                    onClick={() => setOpen(false)}
                  >
                    <Icon name={m.icon} />
                    <span className="min-w-0 flex-1 truncate">{lang === 'so' ? m.so : m.name}</span>
                    <span className="rounded bg-surface-3 px-1 font-mono text-[10.5px] font-semibold text-ink-2" title="Your access level">
                      {me.perms[m.key]}
                    </span>
                  </Link>
                );
              })}
            </div>
            ));
          })()}
        </nav>
        <div className="border-t border-line p-3">
          <button onClick={logout} className={`${linkCls(false)} w-full`}>
            <LogOut size={18} strokeWidth={1.75} />
            {t('Sign out', 'Ka bax')}
          </button>
        </div>
      </aside>
      {open ? <div className="fixed inset-0 z-30 bg-ink/40 lg:hidden" onClick={() => setOpen(false)} /> : null}

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-20 flex items-center gap-2.5 border-b border-line bg-surface/90 px-4 py-2.5 backdrop-blur">
          <button className="btn h-9 w-9 justify-center p-0 lg:hidden" onClick={() => setOpen(true)} aria-label="Open navigation">
            <Menu size={18} />
          </button>
          <span className="truncate rounded-[9px] border border-line px-2.5 py-1.5 text-[13px]">
            <b>{me.tenant?.name ?? t('All tenants', 'Dhammaan macaamiisha')}</b>
            <span className="text-ink-3"> · {primary ? `L${primary.tier} ${TIERS[primary.tier]?.[lang]}` : ''}</span>
          </span>
          <div className="ml-auto flex items-center gap-2">
            <div className="flex overflow-hidden rounded-[9px] border border-line" role="group" aria-label="Language">
              {(['en', 'so'] as const).map((l) => (
                <button key={l} onClick={() => setLang(l)} aria-pressed={lang === l} className={`h-[34px] px-2.5 text-xs font-semibold ${lang === l ? 'bg-ink text-surface' : 'text-ink-3'}`}>
                  {l.toUpperCase()}
                </button>
              ))}
            </div>
            <button className="btn h-9 w-9 justify-center p-0" onClick={toggleTheme} aria-label="Toggle theme">
              <Sun size={16} className="hidden dark:block" />
              <Moon size={16} className="dark:hidden" />
            </button>
          </div>
        </header>
        <main className="mx-auto flex w-full max-w-[1380px] flex-col gap-5 px-4 pb-16 pt-6 sm:px-6">{children}</main>
      </div>
    </div>
  );
}
