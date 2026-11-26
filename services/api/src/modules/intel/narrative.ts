import type { Document } from 'mongodb';
import { SUPPRESSION_THRESHOLD, metricDef } from './metrics';

/**
 * Spec §9.1 / §9.6 / §9.7. Calculation and language are separate: the metrics engine produces facts; a narrative
 * provider only words them. Templates are server-side and versioned. Every number in the text must be one of the
 * facts (checked in code), and every sentence cites the metric ids it uses.
 */
export interface Fact {
  id: string;
  label: string;
  value: number;
  unit: 'minor' | 'count' | 'percent' | 'minutes' | 'days';
  currency?: string;
}
export interface Sentence {
  text: string;
  cites: string[];
}
export interface Narrative {
  provider: string;
  template: string;
  sections: { heading: string; sentences: Sentence[] }[];
}
export interface NarrativeProvider {
  readonly name: string;
  write(kind: 'finance' | 'disease', ctx: { period: string; facts: Fact[]; identifiers: string[] }): Promise<Narrative>;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthName = (period: string) => `${MONTHS[Number(period.slice(5, 7)) - 1]} ${period.slice(0, 4)}`;

export function fmt(f: Fact): string {
  if (f.unit === 'minor') {
    const n = Math.abs(f.value) / 100;
    const sos = f.currency === 'SOS';
    return `${f.value < 0 ? '-' : ''}${sos ? 'Sh ' : '$'}${n.toLocaleString('en-US', { minimumFractionDigits: sos ? 0 : 2, maximumFractionDigits: sos ? 0 : 2 })}`;
  }
  if (f.unit === 'percent') return `${f.value.toLocaleString('en-US', { maximumFractionDigits: 1 })}%`;
  return f.value.toLocaleString('en-US', { maximumFractionDigits: 1 });
}

// ---------- facts from snapshots (calculation side) ----------

/** Turns a finance snapshot (and the previous month's, if any) into the facts the narrative may use. */
export function financeFacts(s: Document, prev: Document | null): Fact[] {
  const cur = (s.currency as string) ?? 'USD';
  const m = s.facts.metrics as Record<string, number>;
  const facts: Fact[] = Object.entries(m).map(([id, value]) => ({ id, label: metricDef(id)?.label ?? id, value, unit: 'minor', currency: cur }));
  const mix = [...(s.facts.revenueMix as { accountCode: string; name: string; amountMinor: number }[])].filter((x) => x.amountMinor > 0).sort((a, b) => b.amountMinor - a.amountMinor);
  const gross = mix.reduce((n, x) => n + x.amountMinor, 0);
  if (mix[0] && gross > 0) {
    facts.push({ id: `fin.mix.${mix[0].accountCode}`, label: mix[0].name, value: mix[0].amountMinor, unit: 'minor', currency: cur });
    facts.push({ id: `fin.mix.${mix[0].accountCode}.share`, label: `${mix[0].name} share of revenue before deductions`, value: Math.round((mix[0].amountMinor / gross) * 1000) / 10, unit: 'percent' });
  }
  const cash = m['fin.cashCollected'] ?? 0;
  const refunds = m['fin.refundsPaid'] ?? 0;
  if (cash + refunds > 0) facts.push({ id: 'fin.refundsPaid.shareOfCollections', label: 'Refunds as share of collections', value: Math.round((refunds / (cash + refunds)) * 1000) / 10, unit: 'percent' });
  if (prev) {
    const p = prev.facts.metrics as Record<string, number>;
    for (const id of ['fin.recognizedRevenue', 'fin.operatingExpenses', 'fin.cashCollected']) {
      facts.push({ id: `${id}.change`, label: `${metricDef(id)?.label} change vs ${prev.period}`, value: (m[id] ?? 0) - (p[id] ?? 0), unit: 'minor', currency: cur });
    }
  }
  return facts;
}

/** Disease facts carry only unsuppressed counts; suppressed cells never reach the narrative. */
export function diseaseFacts(s: Document): { facts: Fact[]; identifiers: string[] } {
  const facts: Fact[] = [];
  const identifiers: string[] = [];
  for (const r of s.facts.rows as Document[]) {
    identifiers.push(r.code);
    for (const k of ['confirmedPatients', 'confirmedEncounters', 'newPatients', 'suspectedPatients']) {
      if (typeof r[k] === 'number') facts.push({ id: `dis.${r.code}.${k}`, label: `${r.display} — ${metricDef(`dis.${k}`)?.label ?? k}`, value: r[k], unit: 'count' });
    }
  }
  facts.push({ id: 'dis.suppressedCells', label: 'Suppressed small groups', value: s.facts.suppressedCells as number, unit: 'count' });
  facts.push({ id: 'dis.suppressionThreshold', label: 'Suppression threshold', value: SUPPRESSION_THRESHOLD, unit: 'count' });
  return { facts, identifiers };
}

// ---------- the built-in provider: deterministic, offline, no data leaves the server ----------

const get = (facts: Fact[], id: string) => facts.find((f) => f.id === id);

export const templateProvider: NarrativeProvider = {
  name: 'fahan-template',
  async write(kind, { period, facts }) {
    const S = (text: string, cites: string[]): Sentence => ({ text, cites });
    const v = (id: string) => fmt(get(facts, id)!);
    if (kind === 'finance') {
      const sections: Narrative['sections'] = [];
      sections.push({
        heading: 'Result',
        sentences: [S(`In ${monthName(period)}, recognised revenue was ${v('fin.recognizedRevenue')} against operating expenses of ${v('fin.operatingExpenses')}, an operating result of ${v('fin.operatingResult')}.`, ['fin.recognizedRevenue', 'fin.operatingExpenses', 'fin.operatingResult'])],
      });
      sections.push({
        heading: 'Billing and cash',
        sentences: [
          S(`Gross billing was ${v('fin.grossBilled')}, or ${v('fin.netBilled')} after discounts; cash collected was ${v('fin.cashCollected')}.`, ['fin.grossBilled', 'fin.netBilled', 'fin.cashCollected']),
          S(`Patients and insurers owed ${v('fin.accountsReceivable')} at month end.`, ['fin.accountsReceivable']),
        ],
      });
      const top = facts.find((f) => /^fin\.mix\.\d{4}$/.test(f.id));
      if (top) sections.push({ heading: 'Revenue mix', sentences: [S(`The largest revenue line was ${top.label.toLowerCase()} at ${fmt(top)}, ${v(`${top.id}.share`)} of revenue before deductions.`, [top.id, `${top.id}.share`])] });
      const changes: Sentence[] = [];
      for (const id of ['fin.recognizedRevenue', 'fin.operatingExpenses', 'fin.cashCollected']) {
        const c = get(facts, `${id}.change`);
        if (c && c.value !== 0) changes.push(S(`${metricDef(id)!.label} ${c.value > 0 ? 'rose' : 'fell'} by ${fmt({ ...c, value: Math.abs(c.value) })} compared with the previous month.`, [`${id}.change`]));
      }
      if (changes.length) sections.push({ heading: 'Changes', sentences: changes });
      const rs = get(facts, 'fin.refundsPaid.shareOfCollections');
      if (rs && rs.value >= 10) sections.push({ heading: 'Watch', sentences: [S(`Refunds paid were ${v('fin.refundsPaid')}, ${fmt(rs)} of collections, which is above the watch level; review the refund reasons.`, ['fin.refundsPaid', 'fin.refundsPaid.shareOfCollections'])] });
      sections.push({ heading: 'Limits', sentences: [S('This summary was written by AI from the posted ledger snapshot only. It is not an audit opinion; the figures it cites are listed below it.', [])] });
      return { provider: this.name, template: 'finance-narrative-v1', sections };
    }
    const rows = facts.filter((f) => f.id.endsWith('.confirmedPatients') && f.value > 0).sort((a, b) => b.value - a.value || a.id.localeCompare(b.id));
    const sections: Narrative['sections'] = [];
    const top: Sentence[] = rows.slice(0, 3).map((f) => {
      const code = f.id.split('.')[1]!;
      const name = f.label.split(' — ')[0]!;
      const enc = get(facts, `dis.${code}.confirmedEncounters`);
      const fresh = get(facts, `dis.${code}.newPatients`);
      return S(
        `${name} (${code}) was confirmed in ${fmt(f)} patients${enc ? ` across ${fmt(enc)} visits` : ''}${fresh ? `, ${fmt(fresh)} of them newly diagnosed` : ''}.`,
        [f.id, ...(enc ? [enc.id] : []), ...(fresh ? [fresh.id] : [])],
      );
    });
    sections.push({ heading: 'Most frequent confirmed conditions', sentences: top.length ? top : [S(`No condition reached the reporting threshold in ${monthName(period)}.`, [])] });
    const susp = facts.filter((f) => f.id.endsWith('.suspectedPatients') && f.value > 0).sort((a, b) => b.value - a.value);
    if (susp.length) sections.push({ heading: 'Not yet confirmed', sentences: susp.slice(0, 3).map((f) => S(`${f.label.split(' — ')[0]} (${f.id.split('.')[1]}) is suspected but not confirmed in ${fmt(f)} patients; these are not counted above.`, [f.id])) });
    sections.push({
      heading: 'Limits',
      sentences: [
        S(`${v('dis.suppressedCells')} small groups are hidden because they have fewer than ${v('dis.suppressionThreshold')} patients.`, ['dis.suppressedCells', 'dis.suppressionThreshold']),
        S("These are counts within this hospital's own records, not population prevalence. This summary was written by AI and needs clinical review.", []),
      ],
    });
    return { provider: this.name, template: 'disease-narrative-v1', sections };
  },
};

/**
 * Programmatic check (spec §9.6 "check copied numbers"): every number in the text must be the formatted value of a
 * cited fact, the reporting month, or a known identifier such as an ICD-11 code. Returns the unsupported numbers.
 */
export function checkNarrative(n: Narrative, facts: Fact[], period: string, identifiers: string[]): { ok: boolean; unsupported: string[]; uncited: string[] } {
  const unsupported: string[] = [];
  const uncited: string[] = [];
  const known = (id: string) => facts.some((f) => f.id === id);
  const numbersOf = (s: string) => (s.match(/\d[\d,]*(\.\d+)?/g) ?? []).map((x) => x.replace(/,/g, ''));
  for (const sec of n.sections) {
    for (const s of sec.sentences) {
      for (const c of s.cites) if (!known(c)) uncited.push(c);
      let text = s.text.replace(monthName(period), ' ');
      for (const idf of identifiers) text = text.split(idf).join(' ');
      const allowed = new Set(s.cites.filter(known).flatMap((c) => numbersOf(fmt(facts.find((f) => f.id === c)!))));
      // Absolute values are allowed for change facts ("rose by $5"), which are worded without a sign.
      for (const num of numbersOf(text)) if (!allowed.has(num)) unsupported.push(`${num} in "${s.text}"`);
    }
  }
  return { ok: !unsupported.length && !uncited.length, unsupported, uncited };
}
