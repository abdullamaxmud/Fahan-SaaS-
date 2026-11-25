'use client';

import Link from 'next/link';
import { use, useCallback, useEffect, useState } from 'react';
import { BadgeCheck, CalendarClock, ClipboardList, FileSignature, GitMerge, HeartPulse, Stethoscope } from 'lucide-react';
import { ApiError, api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { canDo, useMe } from '@/lib/session';
import { PatientBand, fullName, type PatientBrief } from '@/components/clinical';
import { Card, ErrorNote, Field, Pill, statusTone, useAction } from '@/components/ui';

interface Patient extends PatientBrief {
  phone: string | null;
  identifiers: { system: string; value: string }[];
  mergedInto: string | null;
  version: number;
}
interface Consent {
  id: string;
  type: string;
  status: string;
  method: string;
  recordedAt: string;
}
interface Item {
  kind: string;
  at: string;
  id: string;
  encounterId: string | null;
  title: string;
  status: string;
  detail: string | null;
}

const ICON: Record<string, React.ComponentType<{ size?: number }>> = {
  encounter: Stethoscope,
  note: FileSignature,
  diagnosis: ClipboardList,
  observation: HeartPulse,
  appointment: CalendarClock,
};

export default function PatientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { me } = useMe();
  const { t } = useLang();
  const [p, setP] = useState<Patient | null>(null);
  const [consents, setConsents] = useState<Consent[]>([]);
  const [items, setItems] = useState<Item[] | null>(null);
  const [timelineDenied, setTimelineDenied] = useState(false);
  const [consent, setConsent] = useState({ type: 'treatment', status: 'granted', method: 'verbal' });
  const [merge, setMerge] = useState({ duplicateMrn: '', reason: '' });
  const load = useAction();
  const act = useAction();

  const refresh = useCallback(async () => {
    await load.run(async () => {
      setP(await api<Patient>(`/patients/${id}`));
      setConsents(await api<Consent[]>(`/patients/${id}/consents`));
      try {
        setItems((await api<{ items: Item[] }>(`/patients/${id}/timeline`)).items);
      } catch (e) {
        if (e instanceof ApiError && e.status === 403) setTimelineDenied(true);
        else throw e;
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!p) return <ErrorNote error={load.error} />;
  const canEdit = canDo(me, 'mpi', 'E');

  async function requestMerge() {
    const r = await act.run(async () => {
      const found = await api<Patient[]>(`/patients?q=${encodeURIComponent(merge.duplicateMrn.trim())}`);
      const dup = found.find((x) => x.mrn === merge.duplicateMrn.trim().toUpperCase());
      if (!dup) throw new ApiError(404, { code: 'NOT_FOUND', message: 'No record with that MRN is visible to you' });
      return api('/patients/merge-requests', { body: { survivorId: id, duplicateId: dup.id, reason: merge.reason } });
    });
    if (r) setMerge({ duplicateMrn: '', reason: '' });
  }

  return (
    <>
      <PatientBand p={p}>
        {p.status === 'Merged' ? (
          <Pill tone="crit">
            {t('Merged into another record', 'Waa lagu daray diiwaan kale')}{' '}
            {p.mergedInto ? (
              <Link className="underline" href={`/patients/${p.mergedInto}`}>
                {t('open', 'fur')}
              </Link>
            ) : null}
          </Pill>
        ) : null}
        {p.identifiers.map((i) => (
          <span key={i.system + i.value} className="rounded-md border border-line bg-surface-2 px-2 font-mono text-[11.5px]">
            {i.system}: {i.value}
          </span>
        ))}
        {p.status === 'Provisional' && canEdit ? (
          <button className="btn h-7 px-2.5 text-xs" onClick={async () => (await act.run(() => api(`/patients/${id}/verify`, { body: {} }))) && refresh()}>
            <BadgeCheck size={14} />
            {t('Mark identity verified', 'Xaqiiji aqoonsiga')}
          </button>
        ) : null}
      </PatientBand>
      <ErrorNote error={act.error} />

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card title={t('Clinical timeline', 'Taariikhda caafimaadka')}>
          {timelineDenied ? (
            <p className="px-4 pb-4 text-[13px] text-ink-2">
              {t('Your role sees registration details only. Clinical history is limited to the care team.', 'Doorkaagu wuxuu arkaa xogta diiwaangelinta kaliya.')}
            </p>
          ) : (
            <ol className="grid">
              {(items ?? []).map((i) => {
                const I = ICON[i.kind] ?? ClipboardList;
                return (
                  <li key={i.kind + i.id} className="flex gap-3 border-t border-line px-4 py-2.5 first:border-t-0">
                    <span className="grid h-8 w-8 flex-none place-items-center rounded-lg bg-surface-2 text-ink-2">
                      <I size={16} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <b className="text-[13.5px]">{i.encounterId && i.kind !== 'appointment' ? <Link className="hover:underline" href={`/encounters/${i.encounterId}`}>{i.title}</Link> : i.title}</b>
                        <Pill tone={statusTone(i.status)}>{i.status}</Pill>
                      </div>
                      {i.detail ? <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap text-[13px] text-ink-2">{i.detail}</p> : null}
                    </div>
                    <span className="num whitespace-nowrap text-xs text-ink-3">{new Date(i.at).toLocaleString()}</span>
                  </li>
                );
              })}
              {items && !items.length ? <li className="px-4 pb-4 text-[13px] text-ink-3">{t('No visits yet.', 'Weli booqasho ma jirto.')}</li> : null}
            </ol>
          )}
        </Card>

        <div className="grid gap-4">
          <Card title={t('Contact', 'Xiriirka')}>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 px-4 pb-4 text-[13px]">
              <dt className="text-ink-3">{t('Phone', 'Telefoon')}</dt>
              <dd className="font-mono">{p.phone ? `+${p.phone}` : '—'}</dd>
              <dt className="text-ink-3">{t('Name', 'Magaca')}</dt>
              <dd>{fullName(p.names)}</dd>
            </dl>
          </Card>

          <Card title={t('Consent', 'Oggolaanshaha')}>
            <ul className="grid px-4 pb-2 text-[13px]">
              {consents.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-2 border-t border-line py-1.5 first:border-t-0">
                  <span>
                    {c.type} <span className="text-ink-3">· {c.method}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <Pill tone={c.status === 'granted' ? 'ok' : 'crit'}>{c.status}</Pill>
                    <span className="num text-xs text-ink-3">{new Date(c.recordedAt).toLocaleDateString()}</span>
                  </span>
                </li>
              ))}
              {!consents.length ? <li className="py-1 text-ink-3">{t('Nothing recorded.', 'Waxba lama diiwaangelin.')}</li> : null}
            </ul>
            {canEdit || canDo(me, 'opd', 'E') ? (
              <form
                className="flex flex-wrap gap-2 px-4 pb-4"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (await act.run(() => api(`/patients/${id}/consents`, { body: consent }))) await refresh();
                }}
              >
                <select className="input h-9 w-auto" value={consent.type} onChange={(e) => setConsent({ ...consent, type: e.target.value })} aria-label="Consent type">
                  {['treatment', 'data-sharing', 'telehealth', 'research', 'sms-reminders'].map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
                <select className="input h-9 w-auto" value={consent.status} onChange={(e) => setConsent({ ...consent, status: e.target.value })} aria-label="Consent status">
                  <option value="granted">granted</option>
                  <option value="withdrawn">withdrawn</option>
                </select>
                <select className="input h-9 w-auto" value={consent.method} onChange={(e) => setConsent({ ...consent, method: e.target.value })} aria-label="How consent was given">
                  {['verbal', 'written', 'electronic'].map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
                <button className="btn h-9">{t('Record', 'Diiwaangeli')}</button>
              </form>
            ) : null}
          </Card>

          {canEdit && p.status !== 'Merged' ? (
            <Card title={t('Duplicate record?', 'Diiwaan labalaaban?')}>
              <form
                className="grid gap-3 px-4 pb-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  void requestMerge();
                }}
              >
                <p className="text-[12.5px] text-ink-2">
                  {t('Ask the medical records officer to merge another record into this one. The other MRN stays as an alias and the merge can be reversed.', 'Codso in diiwaan kale lagu daro kan.')}
                </p>
                <Field label={t('Duplicate MRN', 'MRN-ka labalaaban')}>
                  <input className="input font-mono uppercase" required value={merge.duplicateMrn} onChange={(e) => setMerge({ ...merge, duplicateMrn: e.target.value })} />
                </Field>
                <Field label={t('Reason', 'Sababta')}>
                  <input className="input" required minLength={5} value={merge.reason} onChange={(e) => setMerge({ ...merge, reason: e.target.value })} />
                </Field>
                <button className="btn justify-self-start" disabled={act.busy}>
                  <GitMerge size={16} />
                  {t('Request merge', 'Codso isku-darka')}
                </button>
              </form>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
