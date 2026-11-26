'use client';

import { useEffect, useState } from 'react';
import { FlaskConical, ScanLine } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { when } from '@/lib/portal';
import { usePortal } from '@/components/PortalShell';
import { Empty, ErrorNote, useAction } from '@/components/ui';

interface Result {
  id: string;
  kind: 'lab' | 'imaging';
  name: string;
  at: string;
  sharedBy: string;
  results: { name: string; value: number | string; unit: string | null; flag: string | null; range: string | null }[];
  report: { impression: string; findings: string } | null;
}

const FLAG: Record<string, [string, string, string]> = {
  L: ['Low', 'Hoose', 'text-warn'],
  H: ['High', 'Sare', 'text-warn'],
  LL: ['Very low', 'Aad u hoose', 'text-crit'],
  HH: ['Very high', 'Aad u sare', 'text-crit'],
  A: ['Not normal', 'Caadi ma aha', 'text-warn'],
};

export default function PortalResults() {
  const { current } = usePortal();
  const { t, lang } = useLang();
  const [list, setList] = useState<Result[]>([]);
  const act = useAction();
  useEffect(() => {
    if (current) void act.run(async () => setList(await api<Result[]>(`/portal/${current.id}/results`)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  return (
    <>
      <div>
        <h1 className="text-[24px] font-extrabold">{t('Results', 'Natiijooyinka')}</h1>
        <p className="text-[13.5px] text-ink-3">{t('Your doctor shares results here after reviewing them. Ask your doctor what they mean for you.', 'Dhakhtarkaagu halkan ayuu ku wadaagaa natiijooyinka kadib markuu eego. Weydii dhakhtarkaaga macnahooda.')}</p>
      </div>
      <ErrorNote error={act.error} />
      {list.length ? (
        list.map((r) => (
          <section key={r.id} className="card p-4">
            <div className="mb-3 flex items-center gap-3">
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-accent-soft text-accent-2">{r.kind === 'lab' ? <FlaskConical size={18} /> : <ScanLine size={18} />}</span>
              <span className="min-w-0 flex-1">
                <b className="block text-[15px]">{r.name}</b>
                <span className="text-[12.5px] text-ink-3">
                  {when(r.at, lang)} · {t('shared by', 'wadaagay')} {r.sharedBy}
                </span>
              </span>
            </div>
            {r.results.length ? (
              <table className="w-full text-[13.5px]">
                <tbody>
                  {r.results.map((x) => (
                    <tr key={x.name} className="border-t border-line">
                      <td className="py-2 pr-2">{x.name}</td>
                      <td className="num py-2 text-right font-semibold">
                        {x.value} <span className="font-normal text-ink-3">{x.unit}</span>
                      </td>
                      <td className="py-2 pl-3 text-right text-[12.5px]">
                        {x.flag && x.flag !== 'N' && FLAG[x.flag] ? <span className={`font-semibold ${FLAG[x.flag]![2]}`}>{lang === 'so' ? FLAG[x.flag]![1] : FLAG[x.flag]![0]}</span> : <span className="text-ok">{t('Normal', 'Caadi')}</span>}
                        {x.range ? <span className="block text-ink-3">{x.range}</span> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
            {r.report ? (
              <div className="grid gap-1 text-[13.5px]">
                <b>{t('Conclusion', 'Gunaanad')}</b>
                <p>{r.report.impression}</p>
              </div>
            ) : null}
          </section>
        ))
      ) : (
        <div className="card">
          <Empty>{t('No results have been shared with you yet.', 'Weli natiijo laguma wadaagin.')}</Empty>
        </div>
      )}
    </>
  );
}
