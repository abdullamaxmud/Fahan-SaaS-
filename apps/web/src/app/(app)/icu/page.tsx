'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Activity, FileText, Plus, Wind } from 'lucide-react';
import { VITALS } from '@fahan/terminology';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { canDo, useMe } from '@/lib/session';
import { age, fullName, type PatientBrief } from '@/components/clinical';
import { Drawer, Facts, fmtDateTime } from '@/components/Dialog';
import { Card, Empty, ErrorNote, Field, PageHeader, Pill, useAction } from '@/components/ui';

interface Vital {
  code: string;
  value: number;
  unit: string;
  at: string;
  source: string;
  deviceId: string | null;
}
interface Stay {
  id: string;
  unit: string;
  status: string;
  acuity: number;
  ventilated: boolean;
  reason: string;
  openedAt: string;
  encounterId: string;
  patient: PatientBrief | null;
  bed: string | null;
  devices: { deviceId: string; kind: string; label: string }[];
  vitals?: Vital[];
}
interface StayDetail extends Stay {
  reviews: { at: string; byName: string; note: string; acuity: number; ventilated: boolean }[];
  trend: Vital[];
}

const SHOW = ['heart-rate', 'spo2', 'bp-systolic', 'resp-rate', 'temperature'];
const SHORT: Record<string, string> = { 'heart-rate': 'HR', spo2: 'SpO₂', 'bp-systolic': 'BP', 'resp-rate': 'RR', temperature: 'T' };
const ACUITY: Record<number, [string, string, 'crit' | 'warn' | 'info']> = {
  1: ['Critical', 'Halis', 'crit'],
  2: ['Serious', 'Culus', 'warn'],
  3: ['Stable', 'Deggan', 'info'],
};

