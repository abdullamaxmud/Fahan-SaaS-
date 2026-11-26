'use client';

import { useLang } from '@/lib/i18n';
import { Field } from './ui';

export type FieldDef =
  | { type: 'text' | 'longtext'; key: string; label: string; labelSo?: string; required: boolean; maxLength: number }
  | { type: 'number'; key: string; label: string; labelSo?: string; required: boolean; min?: number; max?: number; integer: boolean }
  | { type: 'date' | 'checkbox'; key: string; label: string; labelSo?: string; required: boolean }
  | { type: 'select'; key: string; label: string; labelSo?: string; required: boolean; options: string[] };

export interface FormDef { id: string; key: string; version: number; name: string; module: string; highRisk: boolean; fields: FieldDef[]; approval: { module: string; level: string } | null; status: string; safetySignoff: { byName: string } | null; history: { at: string; action: string; byName: string; note: string | null }[] }

/** Turns raw input strings into typed answers; empty answers are left out (the server decides what is required). */
export function typedAnswers(fields: FieldDef[], raw: Record<string, string | boolean>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = raw[f.key];
    if (f.type === 'checkbox') {
      if (v === true) out[f.key] = true;
      continue;
    }
    if (v === undefined || v === '') continue;
    out[f.key] = f.type === 'number' ? Number(v) : v;
  }
  return out;
}

/** Draws any form version from its field definitions. No code runs; it is a fixed set of inputs. */
export function FormFields({ fields, values, onChange, errors }: { fields: FieldDef[]; values: Record<string, string | boolean>; onChange: (v: Record<string, string | boolean>) => void; errors?: Record<string, string> }) {
  const { lang } = useLang();
  const set = (k: string, v: string | boolean) => onChange({ ...values, [k]: v });
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {fields.map((f) => {
        const label = `${(lang === 'so' && f.labelSo) || f.label}${f.required ? ' *' : ''}`;
        const v = values[f.key];
        if (f.type === 'checkbox') {
          return (
            <label key={f.key} className="flex items-center gap-2 text-[13px] sm:col-span-2">
              <input type="checkbox" checked={v === true} onChange={(e) => set(f.key, e.target.checked)} />
              {label}
              {errors?.[f.key] ? <span className="text-[12px] text-crit">{errors[f.key]}</span> : null}
            </label>
          );
        }
        return (
          <div key={f.key} className={f.type === 'longtext' ? 'sm:col-span-2' : ''}>
            <Field label={label} error={errors?.[f.key]}>
              {f.type === 'select' ? (
                <select className="input h-9" value={(v as string) ?? ''} onChange={(e) => set(f.key, e.target.value)}>
                  <option value="">—</option>
                  {f.options.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
              ) : f.type === 'longtext' ? (
                <textarea className="input min-h-[80px] py-2" maxLength={f.maxLength} value={(v as string) ?? ''} onChange={(e) => set(f.key, e.target.value)} />
              ) : (
                <input
                  className="input h-9"
                  type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}
                  min={f.type === 'number' ? f.min : undefined}
                  max={f.type === 'number' ? f.max : undefined}
                  maxLength={f.type === 'text' ? f.maxLength : undefined}
                  value={(v as string) ?? ''}
                  onChange={(e) => set(f.key, e.target.value)}
                />
              )}
            </Field>
          </div>
        );
      })}
    </div>
  );
}
