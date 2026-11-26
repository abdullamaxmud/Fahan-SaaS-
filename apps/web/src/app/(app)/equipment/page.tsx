'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { canDo, useMe } from '@/lib/session';
import { Drawer, Facts, fmtDate, fmtDateTime } from '@/components/Dialog';
import { TheatreStatus } from '@/components/TheatreStatus';
import { Card, Empty, ErrorNote, Field, PageHeader, Pill, Tabs, fieldErrors, useAction } from '@/components/ui';

interface Asset {
  id: string;
  code: string;
  name: string;
  kind: string;
  modality: string | null;
  status: string;
  statusReason: string | null;
  nextCalibrationDue: string | null;
  usable: boolean;
  blockedReason: string | null;
}
interface Job {
  id: string;
  kind: string;
  scheduledFor: string;
  notes?: string;
  status: string;
  result?: string;
  resultNotes?: string;
}
interface Batch {
  id: string;
  number: string;
  autoclave: string;
  program: string;
  items: { set: string; qty: number }[];
  status: string;
  chemical: string | null;
  biological: string | null;
  loadedAt: string;
  loadedByName: string;
  releasedByName: string | null;
  recallReason: string | null;
}
interface Branch {
  id: string;
  code: string;
  name: string;
}

const KINDS: Record<string, [string, string]> = {
  imaging: ['Imaging', 'Sawir'],
  diagnostic: ['Diagnostic', 'Baaritaan'],
  monitor: ['Monitor', 'Kormeere'],
  ventilator: ['Ventilator', 'Neefsiiye'],
  'infusion-pump': ['Infusion pump', 'Bamka dareeraha'],
  anesthesia: ['Anaesthesia', 'Suuxdinta'],
  autoclave: ['Steriliser', 'Nadiifiye'],
  other: ['Other', 'Kale'],
};
const BATCH: Record<string, [string, string, 'info' | 'acc' | 'ok' | 'crit' | 'warn' | 'plain']> = {
  Loaded: ['Loaded', 'La raray', 'info'],
  Running: ['Running', 'Socda', 'acc'],
  Passed: ['Passed — ready to release', 'Gudbay', 'ok'],
  Failed: ['Failed', 'Fashilmay', 'crit'],
  Released: ['Released', 'La sii daayay', 'ok'],
  Recalled: ['Recalled', 'Dib loo celiyay', 'warn'],
};
const today = () => new Date().toISOString().slice(0, 10);

