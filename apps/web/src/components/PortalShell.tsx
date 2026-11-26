'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useState } from 'react';
import { CalendarDays, FlaskConical, Home, LogOut, MessageSquare, Moon, Receipt, Sun } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { useMe } from '@/lib/session';
import { Brand } from './Brand';

export interface PortalPatient {
  id: string;
  mrn: string;
  name: string;
  dob: string;
  relationship: string;
}

const Ctx = createContext<{ patients: PortalPatient[]; current: PortalPatient | null; setCurrent: (id: string) => void }>({ patients: [], current: null, setCurrent: () => {} });
export const usePortal = () => useContext(Ctx);

export function PortalShell({ children }: { children: React.ReactNode }) {
  const { me } = useMe();
  const { t, lang, setLang } = useLang();
  const path = usePathname();
  const router = useRouter();
  const [patients, setPatients] = useState<PortalPatient[]>([]);
  const [currentId, setCurrentId] = useState<string>('');

  useEffect(() => {
    api<{ patients: PortalPatient[] }>('/portal/me')
      .then((d) => {
        setPatients(d.patients);
        let saved = '';
        try {
          saved = localStorage.getItem('fahan-portal-patient') ?? '';
        } catch {}
        setCurrentId(d.patients.some((p) => p.id === saved) ? saved : (d.patients.find((p) => p.relationship === 'self') ?? d.patients[0])?.id ?? '');
      })
      .catch(() => {});
  }, []);

  const setCurrent = (id: string) => {
    setCurrentId(id);
    try {
      localStorage.setItem('fahan-portal-patient', id);
    } catch {}
  };
  const current = patients.find((p) => p.id === currentId) ?? null;

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

  const tabs = [
    { href: '/portal', en: 'Home', so: 'Hoyga', icon: Home },
    { href: '/portal/appointments', en: 'Visits', so: 'Ballamaha', icon: CalendarDays },
    { href: '/portal/results', en: 'Results', so: 'Natiijooyinka', icon: FlaskConical },
    { href: '/portal/bills', en: 'Bills', so: 'Biilasha', icon: Receipt },
    { href: '/portal/messages', en: 'Messages', so: 'Fariimaha', icon: MessageSquare },
  ];
  const on = (href: string) => (href === '/portal' ? path === '/portal' : path.startsWith(href));

  return (
    <Ctx.Provider value={{ patients, current, setCurrent }}>
      <div className="min-h-screen pb-20 sm:pb-8">
        <header className="sticky top-0 z-20 border-b border-line bg-surface/90 backdrop-blur">
          <div className="mx-auto flex max-w-[960px] items-center gap-3 px-4 py-3">
            <Brand sub={me.tenant?.name} />
            <div className="ml-auto flex items-center gap-2">
              <button className="btn h-9 px-2.5 text-xs" onClick={() => setLang(lang === 'en' ? 'so' : 'en')}>
                {lang === 'en' ? 'Soomaali' : 'English'}
              </button>
              <button className="btn h-9 w-9 justify-center p-0" onClick={toggleTheme} aria-label={t('Light or dark', 'Iftiin ama mugdi')}>
                <Sun size={16} className="hidden dark:block" />
                <Moon size={16} className="dark:hidden" />
              </button>
              <button className="btn h-9 w-9 justify-center p-0" onClick={logout} aria-label={t('Sign out', 'Ka bax')}>
                <LogOut size={16} />
              </button>
            </div>
          </div>
          <nav className="mx-auto hidden max-w-[960px] gap-1 px-4 pb-2 sm:flex" aria-label={t('Portal', 'Bogga')}>
            {tabs.map((x) => (
              <Link key={x.href} href={x.href} className={`flex items-center gap-2 rounded-lg px-3 py-2 text-[13.5px] font-semibold ${on(x.href) ? 'bg-accent-soft text-accent-2' : 'text-ink-2 hover:bg-surface-2'}`}>
                <x.icon size={16} />
                {lang === 'so' ? x.so : x.en}
              </Link>
            ))}
          </nav>
        </header>

        <main className="mx-auto flex w-full max-w-[960px] flex-col gap-4 px-4 pt-5">
          {patients.length > 1 ? (
            <div className="flex gap-2 overflow-x-auto" role="tablist" aria-label={t('Whose record', 'Diiwaanka yaa')}>
              {patients.map((p) => (
                <button key={p.id} role="tab" aria-selected={p.id === currentId} onClick={() => setCurrent(p.id)} className={`flex flex-none items-center gap-2 rounded-full border px-3 py-1.5 text-[13px] font-semibold ${p.id === currentId ? 'border-accent bg-accent-soft text-accent-2' : 'border-line text-ink-2'}`}>
                  {p.name.split(' ')[0]}
                  <span className="text-[11px] font-medium text-ink-3">{p.relationship === 'self' ? t('me', 'aniga') : t('family', 'qoys')}</span>
                </button>
              ))}
            </div>
          ) : null}
          {current ? children : patients.length ? null : <div className="card p-6 text-center text-ink-3">{t('Your account is not linked to a patient record yet. Please contact the hospital.', 'Akoonkaagu weli kuma xirna diiwaan bukaan. Fadlan la xiriir isbitaalka.')}</div>}
        </main>

        <nav className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-5 border-t border-line bg-surface sm:hidden" aria-label={t('Portal', 'Bogga')}>
          {tabs.map((x) => (
            <Link key={x.href} href={x.href} className={`flex flex-col items-center gap-0.5 py-2 text-[11px] font-semibold ${on(x.href) ? 'text-accent-2' : 'text-ink-3'}`}>
              <x.icon size={20} />
              {lang === 'so' ? x.so : x.en}
            </Link>
          ))}
        </nav>
      </div>
    </Ctx.Provider>
  );
}
