'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { canDo, useMe } from '@/lib/session';
import { useReauth } from '@/components/Reauth';
import { fullName, type PatientBrief } from '@/components/clinical';
import { Card, ErrorNote, PageHeader, Pill, statusTone, useAction } from '@/components/ui';

interface MergeRequest {
  id: string;
  status: string;
  reason: string;
  survivor: PatientBrief | null;
  duplicate: PatientBrief | null;
  requestedBy: string;
  createdAt: string;
}

export default function MergesPage() {
  const { me } = useMe();
  const { t } = useLang();
  const [list, setList] = useState<MergeRequest[]>([]);
  const load = useAction();
  const act = useAction();
  const { guarded, dialog } = useReauth();
  const approver = canDo(me, 'mpi', 'A');

  const refresh = useCallback(async () => {
    await load.run(async () => setList(await api<MergeRequest[]>('/patients/merge-requests')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function decide(m: MergeRequest, action: 'approve' | 'reject' | 'reverse') {
    if (await act.run(() => guarded(() => api(`/patients/merge-requests/${m.id}/${action}`, { body: {} })))) await refresh();
  }

  const who = (p: PatientBrief | null) =>
    p ? (
      <Link href={`/patients/${p.id}`} className="hover:underline">
        <b className="block">{fullName(p.names)}</b>
        <span className="font-mono text-[11.5px] text-ink-3">
          {p.mrn} · {p.dob}
        </span>
      </Link>
    ) : (
      '—'
    );

  return (
    <>
      {dialog}
      <PageHeader eyebrow="Spec §4.1" title={t('Merge requests', 'Codsiyada isku-darka')}>
        {t('A merge links two records of the same person. It needs a second person to approve it and can be reversed.', 'Isku-darku wuxuu u baahan yahay qof labaad oo ansixiya.')}
      </PageHeader>
      <ErrorNote error={load.error ?? act.error} />
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <th className="th">{t('Keep', 'Hay')}</th>
                <th className="th">{t('Merge in', 'Ku dar')}</th>
                <th className="th">{t('Reason', 'Sababta')}</th>
                <th className="th">Status</th>
                <th className="th" />
              </tr>
            </thead>
            <tbody>
              {list.map((m) => (
                <tr key={m.id}>
                  <td className="td">{who(m.survivor)}</td>
                  <td className="td">{who(m.duplicate)}</td>
                  <td className="td max-w-[32ch] text-ink-2">{m.reason}</td>
                  <td className="td">
                    <Pill tone={statusTone(m.status === 'Approved' ? 'Active' : m.status)}>{m.status}</Pill>
                  </td>
                  <td className="td whitespace-nowrap text-right">
                    {approver && m.status === 'Pending' ? (
                      <span className="flex justify-end gap-2">
                        <button className="btn btn-primary h-7 px-2.5 text-xs" disabled={act.busy || m.requestedBy === me.id} title={m.requestedBy === me.id ? 'You requested this merge' : undefined} onClick={() => decide(m, 'approve')}>
                          {t('Approve', 'Ansixi')}
                        </button>
                        <button className="btn h-7 px-2.5 text-xs" disabled={act.busy} onClick={() => decide(m, 'reject')}>
                          {t('Reject', 'Diid')}
                        </button>
                      </span>
                    ) : null}
                    {approver && m.status === 'Approved' ? (
                      <button className="btn h-7 px-2.5 text-xs" disabled={act.busy} onClick={() => decide(m, 'reverse')}>
                        {t('Reverse', 'Dib u celi')}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
              {!list.length && !load.busy ? (
                <tr>
                  <td className="td text-ink-3" colSpan={5}>
                    {t('No merge requests.', 'Codsi ma jiro.')}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
