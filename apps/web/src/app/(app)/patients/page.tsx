'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { GitMerge, Search, UserPlus } from 'lucide-react';
import { ApiError, api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { canDo, useMe } from '@/lib/session';
import { age, fullName, type PatientBrief } from '@/components/clinical';
import { Card, ErrorNote, Field, PageHeader, Pill, fieldErrors, statusTone, useAction } from '@/components/ui';

interface Candidate {
  id: string;
  mrn: string;
  names: PatientBrief['names'];
  dob: string;
  phone: string | null;
  branches: string[];
  score: number;
}
interface Branch {
  id: string;
  code: string;
  name: string;
}

const EMPTY = { givenName: '', middleName: '', familyName: '', dob: '', sexAtBirth: '', phone: '', nationalId: '' };

export default function PatientsPage() {
  const { me } = useMe();
  const { t } = useLang();
  const [q, setQ] = useState('');
  const [list, setList] = useState<PatientBrief[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [form, setForm] = useState(EMPTY);
  const [branchId, setBranchId] = useState(me.branchId ?? '');
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const load = useAction();
  const reg = useAction();
  const canRegister = canDo(me, 'mpi', 'E');

  const search = useCallback(
    async (term: string) => {
      await load.run(async () => setList(await api<PatientBrief[]>(`/patients${term ? `?q=${encodeURIComponent(term)}` : ''}`)));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  useEffect(() => {
    void search('');
    if (canRegister) api<Branch[]>('/branches').then((b) => {
      setBranches(b);
      setBranchId((x) => x || b[0]?.id || '');
    }).catch(() => {});
  }, [search, canRegister]);

  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value });

  async function register(confirmNotDuplicate = false) {
    const body = {
      branchId,
      givenName: form.givenName,
      ...(form.middleName ? { middleName: form.middleName } : {}),
      familyName: form.familyName,
      dob: form.dob,
      ...(form.sexAtBirth ? { sexAtBirth: form.sexAtBirth } : {}),
      ...(form.phone ? { phone: form.phone } : {}),
      identifiers: form.nationalId ? [{ system: 'national-id', value: form.nationalId }] : [],
      confirmNotDuplicate,
    };
    try {
      const p = await reg.run(async () => {
        try {
          return await api<PatientBrief>('/patients', { body });
        } catch (e) {
          if (e instanceof ApiError && e.code === 'POSSIBLE_DUPLICATE') {
            setCandidates((e.body as unknown as { candidates: Candidate[] }).candidates);
            return undefined;
          }
          throw e;
        }
      });
      if (p) {
        setForm(EMPTY);
        setCandidates(null);
        setList((l) => [p, ...l]);
      }
    } catch {}
  }

  async function linkBranch(id: string) {
    if (await reg.run(() => api(`/patients/${id}/link-branch`, { body: {} }))) {
      setCandidates(null);
      setForm(EMPTY);
      await search(q);
    }
  }

  const fe = fieldErrors(reg.error);

  return (
    <>
      <PageHeader eyebrow="Spec §5.3" title={t('Patients', 'Bukaanka')}>
        {t('Search by name (any spelling), MRN or phone. Each person has one record across all branches.', 'Ku raadi magac, MRN ama telefoon.')}
      </PageHeader>
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card
          title={t('Find a patient', 'Raadi bukaan')}
          actions={
            canDo(me, 'mpi', 'E') ? (
              <Link className="btn h-8 px-2.5 text-xs" href="/patients/merges">
                <GitMerge size={14} />
                {t('Merge requests', 'Codsiyada isku-darka')}
              </Link>
            ) : null
          }
        >
          <form
            className="flex gap-2 px-4 pb-3"
            onSubmit={(e) => {
              e.preventDefault();
              void search(q);
            }}
          >
            <label className="flex h-10 flex-1 items-center gap-2 rounded-lg border border-line-2 bg-surface-2 px-3">
              <Search size={16} className="text-ink-3" />
              <input className="min-w-0 flex-1 bg-transparent outline-none" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Faadumo Xasan · MGD-26-000001 · 061 555 0147" aria-label="Search patients" />
            </label>
            <button className="btn btn-primary h-10">{t('Search', 'Raadi')}</button>
          </form>
          <ErrorNote error={load.error} />
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className="th">{t('Patient', 'Bukaanka')}</th>
                  <th className="th">MRN</th>
                  <th className="th">{t('Age', 'Da’da')}</th>
                  <th className="th">Status</th>
                </tr>
              </thead>
              <tbody>
                {list.map((p) => (
                  <tr key={p.id} className="hover:bg-surface-2/50">
                    <td className="td">
                      <Link href={`/patients/${p.id}`} className="font-semibold hover:text-accent-2 hover:underline">
                        {fullName(p.names)}
                      </Link>
                    </td>
                    <td className="td font-mono text-xs">{p.mrn}</td>
                    <td className="td num">
                      {age(p.dob)} · {p.sexAtBirth?.[0]?.toUpperCase() ?? '—'}
                    </td>
                    <td className="td">
                      <Pill tone={statusTone(p.status === 'Verified' ? 'Active' : p.status === 'Provisional' ? 'Pending' : String(p.status))}>{p.status}</Pill>
                    </td>
                  </tr>
                ))}
                {!list.length && !load.busy ? (
                  <tr>
                    <td className="td text-ink-3" colSpan={4}>
                      {me.scope === 'assigned-patient'
                        ? t('No patients in your care yet. Patients appear here when they are booked with you or you join their visit.', 'Weli bukaan kuguma xirna.')
                        : t('No matches. Check the spelling or search by phone.', 'Lama helin.')}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </Card>

        {canRegister ? (
          <Card title={t('Register patient', 'Diiwaangeli bukaan')}>
            <form
              className="grid gap-3 px-4 pb-4"
              onSubmit={(e) => {
                e.preventDefault();
                void register(false);
              }}
            >
              <div className="grid grid-cols-2 gap-3">
                <Field label={t('Given name', 'Magaca')} error={fe.givenName}>
                  <input className="input" required value={form.givenName} onChange={set('givenName')} />
                </Field>
                <Field label={t('Father’s name', 'Magaca aabbaha')} error={fe.middleName}>
                  <input className="input" value={form.middleName} onChange={set('middleName')} />
                </Field>
              </div>
              <Field label={t('Family / grandfather’s name', 'Magaca awoowe')} error={fe.familyName}>
                <input className="input" required value={form.familyName} onChange={set('familyName')} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label={t('Date of birth', 'Taariikhda dhalashada')} error={fe.dob}>
                  <input className="input" type="date" required value={form.dob} onChange={set('dob')} />
                </Field>
                <Field label={t('Sex at birth', 'Jinsiga')}>
                  <select className="input" value={form.sexAtBirth} onChange={set('sexAtBirth')}>
                    <option value="">—</option>
                    <option value="female">{t('Female', 'Dheddig')}</option>
                    <option value="male">{t('Male', 'Lab')}</option>
                    <option value="unknown">{t('Unknown', 'Lama yaqaan')}</option>
                  </select>
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label={t('Phone', 'Telefoon')} error={fe.phone}>
                  <input className="input" inputMode="tel" value={form.phone} onChange={set('phone')} placeholder="061 …" />
                </Field>
                <Field label={t('National ID', 'Aqoonsiga')}>
                  <input className="input font-mono" value={form.nationalId} onChange={set('nationalId')} />
                </Field>
              </div>
              {branches.length > 1 && !me.branchId ? (
                <Field label={t('Branch', 'Laanta')}>
                  <select className="input" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                    {branches.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.code} · {b.name}
                      </option>
                    ))}
                  </select>
                </Field>
              ) : null}
              {candidates ? (
                <div className="grid gap-2 rounded-[10px] bg-warn-soft p-3 text-[13px] text-ink">
                  <b className="text-warn">{t('This person may already be registered', 'Qofkan waxaa laga yaabaa inuu horay u diiwaangashanaa')}</b>
                  {candidates.map((c) => (
                    <div key={c.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-surface p-2">
                      <span className="min-w-0 flex-1">
                        <b>{fullName(c.names)}</b> <span className="text-ink-3">· {c.dob}</span>
                        <span className="block font-mono text-[11.5px] text-ink-2">
                          {c.mrn} · {c.branches.join(', ')} {c.phone ? `· ${c.phone}` : ''} · {Math.round(c.score * 100)}%
                        </span>
                      </span>
                      {c.branches.length && me.branchId ? (
                        <button type="button" className="btn h-8 px-2.5 text-xs" onClick={() => linkBranch(c.id)}>
                          {t('Use this record', 'Isticmaal diiwaankan')}
                        </button>
                      ) : (
                        <Link className="btn h-8 px-2.5 text-xs" href={`/patients/${c.id}`}>
                          {t('Open', 'Fur')}
                        </Link>
                      )}
                    </div>
                  ))}
                  <button type="button" className="btn justify-self-start" onClick={() => register(true)}>
                    {t('Different person — register anyway', 'Qof kale — diiwaangeli')}
                  </button>
                </div>
              ) : null}
              {Object.keys(fe).length ? null : <ErrorNote error={reg.error} />}
              <button className="btn btn-primary justify-self-start" disabled={reg.busy}>
                <UserPlus size={16} />
                {t('Register', 'Diiwaangeli')}
              </button>
            </form>
          </Card>
        ) : null}
      </div>
    </>
  );
}
