'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { BedDouble } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { canDo, useMe } from '@/lib/session';
import { useReauth } from '@/components/Reauth';
import { fullName, type PatientBrief } from '@/components/clinical';
import { Card, ErrorNote, PageHeader, Pill, statusTone, useAction } from '@/components/ui';

interface Bed {
  id: string;
  code: string;
  status: string;
  admissionId: string | null;
  patient: (PatientBrief & { initials?: string }) | { initials: string } | null;
}
interface Ward {
  id: string;
  code: string;
  name: string;
  kind: string;
  beds: Bed[];
}
interface Admission {
  id: string;
  status: string;
  source: string;
  reason: string;
  bed: string | null;
  attending: string;
  encounterId: string | null;
  patient: PatientBrief | null;
}

const BED_STYLE: Record<string, string> = {
  Available: 'border-dashed border-line-2 bg-surface',
  Reserved: 'border-info/40 bg-info-soft',
  Occupied: 'border-accent/40 bg-accent-soft',
  Cleaning: 'border-warn/40 bg-warn-soft',
  OutOfService: 'border-crit/40 bg-crit-soft',
};

export default function WardsPage() {
  const { me } = useMe();
  const { t } = useLang();
  const [wards, setWards] = useState<Ward[]>([]);
  const [adms, setAdms] = useState<Admission[]>([]);
  const [pick, setPick] = useState<{ admission: Admission; mode: 'assign' | 'transfer' } | null>(null);
  const [discharge, setDischarge] = useState<{ id: string; disposition: string; summary: string; followUp: string } | null>(null);
  const load = useAction();
  const act = useAction();
  const { guarded, dialog } = useReauth();
  const canBeds = canDo(me, 'bed', 'E') || canDo(me, 'adm', 'E');
  const canDischarge = canDo(me, 'opd', 'S') || canDo(me, 'icu', 'S') || canDo(me, 'mat', 'S');

  const refresh = useCallback(async () => {
    await load.run(async () => {
      setWards(await api<Ward[]>('/wards'));
      if (canDo(me, 'adm', 'V')) setAdms(await api<Admission[]>('/admissions'));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (fn: () => Promise<unknown>) => {
    if ((await act.run(fn)) !== undefined) await refresh();
  };

  async function onBed(b: Bed) {
    if (pick && b.status === 'Available') {
      const { admission, mode } = pick;
      await run(() =>
        mode === 'assign'
          ? api(`/admissions/${admission.id}/assign-bed`, { body: { bedId: b.id } })
          : api(`/admissions/${admission.id}/transfer`, { body: { bedId: b.id, reason: 'Bed move on ward board' } }),
      );
      setPick(null);
    } else if (b.status === 'Cleaning' && canBeds) {
      await run(() => api(`/beds/${b.id}/status`, { body: { status: 'Available' } }));
    }
  }

  const name = (p: Bed['patient']) => (!p ? '' : 'names' in p && p.names ? fullName(p.names) : (p.initials ?? ''));

  return (
    <>
      {dialog}
      <PageHeader title={t('Wards & beds', 'Qolalka & sariiraha')}>
        {t('Pick an admission, then click a free bed.', 'Dooro dhigis, kadib guji sariir bannaan.')}
      </PageHeader>
      {pick ? (
        <div className="flex items-center gap-3 rounded-[10px] bg-info-soft px-4 py-2.5 text-[13px] text-info">
          <BedDouble size={16} />
          {pick.mode === 'assign' ? t('Choose a free bed for', 'Dooro sariir bannaan') : t('Choose the new bed for', 'Dooro sariirta cusub')} <b>{pick.admission.patient ? fullName(pick.admission.patient.names) : ''}</b>
          <button className="btn ml-auto h-7 px-2.5 text-xs" onClick={() => setPick(null)}>
            {t('Cancel', 'Jooji')}
          </button>
        </div>
      ) : null}
      <ErrorNote error={load.error ?? act.error} />

      {wards.map((w) => {
        const occ = w.beds.filter((b) => b.status === 'Occupied').length;
        return (
          <Card key={w.id} title={`${w.code} · ${w.name}`} actions={<span className="text-xs text-ink-3">{occ}/{w.beds.length} {t('occupied', 'buuxa')} · {w.kind}</span>}>
            <div className="grid grid-cols-2 gap-2 px-4 pb-4 sm:grid-cols-4 lg:grid-cols-6">
              {w.beds.map((b) => (
                <button key={b.id} onClick={() => onBed(b)} className={`flex min-h-20 flex-col gap-0.5 rounded-[10px] border p-2 text-left text-xs ${BED_STYLE[b.status] ?? ''} ${pick && b.status === 'Available' ? 'ring-2 ring-accent' : ''}`}>
                  <b className="font-mono text-[11.5px]">{b.code}</b>
                  <span className="line-clamp-2 text-[12.5px] font-semibold text-ink">{name(b.patient)}</span>
                  <span className="mt-auto text-[11px] text-ink-3">{b.status}</span>
                </button>
              ))}
            </div>
          </Card>
        );
      })}

      {canDo(me, 'adm', 'V') ? (
        <Card title={t('Active admissions', 'Dhigisyada socda')}>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className="th">{t('Patient', 'Bukaanka')}</th>
                  <th className="th">{t('Reason', 'Sababta')}</th>
                  <th className="th">{t('Doctor', 'Dhakhtarka')}</th>
                  <th className="th">{t('Bed', 'Sariirta')}</th>
                  <th className="th">Status</th>
                  <th className="th" />
                </tr>
              </thead>
              <tbody>
                {adms.map((a) => (
                  <tr key={a.id}>
                    <td className="td">
                      <b className="block">{a.patient ? fullName(a.patient.names) : '—'}</b>
                      <span className="font-mono text-[11.5px] text-ink-3">
                        {a.patient?.mrn} · {a.source}
                      </span>
                    </td>
                    <td className="td text-ink-2">{a.reason}</td>
                    <td className="td">{a.attending}</td>
                    <td className="td font-mono">{a.bed ?? '—'}</td>
                    <td className="td">
                      <Pill tone={statusTone(a.status === 'Admitted' ? 'Active' : 'Pending')}>{a.status}</Pill>
                    </td>
                    <td className="td whitespace-nowrap text-right">
                      <span className="flex justify-end gap-1.5">
                        {canBeds && a.status === 'Requested' ? (
                          <button className="btn btn-primary h-7 px-2.5 text-xs" onClick={() => setPick({ admission: a, mode: 'assign' })}>
                            {t('Assign bed', 'Sii sariir')}
                          </button>
                        ) : null}
                        {canBeds && a.status === 'Admitted' ? (
                          <button className="btn h-7 px-2.5 text-xs" onClick={() => setPick({ admission: a, mode: 'transfer' })}>
                            {t('Transfer', 'U wareeji')}
                          </button>
                        ) : null}
                        {a.encounterId && canDo(me, 'nur', 'V') ? (
                          <Link className="btn h-7 px-2.5 text-xs" href={`/encounters/${a.encounterId}`}>
                            {t('Chart', 'Kaarka')}
                          </Link>
                        ) : null}
                        {canDischarge && a.status === 'Admitted' ? (
                          <button className="btn h-7 px-2.5 text-xs" onClick={() => setDischarge({ id: a.id, disposition: 'home', summary: '', followUp: '' })}>
                            {t('Discharge', 'Ka saar')}
                          </button>
                        ) : null}
                      </span>
                      {discharge?.id === a.id ? (
                        <form
                          className="mt-2 grid gap-2 text-left"
                          onSubmit={(e) => {
                            e.preventDefault();
                            void run(async () => {
                              const r = await guarded(() => api(`/admissions/${a.id}/discharge`, { body: { disposition: discharge.disposition, summary: discharge.summary, ...(discharge.followUp ? { followUp: discharge.followUp } : {}) } }));
                              setDischarge(null);
                              return r;
                            });
                          }}
                        >
                          <select className="input h-8" value={discharge.disposition} onChange={(e) => setDischarge({ ...discharge, disposition: e.target.value })} aria-label="Disposition">
                            {['home', 'referred', 'transferred-out', 'against-advice', 'deceased'].map((d) => (
                              <option key={d}>{d}</option>
                            ))}
                          </select>
                          <textarea className="input min-h-24 py-2" required minLength={20} placeholder={t('Discharge summary (signed)', 'Warbixinta ka bixitaanka')} value={discharge.summary} onChange={(e) => setDischarge({ ...discharge, summary: e.target.value })} />
                          <input className="input h-8" placeholder={t('Follow-up', 'La socod')} value={discharge.followUp} onChange={(e) => setDischarge({ ...discharge, followUp: e.target.value })} />
                          <button className="btn btn-primary h-8 justify-self-start text-xs">{t('Sign and discharge', 'Saxiix oo ka saar')}</button>
                        </form>
                      ) : null}
                    </td>
                  </tr>
                ))}
                {!adms.length ? (
                  <tr>
                    <td className="td text-ink-3" colSpan={6}>
                      {t('No active admissions.', 'Dhigis ma jiro.')}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
    </>
  );
}
