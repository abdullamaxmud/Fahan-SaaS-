'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { useReauth } from './Reauth';
import { fullName, type PatientBrief } from './clinical';
import { Card, ErrorNote, PageHeader, Pill, useAction } from './ui';

interface Order {
  id: string;
  accessionNumber: string;
  modality: string;
  examination: string;
  priority: string;
  status: string;
  clinicalQuestion: string;
  assetCode: string | null;
  scheduledFor: string | null;
  report: { findings: string; impression: string } | null;
  patient: Pick<PatientBrief, 'mrn' | 'names' | 'dob' | 'sexAtBirth'> | null;
}
interface Asset {
  id: string;
  code: string;
  modality: string | null;
  usable: boolean;
  blockedReason: string | null;
}

/** Shared worklist for radiology (§5.12) and diagnostics (§5.13). */
export function ImagingWorklist({ base, spec, title, canReport, needsStudyUid }: { base: string; spec: string; title: string; canReport: boolean; needsStudyUid: boolean }) {
  const { t } = useLang();
  const [list, setList] = useState<Order[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [form, setForm] = useState<Record<string, { assetId?: string; at?: string; uid?: string; findings?: string; impression?: string; critical?: string }>>({});
  const load = useAction();
  const act = useAction();
  const { guarded, dialog } = useReauth();

  const refresh = useCallback(async () => {
    await load.run(async () => {
      setList(await api<Order[]>(`${base}/worklist`));
      setAssets(await api<Asset[]>('/equipment/assets').catch(() => []));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const run = async (fn: () => Promise<unknown>) => {
    if ((await act.run(fn)) !== undefined) await refresh();
  };

  return (
    <>
      {dialog}
      <PageHeader eyebrow={spec} title={title}>
        {t('Only working, calibrated devices can be booked. Reports are visible to the doctor once signed.', 'Qalab shaqeynaya oo kaliya ayaa la ballansan karaa.')}
      </PageHeader>
      <ErrorNote error={load.error ?? act.error} />
      <Card title={`${t('Worklist', 'Liiska shaqada')} · ${list.length}`}>
        <ul className="grid text-[13px]">
          {list.map((o) => {
            const f = form[o.id] ?? {};
            const set = (k: string, v: string) => setForm({ ...form, [o.id]: { ...f, [k]: v } });
            const devices = assets.filter((a) => a.modality === o.modality);
            return (
              <li key={o.id} className="grid gap-2 border-t border-line px-4 py-3 first:border-t-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-md bg-surface-2 px-1.5 font-mono text-xs font-bold">{o.modality}</span>
                  <b>{o.examination}</b>
                  <Pill tone={o.priority === 'stat' ? 'crit' : o.priority === 'urgent' ? 'warn' : 'plain'}>{o.priority}</Pill>
                  <span className="text-ink-2">
                    {o.patient ? fullName(o.patient.names) : ''} · <span className="font-mono">{o.patient?.mrn}</span>
                  </span>
                  <span className="ml-auto flex items-center gap-2">
                    <span className="font-mono text-xs">{o.accessionNumber}</span>
                    <Pill tone={o.status === 'Interpreted' ? 'warn' : 'info'}>{o.status}</Pill>
                  </span>
                </div>
                <p className="text-ink-2">“{o.clinicalQuestion}”</p>
                {o.status === 'Ordered' ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <select className="input h-8 w-auto text-xs" value={f.assetId ?? ''} onChange={(e) => set('assetId', e.target.value)} aria-label="Device">
                      <option value="">{t('Choose device…', 'Dooro qalab…')}</option>
                      {devices.map((a) => (
                        <option key={a.id} value={a.id} disabled={!a.usable}>
                          {a.code}
                          {a.usable ? '' : ` — ${a.blockedReason}`}
                        </option>
                      ))}
                    </select>
                    <input className="input h-8 w-auto text-xs" type="datetime-local" value={f.at ?? ''} onChange={(e) => set('at', e.target.value)} aria-label="Time" />
                    <button className="btn btn-primary h-8 text-xs" disabled={!f.assetId || !f.at} onClick={() => run(() => api(`${base}/orders/${o.id}/schedule`, { body: { assetId: f.assetId, startsAt: new Date(f.at!).toISOString() } }))}>
                      {t('Book', 'Ballanso')}
                    </button>
                  </div>
                ) : null}
                {o.status === 'Scheduled' ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs text-ink-3">
                      {o.assetCode} · {o.scheduledFor ? new Date(o.scheduledFor).toLocaleString() : ''}
                    </span>
                    {needsStudyUid ? <input className="input h-8 w-72 font-mono text-xs" placeholder="StudyInstanceUID from PACS" value={f.uid ?? ''} onChange={(e) => set('uid', e.target.value)} /> : null}
                    <button className="btn btn-primary h-8 text-xs" onClick={() => run(() => api(`${base}/orders/${o.id}/acquire`, { body: needsStudyUid ? { studyInstanceUid: f.uid } : {} }))}>
                      {t('Mark acquired', 'Waa la qaaday')}
                    </button>
                  </div>
                ) : null}
                {canReport && ['Acquired', 'Interpreted'].includes(o.status) ? (
                  <div className="grid gap-1.5">
                    <textarea className="input min-h-20 py-2" placeholder={t('Findings', 'Natiijooyinka')} value={f.findings ?? o.report?.findings ?? ''} onChange={(e) => set('findings', e.target.value)} />
                    <input className="input h-8" placeholder={t('Impression', 'Gunaanadka')} value={f.impression ?? o.report?.impression ?? ''} onChange={(e) => set('impression', e.target.value)} />
                    <input className="input h-8" placeholder={t('Critical finding (leave empty if none)', 'Natiijo khatar ah')} value={f.critical ?? ''} onChange={(e) => set('critical', e.target.value)} />
                    <span className="flex gap-2">
                      <button className="btn h-8 text-xs" onClick={() => run(() => api(`${base}/orders/${o.id}/report`, { body: { findings: f.findings ?? o.report?.findings, impression: f.impression ?? o.report?.impression } }))}>
                        {t('Save report', 'Kaydi')}
                      </button>
                      {o.status === 'Interpreted' ? (
                        <button className="btn btn-primary h-8 text-xs" onClick={() => run(() => guarded(() => api(`${base}/orders/${o.id}/sign`, { body: f.critical ? { criticalFinding: f.critical } : {} })))}>
                          {t('Sign as final', 'Saxiix')}
                        </button>
                      ) : null}
                    </span>
                  </div>
                ) : null}
              </li>
            );
          })}
          {!list.length ? <li className="px-4 pb-4 text-ink-3">{t('Nothing waiting.', 'Waxba ma sugayaan.')}</li> : null}
        </ul>
      </Card>
    </>
  );
}
