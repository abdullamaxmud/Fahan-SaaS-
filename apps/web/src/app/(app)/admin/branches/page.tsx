'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { canDo, useMe } from '@/lib/session';
import { Card, ErrorNote, Field, PageHeader, Pill, Tabs, fieldErrors, statusTone, useAction } from '@/components/ui';
import { HospitalSettings } from '@/components/HospitalSettings';
import { FacilitiesSetup } from '@/components/Facilities';

interface Branch {
  id: string;
  code: string;
  name: string;
  timezone: string;
  status: string;
}
interface Department {
  id: string;
  branchId: string;
  code: string;
  name: string;
  status: string;
}

export default function BranchesPage() {
  const { me } = useMe();
  const { t } = useLang();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [depts, setDepts] = useState<Department[]>([]);
  const [b, setB] = useState({ code: '', name: '', timezone: 'Africa/Mogadishu' });
  const [d, setD] = useState({ branchId: '', code: '', name: '' });
  const load = useAction();
  const addB = useAction();
  const addD = useAction();
  const canEdit = canDo(me, 'org', 'E');
  const [tab, setTab] = useState<'branches' | 'facilities' | 'profile' | 'modules'>('branches');

  const refresh = useCallback(async () => {
    await load.run(async () => {
      const [bs, ds] = await Promise.all([api<Branch[]>('/branches'), api<Department[]>('/departments')]);
      setBranches(bs);
      setDepts(ds);
      setD((x) => ({ ...x, branchId: x.branchId || bs[0]?.id || '' }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const feB = fieldErrors(addB.error);
  const feD = fieldErrors(addD.error);

  return (
    <>
      <PageHeader title={t('Hospital setup', 'Habaynta isbitaalka')}>
        {t('Branches, departments, hospital profile and the modules in use.', 'Laamaha, waaxaha, xogta isbitaalka iyo qaybaha la isticmaalo.')}
      </PageHeader>
      <Tabs<'branches' | 'facilities' | 'profile' | 'modules'>
        value={tab}
        onChange={setTab}
        items={[
          { id: 'branches', label: t('Branches & departments', 'Laamaha & waaxaha') },
          { id: 'facilities', label: t('Theatres & ambulances', 'Qalliinka & ambalaasyada') },
          { id: 'profile', label: t('Profile', 'Xogta') },
          { id: 'modules', label: t('Modules', 'Qaybaha') },
        ]}
      />
      <ErrorNote error={load.error} />
      {tab === 'facilities' ? <FacilitiesSetup /> : null}
      {tab === 'profile' || tab === 'modules' ? <HospitalSettings tab={tab} /> : null}
      <div className={`grid items-start gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] ${tab === 'branches' ? '' : 'hidden'}`}>
        <div className="grid gap-4">
          <Card title={t('Branches', 'Laamaha')}>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr>
                    <th className="th">Code</th>
                    <th className="th">{t('Name', 'Magaca')}</th>
                    <th className="th">{t('Timezone', 'Waqtiga')}</th>
                    <th className="th">{t('Departments', 'Waaxaha')}</th>
                    <th className="th">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {branches.map((x) => (
                    <tr key={x.id}>
                      <td className="td font-mono font-semibold">{x.code}</td>
                      <td className="td">{x.name}</td>
                      <td className="td text-ink-2">{x.timezone}</td>
                      <td className="td">
                        <div className="flex flex-wrap gap-1">
                          {depts
                            .filter((y) => y.branchId === x.id)
                            .map((y) => (
                              <span key={y.id} className="rounded-md border border-line bg-surface-2 px-1.5 font-mono text-[11.5px]" title={y.name}>
                                {y.code}
                              </span>
                            ))}
                        </div>
                      </td>
                      <td className="td">
                        <Pill tone={statusTone(x.status)}>{x.status}</Pill>
                      </td>
                    </tr>
                  ))}
                  {!branches.length && !load.busy ? (
                    <tr>
                      <td className="td text-ink-3" colSpan={5}>
                        {t('No branches yet. Add the first one to start registering staff and patients.', 'Weli laan ma jirto.')}
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
        {canEdit ? (
          <div className="grid gap-4">
            <Card title={t('Add branch', 'Ku dar laan')}>
              <form
                className="grid gap-3 px-4 pb-4"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (await addB.run(() => api('/branches', { body: b }))) {
                    setB({ code: '', name: '', timezone: b.timezone });
                    await refresh();
                  }
                }}
              >
                <Field label="Code" error={feB.code}>
                  <input className="input font-mono uppercase" value={b.code} onChange={(e) => setB({ ...b, code: e.target.value })} placeholder="MGD" required />
                </Field>
                <Field label={t('Name', 'Magaca')} error={feB.name}>
                  <input className="input" value={b.name} onChange={(e) => setB({ ...b, name: e.target.value })} placeholder="Mogadishu Central" required />
                </Field>
                <Field label={t('Timezone', 'Waqtiga')} error={feB.timezone}>
                  <input className="input" value={b.timezone} onChange={(e) => setB({ ...b, timezone: e.target.value })} />
                </Field>
                {Object.keys(feB).length ? null : <ErrorNote error={addB.error} />}
                <button className="btn btn-primary justify-self-start" disabled={addB.busy}>
                  <Plus size={16} />
                  {t('Add branch', 'Ku dar laan')}
                </button>
              </form>
            </Card>
            {branches.length ? (
              <Card title={t('Add department', 'Ku dar waax')}>
                <form
                  className="grid gap-3 px-4 pb-4"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (await addD.run(() => api('/departments', { body: d }))) {
                      setD({ ...d, code: '', name: '' });
                      await refresh();
                    }
                  }}
                >
                  <Field label={t('Branch', 'Laanta')}>
                    <select className="input" value={d.branchId} onChange={(e) => setD({ ...d, branchId: e.target.value })}>
                      {branches.map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.code} · {x.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Code" error={feD.code}>
                    <input className="input font-mono uppercase" value={d.code} onChange={(e) => setD({ ...d, code: e.target.value })} placeholder="RAD" required />
                  </Field>
                  <Field label={t('Name', 'Magaca')} error={feD.name}>
                    <input className="input" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="Radiology" required />
                  </Field>
                  {Object.keys(feD).length ? null : <ErrorNote error={addD.error} />}
                  <button className="btn btn-primary justify-self-start" disabled={addD.busy}>
                    <Plus size={16} />
                    {t('Add department', 'Ku dar waax')}
                  </button>
                </form>
              </Card>
            ) : null}
          </div>
        ) : null}
      </div>
    </>
  );
}
