'use client';

import { useCallback, useEffect, useState } from 'react';
import { FlaskConical, Siren } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { canDo, useMe } from '@/lib/session';
import { fullName, type PatientBrief } from '@/components/clinical';
import { Card, ErrorNote, PageHeader, Pill, useAction } from '@/components/ui';

interface Result {
  analyteCode: string;
  name: string;
  value: number | string;
  unit: string | null;
  flag: string;
}
interface Order {
  id: string;
  accessionNumber: string | null;
  testCode: string;
  testName: string;
  specimen: string;
  priority: string;
  status: string;
  waitingMinutes: number;
  results: Result[];
  critical: { analytes: string[] } | null;
  patient: Pick<PatientBrief, 'mrn' | 'names'> | null;
}
interface TestDef {
  id: string;
  code: string;
  analytes: { code: string; name: string; unit?: string }[];
}

const FLAG_TONE: Record<string, 'ok' | 'warn' | 'crit' | 'plain'> = { N: 'ok', L: 'warn', H: 'warn', LL: 'crit', HH: 'crit', A: 'warn' };

export default function LabPage() {
  const { me } = useMe();
  const { t } = useLang();
  const [list, setList] = useState<Order[]>([]);
  const [tests, setTests] = useState<TestDef[]>([]);
  const [criticals, setCriticals] = useState<Order[]>([]);
  const [entry, setEntry] = useState<Record<string, Record<string, string>>>({});
  const load = useAction();
  const act = useAction();
  const pathologist = canDo(me, 'lab', 'A');

  const refresh = useCallback(async () => {
    await load.run(async () => {
      setList(await api<Order[]>('/lab/worklist'));
      setCriticals(await api<Order[]>('/lab/criticals'));
      setTests(await api<TestDef[]>('/lab/tests'));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const run = async (fn: () => Promise<unknown>) => {
    if ((await act.run(fn)) !== undefined) await refresh();
  };

  return (
    <>
      <PageHeader title={t('Laboratory', 'Shaybaarka')}>
        {t('Samples, results and verification — urgent first.', 'Muunadaha, natiijooyinka iyo xaqiijinta.')}
      </PageHeader>
      {criticals.length ? (
        <div className="grid gap-1 rounded-[12px] bg-crit-soft px-4 py-3 text-[13px] text-crit">
          <b className="flex items-center gap-2">
            <Siren size={16} />
            {criticals.length} {t('critical value(s) waiting for clinician acknowledgement', 'qiime khatar ah oo sugaya')}
          </b>
          {criticals.map((c) => (
            <span key={c.id}>
              {c.accessionNumber} · {c.testName} · {c.critical?.analytes.join(', ')}
            </span>
          ))}
        </div>
      ) : null}
      <ErrorNote error={load.error ?? act.error} />
      <Card title={`${t('Worklist', 'Liiska shaqada')} · ${list.length}`}>
        <ul className="grid text-[13px]">
          {list.map((o) => {
            const def = tests.find((x) => x.code === o.testCode);
            const vals = entry[o.id] ?? {};
            return (
              <li key={o.id} className="grid gap-2 border-t border-line px-4 py-3 first:border-t-0">
                <div className="flex flex-wrap items-center gap-2">
                  <FlaskConical size={16} className="text-ink-3" />
                  <b>{o.testName}</b>
                  <Pill tone={o.priority === 'stat' ? 'crit' : o.priority === 'urgent' ? 'warn' : 'plain'}>{o.priority}</Pill>
                  <span className="text-ink-2">
                    {o.patient ? fullName(o.patient.names) : ''} · <span className="font-mono">{o.patient?.mrn}</span>
                  </span>
                  {o.accessionNumber ? <span className="font-mono text-xs">{o.accessionNumber}</span> : null}
                  <span className="ml-auto flex items-center gap-2">
                    <span className="num text-xs text-ink-3">{o.waitingMinutes}′</span>
                    <Pill tone={o.status === 'Verified' ? 'ok' : 'info'}>{o.status}</Pill>
                  </span>
                </div>
                {o.results.length ? (
                  <div className="flex flex-wrap gap-2">
                    {o.results.map((x) => (
                      <Pill key={x.analyteCode} tone={FLAG_TONE[x.flag] ?? 'plain'}>
                        {x.name} {x.value} {x.unit ?? ''} {x.flag !== 'N' ? `(${x.flag})` : ''}
                      </Pill>
                    ))}
                  </div>
                ) : null}
                <div className="flex flex-wrap items-center gap-1.5">
                  {o.status === 'Ordered' ? (
                    <button className="btn btn-primary h-7 px-2.5 text-xs" onClick={() => run(() => api(`/lab/orders/${o.id}/collect`, { body: {} }))}>
                      {t('Collect & label', 'Qaado muunad')}
                    </button>
                  ) : null}
                  {o.status === 'Collected' ? (
                    <button className="btn btn-primary h-7 px-2.5 text-xs" onClick={() => run(() => api(`/lab/orders/${o.id}/receive`, { body: {} }))}>
                      {t('Receive in lab', 'Qaabil')}
                    </button>
                  ) : null}
                  {o.status === 'Processing' && def ? (
                    <form
                      className="flex flex-wrap items-center gap-1.5"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void run(() =>
                          api(`/lab/orders/${o.id}/results`, {
                            body: { results: def.analytes.map((an) => ({ analyteCode: an.code, value: Number.isNaN(Number(vals[an.code])) ? vals[an.code] : Number(vals[an.code]) })) },
                          }),
                        );
                      }}
                    >
                      {def.analytes.map((an) => (
                        <label key={an.code} className="flex items-center gap-1 text-xs">
                          {an.code}
                          <input className="input h-7 w-20 px-2 text-xs" required value={vals[an.code] ?? ''} onChange={(e) => setEntry({ ...entry, [o.id]: { ...vals, [an.code]: e.target.value } })} aria-label={an.name} />
                          <span className="text-ink-3">{an.unit}</span>
                        </label>
                      ))}
                      <button className="btn h-7 px-2.5 text-xs">{t('Save results', 'Kaydi')}</button>
                    </form>
                  ) : null}
                  {pathologist && o.status === 'Processing' && o.results.length ? (
                    <button className="btn btn-primary h-7 px-2.5 text-xs" onClick={() => run(() => api(`/lab/orders/${o.id}/verify`, { body: {} }))}>
                      {t('Verify', 'Xaqiiji')}
                    </button>
                  ) : null}
                  {pathologist && o.status === 'Verified' ? (
                    <button className="btn btn-primary h-7 px-2.5 text-xs" onClick={() => run(() => api(`/lab/orders/${o.id}/release`, { body: {} }))}>
                      {t('Release to clinician', 'Sii daa')}
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
          {!list.length ? <li className="px-4 pb-4 text-ink-3">{t('Nothing waiting.', 'Waxba ma sugayaan.')}</li> : null}
        </ul>
      </Card>
    </>
  );
}
