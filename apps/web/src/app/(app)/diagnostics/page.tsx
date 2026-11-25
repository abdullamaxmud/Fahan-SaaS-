'use client';

import { useLang } from '@/lib/i18n';
import { canDo, useMe } from '@/lib/session';
import { ImagingWorklist } from '@/components/ImagingWorklist';

export default function DiagnosticsPage() {
  const { me } = useMe();
  const { t } = useLang();
  const specialist = canDo(me, 'dx', 'E') && (canDo(me, 'opd', 'S') || canDo(me, 'icu', 'S') || canDo(me, 'er', 'S'));
  return <ImagingWorklist base="/diagnostics" spec="Spec §5.13" title={t('ECG, echo & endoscopy', 'ECG, echo & baaritaanno')} canReport={specialist} needsStudyUid={false} />;
}
