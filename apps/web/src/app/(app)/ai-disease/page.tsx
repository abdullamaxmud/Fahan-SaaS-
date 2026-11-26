'use client';

import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/ui';
import { InsightBoard } from '@/components/intel';

export default function AiDiseasePage() {
  const { t } = useLang();
  return (
    <>
      <PageHeader title={t('Disease insights', 'Falanqaynta cudurrada')}>
        {t('Diagnosis trends from this hospital’s own records.', 'Isbeddelka cudurrada ee diiwaannada isbitaalka.')}
      </PageHeader>
      <InsightBoard kind="disease" />
    </>
  );
}
