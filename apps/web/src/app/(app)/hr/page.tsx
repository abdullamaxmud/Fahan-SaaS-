'use client';

import { useCallback, useEffect, useState } from 'react';
import { CalendarPlus, UserPlus, Wallet } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { money, toMinor } from '@/lib/money';
import { canDo, useMe } from '@/lib/session';
import { useReauth } from '@/components/Reauth';
import { EmployeePanel } from '@/components/EmployeePanel';
import { Card, ErrorNote, Field, PageHeader, Pill, fieldErrors, useAction } from '@/components/ui';

interface Employee { id: string; staffNumber: string; name: string; jobTitle: string; hireDate: string; salary?: { currency: string; baseMinor: number; allowancesMinor: number; deductionsMinor: number } }
interface Cred { id: string; employeeName: string; kind: string; number: string; expiresOn: string; expired: boolean }
interface Shift { id: string; employeeId: string; employeeName: string; date: string; shift: string; unit: string | null; status: string }
interface Leave { id: string; employeeName: string; kind: string; from: string; to: string; reason: string | null }
interface Run { id: string; period: string; currency: string; status: string; employees: number; grossMinor: number; deductionsMinor: number; netMinor: number; preparedByName: string }
interface Branch { id: string; code: string; name: string }

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => iso(new Date(new Date(`${s}T12:00:00Z`).getTime() + n * 86_400_000));

