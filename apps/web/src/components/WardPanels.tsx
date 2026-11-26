'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { canDo, useMe } from '@/lib/session';
import { fullName, type PatientBrief } from './clinical';
import { Drawer, fmtDateTime } from './Dialog';
import { PatientPicker } from './PatientPicker';
import { ErrorNote, Field, Pill, fieldErrors, useAction } from './ui';

interface Branch {
  id: string;
  code: string;
  name: string;
}

/** Admission request: the patient then waits for a bed on the board. */
export function AdmitDrawer({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
  const { t } = useLang();
  const [patient, setPatient] = useState<PatientBrief | null>(null);
  const [docs, setDocs] = useState<{ id: string; name: string }[]>([]);
  const [f, setF] = useState({ attendingId: '', reason: '', source: 'OPD' });
  const act = useAction();
  const fe = fieldErrors(act.error);
  useEffect(() => {
    api<{ id: string; name: string }[]>('/admissions/attendings')
      .then((d) => {
        setDocs(d);
        setF((x) => ({ ...x, attendingId: x.attendingId || d[0]?.id || '' }));
      })
      .catch(() => {});
  }, []);
  return (
    <Drawer title={t('Admit a patient', 'Dhig bukaan')} onClose={onClose}>
      <form
        className="grid gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!patient) return;
          if (await act.run(() => api('/admissions', { body: { patientId: patient.id, ...f } }))) await onDone();
        }}
      >
        <Field label={t('Patient', 'Bukaanka')} error={fe.patientId}>
          <PatientPicker value={patient} onChange={setPatient} />
        </Field>
        <Field label={t('Responsible doctor', 'Dhakhtarka mas’uulka ah')} error={fe.attendingId}>
          <select className="input" value={f.attendingId} onChange={(e) => setF({ ...f, attendingId: e.target.value })}>
            {docs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('Coming from', 'Halka uu ka yimid')}>
          <select className="input" value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}>
            <option value="OPD">{t('Outpatient clinic', 'Bukaan-socod')}</option>
            <option value="ER">{t('Emergency', 'Gurmad')}</option>
            <option value="direct">{t('Direct admission', 'Toos')}</option>
            <option value="referral">{t('Referral', 'Gudbin')}</option>
          </select>
        </Field>
        <Field label={t('Reason for admission', 'Sababta dhigista')} error={fe.reason}>
          <input className="input" required minLength={3} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
        </Field>
        {Object.keys(fe).length ? null : <ErrorNote error={act.error} />}
        <button className="btn btn-primary justify-self-start" disabled={act.busy || !patient}>
          {t('Request admission', 'Codso dhigis')}
        </button>
        <p className="text-[12.5px] text-ink-3">{t('Next, choose a free bed on the board.', 'Kadib, ka dooro sariir bannaan sabuuradda.')}</p>
      </form>
    </Drawer>
  );
}

