'use client';

import { useCallback, useEffect, useState } from 'react';
import { CircleCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { CATEGORY, INCIDENT_STATUS, SEVERITY } from '@/lib/quality';
import { fmtDate } from '@/components/Dialog';
import { IncidentForm } from '@/components/IncidentForm';
import { Card, Empty, PageHeader, Pill } from '@/components/ui';

interface Mine {
  id: string;
  number: string;
  category: string;
  severity: string;
  status: string;
  reportedAt: string;
  outcome: string | null;
}

/** Any member of staff can report a safety event and follow what happened to it. */
export default function ReportIncidentPage() {
  const { t, lang } = useLang();
  const [mine, setMine] = useState<Mine[]>([]);
  const [sent, setSent] = useState<string | null>(null);
  const load = useCallback(() => api<Mine[]>('/quality/incidents/mine').then(setMine).catch(() => {}), []);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <PageHeader title={t('Report an incident', 'Soo sheeg dhacdo')}>
        {t('Anything that harmed, or could have harmed, a patient or colleague. Reports are confidential.', 'Wax kasta oo waxyeeleeyay ama waxyeeli lahaa bukaan ama shaqaale. Warbixintu waa qarsoodi.')}
      </PageHeader>
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <Card>
          <div className="p-4">
            {sent ? (
              <div className="mb-4 flex items-center gap-2 rounded-lg bg-ok-soft px-3 py-2.5 text-[13.5px] text-ok">
                <CircleCheck size={18} />
                {t(`Thank you. Report ${sent} was sent to the quality team.`, `Mahadsanid. Warbixinta ${sent} waxaa loo diray kooxda tayada.`)}
              </div>
            ) : null}
            <IncidentForm
              onDone={(r) => {
                setSent(r.number);
                void load();
              }}
            />
          </div>
        </Card>
        <Card title={t('My reports', 'Warbixinnadayda')}>
          {mine.length ? (
            <ul className="pb-2">
              {mine.map((x) => (
                <li key={x.id} className="flex items-center gap-3 border-t border-line px-4 py-2.5">
                  <span className="min-w-0 flex-1">
                    <b className="block text-[13.5px]">{lang === 'so' ? CATEGORY[x.category]?.[1] : CATEGORY[x.category]?.[0]}</b>
                    <span className="font-mono text-[11.5px] text-ink-3">
                      {x.number} · {fmtDate(x.reportedAt, lang)}
                    </span>
                  </span>
                  <Pill tone={SEVERITY[x.severity]?.[2]}>{lang === 'so' ? SEVERITY[x.severity]?.[1] : SEVERITY[x.severity]?.[0]}</Pill>
                  <Pill tone={INCIDENT_STATUS[x.status]?.[2]}>{lang === 'so' ? INCIDENT_STATUS[x.status]?.[1] : INCIDENT_STATUS[x.status]?.[0]}</Pill>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>{t('You have not reported anything yet.', 'Weli wax ma aadan soo sheegin.')}</Empty>
          )}
        </Card>
      </div>
    </>
  );
}