export default function HrPage() {
  const { me } = useMe();
  const { t } = useLang();
  const { guarded, dialog } = useReauth();
  const [emps, setEmps] = useState<Employee[]>([]);
  const [openEmp, setOpenEmp] = useState<Employee | null>(null);
  const [creds, setCreds] = useState<Cred[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [leave, setLeave] = useState<Leave[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [from] = useState(iso(new Date()));
  const [emp, setEmp] = useState({ staffNumber: '', name: '', jobTitle: '', branchId: '', hireDate: iso(new Date()), currency: 'USD', base: '', allowances: '', deductions: '' });
  const [shift, setShift] = useState({ employeeId: '', date: iso(new Date()), shift: 'day', unit: '' });
  const [mine, setMine] = useState({ kind: 'annual', from: '', to: '', reason: '' });
  const [run, setRun] = useState({ period: iso(new Date()).slice(0, 7), currency: 'USD' });
  const [note, setNote] = useState<string | null>(null);
  const load = useAction();
  const act = useAction();
  const viewer = canDo(me, 'hr', 'V');
  const hrAdmin = canDo(me, 'hr', 'A');
  const finance = canDo(me, 'acct', 'S');

  const refresh = useCallback(async () => {
    await load.run(async () => {
      if (viewer) {
        const [e, c, s, l, b] = await Promise.all([
          api<Employee[]>('/hr/employees'),
          api<Cred[]>('/hr/credentials/expiring'),
          api<Shift[]>(`/hr/rosters?from=${from}&to=${addDays(from, 13)}`),
          api<Leave[]>('/hr/leave'),
          hrAdmin ? api<Branch[]>('/branches').catch(() => []) : Promise.resolve([] as Branch[]),
        ]);
        setEmps(e);
        setCreds(c);
        setShifts(s);
        setLeave(l);
        setBranches(b);
      }
      if (viewer || finance) setRuns(await api<Run[]>('/hr/payroll/runs'));
    });
  }, [viewer, finance, hrAdmin, from]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const exec = async (fn: () => Promise<unknown>, after?: (out: unknown) => void) => {
    const out = await act.run(fn);
    if (out !== undefined) {
      after?.(out);
      await refresh();
    }
  };
  const fe = fieldErrors(act.error);
  const days = Array.from({ length: 14 }, (_, i) => addDays(from, i));

  return (
    <>
      {dialog}
      <PageHeader title={t('Staff & payroll', 'Shaqaalaha & mushaharka')}>
        {t('Staff, rosters, leave and payroll.', 'Shaqaalaha, jadwalka, fasaxa iyo mushaharka.')}
      </PageHeader>
      <ErrorNote error={load.error ?? (Object.keys(fe).length ? null : act.error)} />
      {note ? <p className="rounded-[10px] bg-ok-soft px-3 py-2 text-[13px] text-ok">{note}</p> : null}

      <Card title={t('My leave', 'Fasaxayga')}>
        <form
          className="flex flex-wrap items-end gap-2 px-4 pb-4 text-[13px]"
          onSubmit={(e) => {
            e.preventDefault();
            void exec(() => api('/hr/leave', { body: { kind: mine.kind, from: mine.from, to: mine.to, reason: mine.reason || undefined } }), () => {
              setNote(t('Leave requested. HR will decide.', 'Fasax waa la codsaday.'));
              setMine({ ...mine, from: '', to: '', reason: '' });
            });
          }}
        >
          <Field label={t('Type', 'Nooca')}>
            <select className="input h-9" value={mine.kind} onChange={(e) => setMine({ ...mine, kind: e.target.value })}>
              {['annual', 'sick', 'maternity', 'unpaid', 'study'].map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
          </Field>
          <Field label={t('From', 'Laga bilaabo')}>
            <input className="input h-9" type="date" required value={mine.from} onChange={(e) => setMine({ ...mine, from: e.target.value })} />
          </Field>
          <Field label={t('To', 'Ilaa')} error={fe.to}>
            <input className="input h-9" type="date" required value={mine.to} onChange={(e) => setMine({ ...mine, to: e.target.value })} />
          </Field>
          <Field label={t('Reason', 'Sababta')}>
            <input className="input h-9" value={mine.reason} onChange={(e) => setMine({ ...mine, reason: e.target.value })} />
          </Field>
          <button className="btn btn-primary h-9">{t('Request leave', 'Codso fasax')}</button>
        </form>
      </Card>

      {viewer ? (
        <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
          <div className="grid gap-4">
            <Card title={t('Roster — next two weeks', 'Jadwalka — labada toddobaad')}>
              <div className="overflow-x-auto px-4 pb-4">
                <table className="w-full border-collapse text-[12px]">
                  <thead>
                    <tr>
                      <th className="th">{t('Staff', 'Shaqaale')}</th>
                      {days.map((d) => (
                        <th key={d} className="th text-center">
                          {d.slice(8)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {emps.map((e) => (
                      <tr key={e.id}>
                        <td className="td whitespace-nowrap">{e.name}</td>
                        {days.map((d) => {
                          const s = shifts.find((x) => x.employeeId === e.id && x.date === d);
                          return (
                            <td key={d} className="td text-center">
                              {s ? <Pill tone={s.status === 'uncovered' ? 'crit' : s.shift === 'night' ? 'info' : 'plain'}>{s.status === 'uncovered' ? t('gap', 'bannaan') : s.shift[0]!.toUpperCase()}</Pill> : null}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {hrAdmin ? (
                  <form
                    className="mt-3 flex flex-wrap items-end gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void exec(() => api('/hr/rosters/shifts', { body: { ...shift, unit: shift.unit || undefined } }));
                    }}
                  >
                    <Field label={t('Staff', 'Shaqaale')}>
                      <select className="input h-9" required value={shift.employeeId} onChange={(e) => setShift({ ...shift, employeeId: e.target.value })}>
                        <option value="">—</option>
                        {emps.map((e) => (
                          <option key={e.id} value={e.id}>
                            {e.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label={t('Date', 'Taariikh')}>
                      <input className="input h-9" type="date" required value={shift.date} onChange={(e) => setShift({ ...shift, date: e.target.value })} />
                    </Field>
                    <Field label={t('Shift', 'Wareeg')}>
                      <select className="input h-9" value={shift.shift} onChange={(e) => setShift({ ...shift, shift: e.target.value })}>
                        <option value="day">{t('day', 'maalin')}</option>
                        <option value="evening">{t('evening', 'galab')}</option>
                        <option value="night">{t('night', 'habeen')}</option>
                      </select>
                    </Field>
                    <Field label={t('Unit', 'Qaybta')}>
                      <input className="input h-9 w-28" value={shift.unit} onChange={(e) => setShift({ ...shift, unit: e.target.value })} />
                    </Field>
                    <button className="btn h-9">
                      <CalendarPlus size={15} /> {t('Add shift', 'Ku dar')}
                    </button>
                  </form>
                ) : null}
              </div>
            </Card>

            <Card title={t('Staff', 'Shaqaalaha')}>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[13px]">
                  <thead>
                    <tr>
                      <th className="th">{t('Name', 'Magaca')}</th>
                      <th className="th">{t('Role', 'Shaqada')}</th>
                      <th className="th">{t('Since', 'Laga bilaabo')}</th>
                      {emps.some((e) => e.salary) ? <th className="th text-right">{t('Monthly gross', 'Mushaharka')}</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {emps.map((e) => (
                      <tr key={e.id} className={hrAdmin ? 'cursor-pointer hover:bg-surface-2/60' : ''} onClick={() => hrAdmin && setOpenEmp(e)}>
                        <td className="td">
                          <b>{e.name}</b> <span className="font-mono text-[11.5px] text-ink-3">{e.staffNumber}</span>
                        </td>
                        <td className="td">{e.jobTitle}</td>
                        <td className="td">{e.hireDate}</td>
                        {e.salary ? <td className="td num text-right">{money(e.salary.baseMinor + e.salary.allowancesMinor, e.salary.currency)}</td> : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {hrAdmin ? (
                <form
                  className="grid gap-2 px-4 pb-4 pt-2 text-[13px] sm:grid-cols-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void exec(
                      () => api('/hr/employees', { body: { staffNumber: emp.staffNumber, name: emp.name, jobTitle: emp.jobTitle, branchId: emp.branchId, hireDate: emp.hireDate, salary: { currency: emp.currency, baseMinor: toMinor(emp.base), allowancesMinor: toMinor(emp.allowances || '0'), deductionsMinor: toMinor(emp.deductions || '0') } } }),
                      () => setEmp({ ...emp, staffNumber: '', name: '', jobTitle: '', base: '', allowances: '', deductions: '' }),
                    );
                  }}
                >
                  <Field label={t('Staff number', 'Lambarka')} error={fe.staffNumber}>
                    <input className="input h-9" required value={emp.staffNumber} onChange={(e) => setEmp({ ...emp, staffNumber: e.target.value })} />
                  </Field>
                  <Field label={t('Name', 'Magaca')} error={fe.name}>
                    <input className="input h-9" required value={emp.name} onChange={(e) => setEmp({ ...emp, name: e.target.value })} />
                  </Field>
                  <Field label={t('Job title', 'Shaqada')} error={fe.jobTitle}>
                    <input className="input h-9" required value={emp.jobTitle} onChange={(e) => setEmp({ ...emp, jobTitle: e.target.value })} />
                  </Field>
                  <Field label={t('Branch', 'Laanta')}>
                    <select className="input h-9" required value={emp.branchId} onChange={(e) => setEmp({ ...emp, branchId: e.target.value })}>
                      <option value="">—</option>
                      {branches.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.code} · {b.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t('Hired', 'La shaqaaleysiiyay')}>
                    <input className="input h-9" type="date" required value={emp.hireDate} onChange={(e) => setEmp({ ...emp, hireDate: e.target.value })} />
                  </Field>
                  <Field label={t('Paid in', 'Lacagta')}>
                    <select className="input h-9" value={emp.currency} onChange={(e) => setEmp({ ...emp, currency: e.target.value })}>
                      <option>USD</option>
                      <option>SOS</option>
                    </select>
                  </Field>
                  <Field label={t('Base salary', 'Mushaharka aasaasiga')}>
                    <input className="input h-9" inputMode="decimal" required value={emp.base} onChange={(e) => setEmp({ ...emp, base: e.target.value })} />
                  </Field>
                  <Field label={t('Allowances', 'Gunnooyin')}>
                    <input className="input h-9" inputMode="decimal" value={emp.allowances} onChange={(e) => setEmp({ ...emp, allowances: e.target.value })} />
                  </Field>
                  <Field label={t('Deductions', 'Jarid')}>
                    <input className="input h-9" inputMode="decimal" value={emp.deductions} onChange={(e) => setEmp({ ...emp, deductions: e.target.value })} />
                  </Field>
                  <button className="btn btn-primary h-9 justify-self-start">
                    <UserPlus size={15} /> {t('Add employee', 'Ku dar')}
                  </button>
                </form>
              ) : null}
            </Card>
          </div>

          <div className="grid gap-4">
            <Card title={t('Credentials expiring in 30 days', 'Shahaadooyinka dhacaya')}>
              <ul className="grid gap-1.5 px-4 pb-4 text-[13px]">
                {creds.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center gap-2">
                    <b>{c.employeeName}</b> {c.kind} <span className="font-mono text-[11.5px] text-ink-3">{c.number}</span>
                    <Pill tone={c.expired ? 'crit' : 'warn'}>
                      {c.expired ? t('expired', 'dhacay') : t('expires', 'dhacaya')} {c.expiresOn}
                    </Pill>
                  </li>
                ))}
                {!creds.length ? <li className="text-ink-3">{t('Nothing expiring.', 'Waxba ma dhacayaan.')}</li> : null}
              </ul>
            </Card>

            <Card title={t('Leave requests', 'Codsiyada fasaxa')}>
              <ul className="grid gap-2 px-4 pb-4 text-[13px]">
                {leave.map((l) => (
                  <li key={l.id} className="rounded-[10px] border border-line p-3">
                    <b>{l.employeeName}</b> · {l.kind} · {l.from} → {l.to}
                    {l.reason ? <p className="text-ink-2">{l.reason}</p> : null}
                    {hrAdmin ? (
                      <div className="mt-2 flex gap-2">
                        <button
                          className="btn btn-primary h-8"
                          onClick={() => exec(() => api<{ uncoveredShifts: number }>(`/hr/leave/${l.id}/decide`, { body: { decision: 'approve' } }), (o) => setNote((o as { uncoveredShifts: number }).uncoveredShifts ? `${(o as { uncoveredShifts: number }).uncoveredShifts} ${t('shift(s) now need cover', 'wareeg ayaa u baahan beddel')}` : null))}
                        >
                          {t('Approve', 'Oggolow')}
                        </button>
                        <button className="btn h-8" onClick={() => exec(() => api(`/hr/leave/${l.id}/decide`, { body: { decision: 'reject' } }))}>
                          {t('Reject', 'Diid')}
                        </button>
                      </div>
                    ) : null}
                  </li>
                ))}
                {!leave.length ? <li className="text-ink-3">{t('No requests waiting.', 'Codsi ma jiro.')}</li> : null}
              </ul>
            </Card>
          </div>
        </div>
      ) : null}

      {viewer || finance ? (
        <Card title={t('Payroll', 'Mushaharka')}>
          <div className="grid gap-3 px-4 pb-4 text-[13px]">
            {hrAdmin ? (
              <form
                className="flex flex-wrap items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void exec(() => api('/hr/payroll/runs', { body: run }));
                }}
              >
                <Field label={t('Month', 'Bisha')}>
                  <input className="input h-9" type="month" required value={run.period} onChange={(e) => setRun({ ...run, period: e.target.value })} />
                </Field>
                <Field label={t('Currency', 'Lacagta')}>
                  <select className="input h-9" value={run.currency} onChange={(e) => setRun({ ...run, currency: e.target.value })}>
                    <option>USD</option>
                    <option>SOS</option>
                  </select>
                </Field>
                <button className="btn btn-primary h-9">
                  <Wallet size={15} /> {t('Prepare payroll', 'Diyaari mushaharka')}
                </button>
              </form>
            ) : null}
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className="th">{t('Month', 'Bisha')}</th>
                  <th className="th">{t('Status', 'Xaaladda')}</th>
                  <th className="th text-right">{t('Staff', 'Shaqaale')}</th>
                  <th className="th text-right">{t('Gross', 'Guud')}</th>
                  <th className="th text-right">{t('Net paid', 'Saafi')}</th>
                  <th className="th" />
                </tr>
              </thead>
              <tbody>
                {runs.map((x) => (
                  <tr key={x.id}>
                    <td className="td">
                      {x.period} <span className="text-ink-3">{x.currency}</span>
                    </td>
                    <td className="td">
                      <Pill tone={x.status === 'Paid' ? 'ok' : x.status === 'Approved' ? 'info' : 'plain'}>{x.status}</Pill>
                    </td>
                    <td className="td num text-right">{x.employees}</td>
                    <td className="td num text-right">{money(x.grossMinor, x.currency)}</td>
                    <td className="td num text-right">{money(x.netMinor, x.currency)}</td>
                    <td className="td text-right">
                      {finance && x.status === 'Draft' ? (
                        <button className="btn btn-primary h-8" onClick={() => exec(() => guarded(() => api(`/hr/payroll/runs/${x.id}/approve`, { body: {} })))}>
                          {t('Approve', 'Oggolow')}
                        </button>
                      ) : null}
                      {finance && x.status === 'Approved' ? (
                        <button className="btn btn-primary h-8" onClick={() => { const reference = prompt(t('Bank batch reference', 'Tixraaca bangiga')); if (reference) void exec(() => guarded(() => api(`/hr/payroll/runs/${x.id}/pay`, { body: { reference } }))); }}>
                          {t('Pay', 'Bixi')}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
                {!runs.length ? (
                  <tr>
                    <td className="td text-ink-3" colSpan={6}>
                      {t('No payroll runs yet.', 'Mushahar weli lama diyaarin.')}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
      {openEmp ? <EmployeePanel e={openEmp} onClose={() => setOpenEmp(null)} onDone={refresh} /> : null}
    </>
  );
}
