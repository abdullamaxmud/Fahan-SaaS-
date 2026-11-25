'use client';

import { createContext, useContext, useEffect, useState } from 'react';

export type Lang = 'en' | 'so';
const Ctx = createContext<{ lang: Lang; setLang: (l: Lang) => void }>({ lang: 'en', setLang: () => {} });

export function LangProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>('en');
  useEffect(() => {
    try {
      const saved = localStorage.getItem('fahan-lang');
      if (saved === 'so' || saved === 'en') setLangState(saved);
    } catch {}
  }, []);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  const setLang = (l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem('fahan-lang', l);
    } catch {}
  };
  return <Ctx.Provider value={{ lang, setLang }}>{children}</Ctx.Provider>;
}

export function useLang() {
  const { lang, setLang } = useContext(Ctx);
  /** t('English', 'Somali') — Somali strings pending native-speaker review. */
  const t = (en: string, so: string) => (lang === 'so' ? so : en);
  return { lang, setLang, t };
}
