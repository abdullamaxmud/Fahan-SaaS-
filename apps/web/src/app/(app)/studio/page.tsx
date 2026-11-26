'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CopyPlus, FlaskConical, Plus, Rocket, ShieldCheck, Stamp, Trash2 } from 'lucide-react';
import { MODULES } from '@fahan/policy';
import { api } from '@/lib/api';
import { useLang } from '@/lib/i18n';
import { canDo, useMe } from '@/lib/session';
import { useReauth } from '@/components/Reauth';
import { Card, ErrorNote, Field, PageHeader, Pill, fieldErrors, useAction } from '@/components/ui';
import { FormFields, typedAnswers, type FieldDef, type FormDef } from '@/components/forms';
import { statusTone } from '@/components/intel';

type Draft = { key: string; name: string; module: string; highRisk: boolean; approval: string; fields: (FieldDef & { optionsText?: string })[] };
const TYPES = ['text', 'longtext', 'number', 'date', 'checkbox', 'select'] as const;
const blankField = (): Draft['fields'][number] => ({ type: 'text', key: '', label: '', required: false, maxLength: 200 });

function toPayload(d: Draft) {
  const [m, l] = d.approval ? d.approval.split(':') : [];
  return {
    name: d.name,
    module: d.module,
    highRisk: d.highRisk,
    approval: m ? { module: m, level: l } : null,
    fields: d.fields.map(({ optionsText, ...f }) => (f.type === 'select' ? { ...f, options: (optionsText ?? '').split(',').map((s) => s.trim()).filter(Boolean) } : f)),
  };
}

