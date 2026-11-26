'use client';

import { useLang } from '@/lib/i18n';
import { canDo, useMe } from '@/lib/session';
import { ImagingWorklist } from '@/components/ImagingWorklist';

export default function RadiologyPage() {
  const { me } = useMe();
  const { t } = useLang();
  return <ImagingWorklist base="/radiology" title={t('Radiology', 'Raajada')} canReport={canDo(me, 'rad', 'A')} needsStudyUid />;
}
