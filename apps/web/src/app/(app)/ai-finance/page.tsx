'use client';

import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/ui';
import { InsightBoard } from '@/components/intel';

export default function AiFinancePage() {
  const { t } = useLang();
  return (
    <>
      <PageHeader title={t('Finance insights', 'Falanqaynta maaliyadda')}>
        {t('Plain-language summaries of each month’s finances.', 'Soo koobid fudud oo maaliyadda bil kasta.')}
      </PageHeader>
      <InsightBoard kind="finance" />
    </>
  );
}
