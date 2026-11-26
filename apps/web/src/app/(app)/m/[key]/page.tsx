'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useEffect } from 'react';
import { MODULE_BY_KEY, isModuleKey } from '@fahan/policy';
import { useLang } from '@/lib/i18n';
import { NAV } from '@/lib/nav';
import { useMe } from '@/lib/session';

/** Old module links (/m/lab, /m/bill…) open the screen that now serves the module. */
export default function ModulePage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = use(params);
  const { me } = useMe();
  const { t, lang } = useLang();
  const router = useRouter();
  const target = NAV.flatMap((g) => g.items).find((x) => x.any.includes(key as never));
  const allowed = isModuleKey(key) && Boolean(me.perms[key]);

  useEffect(() => {
    if (allowed && target) router.replace(target.href);
  }, [allowed, target, router]);

  if (allowed && target) return null;
  const name = isModuleKey(key) ? (lang === 'so' ? MODULE_BY_KEY[key].so : MODULE_BY_KEY[key].name) : t('Page not found', 'Bogga lama helin');
  return (
    <div className="card grid place-items-center gap-3 px-4 py-16 text-center">
      <h1 className="text-2xl font-extrabold">{name}</h1>
      <p className="max-w-[48ch] text-ink-2">
        {allowed ? t('This page is not available.', 'Boggan lama heli karo.') : t('Your role does not include this area. Ask your administrator if you need it.', 'Doorkaagu kuma jiro qaybtan. Weydii maamulahaaga haddii aad u baahan tahay.')}
      </p>
      <Link className="btn" href="/">
        {t('Back to home', 'Ku noqo hoyga')}
      </Link>
    </div>
  );
}
