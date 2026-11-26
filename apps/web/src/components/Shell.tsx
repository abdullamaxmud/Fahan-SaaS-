'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Bell, ClipboardList, Home, LogOut, Menu, Moon, Search, Sun, X } from 'lucide-react';
import { ROLE_BY_ID } from '@fahan/policy';
import { api } from '@/lib/api';
import { TASKS } from '@/lib/home';
import { useLang } from '@/lib/i18n';
import { navFor } from '@/lib/nav';
import { canDo, useMe } from '@/lib/session';
import { Brand } from './Brand';
import { Icon } from './Icon';

export function initials(name: string) {
  return name
    .replace(/^(Dr\.|Eng\.)\s*/, '')
    .split(' ')
    .slice(0, 2)
    .map((w) => w[0])
    .join('');
}

/** Number of open tasks for the bell, refreshed every minute. */
function useTaskCount() {
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    const load = () =>
      api<{ counts: Record<string, number> }>('/home')
        .then((d) => live && setN(Object.entries(d.counts).reduce((s, [k, v]) => s + (TASKS[k] ? v : 0), 0)))
        .catch(() => {});
    void load();
    const t = setInterval(load, 60_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  return n;
}

export function Shell({ children }: { children: React.ReactNode }) {
  const { me } = useMe();
  const { t, lang, setLang } = useLang();
  const path = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const tasks = useTaskCount();
  const role = ROLE_BY_ID[me.roles[0] ?? ''];
  const groups = navFor(me.perms, { platform: me.kind === 'platform', ownPatients: me.scope === 'assigned-patient' || me.scope === 'own-record', disabled: me.disabledModules });
  const canSearch = me.kind === 'tenant' && canDo(me, 'mpi', 'V');

  useEffect(() => setOpen(false), [path]);

  async function logout() {
    await api('/auth/logout', { body: {} }).catch(() => {});
    router.replace('/login');
  }

  function toggleTheme() {
    const root = document.documentElement;
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    try {
      localStorage.setItem('fahan-theme', root.dataset.theme);
    } catch {}
  }

  const active = (href: string) => (href === '/' ? path === '/' : path === href || path.startsWith(`${href}/`));
  const linkCls = (on: boolean) =>
    `group flex items-center gap-3 rounded-lg px-3 py-2 text-[13.5px] font-medium transition-colors ${on ? 'bg-accent-soft text-accent-2' : 'text-ink-2 hover:bg-surface-2 hover:text-ink'}`;

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[256px_minmax(0,1fr)]">
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-[min(288px,86vw)] flex-col border-r border-line bg-surface transition-transform lg:sticky lg:top-0 lg:h-screen lg:w-auto lg:translate-x-0 ${open ? 'translate-x-0 shadow-xl' : '-translate-x-full'}`}
        aria-label={t('Main navigation', 'Hagaha')}
      >
        <div className="flex items-center justify-between px-4 pb-3 pt-4">
          <Brand sub={me.tenant?.name ?? t('Platform console', 'Maamulka madasha')} />
          <button className="lg:hidden" onClick={() => setOpen(false)} aria-label={t('Close menu', 'Xir')}>
            <X size={20} />
          </button>
        </div>
        <nav className="flex-1 overflow-y-auto px-3 pb-3">
          <Link href="/" className={linkCls(active('/'))}>
            <Home size={18} strokeWidth={1.75} />
            <span className="flex-1">{t('Home', 'Hoyga')}</span>
            {tasks ? <span className="rounded-full bg-crit px-1.5 text-[11px] font-bold leading-[18px] text-white">{tasks > 99 ? '99+' : tasks}</span> : null}
          </Link>
          {groups.map((g) => (
            <div key={g.en} className="mt-4">
              <span className="block px-3 pb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">{lang === 'so' ? g.so : g.en}</span>
              {g.items.map((x) => (
                <Link key={x.href} href={x.href} className={linkCls(active(x.href))}>
                  <Icon name={x.icon} />
                  <span className="min-w-0 flex-1 truncate">{lang === 'so' ? x.so : x.en}</span>
                </Link>
              ))}
            </div>
          ))}
          {me.kind === 'tenant' ? (
            <div className="mt-4">
              <span className="block px-3 pb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">{t('Me', 'Aniga')}</span>
              <Link href="/forms" className={linkCls(active('/forms'))}>
                <ClipboardList size={18} strokeWidth={1.75} />
                {t('My forms', 'Foomamkayga')}
              </Link>
            </div>
          ) : null}
        </nav>
        <div className="flex items-center gap-2.5 border-t border-line p-3">
          <span className="grid h-9 w-9 flex-none place-items-center rounded-full bg-accent-soft font-display text-xs font-bold text-accent-2">{initials(me.name)}</span>
          <span className="min-w-0 flex-1">
            <b className="block truncate text-[13px]">{me.name}</b>
            <span className="block truncate text-xs text-ink-3">{role?.name ?? me.roles.join(', ')}</span>
          </span>
          <button onClick={logout} className="btn h-9 w-9 justify-center p-0" aria-label={t('Sign out', 'Ka bax')} title={t('Sign out', 'Ka bax')}>
            <LogOut size={16} />
          </button>
        </div>
      </aside>
      {open ? <div className="fixed inset-0 z-30 bg-ink/40 lg:hidden" onClick={() => setOpen(false)} /> : null}

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-20 flex items-center gap-2 border-b border-line bg-surface/90 px-4 py-2.5 backdrop-blur">
          <button className="btn h-9 w-9 justify-center p-0 lg:hidden" onClick={() => setOpen(true)} aria-label={t('Open menu', 'Fur hagaha')}>
            <Menu size={18} />
          </button>
          {canSearch ? (
            <form
              className="flex h-9 min-w-0 max-w-[420px] flex-1 items-center gap-2 rounded-[9px] border border-line bg-surface-2 px-3"
              onSubmit={(e) => {
                e.preventDefault();
                router.push(`/patients?q=${encodeURIComponent(q.trim())}`);
              }}
              role="search"
            >
              <Search size={16} className="flex-none text-ink-3" />
              <input className="min-w-0 flex-1 bg-transparent text-[13.5px] outline-none" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Find a patient — name, MRN or phone', 'Raadi bukaan — magac, MRN ama telefoon')} aria-label={t('Find a patient', 'Raadi bukaan')} />
            </form>
          ) : (
            <span className="truncate text-[13.5px] font-semibold">{me.tenant?.name ?? t('Platform console', 'Maamulka madasha')}</span>
          )}
          <div className="ml-auto flex items-center gap-2">
            <Link href="/" className="btn relative h-9 w-9 justify-center p-0" aria-label={t(`${tasks} tasks waiting`, `${tasks} hawlood ayaa sugaya`)} title={t('Tasks waiting', 'Hawlaha sugaya')}>
              <Bell size={16} />
              {tasks ? <span className="absolute -right-1 -top-1 min-w-[18px] rounded-full bg-crit px-1 text-center text-[10.5px] font-bold leading-[18px] text-white">{tasks > 99 ? '99+' : tasks}</span> : null}
            </Link>
            <div className="flex overflow-hidden rounded-[9px] border border-line" role="group" aria-label={t('Language', 'Luqadda')}>
              {(['so', 'en'] as const).map((l) => (
                <button key={l} onClick={() => setLang(l)} aria-pressed={lang === l} className={`h-[34px] px-2.5 text-xs font-semibold ${lang === l ? 'bg-ink text-surface' : 'text-ink-3'}`}>
                  {l === 'so' ? 'SO' : 'EN'}
                </button>
              ))}
            </div>
            <button className="btn h-9 w-9 justify-center p-0" onClick={toggleTheme} aria-label={t('Light or dark', 'Iftiin ama mugdi')}>
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