export default function EquipmentPage() {
  const { me } = useMe();
  const { t, lang } = useLang();
  const [tab, setTab] = useState<'devices' | 'cssd'>('devices');
  const [list, setList] = useState<Asset[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [open, setOpen] = useState<Asset | null>(null);
  const [adding, setAdding] = useState(false);
  const [loading, setLoading] = useState(false);
  const load = useAction();
  const act = useAction();
  const L = (m: Record<string, readonly string[]>, k: string) => (m[k] ? (lang === 'so' ? m[k][1] : m[k][0]) : k);

  const refresh = useCallback(async () => {
    await load.run(async () => {
      const [a, b] = await Promise.all([api<Asset[]>('/equipment/assets'), api<Batch[]>('/equipment/cssd/batches')]);
      setList(a);
      setBatches(b);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const run = async (fn: () => Promise<unknown>) => {
    if ((await act.run(fn)) !== undefined) await refresh();
  };
  const down = list.filter((a) => !a.usable).length;
  const autoclaves = list.filter((a) => a.kind === 'autoclave');

  return (
    <>
      <PageHeader
        title={t('Equipment & CSSD', 'Qalabka & CSSD')}
        actions={
          tab === 'devices' && canDo(me, 'eq', 'A') ? (
            <button className="btn btn-primary" onClick={() => setAdding(true)}>
              <Plus size={16} />
              {t('Register device', 'Diiwaangeli qalab')}
            </button>
          ) : tab === 'cssd' && canDo(me, 'eq', 'E') ? (
            <button className="btn btn-primary" onClick={() => setLoading(true)}>
              <Plus size={16} />
              {t('New load', 'Raritaan cusub')}
            </button>
          ) : null
        }
      >
        {t('Devices, maintenance and sterilisation.', 'Qalabka, dayactirka iyo nadiifinta.')}
      </PageHeader>
      <Tabs<'devices' | 'cssd'>
        value={tab}
        onChange={setTab}
        items={[
          { id: 'devices', label: t('Devices', 'Qalabka'), count: down || undefined },
          { id: 'cssd', label: t('Sterilisation', 'Nadiifinta'), count: batches.filter((b) => b.status === 'Loaded' || b.status === 'Running' || b.status === 'Passed').length || undefined },
        ]}
      />
      <ErrorNote error={load.error ?? act.error} />

      {tab === 'devices' ? (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className="th">{t('Code', 'Koodh')}</th>
                  <th className="th">{t('Device', 'Qalabka')}</th>
                  <th className="th">{t('Type', 'Nooca')}</th>
                  <th className="th">{t('Calibration due', 'Hagaajinta')}</th>
                  <th className="th">{t('Status', 'Xaalad')}</th>
                </tr>
              </thead>
              <tbody>
                {list.map((a) => (
                  <tr key={a.id} className="cursor-pointer hover:bg-surface-2/60" onClick={() => setOpen(a)}>
                    <td className="td font-mono text-xs font-semibold">{a.code}</td>
                    <td className="td font-medium">
                      {a.name}
                      {a.blockedReason ? <span className="block text-[12px] font-normal text-crit">{a.blockedReason}</span> : null}
                    </td>
                    <td className="td text-ink-2">
                      {L(KINDS, a.kind)}
                      {a.modality ? <span className="ml-1.5 rounded bg-surface-2 px-1.5 font-mono text-[11px]">{a.modality}</span> : null}
                    </td>
                    <td className="td text-ink-2">{a.nextCalibrationDue ? fmtDate(a.nextCalibrationDue, lang) : '—'}</td>
                    <td className="td">
                      <Pill tone={a.usable ? 'ok' : 'crit'}>{a.usable ? t('In use', 'Shaqaynaya') : a.status === 'OutOfService' ? t('Out of service', 'Ma shaqaynayo') : t('Blocked', 'Xiran')}</Pill>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!list.length && !load.busy ? <Empty>{t('No equipment registered yet.', 'Weli qalab lama diiwaangelin.')}</Empty> : null}
          </div>
        </Card>
      ) : (
        <Card>
          {batches.length ? (
            <ul>
              {batches.map((b) => (
                <li key={b.id} className="grid gap-2 border-t border-line px-4 py-3 first:border-t-0 text-[13px]">
                  <div className="flex flex-wrap items-center gap-2">
                    <b className="font-mono">{b.number}</b>
                    <span className="text-ink-2">
                      {b.autoclave} · {b.program}
                    </span>
                    <span className="ml-auto">
                      <Pill tone={BATCH[b.status]?.[2]}>{L(BATCH, b.status)}</Pill>
                    </span>
                  </div>
                  <span className="text-ink-2">{b.items.map((i) => `${i.set} × ${i.qty}`).join(' · ')}</span>
                  <span className="text-[12px] text-ink-3">
                    {t('Loaded by', 'Waxaa raray')} {b.loadedByName} · {fmtDateTime(b.loadedAt, lang)}
                    {b.chemical ? ` · ${t('chemical', 'kiimiko')} ${b.chemical} · ${t('biological', 'noole')} ${b.biological}` : ''}
                    {b.recallReason ? ` · ${b.recallReason}` : ''}
                  </span>
                  {canDo(me, 'eq', 'E') ? <BatchActions b={b} run={run} /> : null}
                </li>
              ))}
            </ul>
          ) : (
            <Empty>{t('No sterilisation loads yet.', 'Weli nadiifin lama samayn.')}</Empty>
          )}
        </Card>
      )}

      {tab === 'devices' ? <TheatreStatus /> : null}
      {open ? (
        <AssetPanel
          a={open}
          onClose={() => setOpen(null)}
          onChanged={async () => {
            await refresh();
            const fresh = (await api<Asset[]>('/equipment/assets')).find((x) => x.id === open.id);
            setOpen(fresh ?? null);
          }}
        />
      ) : null}
      {adding ? (
        <NewAsset
          onClose={() => setAdding(false)}
          onDone={async () => {
            setAdding(false);
            await refresh();
          }}
        />
      ) : null}
      {loading ? (
        <NewLoad
          autoclaves={autoclaves}
          onClose={() => setLoading(false)}
          onDone={async () => {
            setLoading(false);
            await refresh();
          }}
        />
      ) : null}
    </>
  );
}

function BatchActions({ b, run }: { b: Batch; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const { me } = useMe();
  const { t } = useLang();
  const [reason, setReason] = useState('');
  const post = (path: string, body: object = {}) => run(() => api(`/equipment/cssd/batches/${b.id}/${path}`, { body }));
  if (b.status === 'Loaded')
    return (
      <button className="btn h-8 justify-self-start text-xs" onClick={() => post('start')}>
        {t('Start cycle', 'Bilow wareegga')}
      </button>
    );
  if (b.status === 'Running')
    return (
      <div className="flex flex-wrap gap-1.5">
        <button className="btn btn-primary h-8 text-xs" onClick={() => post('result', { chemical: 'pass', biological: 'pass' })}>
          {t('Both indicators passed', 'Labada calaamadood way gudbeen')}
        </button>
        <button className="btn h-8 border-crit/40 text-xs text-crit" onClick={() => post('result', { chemical: 'pass', biological: 'fail' })}>
          {t('Biological failed', 'Noolaha wuu fashilmay')}
        </button>
        <button className="btn h-8 border-crit/40 text-xs text-crit" onClick={() => post('result', { chemical: 'fail', biological: 'fail' })}>
          {t('Chemical failed', 'Kiimikada way fashilantay')}
        </button>
      </div>
    );
  if (b.status === 'Passed')
    return (
      <button className="btn btn-primary h-8 justify-self-start text-xs" onClick={() => post('release')}>
        {t('Release sets for use', 'U sii daa isticmaalka')}
      </button>
    );
  if (b.status === 'Released' && canDo(me, 'eq', 'A'))
    return (
      <div className="flex flex-wrap gap-1.5">
        <input className="input h-8 min-w-0 flex-1 text-xs" placeholder={t('Recall reason', 'Sababta dib-u-celinta')} value={reason} onChange={(e) => setReason(e.target.value)} />
        <button className="btn h-8 text-xs" disabled={reason.trim().length < 3} onClick={() => post('recall', { reason })}>
          {t('Recall load', 'Dib u celi')}
        </button>
      </div>
    );
  return null;
}

function AssetPanel({ a, onClose, onChanged }: { a: Asset; onClose: () => void; onChanged: () => Promise<void> }) {
  const { me } = useMe();
  const { t, lang } = useLang();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [reason, setReason] = useState('');
  const [job, setJob] = useState({ kind: 'preventive', scheduledFor: today(), notes: '' });
  const [done, setDone] = useState<Record<string, { notes: string; next: string }>>({});
  const act = useAction();
  const loadJobs = useCallback(() => api<Job[]>(`/equipment/assets/${a.id}/jobs`).then(setJobs).catch(() => {}), [a.id]);
  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);
  const go = async (fn: () => Promise<unknown>) => {
    if ((await act.run(fn)) !== undefined) {
      await loadJobs();
      await onChanged();
    }
  };
  const L = (m: Record<string, readonly string[]>, k: string) => (m[k] ? (lang === 'so' ? m[k][1] : m[k][0]) : k);

  return (
    <Drawer title={`${a.code} · ${a.name}`} sub={<Pill tone={a.usable ? 'ok' : 'crit'}>{a.usable ? t('In use', 'Shaqaynaya') : t('Not usable', 'Lama isticmaali karo')}</Pill>} onClose={onClose}>
      <div className="grid gap-5 text-[13px]">
        <Facts
          rows={[
            [t('Type', 'Nooca'), L(KINDS, a.kind)],
            [t('Modality', 'Nooca sawirka'), a.modality],
            [t('Calibration due', 'Hagaajinta'), a.nextCalibrationDue ? fmtDate(a.nextCalibrationDue, lang) : null],
            [t('Why blocked', 'Sababta'), a.blockedReason],
          ]}
        />
        {canDo(me, 'eq', 'E') ? (
          <div className="grid gap-2 rounded-xl border border-line p-3">
            <Field label={t('Reason', 'Sababta')}>
              <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <div className="flex flex-wrap gap-2">
              {a.status !== 'OutOfService' ? (
                <button className="btn" disabled={reason.trim().length < 3 || act.busy} onClick={() => go(() => api(`/equipment/assets/${a.id}/out-of-service`, { body: { reason } }))}>
                  {t('Take out of service', 'Jooji isticmaalka')}
                </button>
              ) : null}
              {a.status === 'OutOfService' && canDo(me, 'eq', 'A') ? (
                <button className="btn btn-primary" disabled={reason.trim().length < 3 || act.busy} onClick={() => go(() => api(`/equipment/assets/${a.id}/release`, { body: { reason } }))}>
                  {t('Return to service', 'Dib u shaqeysii')}
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        <div>
          <h3 className="mb-2 text-[14px] font-bold">{t('Maintenance', 'Dayactirka')}</h3>
          <ul className="grid gap-2">
            {jobs.map((j) => (
              <li key={j.id} className="grid gap-2 rounded-lg border border-line p-2.5">
                <div className="flex items-center gap-2">
                  <b className="capitalize">{j.kind}</b>
                  <span className="text-ink-3">{fmtDate(j.scheduledFor, lang)}</span>
                  <span className="ml-auto">
                    <Pill tone={j.status === 'Open' ? 'warn' : j.result === 'fail' ? 'crit' : 'ok'}>{j.status === 'Open' ? t('Open', 'Furan') : j.result === 'fail' ? t('Failed', 'Fashilmay') : t('Done', 'Dhammaaday')}</Pill>
                  </span>
                </div>
                {j.notes ? <span className="text-ink-2">{j.notes}</span> : null}
                {j.resultNotes ? <span className="text-ink-2">{j.resultNotes}</span> : null}
                {j.status === 'Open' && canDo(me, 'eq', 'E') ? (
                  <div className="grid gap-1.5">
                    <input className="input h-8 text-xs" placeholder={t('What was done', 'Maxaa la sameeyay')} value={done[j.id]?.notes ?? ''} onChange={(e) => setDone({ ...done, [j.id]: { next: done[j.id]?.next ?? '', notes: e.target.value } })} />
                    {j.kind === 'calibration' ? (
                      <label className="flex items-center gap-2 text-xs text-ink-2">
                        {t('Next calibration due', 'Hagaajinta xigta')}
                        <input className="input h-8 w-auto text-xs" type="date" value={done[j.id]?.next ?? ''} onChange={(e) => setDone({ ...done, [j.id]: { notes: done[j.id]?.notes ?? '', next: e.target.value } })} />
                      </label>
                    ) : null}
                    <div className="flex gap-1.5">
                      <button className="btn btn-primary h-8 text-xs" disabled={(done[j.id]?.notes ?? '').length < 3} onClick={() => go(() => api(`/equipment/jobs/${j.id}/complete`, { body: { result: 'pass', notes: done[j.id]!.notes, ...(done[j.id]?.next ? { nextCalibrationDue: done[j.id]!.next } : {}) } }))}>
                        {t('Passed', 'Wuu gudbay')}
                      </button>
                      <button className="btn h-8 border-crit/40 text-xs text-crit" disabled={(done[j.id]?.notes ?? '').length < 3} onClick={() => go(() => api(`/equipment/jobs/${j.id}/complete`, { body: { result: 'fail', notes: done[j.id]!.notes } }))}>
                        {t('Failed', 'Wuu fashilmay')}
                      </button>
                    </div>
                  </div>
                ) : null}
              </li>
            ))}
            {!jobs.length ? <li className="text-ink-3">{t('No maintenance recorded.', 'Dayactir lama diiwaangelin.')}</li> : null}
          </ul>
          {canDo(me, 'eq', 'E') ? (
            <div className="mt-3 grid gap-2 rounded-xl border border-line p-3">
              <b>{t('Schedule maintenance', 'Qorshee dayactir')}</b>
              <div className="grid grid-cols-2 gap-2">
                <select className="input" value={job.kind} onChange={(e) => setJob({ ...job, kind: e.target.value })} aria-label={t('Kind', 'Nooca')}>
                  <option value="preventive">{t('Preventive', 'Ka-hortag')}</option>
                  <option value="repair">{t('Repair', 'Hagaajin')}</option>
                  <option value="calibration">{t('Calibration', 'Cabbirid')}</option>
                </select>
                <input className="input" type="date" value={job.scheduledFor} onChange={(e) => setJob({ ...job, scheduledFor: e.target.value })} aria-label={t('Date', 'Taariikh')} />
              </div>
              <input className="input" placeholder={t('Notes', 'Qoraal')} value={job.notes} onChange={(e) => setJob({ ...job, notes: e.target.value })} />
              <button className="btn justify-self-start" disabled={act.busy} onClick={() => go(() => api(`/equipment/assets/${a.id}/jobs`, { body: { kind: job.kind, scheduledFor: job.scheduledFor, ...(job.notes ? { notes: job.notes } : {}) } }))}>
                {t('Add job', 'Ku dar')}
              </button>
            </div>
          ) : null}
        </div>
        <ErrorNote error={act.error} />
      </div>
    </Drawer>
  );
}

function NewAsset({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
  const { me } = useMe();
  const { t, lang } = useLang();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [f, setF] = useState({ branchId: me.branchId ?? '', code: '', name: '', kind: 'monitor', modality: '', serial: '', nextCalibrationDue: '' });
  const act = useAction();
  const fe = fieldErrors(act.error);
  useEffect(() => {
    api<Branch[]>('/lookup/branches')
      .then((b) => {
        setBranches(b);
        setF((x) => ({ ...x, branchId: x.branchId || b[0]?.id || '' }));
      })
      .catch(() => {});
  }, []);
  return (
    <Drawer title={t('Register device', 'Diiwaangeli qalab')} onClose={onClose}>
      <form
        className="grid gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          const body = { branchId: f.branchId, code: f.code, name: f.name, kind: f.kind, ...(f.modality ? { modality: f.modality } : {}), ...(f.serial ? { serial: f.serial } : {}), ...(f.nextCalibrationDue ? { nextCalibrationDue: f.nextCalibrationDue } : {}) };
          if (await act.run(() => api('/equipment/assets', { body }))) await onDone();
        }}
      >
        {branches.length > 1 ? (
          <Field label={t('Branch', 'Laanta')}>
            <select className="input" value={f.branchId} onChange={(e) => setF({ ...f, branchId: e.target.value })}>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.code} · {b.name}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('Code', 'Koodh')} error={fe.code}>
            <input className="input font-mono uppercase" required value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} placeholder="CT-1" />
          </Field>
          <Field label={t('Type', 'Nooca')}>
            <select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
              {Object.entries(KINDS).map(([k, v]) => (
                <option key={k} value={k}>
                  {lang === 'so' ? v[1] : v[0]}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label={t('Name', 'Magaca')} error={fe.name}>
          <input className="input" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('Imaging modality (if any)', 'Nooca sawirka')}>
            <select className="input" value={f.modality} onChange={(e) => setF({ ...f, modality: e.target.value })}>
              <option value="">—</option>
              {['XR', 'CT', 'MR', 'US', 'MG', 'FL', 'ECG', 'ECHO', 'ENDO', 'EEG'].map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('Serial number', 'Lambarka taxanaha')}>
            <input className="input font-mono" value={f.serial} onChange={(e) => setF({ ...f, serial: e.target.value })} />
          </Field>
        </div>
        <Field label={t('Next calibration due', 'Hagaajinta xigta')} error={fe.nextCalibrationDue}>
          <input className="input" type="date" value={f.nextCalibrationDue} onChange={(e) => setF({ ...f, nextCalibrationDue: e.target.value })} />
        </Field>
        {Object.keys(fe).length ? null : <ErrorNote error={act.error} />}
        <button className="btn btn-primary justify-self-start" disabled={act.busy}>
          {t('Register', 'Diiwaangeli')}
        </button>
      </form>
    </Drawer>
  );
}

function NewLoad({ autoclaves, onClose, onDone }: { autoclaves: Asset[]; onClose: () => void; onDone: () => Promise<void> }) {
  const { t } = useLang();
  const [autoclaveId, setAutoclaveId] = useState(autoclaves.find((a) => a.usable)?.id ?? '');
  const [program, setProgram] = useState('134C-4min');
  const [items, setItems] = useState([{ set: '', qty: 1 }]);
  const act = useAction();
  return (
    <Drawer title={t('New sterilisation load', 'Nadiifin cusub')} onClose={onClose}>
      {autoclaves.length ? (
        <form
          className="grid gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await act.run(() => api('/equipment/cssd/batches', { body: { autoclaveId, program, items: items.filter((i) => i.set.trim()) } }))) await onDone();
          }}
        >
          <Field label={t('Steriliser', 'Nadiifiyaha')}>
            <select className="input" value={autoclaveId} onChange={(e) => setAutoclaveId(e.target.value)}>
              {autoclaves.map((a) => (
                <option key={a.id} value={a.id} disabled={!a.usable}>
                  {a.code} · {a.name}
                  {a.usable ? '' : ` (${t('not usable', 'lama isticmaali karo')})`}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('Programme', 'Barnaamijka')}>
            <select className="input" value={program} onChange={(e) => setProgram(e.target.value)}>
              <option value="134C-4min">134 °C · 4 min</option>
              <option value="121C-20min">121 °C · 20 min</option>
              <option value="low-temp-plasma">{t('Low-temperature plasma', 'Heerkul hoose')}</option>
              <option value="flash">{t('Flash (emergency)', 'Degdeg')}</option>
            </select>
          </Field>
          <div className="grid gap-2">
            <span className="text-[12.5px] font-medium text-ink-2">{t('Instrument sets', 'Qalabka')}</span>
            {items.map((it, i) => (
              <div key={i} className="grid grid-cols-[1fr_80px] gap-2">
                <input className="input" placeholder={t('e.g. Laparotomy set', 'tus. Qalabka qalliinka caloosha')} value={it.set} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, set: e.target.value } : x)))} />
                <input className="input" type="number" min={1} value={it.qty} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, qty: Number(e.target.value) } : x)))} aria-label={t('Quantity', 'Tirada')} />
              </div>
            ))}
            <button type="button" className="btn h-8 justify-self-start text-xs" onClick={() => setItems([...items, { set: '', qty: 1 }])}>
              <Plus size={14} />
              {t('Add set', 'Ku dar')}
            </button>
          </div>
          <ErrorNote error={act.error} />
          <button className="btn btn-primary justify-self-start" disabled={act.busy || !autoclaveId}>
            {t('Load steriliser', 'Rar nadiifiyaha')}
          </button>
        </form>
      ) : (
        <p className="text-[13.5px] text-ink-3">{t('Register a steriliser under Devices first.', 'Marka hore diiwaangeli nadiifiye.')}</p>
      )}
    </Drawer>
  );
}
