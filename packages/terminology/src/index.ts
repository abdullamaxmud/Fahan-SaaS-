/**
 * Clinical terminology shared by API and web (spec §12.1 terminology, §4.1 units/provenance).
 * The ICD-11 list is a starter pick-list only; any well-formed ICD-11 code is accepted.
 * Licensed WHO ICD API integration and catalog versioning arrive with Phase 4 integrations.
 */

export interface VitalDef {
  code: string;
  name: string;
  so: string;
  unit: string;
  min: number;
  max: number;
  decimals: number;
}

/** Plausibility ranges reject typing errors, not clinical abnormality — abnormal values are allowed. */
export const VITALS: readonly VitalDef[] = [
  { code: 'bp-systolic', name: 'Systolic blood pressure', so: 'Cadaadiska sare', unit: 'mmHg', min: 40, max: 300, decimals: 0 },
  { code: 'bp-diastolic', name: 'Diastolic blood pressure', so: 'Cadaadiska hoose', unit: 'mmHg', min: 20, max: 200, decimals: 0 },
  { code: 'heart-rate', name: 'Heart rate', so: 'Garaaca wadnaha', unit: 'bpm', min: 20, max: 300, decimals: 0 },
  { code: 'resp-rate', name: 'Respiratory rate', so: 'Neefsashada', unit: '/min', min: 4, max: 80, decimals: 0 },
  { code: 'temperature', name: 'Temperature', so: 'Heerkulka', unit: '°C', min: 30, max: 45, decimals: 1 },
  { code: 'spo2', name: 'Oxygen saturation', so: 'Ogsijiinta', unit: '%', min: 50, max: 100, decimals: 0 },
  { code: 'weight', name: 'Weight', so: 'Miisaanka', unit: 'kg', min: 0.3, max: 400, decimals: 1 },
  { code: 'height', name: 'Height', so: 'Dhererka', unit: 'cm', min: 20, max: 250, decimals: 0 },
];
export const VITAL_BY_CODE: Record<string, VitalDef> = Object.fromEntries(VITALS.map((v) => [v.code, v]));

export interface IcdEntry {
  code: string;
  display: string;
}

export const ICD11_RELEASE = 'ICD-11 MMS (starter list)';

export const ICD11_COMMON: readonly IcdEntry[] = [
  { code: '1F40', display: 'Malaria due to Plasmodium falciparum' },
  { code: '1B10', display: 'Tuberculosis of the respiratory system' },
  { code: 'BA00', display: 'Essential hypertension' },
  { code: '5A10', display: 'Type 1 diabetes mellitus' },
  { code: '5A11', display: 'Type 2 diabetes mellitus' },
  { code: 'CA40', display: 'Pneumonia' },
  { code: 'CA23', display: 'Asthma' },
];

/** ICD-11 MMS stem code shape, e.g. 1F40, BA00, CA40.0 (post-coordination is not accepted yet). */
export function isIcd11Code(code: string): boolean {
  return /^[0-9A-HJ-NP-Z][A-HJ-NP-Z][0-9][0-9A-HJ-NP-Z](\.[0-9A-HJ-NP-Z]{1,2})?$/.test(code);
}

export function searchIcd(q: string): IcdEntry[] {
  const s = q.trim().toLowerCase();
  if (!s) return [...ICD11_COMMON];
  return ICD11_COMMON.filter((e) => e.code.toLowerCase().startsWith(s) || e.display.toLowerCase().includes(s));
}

/**
 * Folding key for duplicate detection across common Somali transliteration variants
 * (Xasan/Hasan, Maxamed/Mohamed, Cali/Ali, Faadumo/Fadumo). Not used for display.
 */
export function nameKey(name: string): string {
  let s = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  s = s
    .replace(/^c(?=[aeiou])/, '') // Cali → ali (ayn)
    .replace(/x/g, 'h')
    .replace(/q/g, 'k')
    .replace(/dh/g, 'd')
    .replace(/kh/g, 'k')
    .replace(/sh/g, 's');
  // Consonant skeleton: vowels are where transliterations disagree most (Maxamed / Mohamed).
  s = (s[0] ?? '') + s.slice(1).replace(/[aeiouy]/g, '');
  return s.replace(/(.)\1+/g, '$1');
}

export const nameKeys = (...parts: (string | undefined)[]): string[] =>
  [...new Set(parts.filter(Boolean).flatMap((p) => p!.split(/\s+/)).map(nameKey).filter((k) => k.length > 1))];