/** Ward manager: add a ward or more beds to an existing ward. */
export function WardSetupDrawer({ wards, onClose, onDone }: { wards: { id: string; code: string; name: string }[]; onClose: () => void; onDone: () => Promise<void> }) {
  const { me } = useMe();
  const { t } = useLang();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [w, setW] = useState({ branchId: me.branchId ?? '', code: '', name: '', kind: 'general' });
  const [b, setB] = useState({ wardId: wards[0]?.id ?? '', count: 4, room: '' });
  const act = useAction();
  const fe = fieldErrors(act.error);
  useEffect(() => {
    api<Branch[]>('/lookup/branches')
      .then((x) => {
        setBranches(x);
        setW((v) => ({ ...v, branchId: v.branchId || x[0]?.id || '' }));
      })
      .catch(() => {});
  }, []);
  return (
    <Drawer title={t('Set up wards and beds', 'Habee qolalka iyo sariiraha')} onClose={onClose}>
      <div className="grid gap-5">
        <form
          className="grid gap-3 rounded-xl border border-line p-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await act.run(() => api('/wards', { body: w }))) {
              setW({ ...w, code: '', name: '' });
              await onDone();
            }
          }}
        >
          <b>{t('New ward', 'Qol cusub')}</b>
          {branches.length > 1 ? (
            <select className="input" value={w.branchId} onChange={(e) => setW({ ...w, branchId: e.target.value })} aria-label={t('Branch', 'Laanta')}>
              {branches.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.code} · {x.name}
                </option>
              ))}
            </select>
          ) : null}
          <div className="grid grid-cols-[110px_1fr] gap-2">
            <Field label={t('Code', 'Koodh')} error={fe.code}>
              <input className="input font-mono uppercase" required value={w.code} onChange={(e) => setW({ ...w, code: e.target.value })} placeholder="4A" />
            </Field>
            <Field label={t('Name', 'Magaca')} error={fe.name}>
              <input className="input" required value={w.name} onChange={(e) => setW({ ...w, name: e.target.value })} placeholder={t('e.g. Ward 4A Surgical', 'tus. Qolka 4A')} />
            </Field>
          </div>
          <Field label={t('Type', 'Nooca')}>
            <select className="input" value={w.kind} onChange={(e) => setW({ ...w, kind: e.target.value })}>
              {[
                ['general', t('General', 'Guud')],
                ['surgical', t('Surgical', 'Qalliin')],
                ['maternity', t('Maternity', 'Umulaha')],
                ['pediatric', t('Children', 'Carruurta')],
                ['icu', 'ICU'],
                ['nicu', 'NICU'],
                ['picu', 'PICU'],
                ['isolation', t('Isolation', 'Go’doon')],
              ].map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
          <button className="btn btn-primary justify-self-start" disabled={act.busy}>
            {t('Add ward', 'Ku dar qol')}
          </button>
        </form>
        {wards.length ? (
          <form
            className="grid gap-3 rounded-xl border border-line p-3"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await act.run(() => api(`/wards/${b.wardId}/beds`, { body: { count: b.count, ...(b.room ? { room: b.room } : {}) } }))) await onDone();
            }}
          >
            <b>{t('Add beds', 'Ku dar sariiro')}</b>
            <select className="input" value={b.wardId} onChange={(e) => setB({ ...b, wardId: e.target.value })} aria-label={t('Ward', 'Qolka')}>
              {wards.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.code} · {x.name}
                </option>
              ))}
            </select>
            <div className="grid grid-cols-2 gap-2">
              <Field label={t('How many', 'Immisa')}>
                <input className="input" type="number" min={1} max={60} value={b.count} onChange={(e) => setB({ ...b, count: Number(e.target.value) })} />
              </Field>
              <Field label={t('Room (optional)', 'Qolka (ikhtiyaari)')}>
                <input className="input" value={b.room} onChange={(e) => setB({ ...b, room: e.target.value })} />
              </Field>
            </div>
            <button className="btn justify-self-start" disabled={act.busy}>
              {t('Add beds', 'Ku dar')}
            </button>
          </form>
        ) : null}
        <ErrorNote error={act.error} />
      </div>
    </Drawer>
  );
}

interface Plan {
  id: string;
  problem: string;
  goal: string;
  interventions: string[];
  status: string;
  ownerName: string;
  outcome?: string;
  version: number;
}