function Spark({ points }: { points: number[] }) {
  if (points.length < 2) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const d = points.map((v, i) => `${(i / (points.length - 1)) * 100},${28 - ((v - min) / (max - min || 1)) * 24}`).join(' ');
  return (
    <svg viewBox="0 0 100 30" className="h-8 w-full" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={d} fill="none" stroke="rgb(var(--accent))" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export default function IcuPage() {
  const { me } = useMe();
  const { t, lang } = useLang();
  const [list, setList] = useState<Stay[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const load = useAction();

  const refresh = useCallback(async () => {
    await load.run(async () => setList(await api<Stay[]>('/icu/stays')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 60_000);
    return () => clearInterval(timer);
  }, [refresh]);

  return (
    <>
      <PageHeader
        title={t('Intensive care', 'Daryeelka degdegga ah')}
        actions={
          canDo(me, 'icu', 'E') ? (
            <button className="btn btn-primary" onClick={() => setAdding(true)}>
              <Plus size={16} />
              {t('Admit to ICU', 'Gali ICU')}
            </button>
          ) : null
        }
      >
        {t('Patients in critical care, most unwell first. Refreshes every minute.', 'Bukaanka daryeelka degdegga ah, kan ugu xun marka hore.')}
      </PageHeader>
      <ErrorNote error={load.error} />
      {list.length ? (
        <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
          {list.map((s) => (
            <button key={s.id} onClick={() => setOpen(s.id)} className={`card grid gap-3 p-4 text-left hover:border-accent ${s.acuity === 1 ? 'border-crit/50' : ''}`}>
              <div className="flex items-start gap-2">
                <span className="min-w-0 flex-1">
                  <b className="block truncate text-[15px]">{s.patient ? fullName(s.patient.names) : '—'}</b>
                  <span className="text-[12.5px] text-ink-3">
                    {s.unit}
                    {s.bed ? ` · ${s.bed}` : ''} · {s.patient ? age(s.patient.dob) : ''}
                  </span>
                </span>
                <Pill tone={ACUITY[s.acuity]?.[2]}>{lang === 'so' ? ACUITY[s.acuity]?.[1] : ACUITY[s.acuity]?.[0]}</Pill>
              </div>
              <span className="line-clamp-1 text-[13px] text-ink-2">{s.reason}</span>
              <div className="grid grid-cols-5 gap-1.5">
                {SHOW.map((c) => {
                  const v = s.vitals?.find((x) => x.code === c);
                  return (
                    <span key={c} className="rounded-lg bg-surface-2 px-2 py-1.5 text-center">
                      <span className="block text-[10.5px] font-semibold text-ink-3">{SHORT[c]}</span>
                      <b className="num block text-[15px]">{v ? v.value : '—'}</b>
                      {v?.source === 'device' ? <span className="block text-[9.5px] text-accent-2">{v.deviceId}</span> : null}
                    </span>
                  );
                })}
              </div>
              <div className="flex flex-wrap gap-1.5 text-[12px] text-ink-3">
                {s.ventilated ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-info-soft px-2 py-0.5 text-info">
                    <Wind size={12} />
                    {t('Ventilated', 'Neefsiiye')}
                  </span>
                ) : null}
                {s.devices.length ? (
                  <span className="inline-flex items-center gap-1">
                    <Activity size={12} />
                    {s.devices.length} {t('devices', 'qalab')}
                  </span>
                ) : (
                  <span>{t('No devices attached', 'Qalab kuma xirna')}</span>
                )}
              </div>
            </button>
          ))}
        </div>
      ) : (
        <Card>
          <Empty>{load.busy ? '…' : t('No patients in critical care.', 'Bukaan daryeel degdeg ah kuma jiro.')}</Empty>
        </Card>
      )}
      {open ? <StayPanel id={open} onClose={() => setOpen(null)} onChanged={refresh} /> : null}
      {adding ? (
        <AdmitPanel
          onClose={() => setAdding(false)}
          onDone={async () => {
            setAdding(false);
            await refresh();
          }}
        />
      ) : null}
    </>
  );
}

function StayPanel({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => Promise<void> }) {
  const { me } = useMe();
  const { t, lang } = useLang();
  const [s, setS] = useState<StayDetail | null>(null);
  const [reading, setReading] = useState({ code: 'heart-rate', value: '', deviceId: '' });
  const [device, setDevice] = useState({ deviceId: '', kind: 'monitor', label: '' });
  const [review, setReview] = useState({ note: '', acuity: 2, ventilated: false });
  const [close, setClose] = useState({ outcome: 'stepped-down', note: '' });
  const act = useAction();
  const load = useCallback(async () => {
    const d = await api<StayDetail>(`/icu/stays/${id}`);
    setS(d);
    setReview((r) => ({ ...r, acuity: d.acuity, ventilated: d.ventilated }));
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);
  const go = async (fn: () => Promise<unknown>) => {
    if ((await act.run(fn)) !== undefined) {
      await load();
      await onChanged();
    }
  };
  if (!s) return null;
  const open = s.status === 'Open' || s.status === 'Monitored';
  const name = (c: string) => {
    const v = VITALS.find((x) => x.code === c);
    return v ? (lang === 'so' ? v.so : v.name) : c;
  };

  return (
    <Drawer title={s.patient ? fullName(s.patient.names) : t('ICU stay', 'ICU')} sub={`${s.unit}${s.bed ? ` · ${s.bed}` : ''} · ${s.status}`} onClose={onClose} wide>
      <div className="grid gap-5 text-[13px]">
        <Facts
          rows={[
            [t('Reason', 'Sababta'), s.reason],
            [t('Since', 'Laga bilaabo'), fmtDateTime(s.openedAt, lang)],
            [t('Acuity', 'Heerka'), lang === 'so' ? ACUITY[s.acuity]?.[1] : ACUITY[s.acuity]?.[0]],
            [t('Ventilated', 'Neefsiiye'), s.ventilated ? t('Yes', 'Haa') : t('No', 'Maya')],
          ]}
        />
        <Link href={`/encounters/${s.encounterId}`} className="btn justify-self-start">
          <FileText size={16} />
          {t('Open notes, orders and medicines', 'Fur qoraallada, dalabyada iyo daawooyinka')}
        </Link>

        <div>
          <h3 className="mb-2 text-[14px] font-bold">{t('Last 48 hours', '48-kii saac ee u dambeysay')}</h3>
          <div className="grid gap-2 sm:grid-cols-2">
            {SHOW.map((c) => {
              const pts = s.trend.filter((x) => x.code === c);
              const last = pts.at(-1);
              return (
                <div key={c} className="rounded-lg border border-line p-2.5">
                  <div className="flex items-baseline justify-between">
                    <span className="text-ink-2">{name(c)}</span>
                    <b className="num text-[16px]">
                      {last ? last.value : '—'} <span className="text-[11px] font-normal text-ink-3">{last?.unit}</span>
                    </b>
                  </div>
                  <Spark points={pts.map((x) => x.value)} />
                  {last ? (
                    <span className="text-[11px] text-ink-3">
                      {last.source === 'device' ? `${t('from', 'laga helay')} ${last.deviceId}` : t('entered by hand', 'gacan lagu qoray')} · {fmtDateTime(last.at, lang)}
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>

        {open && canDo(me, 'icu', 'E') ? (
          <div className="grid gap-2 rounded-xl border border-line p-3">
            <b>{t('Record a reading', 'Qor akhris')}</b>
            <div className="grid grid-cols-3 gap-2">
              <select className="input" value={reading.code} onChange={(e) => setReading({ ...reading, code: e.target.value })} aria-label={t('Vital sign', 'Calaamad')}>
                {VITALS.filter((v) => v.code !== 'height').map((v) => (
                  <option key={v.code} value={v.code}>
                    {lang === 'so' ? v.so : v.name}
                  </option>
                ))}
              </select>
              <input className="input" inputMode="decimal" placeholder={t('Value', 'Qiimaha')} value={reading.value} onChange={(e) => setReading({ ...reading, value: e.target.value })} />
              <select className="input" value={reading.deviceId} onChange={(e) => setReading({ ...reading, deviceId: e.target.value })} aria-label={t('Source', 'Isha')}>
                <option value="">{t('By hand', 'Gacan')}</option>
                {s.devices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.deviceId}
                  </option>
                ))}
              </select>
            </div>
            <button
              className="btn justify-self-start"
              disabled={!reading.value || act.busy}
              onClick={() =>
                go(async () => {
                  const r = await api(`/encounters/${s.encounterId}/observations`, { body: { code: reading.code, value: Number(reading.value), ...(reading.deviceId ? { source: 'device', deviceId: reading.deviceId } : { source: 'manual' }) } });
                  setReading({ ...reading, value: '' });
                  return r;
                })
              }
            >
              {t('Save reading', 'Kaydi')}
            </button>
          </div>
        ) : null}

        <div>
          <h3 className="mb-2 text-[14px] font-bold">{t('Devices', 'Qalabka')}</h3>
          <ul className="grid gap-1.5">
            {s.devices.map((d) => (
              <li key={d.deviceId} className="flex items-center gap-2 rounded-lg border border-line px-3 py-2">
                <b className="font-mono">{d.deviceId}</b>
                <span className="flex-1 text-ink-2">
                  {d.label} · {d.kind}
                </span>
                {open && canDo(me, 'icu', 'E') ? (
                  <button className="btn h-7 px-2 text-xs" onClick={() => go(() => api(`/icu/stays/${s.id}/devices/${encodeURIComponent(d.deviceId)}/detach`, { body: {} }))}>
                    {t('Detach', 'Ka saar')}
                  </button>
                ) : null}
              </li>
            ))}
            {!s.devices.length ? <li className="text-ink-3">{t('None attached.', 'Midna kuma xirna.')}</li> : null}
          </ul>
          {open && canDo(me, 'icu', 'E') ? (
            <div className="mt-2 grid grid-cols-[1fr_1fr_1.4fr_auto] gap-2">
              <input className="input" placeholder="MON-07" value={device.deviceId} onChange={(e) => setDevice({ ...device, deviceId: e.target.value })} aria-label={t('Device ID', 'Aqoonsiga qalabka')} />
              <select className="input" value={device.kind} onChange={(e) => setDevice({ ...device, kind: e.target.value })} aria-label={t('Kind', 'Nooca')}>
                <option value="monitor">{t('Monitor', 'Kormeere')}</option>
                <option value="ventilator">{t('Ventilator', 'Neefsiiye')}</option>
                <option value="infusion-pump">{t('Infusion pump', 'Bamka')}</option>
                <option value="dialysis">{t('Dialysis', 'Kelyaha')}</option>
                <option value="other">{t('Other', 'Kale')}</option>
              </select>
              <input className="input" placeholder={t('Label, e.g. bay 2 monitor', 'Calaamad')} value={device.label} onChange={(e) => setDevice({ ...device, label: e.target.value })} />
              <button className="btn" disabled={device.deviceId.length < 2 || device.label.length < 2 || act.busy} onClick={() => go(() => api(`/icu/stays/${s.id}/devices`, { body: device }))}>
                {t('Attach', 'Ku xir')}
              </button>
            </div>
          ) : null}
        </div>

        {open && canDo(me, 'icu', 'S') ? (
          <div className="grid gap-2 rounded-xl border border-line p-3">
            <b>{t('Daily review', 'Dib-u-eegista maalinlaha')}</b>
            <textarea className="input h-20 py-2" placeholder={t('Plan for today', 'Qorshaha maanta')} value={review.note} onChange={(e) => setReview({ ...review, note: e.target.value })} />
            <div className="flex flex-wrap items-center gap-3">
              <select className="input h-9 w-auto" value={review.acuity} onChange={(e) => setReview({ ...review, acuity: Number(e.target.value) })} aria-label={t('Acuity', 'Heerka')}>
                {[1, 2, 3].map((n) => (
                  <option key={n} value={n}>
                    {lang === 'so' ? ACUITY[n]![1] : ACUITY[n]![0]}
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={review.ventilated} onChange={(e) => setReview({ ...review, ventilated: e.target.checked })} />
                {t('On ventilator', 'Neefsiiye ku jira')}
              </label>
              <button className="btn btn-primary ml-auto" disabled={review.note.trim().length < 3 || act.busy} onClick={() => go(() => api(`/icu/stays/${s.id}/review`, { body: review }))}>
                {t('Save review', 'Kaydi')}
              </button>
            </div>
          </div>
        ) : null}

        {s.reviews.length ? (
          <div>
            <h3 className="mb-2 text-[14px] font-bold">{t('Reviews', 'Dib-u-eegisyada')}</h3>
            <ul className="grid gap-2">
              {[...s.reviews].reverse().map((v, i) => (
                <li key={i} className="rounded-lg bg-surface-2 px-3 py-2">
                  <p>{v.note}</p>
                  <span className="text-[12px] text-ink-3">
                    {v.byName} · {fmtDateTime(v.at, lang)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {open && canDo(me, 'icu', 'S') ? (
          <div className="grid gap-2 rounded-xl border border-line p-3">
            <b>{t('Leave intensive care', 'Ka bax ICU')}</b>
            <div className="grid grid-cols-[auto_1fr] gap-2">
              <select className="input w-auto" value={close.outcome} onChange={(e) => setClose({ ...close, outcome: e.target.value })} aria-label={t('Outcome', 'Natiijada')}>
                <option value="stepped-down">{t('To a ward', 'Qol caadi ah')}</option>
                <option value="transferred">{t('To another hospital', 'Isbitaal kale')}</option>
                <option value="discharged">{t('Home', 'Guriga')}</option>
                <option value="died">{t('Died', 'Geeriyooday')}</option>
              </select>
              <input className="input" placeholder={t('Note', 'Qoraal')} value={close.note} onChange={(e) => setClose({ ...close, note: e.target.value })} />
            </div>
            <button
              className="btn justify-self-start"
              disabled={close.note.trim().length < 3 || act.busy}
              onClick={async () => {
                if ((await act.run(() => api(`/icu/stays/${s.id}/close`, { body: close }))) !== undefined) {
                  await onChanged();
                  onClose();
                }
              }}
            >
              {t('Close ICU stay', 'Xir')}
            </button>
          </div>
        ) : null}
        <ErrorNote error={act.error} />
      </div>
    </Drawer>
  );
}

function AdmitPanel({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
  const { t } = useLang();
  const [cands, setCands] = useState<{ admissionId: string; patient: PatientBrief | null }[]>([]);
  const [f, setF] = useState({ admissionId: '', unit: 'ICU', acuity: 2, reason: '' });
  const act = useAction();
  useEffect(() => {
    api<{ admissionId: string; patient: PatientBrief | null }[]>('/icu/candidates')
      .then((c) => {
        setCands(c);
        setF((x) => ({ ...x, admissionId: c[0]?.admissionId ?? '' }));
      })
      .catch(() => {});
  }, []);
  return (
    <Drawer title={t('Admit to intensive care', 'Gali daryeelka degdegga ah')} onClose={onClose}>
      {cands.length ? (
        <form
          className="grid gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await act.run(() => api('/icu/stays', { body: f }))) await onDone();
          }}
        >
          <Field label={t('Admitted patient', 'Bukaanka jiifa')}>
            <select className="input" value={f.admissionId} onChange={(e) => setF({ ...f, admissionId: e.target.value })}>
              {cands.map((c) => (
                <option key={c.admissionId} value={c.admissionId}>
                  {c.patient ? `${fullName(c.patient.names)} · ${c.patient.mrn}` : c.admissionId}
                </option>
              ))}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('Unit', 'Qaybta')}>
              <select className="input" value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })}>
                {['ICU', 'NICU', 'PICU', 'HDU'].map((u) => (
                  <option key={u}>{u}</option>
                ))}
              </select>
            </Field>
            <Field label={t('Acuity', 'Heerka')}>
              <select className="input" value={f.acuity} onChange={(e) => setF({ ...f, acuity: Number(e.target.value) })}>
                <option value={1}>{t('Critical', 'Halis')}</option>
                <option value={2}>{t('Serious', 'Culus')}</option>
                <option value={3}>{t('Stable', 'Deggan')}</option>
              </select>
            </Field>
          </div>
          <Field label={t('Reason', 'Sababta')}>
            <input className="input" required minLength={3} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
          </Field>
          <ErrorNote error={act.error} />
          <button className="btn btn-primary justify-self-start" disabled={act.busy}>
            {t('Admit to ICU', 'Gali ICU')}
          </button>
        </form>
      ) : (
        <p className="text-[13.5px] text-ink-3">{t('Only patients already admitted to a bed can move to intensive care.', 'Bukaanka sariir loo dhigay oo keliya ayaa loo wareejin karaa.')}</p>
      )}
    </Drawer>
  );
}
