'use client';

import { useLang } from '@/lib/i18n';
import { PageHeader } from '@/components/ui';
import { InsightBoard } from '@/components/intel';

export default function AiDiseasePage() {
  const { t } = useLang();
  return (
    <>
      <PageHeader eyebrow="Spec §5.31 · §9.3" title={t('AI disease intelligence', 'AI cudurrada')}>
        {t(
          'Confirmed diagnoses counted once per patient per month, suspected cases kept apart, groups under five patients hidden. These are this hospital’s records, not population prevalence.',
          'Ogaanshaha la xaqiijiyay hal mar bukaan kasta; kuwa la tuhunsan yahay waa gooni; kooxaha yar waa la qariyay.',
        )}
      </PageHeader>
      <InsightBoard kind="disease" />
    </>
  );
}
