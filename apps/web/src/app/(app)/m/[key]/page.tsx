'use client';

import Link from 'next/link';
import { use } from 'react';
import { LEVEL_LABEL, MODULE_BY_KEY, isModuleKey, type ModuleKey } from '@fahan/policy';
import { useLang } from '@/lib/i18n';
import { useMe } from '@/lib/session';
import { Card, PageHeader, Pill } from '@/components/ui';

/** Roadmap phase per module (spec §15). */
const PHASE: Partial<Record<ModuleKey, number>> = {
  mpi: 2, appt: 2, opd: 2, portal: 6,
  er: 3, adm: 3, bed: 3, nur: 3, icu: 3, sx: 3, mat: 3, amb: 3, tele: 3,
  lab: 4, rad: 4, dx: 4, rx: 4, inv: 4, bb: 4, eq: 4, intg: 4,
  bill: 5, ins: 5, acct: 5, proc: 5, hr: 5,
  qual: 6, bi: 6, aifin: 6, aidis: 6, ai360: 6, studio: 6,
};

export default function ModulePage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = use(params);
  const { me } = useMe();
  const { t, lang } = useLang();
  if (!isModuleKey(key)) return <PageHeader eyebrow="404" title={t('Page not found', 'Bogga lama helin')} />;
  const m = MODULE_BY_KEY[key];
  const level = me.perms[key];
  if (!level) {
    return (
      <div className="card grid place-items-center gap-3 px-4 py-16 text-center">
        <span className="rounded-lg bg-crit-soft px-3 py-1.5 font-mono text-[13px] text-crit">403 · PERMISSION_DENIED</span>
        <h1 className="text-3xl font-extrabold">{lang === 'so' ? m.so : m.name}</h1>
        <p className="max-w-[56ch] text-ink-2">{t('Your role has no access to this module. The server refuses it too, so guessing a link does not help.', 'Doorkaagu ma laha gelitaanka qaybtan.')}</p>
        <Link className="btn" href="/">
          {t('Back to my workspace', 'Ku noqo goobta shaqada')}
        </Link>
      </div>
    );
  }
  return (
    <>
      <PageHeader eyebrow={`Spec §${m.spec}`} title={lang === 'so' ? m.so : m.name}>
        <Pill tone="acc">
          {level} · {LEVEL_LABEL[level]}
        </Pill>
      </PageHeader>
      <Card>
        <div className="grid gap-2 p-6">
          <span className="eyebrow">{t('Roadmap', 'Qorshaha')}</span>
          <p className="text-[15px]">
            {t('This module is built in', 'Qaybtan waxaa la dhisayaa')} <b>Phase {PHASE[key] ?? 1}</b>.{' '}
            {t('Your access level is already enforced by the API.', 'Heerka gelitaankaaga hadda ayaa API-gu dhaqangeliyaa.')}
          </p>
        </div>
      </Card>
    </>
  );
}
