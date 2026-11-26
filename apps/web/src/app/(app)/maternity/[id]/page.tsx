'use client';

import Link from 'next/link';
import { use, useCallback, useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { canDo, useMe } from '@/lib/session';
import { useReauth } from '@/components/Reauth';
import { Card, ErrorNote, Field, PageHeader, Pill, useAction } from '@/components/ui';

interface Visit {
  id: string;
  at: string;
  gestation: { weeks: number; days: number };
  bp: string;
  fetalHeartRate: number | null;
  presentation: string | null;
  flags: string[];
}
interface Pregnancy {
  id: string;
  patientId: string;
  status: string;
  lmp: string;
  edd: string;
  gravida: number;
  para: number;
  gestation: { weeks: number; days: number } | null;
  visits: Visit[];
  delivery: { at: string; mode: string; bloodLossMl: number; babies: { sexAtBirth: string; weightGrams: number; apgar1: number; apgar5: number; outcome: string }[]; newbornIds: string[]; recordedByName: string } | null;
}
type BabyForm = { sexAtBirth: string; weightGrams: string; apgar1: string; apgar5: string; outcome: string };
const BABY: BabyForm = { sexAtBirth: 'female', weightGrams: '3200', apgar1: '8', apgar5: '9', outcome: 'live' };

export default function PregnancyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { me } = useMe();
  const { t } = useLang();
  const [p, setP] = useState<Pregnancy | null>(null);
  const [v, setV] = useState({ bpSystolic: '', bpDiastolic: '', fetalHeartRate: '', presentation: 'cephalic' });
  const [d, setD] = useState({ deliveredAt: '', mode: 'spontaneous-vaginal', bloodLossMl: '300', babies: [BABY] });
  const [warnings, setWarnings] = useState<string[]>([]);
  const load = useAction();
  const act = useAction();
  const { guarded, dialog } = useReauth();

  const refresh = useCallback(async () => {
    await load.run(async () => setP(await api<Pregnancy>(`/maternity/pregnancies/${id}`)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  if (!p) return <ErrorNote error={load.error} />;

  const run = async (fn: () => Promise<unknown>) => {
    if ((await act.run(fn)) !== undefined) await refresh();
  };
  const setBaby = (i: number, k: keyof BabyForm, val: string) => setD({ ...d, babies: d.babies.map((b, j) => (j === i ? { ...b, [k]: val } : b)) });

  return (
    <>
      {dialog}
      <PageHeader title={t('Pregnancy record', 'Diiwaanka uurka')}>
        <span className="flex flex-wrap gap-2">
          <Pill tone={p.status === 'active' ? 'info' : 'ok'}>{p.status}</Pill>
          <span>
            G{p.gravida} P{p.para} · LMP {p.lmp} · EDD {p.edd}
          </span>
          {p.gestation ? (
            <b>
              {p.gestation.weeks}+{p.gestation.days} {t('weeks', 'toddobaad')}
            </b>
          ) : null}
          <Link className="text-accent-2 underline" href={`/patients/${p.patientId}`}>
            {t('Mother’s record', 'Diiwaanka hooyada')}
          </Link>
        </span>
      </PageHeader>
      <ErrorNote error={act.error} />
      {warnings.length ? <div className="rounded-[10px] bg-crit-soft px-4 py-2.5 text-[13px] font-semibold text-crit">{warnings.join(' · ')}</div> : null}

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Card title={t('Antenatal visits', 'Booqashooyinka uurka')}>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className="th">{t('Date', 'Taariikh')}</th>
                  <th className="th">GA</th>
                  <th className="th">BP</th>
                  <th className="th">FHR</th>
                  <th className="th">{t('Flags', 'Digniino')}</th>
                </tr>
              </thead>
              <tbody>
                {p.visits.map((x) => (
                  <tr key={x.id}>
                    <td className="td num">{new Date(x.at).toLocaleDateString()}</td>
                    <td className="td num">
                      {x.gestation.weeks}+{x.gestation.days}
                    </td>
                    <td className="td num font-mono">{x.bp}</td>
                    <td className="td num font-mono">{x.fetalHeartRate ?? '—'}</td>
                    <td className="td">
                      {x.flags.map((f) => (
                        <Pill key={f} tone="crit">
                          {f}
                        </Pill>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {p.status === 'active' && canDo(me, 'mat', 'E') ? (
            <form
              className="flex flex-wrap items-end gap-2 border-t border-line px-4 py-3"
              onSubmit={(e) => {
                e.preventDefault();
                void run(() =>
                  api(`/maternity/pregnancies/${id}/antenatal`, {
                    body: { bpSystolic: Number(v.bpSystolic), bpDiastolic: Number(v.bpDiastolic), ...(v.fetalHeartRate ? { fetalHeartRate: Number(v.fetalHeartRate) } : {}), presentation: v.presentation },
                  }),
                );
              }}
            >
              <Field label="BP sys">
                <input className="input h-9 w-20" required inputMode="numeric" value={v.bpSystolic} onChange={(e) => setV({ ...v, bpSystolic: e.target.value })} />
              </Field>
              <Field label="BP dia">
                <input className="input h-9 w-20" required inputMode="numeric" value={v.bpDiastolic} onChange={(e) => setV({ ...v, bpDiastolic: e.target.value })} />
              </Field>
              <Field label="FHR">
                <input className="input h-9 w-20" inputMode="numeric" value={v.fetalHeartRate} onChange={(e) => setV({ ...v, fetalHeartRate: e.target.value })} />
              </Field>
              <Field label={t('Presentation', 'Booska')}>
                <select className="input h-9" value={v.presentation} onChange={(e) => setV({ ...v, presentation: e.target.value })}>
                  {['cephalic', 'breech', 'transverse', 'unknown'].map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
              </Field>
              <button className="btn btn-primary h-9">{t('Record visit', 'Qor')}</button>
            </form>
          ) : null}
        </Card>

        <Card title={t('Delivery', 'Dhalmada')}>
          {p.delivery ? (
            <div className="grid gap-2 px-4 pb-4 text-[13px]">
              <p>
                {new Date(p.delivery.at).toLocaleString()} · {p.delivery.mode} · {p.delivery.bloodLossMl} ml · {p.delivery.recordedByName}
              </p>
              {p.delivery.babies.map((b, i) => {
                // newbornIds holds live births only, in order; map this baby to its record.
                const liveIndex = p.delivery!.babies.slice(0, i).filter((x) => x.outcome === 'live').length;
                const babyId = b.outcome === 'live' ? p.delivery!.newbornIds[liveIndex] : undefined;
                return (
                  <div key={i} className="flex items-center justify-between rounded-lg border border-line p-2">
                    <span>
                      {b.sexAtBirth} · {b.weightGrams} g · Apgar {b.apgar1}/{b.apgar5}
                    </span>
                    {babyId ? (
                      <Link className="btn h-7 px-2.5 text-xs" href={`/patients/${babyId}`}>
                        {t('Newborn record', 'Diiwaanka ilmaha')}
                      </Link>
                    ) : (
                      <Pill tone="crit">{b.outcome}</Pill>
                    )}
                  </div>
                );
              })}
            </div>
          ) : canDo(me, 'mat', 'S') ? (
            <form
              className="grid gap-2 px-4 pb-4"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  const r = await guarded(() =>
                    api<{ warnings: string[] }>(`/maternity/pregnancies/${id}/delivery`, {
                      body: {
                        deliveredAt: new Date(d.deliveredAt).toISOString(),
                        mode: d.mode,
                        bloodLossMl: Number(d.bloodLossMl),
                        babies: d.babies.map((b) => ({ sexAtBirth: b.sexAtBirth, weightGrams: Number(b.weightGrams), apgar1: Number(b.apgar1), apgar5: Number(b.apgar5), outcome: b.outcome })),
                      },
                    }),
                  );
                  setWarnings(r.warnings);
                  return r;
                });
              }}
            >
              <div className="grid grid-cols-2 gap-2">
                <Field label={t('Delivered at', 'Waqtiga')}>
                  <input className="input h-9" type="datetime-local" required value={d.deliveredAt} onChange={(e) => setD({ ...d, deliveredAt: e.target.value })} />
                </Field>
                <Field label={t('Blood loss (ml)', 'Dhiigga (ml)')}>
                  <input className="input h-9" inputMode="numeric" value={d.bloodLossMl} onChange={(e) => setD({ ...d, bloodLossMl: e.target.value })} />
                </Field>
              </div>
              <select className="input h-9" value={d.mode} onChange={(e) => setD({ ...d, mode: e.target.value })} aria-label="Mode of delivery">
                {['spontaneous-vaginal', 'assisted-vaginal', 'caesarean'].map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
              {d.babies.map((b, i) => (
                <div key={i} className="grid grid-cols-[repeat(5,minmax(0,1fr))_auto] items-center gap-1.5 rounded-lg border border-line p-2">
                  <select className="input h-8 px-1 text-xs" value={b.sexAtBirth} onChange={(e) => setBaby(i, 'sexAtBirth', e.target.value)} aria-label="Sex">
                    <option>female</option>
                    <option>male</option>
                    <option>unknown</option>
                  </select>
                  <input className="input h-8 px-1 text-xs" aria-label="Weight grams" value={b.weightGrams} onChange={(e) => setBaby(i, 'weightGrams', e.target.value)} />
                  <input className="input h-8 px-1 text-xs" aria-label="Apgar 1 min" value={b.apgar1} onChange={(e) => setBaby(i, 'apgar1', e.target.value)} />
                  <input className="input h-8 px-1 text-xs" aria-label="Apgar 5 min" value={b.apgar5} onChange={(e) => setBaby(i, 'apgar5', e.target.value)} />
                  <select className="input h-8 px-1 text-xs" value={b.outcome} onChange={(e) => setBaby(i, 'outcome', e.target.value)} aria-label="Outcome">
                    <option>live</option>
                    <option>stillbirth</option>
                  </select>
                  <button type="button" aria-label="Remove baby" disabled={d.babies.length === 1} onClick={() => setD({ ...d, babies: d.babies.filter((_, j) => j !== i) })}>
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
              <span className="flex gap-2">
                <button type="button" className="btn h-8 text-xs" onClick={() => setD({ ...d, babies: [...d.babies, BABY] })}>
                  <Plus size={14} />
                  {t('Another baby', 'Ilmo kale')}
                </button>
                <button className="btn btn-primary h-8 text-xs">{t('Sign delivery', 'Saxiix dhalmada')}</button>
              </span>
            </form>
          ) : (
            <p className="px-4 pb-4 text-[13px] text-ink-3">{t('Recorded by the obstetrician.', 'Dhakhtarka umulaha ayaa qora.')}</p>
          )}
        </Card>
      </div>
    </>
  );
}
