'use client';

import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/ui';
import { InsightBoard } from '@/components/intel';

export default function AiFinancePage() {
  const { t } = useLang();
  return (
    <>
      <PageHeader eyebrow="Spec §5.30 · §9.4" title={t('AI financial intelligence', 'AI maaliyadda')}>
        {t(
          'Summaries are written only from the certified finance snapshot, every number is checked against it, and finance reviews and releases them. AI never changes the ledger.',
          'Soo koobidyada waxaa laga qoraa sawirka maaliyadda ee la hubiyay oo keliya; maaliyaddu ayaa dib u eegta.',
        )}
      </PageHeader>
      <InsightBoard kind="finance" />
    </>
  );
}
