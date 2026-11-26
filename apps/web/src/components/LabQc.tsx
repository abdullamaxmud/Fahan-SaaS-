'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { Card, ErrorNote, Field, useAction } from './ui';

interface TestDef {
  id: string;
  code: string;
  name?: string;
  analytes: { code: string; name: string; unit?: string; kind?: string }[];
}

/** Daily quality control: a control result outside 2 SD warns, outside 3 SD fails and blocks verification for that test. */
export function LabQc({ tests }: { tests: TestDef[] }) {
  const { t } = useLang();
  const numeric = tests.filter((x) => x.analytes.some((a) => a.kind !== 'text'));
  const [f, setF] = useState({ testId: numeric[0]?.id ?? '', analyteCode: numeric[0]?.analytes[0]?.code ?? '', level: 'L1', value: '', mean: '', sd: '' });
  const [result, setResult] = useState<{ outcome: string; z: number } | null>(null);
  const act = useAction();
  const test = numeric.find((x) => x.id === f.testId);
  if (!numeric.length) return null;
  return (
    <Card title={t('Quality control', 'Hubinta tayada (QC)')}>
      <form
        className="grid gap-2 px-4 pb-4"
        onSubmit={async (e) => {
          e.preventDefault();
          const r = await act.run(() => api<{ outcome: string; z: number }>('/lab/qc', { body: { testId: f.testId, analyteCode: f.analyteCode, level: f.level, value: Number(f.value), mean: Number(f.mean), sd: Number(f.sd) } }));
          if (r) setResult(r);
        }}
      >
        <div className="grid gap-2 sm:grid-cols-3">
          <Field label={t('Test', 'Baaritaanka')}>
            <select className="input h-9" value={f.testId} onChange={(e) => { const x = numeric.find((y) => y.id === e.target.value); setF({ ...f, testId: e.target.value, analyteCode: x?.analytes[0]?.code ?? '' }); }}>
              {numeric.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.code}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('Analyte', 'Walaxda')}>
            <select className="input h-9" value={f.analyteCode} onChange={(e) => setF({ ...f, analyteCode: e.target.value })}>
              {test?.analytes.filter((a) => a.kind !== 'text').map((a) => (
                <option key={a.code} value={a.code}>
                  {a.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('Control level', 'Heerka')}>
            <select className="input h-9" value={f.level} onChange={(e) => setF({ ...f, level: e.target.value })}>
              <option>L1</option>
              <option>L2</option>
              <option>L3</option>
            </select>
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Field label={t('Result', 'Natiijada')}>
            <input className="input h-9" inputMode="decimal" required value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} />
          </Field>
          <Field label={t('Target mean', 'Celceliska')}>
            <input className="input h-9" inputMode="decimal" required value={f.mean} onChange={(e) => setF({ ...f, mean: e.target.value })} />
          </Field>
          <Field label="SD">
            <input className="input h-9" inputMode="decimal" required value={f.sd} onChange={(e) => setF({ ...f, sd: e.target.value })} />
          </Field>
        </div>
        <ErrorNote error={act.error} />
        <button className="btn justify-self-start" disabled={act.busy}>
          {t('Record control', 'Kaydi')}
        </button>
        {result ? (
          <p className={`rounded-lg px-3 py-2 text-[13px] ${result.outcome === 'pass' ? 'bg-ok-soft text-ok' : result.outcome === 'warn' ? 'bg-warn-soft text-warn' : 'bg-crit-soft text-crit'}`}>
            {result.outcome === 'pass'
              ? t(`In control (z = ${result.z}).`, `Waa sax (z = ${result.z}).`)
              : result.outcome === 'warn'
                ? t(`Warning: outside 2 SD (z = ${result.z}). Watch the next run.`, `Digniin: z = ${result.z}.`)
                : t(`Failed (z = ${result.z}). Results for this test cannot be verified until a control passes.`, `Wuu fashilmay (z = ${result.z}). Natiijooyinka lama xaqiijin karo ilaa QC uu gudbo.`)}
          </p>
        ) : null}
      </form>
    </Card>
  );
}
