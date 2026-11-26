'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Plus, TriangleAlert } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { CATEGORY, INCIDENT_STATUS, IPC_STATUS, ISOLATION, SEVERITY, SITE } from '@/lib/quality';
import { canDo, useMe } from '@/lib/session';
import { Bars, Drawer, Facts, fmtDate, fmtDateTime, monthLabel } from '@/components/Dialog';
import { Card, Empty, ErrorNote, Field, PageHeader, Pill, Stat, Tabs, fieldErrors, useAction } from '@/components/ui';

interface Incident {
  id: string;
  number: string;
  category: string;
  severity: string;
  serious: boolean;
  status: string;
  occurredAt: string;
  reportedAt: string;
  location: string;
  description: string | null;
  immediateAction: string | null;
  patient: { mrn: string; name: string } | null;
  reporter: string | null;
  investigator: string | null;
  rootCause: string | null;
  outcome: string | null;
  actions: { text: string; owner: string; dueOn: string }[];
  history: { at: string; action: string; byName: string; note: string | null }[];
}
interface Ipc {
  id: string;
  number: string;
  patient: { mrn: string; name: string } | null;
  organism: string;
  site: string;
  onsetDate: string;
  hospitalAcquired: boolean;
  isolation: string;
  ward: string | null;
  status: string;
  history: { at: string; action: string; byName: string; note: string | null }[];
}
interface Summary {
  months: string[];
  incidents: { open: number; serious: number; byMonth: number[]; byCategory: Record<string, number>; medianDaysToClose: number | null };
  infections: { open: number; haiByMonth: number[]; bySite: Record<string, number> };
  criticalResults: { raised: number; acknowledged: number; medianMinutesToAcknowledge: number | null };
}

type Tab = 'overview' | 'incidents' | 'ipc';