export default function StudioPage() {
  const { me } = useMe();
  const { t, lang } = useLang();
  const { guarded, dialog } = useReauth();
  const [forms, setForms] = useState<FormDef[]>([]);
  const [sel, setSel] = useState<FormDef | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [sample, setSample] = useState<Record<string, string | boolean>>({});
  const load = useAction();
  const act = useAction();
  const designer = canDo(me, 'studio', 'E');
  const approver = canDo(me, 'studio', 'A');
  const safety = canDo(me, 'qual', 'A');

  const refresh = useCallback(async () => {
    await load.run(async () => setForms(await api<FormDef[]>('/studio/forms')));
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const byKey = useMemo(() => {
    const m = new Map<string, FormDef[]>();
    for (const f of forms) m.set(f.key, [...(m.get(f.key) ?? []), f]);
    return [...m.entries()];
  }, [forms]);

  const pick = (f: FormDef) => {
    setSel(f);
    setSample({});
    setDraft(
      ['Draft', 'Tested'].includes(f.status)
        ? { key: f.key, name: f.name, module: f.module, highRisk: f.highRisk, approval: f.approval ? `${f.approval.module}:${f.approval.level}` : '', fields: f.fields.map((x) => (x.type === 'select' ? { ...x, optionsText: x.options.join(', ') } : x)) }
        : null,
    );
  };
  const run = async (fn: () => Promise<unknown>) => {
    const out = await act.run(fn);
    if (out !== undefined) {
      const list = await api<FormDef[]>('/studio/forms');
      setForms(list);
      const again = list.find((x) => x.id === (out as { id?: string }).id) ?? list.find((x) => x.id === sel?.id);
      if (again) pick(again);
    }
    return out;
  };
  const fe = fieldErrors(act.error);
  const setField = (i: number, patch: Partial<Draft['fields'][number]>) => draft && setDraft({ ...draft, fields: draft.fields.map((f, j) => (j === i ? ({ ...f, ...patch } as Draft['fields'][number]) : f)) });

  return (
    <>
      {dialog}
      <PageHeader title={t('Forms studio', 'Foomamka')}>
        {t('Build forms without code. Nothing goes live without approval.', 'Samee foomam koodh la’aan. Waxba ma shaqeeyaan ansixin la’aan.')}
      </PageHeader>
      <ErrorNote error={load.error ?? (Object.keys(fe).length ? null : act.error)} />
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,2fr)]">
        <Card
          title={t('Forms', 'Foomamka')}
          actions={
            designer ? (
              <button className="btn h-8" onClick={() => { setSel(null); setDraft({ key: '', name: '', module: 'nur', highRisk: false, approval: '', fields: [blankField()] }); }}>
                <Plus size={14} /> {t('New form', 'Foom cusub')}
              </button>
            ) : null
          }
        >
          <ul className="grid gap-2 px-4 pb-4 text-[13px]">
            {byKey.map(([key, versions]) => (
              <li key={key} className="rounded-[10px] border border-line p-2.5">
                <b>{versions[0]!.name}</b> <span className="font-mono text-[11px] text-ink-3">{key}</span>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {versions.map((v) => (
                    <button key={v.id} onClick={() => pick(v)} className={`rounded-full border px-2 py-0.5 text-[11.5px] ${sel?.id === v.id ? 'border-ink' : 'border-line'}`}>
                      v{v.version} · <span className={statusTone(v.status) === 'ok' ? 'text-ok' : statusTone(v.status) === 'crit' ? 'text-crit' : ''}>{v.status}</span>
                    </button>
                  ))}
                </div>
              </li>
            ))}
            {!byKey.length ? <li className="text-ink-3">{t('No forms yet.', 'Foom weli ma jiro.')}</li> : null}
          </ul>
        </Card>

        <div className="grid gap-4">
          {draft && designer ? (
            <Card title={sel ? `${t('Edit', 'Wax ka beddel')} ${sel.key} v${sel.version}` : t('New form', 'Foom cusub')}>
              <form
                className="grid gap-3 px-4 pb-4 text-[13px]"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(() => (sel ? api<FormDef>(`/studio/forms/${sel.id}`, { method: 'PUT', body: toPayload(draft) }) : api<FormDef>('/studio/forms', { body: { key: draft.key, ...toPayload(draft) } })));
                }}
              >
                <div className="grid gap-2 sm:grid-cols-2">
                  {!sel ? (
                    <Field label={t('Key (permanent)', 'Furaha')} error={fe.key}>
                      <input className="input h-9" required value={draft.key} onChange={(e) => setDraft({ ...draft, key: e.target.value })} placeholder="fall-risk" />
                    </Field>
                  ) : null}
                  <Field label={t('Name', 'Magaca')} error={fe.name}>
                    <input className="input h-9" required value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                  </Field>
                  <Field label={t('Who fills it in (module)', 'Cidda buuxisa')}>
                    <select className="input h-9" value={draft.module} onChange={(e) => setDraft({ ...draft, module: e.target.value })}>
                      {MODULES.map((m) => (
                        <option key={m.key} value={m.key}>
                          {lang === 'so' ? m.so : m.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t('Approval rule', 'Xeerka oggolaanshaha')}>
                    <select className="input h-9" value={draft.approval} onChange={(e) => setDraft({ ...draft, approval: e.target.value })}>
                      <option value="">{t('No approval needed', 'Oggolaansho looma baahna')}</option>
                      {['S', 'A'].map((l) => (
                        <option key={l} value={`${draft.module}:${l}`}>
                          {t(`Approved by ${l === 'S' ? 'a supervisor' : 'an administrator'} of this module`, l === 'S' ? 'Kormeere' : 'Maamule')}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <label className="flex items-center gap-2 sm:col-span-2">
                    <input type="checkbox" checked={draft.highRisk} onChange={(e) => setDraft({ ...draft, highRisk: e.target.checked })} />
                    {t('High-risk (clinical safety officer signs off)', 'Khatar sare')}
                  </label>
                </div>
                <b>{t('Fields', 'Meelaha')}</b>
                {draft.fields.map((f, i) => (
                  <div key={i} className="grid gap-2 rounded-[10px] border border-line p-2.5 sm:grid-cols-[110px_1fr_1fr_auto]">
                    <select className="input h-9" aria-label="Type" value={f.type} onChange={(e) => setField(i, { type: e.target.value as FieldDef['type'], ...(e.target.value === 'select' ? { optionsText: '' } : {}), ...(e.target.value === 'text' || e.target.value === 'longtext' ? { maxLength: e.target.value === 'text' ? 200 : 2000 } : {}), ...(e.target.value === 'number' ? { integer: false } : {}) })}>
                      {TYPES.map((x) => (
                        <option key={x}>{x}</option>
                      ))}
                    </select>
                    <input className="input h-9" placeholder={t('key, e.g. score', 'furaha')} value={f.key} onChange={(e) => setField(i, { key: e.target.value })} aria-label="Field key" />
                    <input className="input h-9" placeholder={t('Label', 'Calaamadda')} value={f.label} onChange={(e) => setField(i, { label: e.target.value })} aria-label="Label" />
                    <div className="flex items-center gap-2">
                      <label className="flex items-center gap-1 text-[12px]">
                        <input type="checkbox" checked={f.required} onChange={(e) => setField(i, { required: e.target.checked })} /> {t('required', 'qasab')}
                      </label>
                      <button type="button" className="btn h-8 px-2" aria-label="Remove field" disabled={draft.fields.length <= 1} onClick={() => setDraft({ ...draft, fields: draft.fields.filter((_, j) => j !== i) })}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                    {f.type === 'select' ? <input className="input h-9 sm:col-span-4" placeholder={t('Options, separated by commas', 'Doorashooyin')} value={f.optionsText ?? ''} onChange={(e) => setField(i, { optionsText: e.target.value })} /> : null}
                    {f.type === 'number' ? (
                      <div className="flex gap-2 sm:col-span-4">
                        <input className="input h-9 w-24" type="number" placeholder="min" value={f.min ?? ''} onChange={(e) => setField(i, { min: e.target.value === '' ? undefined : Number(e.target.value) })} />
                        <input className="input h-9 w-24" type="number" placeholder="max" value={f.max ?? ''} onChange={(e) => setField(i, { max: e.target.value === '' ? undefined : Number(e.target.value) })} />
                      </div>
                    ) : null}
                  </div>
                ))}
                <div className="flex flex-wrap gap-2">
                  <button type="button" className="btn h-8" onClick={() => setDraft({ ...draft, fields: [...draft.fields, blankField()] })}>
                    <Plus size={14} /> {t('Field', 'Meel')}
                  </button>
                  <button className="btn btn-primary ml-auto h-9">{t('Save draft', 'Kaydi')}</button>
                </div>
              </form>
            </Card>
          ) : null}

          {sel ? (
            <Card title={`${sel.name} · v${sel.version}`} actions={<Pill tone={statusTone(sel.status)}>{sel.status}</Pill>}>
              <div className="grid gap-3 px-4 pb-4 text-[13px]">
                <p className="text-ink-2">
                  {t('Filled in by', 'Waxaa buuxiya')} <b>{sel.module}</b> · {sel.approval ? `${t('approval', 'oggolaansho')} ${sel.approval.module}:${sel.approval.level}` : t('no approval step', 'oggolaansho ma leh')}
                  {sel.highRisk ? <> · <Pill tone="warn">{t('high-risk', 'khatar sare')}</Pill></> : null}
                  {sel.safetySignoff ? <> · {t('safety signed by', 'waxaa saxiixay')} {sel.safetySignoff.byName}</> : null}
                </p>
                <div className="rounded-[10px] bg-surface-2 p-3">
                  <b className="mb-2 block">{t('Preview / test with a sample', 'Tijaabi')}</b>
                  <FormFields fields={sel.fields} values={sample} onChange={setSample} errors={fe} />
                  {designer && ['Draft', 'Tested'].includes(sel.status) ? (
                    <button className="btn btn-primary mt-3 h-9" onClick={() => run(() => api(`/studio/forms/${sel.id}/test`, { body: { sample: typedAnswers(sel.fields, sample) } }).then(() => ({ id: sel.id })))}>
                      <FlaskConical size={15} /> {t('Run test', 'Tijaabi')}
                    </button>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  {safety && sel.highRisk && sel.status === 'Tested' && !sel.safetySignoff ? (
                    <button className="btn h-9" onClick={() => run(() => api(`/studio/forms/${sel.id}/safety-signoff`, { body: {} }).then(() => ({ id: sel.id })))}>
                      <ShieldCheck size={15} /> {t('Clinical safety sign-off', 'Saxiixa badbaadada')}
                    </button>
                  ) : null}
                  {approver && sel.status === 'Tested' ? (
                    <button className="btn btn-primary h-9" onClick={() => run(() => api(`/studio/forms/${sel.id}/approve`, { body: {} }).then(() => ({ id: sel.id })))}>
                      <Stamp size={15} /> {t('Approve', 'Oggolow')}
                    </button>
                  ) : null}
                  {approver && (sel.status === 'Approved' || sel.status === 'Retired') ? (
                    <button className="btn btn-primary h-9" onClick={() => run(() => guarded(() => api(`/studio/forms/${sel.id}/publish`, { body: {} })).then(() => ({ id: sel.id })))}>
                      <Rocket size={15} /> {sel.status === 'Retired' ? t('Roll back to this version', 'Ku celi noocan') : t('Publish', 'Daabac')}
                    </button>
                  ) : null}
                  {designer && ['Published', 'Retired', 'Approved'].includes(sel.status) ? (
                    <button className="btn h-9" onClick={() => run(() => api<FormDef>(`/studio/forms/${sel.id}/versions`, { body: {} }))}>
                      <CopyPlus size={15} /> {t('New version', 'Nooc cusub')}
                    </button>
                  ) : null}
                </div>
                <ol className="grid gap-1 border-t border-line pt-2 text-[12px] text-ink-2">
                  {sel.history.map((h, i) => (
                    <li key={i}>
                      {new Date(h.at).toLocaleString()} · <b>{h.action}</b> · {h.byName}
                      {h.note ? ` — ${h.note}` : ''}
                    </li>
                  ))}
                </ol>
              </div>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