/** One inpatient: nursing care plans and the care team. */
export function CareDrawer({ admissionId, encounterId, patient, onClose }: { admissionId: string; encounterId: string | null; patient: string; onClose: () => void }) {
  const { me } = useMe();
  const { t } = useLang();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [np, setNp] = useState({ problem: '', goal: '', interventions: '' });
  const [closing, setClosing] = useState<Record<string, string>>({});
  const [staff, setStaff] = useState<{ id: string; name: string; role: string }[]>([]);
  const [member, setMember] = useState('');
  const [added, setAdded] = useState<string | null>(null);
  const act = useAction();
  const load = useCallback(() => api<Plan[]>(`/nursing/admissions/${admissionId}/care-plans`).then(setPlans), [admissionId]);
  useEffect(() => {
    void act.run(load);
    api<{ id: string; name: string; role: string }[]>('/lookup/clinical-staff').then(setStaff).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);
  const canWrite = canDo(me, 'nur', 'E');

  return (
    <Drawer title={patient} sub={t('Nursing care', 'Daryeelka kalkaalinta')} onClose={onClose} wide>
      <div className="grid gap-5 text-[13px]">
        {encounterId ? (
          <Link className="btn justify-self-start" href={`/encounters/${encounterId}`}>
            {t('Open chart: vitals, notes, medicines', 'Fur kaarka: calaamadaha, qoraallada, daawooyinka')}
          </Link>
        ) : null}
        <div>
          <h3 className="mb-2 text-[14px] font-bold">{t('Care plans', 'Qorshayaasha daryeelka')}</h3>
          <ul className="grid gap-2">
            {plans.map((p) => (
              <li key={p.id} className="grid gap-1.5 rounded-lg border border-line p-3">
                <div className="flex items-center gap-2">
                  <b className="flex-1">{p.problem}</b>
                  <Pill tone={p.status === 'active' ? 'info' : 'ok'}>{p.status === 'active' ? t('Active', 'Socda') : p.status === 'resolved' ? t('Resolved', 'Xallisan') : t('Stopped', 'La joojiyay')}</Pill>
                </div>
                <span className="text-ink-2">
                  {t('Goal', 'Hadafka')}: {p.goal}
                </span>
                <ul className="ml-4 list-disc text-ink-2">
                  {p.interventions.map((i, k) => (
                    <li key={k}>{i}</li>
                  ))}
                </ul>
                <span className="text-[12px] text-ink-3">
                  {t('Owner', 'Mas’uulka')}: {p.ownerName}
                  {p.outcome ? ` · ${p.outcome}` : ''}
                </span>
                {canWrite && p.status === 'active' ? (
                  <div className="flex gap-1.5">
                    <input className="input h-8 flex-1 text-xs" placeholder={t('Outcome', 'Natiijada')} value={closing[p.id] ?? ''} onChange={(e) => setClosing({ ...closing, [p.id]: e.target.value })} />
                    <button className="btn h-8 text-xs" disabled={(closing[p.id] ?? '').length < 3} onClick={async () => { if ((await act.run(() => api(`/nursing/care-plans/${p.id}`, { method: 'PATCH', body: { status: 'resolved', outcome: closing[p.id], version: p.version } }))) !== undefined) await load(); }}>
                      {t('Resolved', 'Xallisan')}
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
            {!plans.length ? <li className="text-ink-3">{t('No care plans yet.', 'Weli qorshe daryeel ma jiro.')}</li> : null}
          </ul>
          {canWrite ? (
            <form
              className="mt-3 grid gap-2 rounded-xl border border-line p-3"
              onSubmit={async (e) => {
                e.preventDefault();
                const interventions = np.interventions.split('\n').map((x) => x.trim()).filter(Boolean);
                if (await act.run(() => api(`/nursing/admissions/${admissionId}/care-plans`, { body: { problem: np.problem, goal: np.goal, interventions } }))) {
                  setNp({ problem: '', goal: '', interventions: '' });
                  await load();
                }
              }}
            >
              <b>{t('New care plan', 'Qorshe cusub')}</b>
              <input className="input" required placeholder={t('Problem, e.g. Risk of falls', 'Dhibaatada, tus. Khatar dhicis')} value={np.problem} onChange={(e) => setNp({ ...np, problem: e.target.value })} />
              <input className="input" required placeholder={t('Goal, e.g. No falls during stay', 'Hadafka')} value={np.goal} onChange={(e) => setNp({ ...np, goal: e.target.value })} />
              <textarea className="input h-20 py-2" required placeholder={t('Actions — one per line', 'Tallaabooyinka — mid kasta sadar')} value={np.interventions} onChange={(e) => setNp({ ...np, interventions: e.target.value })} />
              <button className="btn btn-primary justify-self-start" disabled={act.busy}>
                <Plus size={15} />
                {t('Add plan', 'Ku dar')}
              </button>
            </form>
          ) : null}
        </div>

        {encounterId && canDo(me, 'nur', 'E') ? (
          <div className="grid gap-2 rounded-xl border border-line p-3">
            <b>{t('Add someone to the care team', 'Ku dar kooxda daryeelka')}</b>
            <div className="flex gap-2">
              <select className="input flex-1" value={member} onChange={(e) => setMember(e.target.value)} aria-label={t('Colleague', 'Saaxiib shaqo')}>
                <option value="">{t('Choose a colleague…', 'Dooro…')}</option>
                {staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {s.role}
                  </option>
                ))}
              </select>
              <button className="btn" disabled={!member || act.busy} onClick={async () => { if ((await act.run(() => api(`/encounters/${encounterId}/care-team`, { body: { userId: member } }))) !== undefined) setAdded(staff.find((s) => s.id === member)?.name ?? ''); }}>
                {t('Add', 'Ku dar')}
              </button>
            </div>
            {added ? <span className="text-ok">{t(`${added} can now open this patient’s chart.`, `${added} hadda wuu furi karaa kaarka bukaankan.`)}</span> : null}
          </div>
        ) : null}
        <ErrorNote error={act.error} />
      </div>
    </Drawer>
  );
}

interface Handover {
  id: string;
  shift: string;
  summary: string;
  items: { admissionId: string; note: string; risks: string[] }[];
  authorName: string;
  createdAt: string;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
}
const RISKS: [string, string, string][] = [
  ['fall', 'Fall', 'Dhicid'],
  ['pressure-injury', 'Pressure sore', 'Nabar'],
  ['infection', 'Infection', 'Infekshan'],
  ['deterioration', 'Getting worse', 'Sii xumaanaya'],
  ['self-harm', 'Self-harm', 'Is-dhaawac'],
];

/** Shift handover for one ward: write it, and the incoming nurse acknowledges it. */
export function HandoverDrawer({ ward, patients, onClose }: { ward: { id: string; code: string; name: string }; patients: { admissionId: string; name: string; bed: string }[]; onClose: () => void }) {
  const { me } = useMe();
  const { t, lang } = useLang();
  const [list, setList] = useState<Handover[]>([]);
  const [shift, setShift] = useState(new Date().getHours() >= 7 && new Date().getHours() < 19 ? 'day' : 'night');
  const [summary, setSummary] = useState('');
  const [items, setItems] = useState<Record<string, { note: string; risks: string[] }>>({});
  const act = useAction();
  const load = useCallback(() => api<Handover[]>(`/nursing/wards/${ward.id}/handovers`).then(setList), [ward.id]);
  useEffect(() => {
    void act.run(load);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);
  const pname = (aid: string) => patients.find((p) => p.admissionId === aid);

  return (
    <Drawer title={`${t('Handover', 'Wareejinta shaqada')} · ${ward.code}`} sub={ward.name} onClose={onClose} wide>
      <div className="grid gap-5 text-[13px]">
        {canDo(me, 'nur', 'E') ? (
          <form
            className="grid gap-3 rounded-xl border border-line p-3"
            onSubmit={async (e) => {
              e.preventDefault();
              const body = { shift, summary, items: Object.entries(items).filter(([, v]) => v.note.trim().length >= 2).map(([admissionId, v]) => ({ admissionId, note: v.note, risks: v.risks })) };
              if (await act.run(() => api(`/nursing/wards/${ward.id}/handovers`, { body }))) {
                setSummary('');
                setItems({});
                await load();
              }
            }}
          >
            <div className="flex items-center gap-2">
              <b className="flex-1">{t('Write handover', 'Qor wareejinta')}</b>
              <select className="input h-8 w-auto" value={shift} onChange={(e) => setShift(e.target.value)} aria-label={t('Shift', 'Shaqada')}>
                <option value="day">{t('Day shift', 'Maalin')}</option>
                <option value="night">{t('Night shift', 'Habeen')}</option>
              </select>
            </div>
            <textarea className="input h-20 py-2" required minLength={5} placeholder={t('Ward summary: staffing, beds, anything the next shift must know', 'Soo koobidda qolka')} value={summary} onChange={(e) => setSummary(e.target.value)} />
            {patients.map((p) => (
              <div key={p.admissionId} className="grid gap-1.5 rounded-lg bg-surface-2/60 p-2.5">
                <b>
                  {p.bed} · {p.name}
                </b>
                <input className="input h-8 text-xs" placeholder={t('Note for the next shift', 'Qoraal shaqada xigta')} value={items[p.admissionId]?.note ?? ''} onChange={(e) => setItems({ ...items, [p.admissionId]: { risks: items[p.admissionId]?.risks ?? [], note: e.target.value } })} />
                <div className="flex flex-wrap gap-1.5">
                  {RISKS.map(([k, en, so]) => {
                    const on = items[p.admissionId]?.risks.includes(k) ?? false;
                    return (
                      <button
                        type="button"
                        key={k}
                        className={`rounded-full border px-2 py-0.5 text-[11.5px] ${on ? 'border-warn bg-warn-soft text-warn' : 'border-line text-ink-3'}`}
                        onClick={() => setItems({ ...items, [p.admissionId]: { note: items[p.admissionId]?.note ?? '', risks: on ? (items[p.admissionId]?.risks ?? []).filter((r) => r !== k) : [...(items[p.admissionId]?.risks ?? []), k] } })}
                      >
                        {lang === 'so' ? so : en}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            <button className="btn btn-primary justify-self-start" disabled={act.busy}>
              {t('Save handover', 'Kaydi')}
            </button>
          </form>
        ) : null}

        <div>
          <h3 className="mb-2 text-[14px] font-bold">{t('Recent handovers', 'Wareejinihii dhawaa')}</h3>
          <ul className="grid gap-2">
            {list.map((h) => (
              <li key={h.id} className="grid gap-1.5 rounded-lg border border-line p-3">
                <div className="flex items-center gap-2">
                  <b className="flex-1">
                    {h.shift === 'day' ? t('Day shift', 'Maalin') : t('Night shift', 'Habeen')} · {h.authorName}
                  </b>
                  <span className="text-[12px] text-ink-3">{fmtDateTime(h.createdAt, lang)}</span>
                </div>
                <p className="text-ink-2">{h.summary}</p>
                {h.items.map((i) => (
                  <p key={i.admissionId} className="text-[12.5px]">
                    <b>{pname(i.admissionId)?.name ?? t('Patient', 'Bukaan')}</b>: {i.note}
                    {i.risks.length ? <span className="text-warn"> · {i.risks.join(', ')}</span> : null}
                  </p>
                ))}
                {h.acknowledgedBy ? (
                  <span className="text-[12px] text-ok">
                    {t('Received by', 'Waxaa qaatay')} {h.acknowledgedBy} · {fmtDateTime(h.acknowledgedAt, lang)}
                  </span>
                ) : canDo(me, 'nur', 'E') ? (
                  <button className="btn h-8 justify-self-start text-xs" disabled={act.busy} onClick={async () => { if ((await act.run(() => api(`/nursing/handovers/${h.id}/acknowledge`, { body: {} }))) !== undefined) await load(); }}>
                    {t('I have received this handover', 'Waan helay wareejintan')}
                  </button>
                ) : null}
              </li>
            ))}
            {!list.length ? <li className="text-ink-3">{t('No handovers yet.', 'Weli wareejin ma jirto.')}</li> : null}
          </ul>
        </div>
        <ErrorNote error={act.error} />
      </div>
    </Drawer>
  );
}

export const patientLabel = (p: { names?: PatientBrief['names']; initials?: string } | null) => (!p ? '' : p.names ? fullName(p.names) : (p.initials ?? ''));
