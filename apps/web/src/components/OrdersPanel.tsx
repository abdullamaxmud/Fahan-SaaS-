'use client';

import { useCallback, useEffect, useState } from 'react';
import { FlaskConical, Pill as PillIcon, ScanLine } from 'lucide-react';
import { ApiError, api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { canDo, useMe } from '@/lib/session';
import { useReauth } from './Reauth';
import { Card, ErrorNote, Pill, useAction } from './ui';

interface LabOrder {
  id: string;
  testName: string;
  priority: string;
  status: string;
  results: { analyteCode: string; name: string; value: number | string; unit: string | null; flag: string }[];
  critical: { analytes: string[]; acknowledgedAt: string | null } | null;
}
interface ImgOrder {
  id: string;
  modality: string;
  examination: string;
  status: string;
  report: { impression: string; findings: string; preliminary: boolean } | null;
  critical: { finding: string; acknowledgedAt: string | null } | null;
  studyInstanceUid: string | null;
}
interface Rx {
  id: string;
  status: string;
  drug: { name: string };
  dose: string;
  frequency: string;
  durationDays: number;
  override: { reason: string } | null;
}
interface TestDef {
  id: string;
  code: string;
  name: string;
}
interface Med {
  id: string;
  code: string;
  name: string;
}

const FLAG: Record<string, 'ok' | 'warn' | 'crit'> = { N: 'ok', L: 'warn', H: 'warn', LL: 'crit', HH: 'crit', A: 'warn' };

/**
 * Orders and results inside a visit (spec §4.2, §6): lab, imaging and prescriptions, plus the
 * nurse's medication chart. The API decides who may do what; the panel only hides what a role cannot use.
 */
export function OrdersPanel({ encounterId, closed, canOrder, canChart }: { encounterId: string; closed: boolean; canOrder: boolean; canChart: boolean }) {
  const { me } = useMe();
  const { t } = useLang();
  const [labs, setLabs] = useState<LabOrder[]>([]);
  const [imgs, setImgs] = useState<ImgOrder[]>([]);
  const [rxs, setRxs] = useState<Rx[]>([]);
  const [tests, setTests] = useState<TestDef[]>([]);
  const [meds, setMeds] = useState<Med[]>([]);
  const [labPick, setLabPick] = useState<string[]>([]);
  const [img, setImg] = useState({ modality: 'XR', examination: '', clinicalQuestion: '', pregnancyStatus: 'not-applicable' });
  const [rx, setRx] = useState({ itemId: '', dose: '', frequency: 'tid', durationDays: '5', quantity: '' });
  const [override, setOverride] = useState<{ id: string; issues: string[]; reason: string } | null>(null);
  const [viewer, setViewer] = useState<{ url: string; expiresAt: string } | null>(null);
  const load = useAction();
  const act = useAction();
  const { guarded, dialog } = useReauth();

  const refresh = useCallback(async () => {
    await load.run(async () => {
      const q = `?encounterId=${encounterId}`;
      const [l, i, r] = await Promise.all([api<LabOrder[]>(`/lab/orders${q}`), api<ImgOrder[]>(`/radiology/orders${q}`), api<Rx[]>(`/pharmacy/prescriptions${q}`)]);
      setLabs(l);
      setImgs(i);
      setRxs(r);
      if (canOrder) {
        setTests(await api<TestDef[]>('/lab/tests'));
        setMeds(await api<Med[]>('/pharmacy/formulary').catch(() => []));
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [encounterId, canOrder]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const run = async (fn: () => Promise<unknown>) => {
    if ((await act.run(fn)) !== undefined) await refresh();
  };

  async function sign(id: string, overrideReason?: string) {
    try {
      await guarded(() => api(`/pharmacy/prescriptions/${id}/sign`, { body: overrideReason ? { overrideReason } : {} }));
      setOverride(null);
      await refresh();
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'ALLERGY_CONFLICT' || e.code === 'DUPLICATE_THERAPY')) {
        setOverride({ id, issues: (e.body.details ?? []).map((d) => d.message), reason: '' });
      } else act.setError(e);
    }
  }

  return (
    <Card title={t('Orders & results', 'Dalabyada & natiijooyinka')}>
      {dialog}
      <div className="grid gap-4 px-4 pb-4 text-[13px]">
        <ErrorNote error={load.error ?? act.error} />
        <section className="grid gap-1.5">
          <b className="flex items-center gap-2">
            <FlaskConical size={15} />
            {t('Laboratory', 'Shaybaarka')}
          </b>
          {labs.map((o) => (
            <div key={o.id} className="rounded-lg border border-line p-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{o.testName}</span>
                <Pill tone={o.status === 'Released' ? 'ok' : 'info'}>{o.status}</Pill>
                {o.critical && !o.critical.acknowledgedAt && o.status === 'Released' ? (
                  <button className="btn h-7 border-crit/40 px-2 text-xs text-crit" onClick={() => run(() => api(`/lab/orders/${o.id}/acknowledge`, { body: {} }))}>
                    {t('Acknowledge critical value', 'Aqbal qiimaha khatarta')}
                  </button>
                ) : null}
              </div>
              {o.results.length ? (
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {o.results.map((x) => (
                    <Pill key={x.analyteCode} tone={FLAG[x.flag] ?? 'plain'}>
                      {x.name} {x.value} {x.unit ?? ''} {x.flag !== 'N' ? `(${x.flag})` : ''}
                    </Pill>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
          {canOrder && !closed ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {tests.map((tt) => {
                const on = labPick.includes(tt.id);
                return (
                  <button key={tt.id} className={`h-7 rounded-md border px-2 text-xs ${on ? 'border-accent bg-accent text-on-accent' : 'border-line-2'}`} onClick={() => setLabPick(on ? labPick.filter((x) => x !== tt.id) : [...labPick, tt.id])}>
                    {tt.code}
                  </button>
                );
              })}
              <button
                className="btn h-7 px-2.5 text-xs"
                disabled={!labPick.length}
                onClick={() =>
                  run(async () => {
                    const r = await api('/lab/orders', { body: { encounterId, testIds: labPick, priority: 'routine' } });
                    setLabPick([]);
                    return r;
                  })
                }
              >
                {t('Order tests', 'Dalbo baaritaan')}
              </button>
            </div>
          ) : null}
        </section>

        <section className="grid gap-1.5">
          <b className="flex items-center gap-2">
            <ScanLine size={15} />
            {t('Imaging', 'Sawirka')}
          </b>
          {imgs.map((o) => (
            <div key={o.id} className="rounded-lg border border-line p-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded bg-surface-2 px-1.5 font-mono text-xs">{o.modality}</span>
                <span className="font-semibold">{o.examination}</span>
                <Pill tone={o.status === 'Final' ? 'ok' : 'info'}>{o.status}</Pill>
                {o.studyInstanceUid ? (
                  <button className="btn h-7 px-2 text-xs" onClick={() => act.run(async () => setViewer(await api<{ url: string; expiresAt: string }>(`/radiology/orders/${o.id}/viewer-link`)))}>
                    {t('Viewer link', 'Muuqaalka')}
                  </button>
                ) : null}
                {o.critical && !o.critical.acknowledgedAt ? (
                  <button className="btn h-7 border-crit/40 px-2 text-xs text-crit" onClick={() => run(() => api(`/radiology/orders/${o.id}/acknowledge`, { body: {} }))}>
                    {t('Acknowledge critical finding', 'Aqbal')}
                  </button>
                ) : null}
              </div>
              {o.report ? (
                <p className="mt-1">
                  <b>{o.report.impression}</b> — {o.report.findings}
                </p>
              ) : null}
            </div>
          ))}
          {viewer ? (
            <p className="break-all rounded-lg bg-surface-2 p-2 font-mono text-[11.5px]">
              {t('Signed viewer link, valid until', 'Xiriirka, wuxuu dhacayaa')} {new Date(viewer.expiresAt).toLocaleTimeString()}: {viewer.url}
            </p>
          ) : null}
          {canOrder && !closed ? (
            <form
              className="grid gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                void run(() => api('/radiology/orders', { body: { encounterId, ...img, ...(img.pregnancyStatus === 'not-applicable' ? { pregnancyStatus: undefined } : {}) } }));
              }}
            >
              <div className="flex flex-wrap gap-1.5">
                <select className="input h-8 w-auto text-xs" value={img.modality} onChange={(e) => setImg({ ...img, modality: e.target.value })} aria-label="Modality">
                  {['XR', 'CT', 'MR', 'US', 'MG', 'FL'].map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </select>
                <input className="input h-8 min-w-0 flex-1 text-xs" required placeholder={t('Examination', 'Baaritaanka')} value={img.examination} onChange={(e) => setImg({ ...img, examination: e.target.value })} />
                <select className="input h-8 w-auto text-xs" value={img.pregnancyStatus} onChange={(e) => setImg({ ...img, pregnancyStatus: e.target.value })} aria-label="Pregnancy status">
                  <option value="not-applicable">{t('Pregnancy: n/a', 'Uur: ma khuseeyo')}</option>
                  <option value="not-pregnant">not-pregnant</option>
                  <option value="pregnant">pregnant</option>
                  <option value="unknown">unknown</option>
                </select>
              </div>
              <input className="input h-8 text-xs" required minLength={5} placeholder={t('Clinical question', 'Su’aasha caafimaad')} value={img.clinicalQuestion} onChange={(e) => setImg({ ...img, clinicalQuestion: e.target.value })} />
              <button className="btn h-7 justify-self-start px-2.5 text-xs">{t('Order imaging', 'Dalbo sawir')}</button>
            </form>
          ) : null}
        </section>

        <section className="grid gap-1.5">
          <b className="flex items-center gap-2">
            <PillIcon size={15} />
            {t('Medicines', 'Daawooyinka')}
          </b>
          {rxs.map((x) => (
            <div key={x.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-line p-2">
              <span className="font-semibold">{x.drug.name}</span>
              <span className="text-ink-2">
                {x.dose} · {x.frequency} · {x.durationDays} d
              </span>
              <Pill tone={x.status === 'Dispensed' ? 'ok' : x.status === 'Cancelled' ? 'crit' : 'info'}>{x.status}</Pill>
              {x.override ? <Pill tone="crit">{t('override', 'ka gudub')}</Pill> : null}
              {x.status === 'Draft' && canDo(me, 'rx', 'S') ? (
                <button className="btn btn-primary h-7 px-2 text-xs" onClick={() => sign(x.id)}>
                  {t('Sign', 'Saxiix')}
                </button>
              ) : null}
              {x.status === 'Dispensed' && canChart ? (
                <span className="flex gap-1">
                  <button className="btn h-7 px-2 text-xs" onClick={() => run(() => api(`/pharmacy/prescriptions/${x.id}/administrations`, { body: { status: 'given', doseGiven: x.dose } }))}>
                    {t('Dose given', 'La siiyay')}
                  </button>
                  <button
                    className="btn h-7 px-2 text-xs"
                    onClick={() => {
                      const reason = window.prompt?.(t('Why was the dose held?', 'Maxaa loo joojiyay?'));
                      if (reason) void run(() => api(`/pharmacy/prescriptions/${x.id}/administrations`, { body: { status: 'held', reason } }));
                    }}
                  >
                    {t('Held', 'La joojiyay')}
                  </button>
                </span>
              ) : null}
              {override?.id === x.id ? (
                <div className="grid w-full gap-1.5 rounded-lg bg-crit-soft p-2 text-crit">
                  <b>{override.issues.join(' · ')}</b>
                  <input className="input h-8 text-xs text-ink" placeholder={t('Reason to proceed (at least 10 characters)', 'Sababta')} value={override.reason} onChange={(e) => setOverride({ ...override, reason: e.target.value })} />
                  <span className="flex gap-1.5">
                    <button className="btn h-7 px-2 text-xs" disabled={override.reason.length < 10} onClick={() => sign(x.id, override.reason)}>
                      {t('Sign with override', 'Saxiix')}
                    </button>
                    <button className="btn h-7 px-2 text-xs" onClick={() => run(() => api(`/pharmacy/prescriptions/${x.id}/cancel`, { body: { reason: 'Stopped after safety check' } }))}>
                      {t('Cancel prescription', 'Jooji')}
                    </button>
                  </span>
                </div>
              ) : null}
            </div>
          ))}
          {canOrder && canDo(me, 'rx', 'S') && !closed ? (
            <form
              className="grid gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                void run(() => api('/pharmacy/prescriptions', { body: { encounterId, itemId: rx.itemId, dose: rx.dose, frequency: rx.frequency, durationDays: Number(rx.durationDays), quantity: Number(rx.quantity) } }));
              }}
            >
              <select className="input h-8 text-xs" required value={rx.itemId} onChange={(e) => setRx({ ...rx, itemId: e.target.value })} aria-label="Medicine">
                <option value="">{t('Choose medicine…', 'Dooro daawo…')}</option>
                {meds.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
              <div className="grid grid-cols-4 gap-1.5">
                <input className="input h-8 text-xs" required placeholder={t('Dose', 'Qiyaas')} value={rx.dose} onChange={(e) => setRx({ ...rx, dose: e.target.value })} />
                <select className="input h-8 text-xs" value={rx.frequency} onChange={(e) => setRx({ ...rx, frequency: e.target.value })} aria-label="Frequency">
                  {['once', 'stat', 'daily', 'bid', 'tid', 'qid', 'q6h', 'q8h', 'prn'].map((f) => (
                    <option key={f}>{f}</option>
                  ))}
                </select>
                <input className="input h-8 text-xs" inputMode="numeric" placeholder={t('Days', 'Maalmo')} value={rx.durationDays} onChange={(e) => setRx({ ...rx, durationDays: e.target.value })} />
                <input className="input h-8 text-xs" inputMode="numeric" required placeholder={t('Quantity', 'Tiro')} value={rx.quantity} onChange={(e) => setRx({ ...rx, quantity: e.target.value })} />
              </div>
              <button className="btn h-7 justify-self-start px-2.5 text-xs">{t('Add prescription (draft)', 'Ku dar')}</button>
            </form>
          ) : null}
        </section>
      </div>
    </Card>
  );
}