export default function QualityPage() {
  const { me } = useMe();
  const { t, lang } = useLang();
  const [tab, setTab] = useState<Tab>('overview');
  const [sum, setSum] = useState<Summary | null>(null);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [ipc, setIpc] = useState<Ipc[]>([]);
  const [showClosed, setShowClosed] = useState(false);
  const [open, setOpen] = useState<Incident | null>(null);
  const [openIpc, setOpenIpc] = useState<Ipc | null>(null);
  const [newIpc, setNewIpc] = useState(false);
  const load = useAction();
  const L = <T extends readonly string[]>(m: Record<string, T>, k: string) => (m[k] ? (lang === 'so' ? m[k][1] : m[k][0]) : k);

  const refresh = useCallback(async () => {
    await load.run(async () => {
      const [s, i, c] = await Promise.all([
        api<Summary>('/quality/summary'),
        api<Incident[]>(`/quality/incidents?status=${showClosed ? 'all' : 'open'}`),
        api<Ipc[]>(`/quality/ipc?status=${showClosed ? 'all' : 'open'}`),
      ]);
      setSum(s);
      setIncidents(i);
      setIpc(c);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showClosed]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const labels = sum?.months.map((m) => monthLabel(m, lang)) ?? [];

  return (
    <>
      <PageHeader
        title={t('Quality & safety', 'Tayada & badbaadada')}
        actions={
          <Link href="/quality/report" className="btn btn-primary">
            <TriangleAlert size={16} />
            {t('Report an incident', 'Soo sheeg dhacdo')}
          </Link>
        }
      >
        {t('Incidents, infection control and safety trends.', 'Dhacdooyinka, xakamaynta infekshanka iyo isbeddelka badbaadada.')}
      </PageHeader>
      <ErrorNote error={load.error} />
      <div className="flex flex-wrap items-center gap-3">
        <Tabs<Tab>
          value={tab}
          onChange={setTab}
          items={[
            { id: 'overview', label: t('Overview', 'Guud') },
            { id: 'incidents', label: t('Incidents', 'Dhacdooyinka'), count: sum?.incidents.open },
            { id: 'ipc', label: t('Infection control', 'Xakamaynta infekshanka'), count: sum?.infections.open },
          ]}
        />
        {tab !== 'overview' ? (
          <label className="ml-auto flex items-center gap-2 text-[13px] text-ink-2">
            <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
            {t('Show closed', 'Tus kuwa la xiray')}
          </label>
        ) : null}
      </div>

      {tab === 'overview' && sum ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label={t('Open incidents', 'Dhacdooyin furan')} value={sum.incidents.open} tone={sum.incidents.open ? 'warn' : undefined} />
            <Stat label={t('Serious, last 6 months', 'Kuwa daran, 6 bilood')} value={sum.incidents.serious} tone={sum.incidents.serious ? 'crit' : undefined} />
            <Stat label={t('Infection cases open', 'Kiisas infekshan oo furan')} value={sum.infections.open} />
            <Stat
              label={t('Critical results — time to acknowledge', 'Natiijooyinka khatarta — waqtiga aqoonsiga')}
              value={sum.criticalResults.medianMinutesToAcknowledge === null ? '—' : `${sum.criticalResults.medianMinutesToAcknowledge} min`}
              hint={t(`${sum.criticalResults.acknowledged} of ${sum.criticalResults.raised} acknowledged`, `${sum.criticalResults.acknowledged} ka mid ah ${sum.criticalResults.raised}`)}
            />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title={t('Incidents reported per month', 'Dhacdooyinka bishii')}>
              <div className="px-4 pb-4">
                <Bars labels={labels} values={sum.incidents.byMonth} />
              </div>
            </Card>
            <Card title={t('Hospital-acquired infections per month', 'Infekshanka isbitaalka bishii')}>
              <div className="px-4 pb-4">
                <Bars labels={labels} values={sum.infections.haiByMonth} tone="crit" />
              </div>
            </Card>
            <Card title={t('Incidents by type', 'Dhacdooyinka nooc ahaan')}>
              <Breakdown rows={Object.entries(sum.incidents.byCategory).map(([k, n]) => [L(CATEGORY, k), n])} empty={t('No incidents in this period.', 'Dhacdo ma jirto muddadan.')} />
            </Card>
            <Card title={t('Infections by site', 'Infekshanka meel ahaan')}>
              <Breakdown rows={Object.entries(sum.infections.bySite).map(([k, n]) => [L(SITE, k), n])} empty={t('No infection cases in this period.', 'Kiis infekshan ma jiro muddadan.')} />
            </Card>
          </div>
        </>
      ) : null}

      {tab === 'incidents' ? (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className="th">{t('Number', 'Lambar')}</th>
                  <th className="th">{t('Type', 'Nooca')}</th>
                  <th className="th">{t('Harm', 'Dhaawac')}</th>
                  <th className="th">{t('Where', 'Halkee')}</th>
                  <th className="th">{t('When', 'Goorma')}</th>
                  <th className="th">{t('Status', 'Xaalad')}</th>
                </tr>
              </thead>
              <tbody>
                {incidents.map((x) => (
                  <tr key={x.id} className="cursor-pointer hover:bg-surface-2/60" onClick={() => setOpen(x)}>
                    <td className="td font-mono text-xs">{x.number}</td>
                    <td className="td font-medium">{L(CATEGORY, x.category)}</td>
                    <td className="td">
                      <Pill tone={SEVERITY[x.severity]?.[2]}>{L(SEVERITY, x.severity)}</Pill>
                    </td>
                    <td className="td text-ink-2">{x.location}</td>
                    <td className="td text-ink-2">{fmtDateTime(x.occurredAt, lang)}</td>
                    <td className="td">
                      <Pill tone={INCIDENT_STATUS[x.status]?.[2]}>{L(INCIDENT_STATUS, x.status)}</Pill>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!incidents.length && !load.busy ? <Empty>{t('No open incidents.', 'Dhacdo furan ma jirto.')}</Empty> : null}
          </div>
        </Card>
      ) : null}

      {tab === 'ipc' ? (
        <Card
          actions={
            canDo(me, 'qual', 'E') ? (
              <button className="btn btn-primary h-8 px-3 text-xs" onClick={() => setNewIpc(true)}>
                <Plus size={14} />
                {t('New case', 'Kiis cusub')}
              </button>
            ) : null
          }
        >
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className="th">{t('Number', 'Lambar')}</th>
                  <th className="th">{t('Patient', 'Bukaan')}</th>
                  <th className="th">{t('Organism', 'Jeermiska')}</th>
                  <th className="th">{t('Site', 'Meesha')}</th>
                  <th className="th">{t('Onset', 'Bilowga')}</th>
                  <th className="th">{t('Isolation', 'Go’doon')}</th>
                  <th className="th">{t('Status', 'Xaalad')}</th>
                </tr>
              </thead>
              <tbody>
                {ipc.map((x) => (
                  <tr key={x.id} className="cursor-pointer hover:bg-surface-2/60" onClick={() => setOpenIpc(x)}>
                    <td className="td font-mono text-xs">{x.number}</td>
                    <td className="td">{x.patient ? <b>{x.patient.name}</b> : '—'}</td>
                    <td className="td">
                      {x.organism}
                      {x.hospitalAcquired ? (
                        <span className="ml-2">
                          <Pill tone="crit">{t('Hospital-acquired', 'Isbitaalka')}</Pill>
                        </span>
                      ) : null}
                    </td>
                    <td className="td text-ink-2">{L(SITE, x.site)}</td>
                    <td className="td text-ink-2">{fmtDate(x.onsetDate, lang)}</td>
                    <td className="td text-ink-2">{L(ISOLATION, x.isolation)}</td>
                    <td className="td">
                      <Pill tone={IPC_STATUS[x.status]?.[2]}>{L(IPC_STATUS, x.status)}</Pill>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!ipc.length && !load.busy ? <Empty>{t('No open infection cases.', 'Kiis infekshan oo furan ma jiro.')}</Empty> : null}
          </div>
        </Card>
      ) : null}

      {open ? (
        <IncidentPanel
          x={open}
          onClose={() => setOpen(null)}
          onChanged={async () => {
            await refresh();
            const fresh = await api<Incident>(`/quality/incidents/${open.id}`);
            setOpen(fresh);
          }}
        />
      ) : null}
      {openIpc ? (
        <IpcPanel
          x={openIpc}
          onClose={() => setOpenIpc(null)}
          onChanged={async () => {
            setOpenIpc(null);
            await refresh();
          }}
        />
      ) : null}
      {newIpc ? (
        <NewIpcPanel
          onClose={() => setNewIpc(false)}
          onDone={async () => {
            setNewIpc(false);
            await refresh();
          }}
        />
      ) : null}
    </>
  );
}

function Breakdown({ rows, empty }: { rows: [string, number][]; empty: string }) {
  const max = Math.max(1, ...rows.map((r) => r[1]));
  if (!rows.length) return <Empty>{empty}</Empty>;
  return (
    <ul className="grid gap-2 px-4 pb-4">
      {rows
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => (
          <li key={k} className="grid grid-cols-[140px_1fr_32px] items-center gap-3 text-[13px]">
            <span className="truncate">{k}</span>
            <span className="h-2 overflow-hidden rounded-full bg-surface-3">
              <span className="block h-full rounded-full bg-accent" style={{ width: `${(n / max) * 100}%` }} />
            </span>
            <b className="num text-right">{n}</b>
          </li>
        ))}
    </ul>
  );
}

function History({ items }: { items: { at: string; action: string; byName: string; note: string | null }[] }) {
  const { lang } = useLang();
  return (
    <ol className="grid gap-3 border-l-2 border-line pl-4">
      {items.map((h, i) => (
        <li key={i} className="relative text-[13px]">
          <span className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full bg-accent" />
          <b className="capitalize">{h.action.replace(/-/g, ' ')}</b> <span className="text-ink-3">· {h.byName} · {fmtDateTime(h.at, lang)}</span>
          {h.note ? <p className="text-ink-2">{h.note}</p> : null}
        </li>
      ))}
    </ol>
  );
}

function IncidentPanel({ x, onClose, onChanged }: { x: Incident; onClose: () => void; onChanged: () => Promise<void> }) {
  const { me } = useMe();
  const { t, lang } = useLang();
  const act = useAction();
  const [staff, setStaff] = useState<{ id: string; name: string }[]>([]);
  const [tri, setTri] = useState({ severity: x.severity, category: x.category, investigatorId: '', note: '' });
  const [note, setNote] = useState('');
  const [action, setAction] = useState({ text: '', owner: '', dueOn: '' });
  const [close, setClose] = useState({ rootCause: '', outcome: '' });
  const team = canDo(me, 'qual', 'E');
  const lead = canDo(me, 'qual', 'A');
  const fe = fieldErrors(act.error);
  const L = <T extends readonly string[]>(m: Record<string, T>, k: string) => (m[k] ? (lang === 'so' ? m[k][1] : m[k][0]) : k);

  useEffect(() => {
    if (team && x.status === 'Reported') api<{ id: string; name: string }[]>('/quality/staff').then(setStaff).catch(() => {});
  }, [team, x.status]);

  const go = async (path: string, body: object) => {
    if ((await act.run(() => api(`/quality/incidents/${x.id}/${path}`, { body }))) !== undefined) {
      setNote('');
      setAction({ text: '', owner: '', dueOn: '' });
      await onChanged();
    }
  };

  return (
    <Drawer
      title={`${L(CATEGORY, x.category)} · ${x.number}`}
      sub={
        <span className="flex flex-wrap gap-2">
          <Pill tone={SEVERITY[x.severity]?.[2]}>{L(SEVERITY, x.severity)}</Pill>
          <Pill tone={INCIDENT_STATUS[x.status]?.[2]}>{L(INCIDENT_STATUS, x.status)}</Pill>
        </span>
      }
      onClose={onClose}
      wide
    >
      <div className="grid gap-5">
        <Facts
          rows={[
            [t('When', 'Goorma'), fmtDateTime(x.occurredAt, lang)],
            [t('Where', 'Halkee'), x.location],
            [t('Patient', 'Bukaan'), x.patient ? `${x.patient.name} · ${x.patient.mrn}` : null],
            [t('Reported by', 'Waxaa sheegay'), x.reporter],
            [t('Investigator', 'Baaraha'), x.investigator],
            [t('What happened', 'Maxaa dhacay'), x.description],
            [t('Done straight away', 'Isla markiiba'), x.immediateAction],
            [t('Root cause', 'Sababta'), x.rootCause],
            [t('Outcome', 'Natiijada'), x.outcome],
          ]}
        />
        {x.actions.length ? (
          <div>
            <h3 className="mb-2 text-[14px] font-bold">{t('Corrective actions', 'Tallaabooyinka saxitaanka')}</h3>
            <ul className="grid gap-1.5">
              {x.actions.map((a, i) => (
                <li key={i} className="rounded-lg bg-surface-2 px-3 py-2 text-[13px]">
                  {a.text}
                  <span className="block text-[12px] text-ink-3">
                    {a.owner} · {t('due', 'ilaa')} {fmtDate(a.dueOn, lang)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {team && x.status === 'Reported' ? (
          <form
            className="grid gap-3 rounded-xl border border-line p-3"
            onSubmit={(e) => {
              e.preventDefault();
              void go('triage', { severity: tri.severity, category: tri.category, ...(tri.investigatorId ? { investigatorId: tri.investigatorId } : {}), ...(tri.note ? { note: tri.note } : {}) });
            }}
          >
            <b className="text-[14px]">{t('Triage', 'Kala saar')}</b>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('Type', 'Nooca')}>
                <select className="input" value={tri.category} onChange={(e) => setTri({ ...tri, category: e.target.value })}>
                  {Object.keys(CATEGORY).map((k) => (
                    <option key={k} value={k}>
                      {L(CATEGORY, k)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('Harm', 'Dhaawac')}>
                <select className="input" value={tri.severity} onChange={(e) => setTri({ ...tri, severity: e.target.value })}>
                  {Object.keys(SEVERITY).map((k) => (
                    <option key={k} value={k}>
                      {L(SEVERITY, k)}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label={t('Investigator', 'Baaraha')}>
              <select className="input" value={tri.investigatorId} onChange={(e) => setTri({ ...tri, investigatorId: e.target.value })}>
                <option value="">—</option>
                {staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
            <button className="btn btn-primary justify-self-start" disabled={act.busy}>
              {t('Save triage', 'Kaydi')}
            </button>
          </form>
        ) : null}

        {team && (x.status === 'Triaged' || x.status === 'Investigating') ? (
          <form
            className="grid gap-2 rounded-xl border border-line p-3"
            onSubmit={(e) => {
              e.preventDefault();
              void go('investigate', { note });
            }}
          >
            <b className="text-[14px]">{t('Add a finding', 'Ku dar natiijo baaritaan')}</b>
            <textarea className="input h-20 py-2" required minLength={3} value={note} onChange={(e) => setNote(e.target.value)} />
            <button className="btn justify-self-start" disabled={act.busy}>
              {t('Add finding', 'Ku dar')}
            </button>
          </form>
        ) : null}

        {team && x.status !== 'Closed' && x.status !== 'Reported' ? (
          <form
            className="grid gap-2 rounded-xl border border-line p-3"
            onSubmit={(e) => {
              e.preventDefault();
              void go('actions', action);
            }}
          >
            <b className="text-[14px]">{t('Add a corrective action', 'Ku dar tallaabo saxid')}</b>
            <input className="input" required placeholder={t('What will change', 'Maxaa isbeddelaya')} value={action.text} onChange={(e) => setAction({ ...action, text: e.target.value })} />
            <div className="grid grid-cols-2 gap-2">
              <input className="input" required placeholder={t('Owner', 'Mas’uulka')} value={action.owner} onChange={(e) => setAction({ ...action, owner: e.target.value })} />
              <input className="input" required type="date" value={action.dueOn} onChange={(e) => setAction({ ...action, dueOn: e.target.value })} aria-label={t('Due date', 'Taariikhda')} />
            </div>
            <button className="btn justify-self-start" disabled={act.busy}>
              {t('Add action', 'Ku dar')}
            </button>
          </form>
        ) : null}

        {lead && x.status === 'Investigating' ? (
          <form
            className="grid gap-2 rounded-xl border border-line p-3"
            onSubmit={(e) => {
              e.preventDefault();
              void go('close', close);
            }}
          >
            <b className="text-[14px]">{t('Close the incident', 'Xir dhacdada')}</b>
            <Field label={t('Root cause', 'Sababta')} error={fe.rootCause}>
              <textarea className="input h-16 py-2" required value={close.rootCause} onChange={(e) => setClose({ ...close, rootCause: e.target.value })} />
            </Field>
            <Field label={t('Outcome', 'Natiijada')} error={fe.outcome}>
              <textarea className="input h-16 py-2" required value={close.outcome} onChange={(e) => setClose({ ...close, outcome: e.target.value })} />
            </Field>
            <button className="btn btn-primary justify-self-start" disabled={act.busy}>
              {t('Close incident', 'Xir')}
            </button>
          </form>
        ) : null}

        {Object.keys(fe).length ? null : <ErrorNote error={act.error} />}
        {x.history.length ? (
          <div>
            <h3 className="mb-2 text-[14px] font-bold">{t('History', 'Taariikhda')}</h3>
            <History items={x.history} />
          </div>
        ) : null}
      </div>
    </Drawer>
  );
}

function IpcPanel({ x, onClose, onChanged }: { x: Ipc; onClose: () => void; onChanged: () => Promise<void> }) {
  const { me } = useMe();
  const { t, lang } = useLang();
  const [note, setNote] = useState('');
  const act = useAction();
  const L = <T extends readonly string[]>(m: Record<string, T>, k: string) => (m[k] ? (lang === 'so' ? m[k][1] : m[k][0]) : k);
  const go = async (path: string) => {
    if ((await act.run(() => api(`/quality/ipc/${x.id}/${path}`, { body: { note } }))) !== undefined) await onChanged();
  };
  const steps: [string, string][] =
    x.status === 'Suspected'
      ? [
          ['confirm', t('Confirm', 'Xaqiiji')],
          ['rule-out', t('Rule out', 'Diid')],
        ]
      : x.status === 'Confirmed'
        ? [['close', t('Close case', 'Xir kiiska')]]
        : [];
  return (
    <Drawer title={`${x.organism} · ${x.number}`} sub={<Pill tone={IPC_STATUS[x.status]?.[2]}>{L(IPC_STATUS, x.status)}</Pill>} onClose={onClose}>
      <div className="grid gap-5">
        <Facts
          rows={[
            [t('Patient', 'Bukaan'), x.patient ? `${x.patient.name} · ${x.patient.mrn}` : null],
            [t('Site', 'Meesha'), L(SITE, x.site)],
            [t('Onset', 'Bilowga'), fmtDate(x.onsetDate, lang)],
            [t('Ward', 'Qolka'), x.ward],
            [t('Isolation', 'Go’doon'), L(ISOLATION, x.isolation)],
            [t('Hospital-acquired', 'Isbitaalka laga qaaday'), x.hospitalAcquired ? t('Yes', 'Haa') : t('No', 'Maya')],
          ]}
        />
        {canDo(me, 'qual', 'E') && steps.length ? (
          <div className="grid gap-2 rounded-xl border border-line p-3">
            <Field label={t('Note', 'Qoraal')}>
              <textarea className="input h-16 py-2" value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('e.g. culture result', 'tus. natiijada baaritaanka')} />
            </Field>
            <div className="flex flex-wrap gap-2">
              {steps.map(([p, label], i) => (
                <button key={p} className={`btn ${i === 0 ? 'btn-primary' : ''}`} disabled={act.busy || note.trim().length < 3} onClick={() => go(p)}>
                  {label}
                </button>
              ))}
            </div>
            <ErrorNote error={act.error} />
          </div>
        ) : null}
        {x.history.length ? <History items={x.history} /> : null}
      </div>
    </Drawer>
  );
}

function NewIpcPanel({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
  const { t, lang } = useLang();
  const [f, setF] = useState({ patientMrn: '', organism: '', site: 'urinary', onsetDate: new Date().toISOString().slice(0, 10), hospitalAcquired: true, isolation: 'contact', ward: '', note: '' });
  const act = useAction();
  const fe = fieldErrors(act.error);
  const L = <T extends readonly string[]>(m: Record<string, T>, k: string) => (m[k] ? (lang === 'so' ? m[k][1] : m[k][0]) : k);
  return (
    <Drawer title={t('New infection case', 'Kiis infekshan cusub')} onClose={onClose}>
      <form
        className="grid gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          const r = await act.run(() => api('/quality/ipc', { body: { ...f, ward: f.ward || undefined, note: f.note || undefined } }));
          if (r) await onDone();
        }}
      >
        <Field label={t('Patient MRN', 'MRN-ka bukaanka')} error={fe.patientMrn}>
          <input className="input font-mono" required value={f.patientMrn} onChange={(e) => setF({ ...f, patientMrn: e.target.value })} placeholder="MGD-26-000001" />
        </Field>
        <Field label={t('Organism', 'Jeermiska')} error={fe.organism}>
          <input className="input" required value={f.organism} onChange={(e) => setF({ ...f, organism: e.target.value })} placeholder="e.g. MRSA" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('Site', 'Meesha')}>
            <select className="input" value={f.site} onChange={(e) => setF({ ...f, site: e.target.value })}>
              {Object.keys(SITE).map((k) => (
                <option key={k} value={k}>
                  {L(SITE, k)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('Onset date', 'Taariikhda bilowga')} error={fe.onsetDate}>
            <input className="input" type="date" required value={f.onsetDate} onChange={(e) => setF({ ...f, onsetDate: e.target.value })} />
          </Field>
          <Field label={t('Isolation', 'Go’doon')}>
            <select className="input" value={f.isolation} onChange={(e) => setF({ ...f, isolation: e.target.value })}>
              {Object.keys(ISOLATION).map((k) => (
                <option key={k} value={k}>
                  {L(ISOLATION, k)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('Ward', 'Qolka')}>
            <input className="input" value={f.ward} onChange={(e) => setF({ ...f, ward: e.target.value })} />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-[13.5px]">
          <input type="checkbox" checked={f.hospitalAcquired} onChange={(e) => setF({ ...f, hospitalAcquired: e.target.checked })} />
          {t('Acquired in this hospital (48 h or more after admission)', 'Isbitaalka laga qaaday (48 saacadood kadib dhigista)')}
        </label>
        <Field label={t('Note', 'Qoraal')}>
          <textarea className="input h-16 py-2" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
        </Field>
        {Object.keys(fe).length ? null : <ErrorNote error={act.error} />}
        <button className="btn btn-primary justify-self-start" disabled={act.busy}>
          {t('Save case', 'Kaydi kiiska')}
        </button>
      </form>
    </Drawer>
  );
}
