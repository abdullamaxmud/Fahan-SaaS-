/**
 * A focused FHIR R4 conformance check for the resources this facade produces (spec §12.2 "conformance tests").
 * It checks cardinality of required elements, value sets of status codes, invariants we rely on (con-5, app-3),
 * id / dateTime / reference formats, absolute code systems, and FHIR's rule that no element may be empty.
 * It is not a replacement for the official validator; partners should still run theirs against our CapabilityStatement.
 */
type Json = Record<string, unknown>;

const ID = /^[A-Za-z0-9\-.]{1,64}$/;
const DATE = /^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/;
const DATETIME = /^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01])(T([01]\d|2[0-3]):[0-5]\d:([0-5]\d|60)(\.\d{1,9})?(Z|[+-]((0\d|1[0-3]):[0-5]\d|14:00)))?)?)?$/;
const REF = /^(Patient|Encounter|Practitioner|Observation|DiagnosticReport|ServiceRequest|MedicationRequest|Appointment|Condition)\/[A-Za-z0-9\-.]{1,64}$/;
const URI = /^(https?:\/\/\S+|urn:\S+)$/;

const STATUS: Record<string, string[]> = {
  Encounter: ['planned', 'arrived', 'triaged', 'in-progress', 'onleave', 'finished', 'cancelled', 'entered-in-error', 'unknown'],
  Observation: ['registered', 'preliminary', 'final', 'amended', 'corrected', 'cancelled', 'entered-in-error', 'unknown'],
  DiagnosticReport: ['registered', 'partial', 'preliminary', 'final', 'amended', 'corrected', 'appended', 'cancelled', 'entered-in-error', 'unknown'],
  ServiceRequest: ['draft', 'active', 'on-hold', 'revoked', 'completed', 'entered-in-error', 'unknown'],
  MedicationRequest: ['active', 'on-hold', 'cancelled', 'completed', 'entered-in-error', 'stopped', 'draft', 'unknown'],
  Appointment: ['proposed', 'pending', 'booked', 'arrived', 'fulfilled', 'cancelled', 'noshow', 'entered-in-error', 'checked-in', 'waitlist'],
};

export function validateResource(r: Json): string[] {
  const errs: string[] = [];
  const t = r.resourceType as string;
  const need = (path: string, v: unknown) => {
    if (v === undefined) errs.push(`${t}.${path} is required`);
  };
  const reference = (path: string, v: unknown, required = true) => {
    if (v === undefined) return required ? errs.push(`${t}.${path} is required`) : undefined;
    const s = (v as Json).reference;
    if (typeof s !== 'string' || !REF.test(s)) errs.push(`${t}.${path}.reference "${String(s)}" is not a valid literal reference`);
  };
  const codeable = (path: string, v: unknown, required = true) => {
    if (v === undefined) return required ? errs.push(`${t}.${path} is required`) : undefined;
    const c = v as { coding?: Json[]; text?: string };
    if (!c.coding?.length && !c.text) errs.push(`${t}.${path} needs a coding or text`);
    for (const [i, cd] of (c.coding ?? []).entries()) {
      if (typeof cd.system !== 'string' || !URI.test(cd.system)) errs.push(`${t}.${path}.coding[${i}].system must be an absolute URI`);
      if (typeof cd.code !== 'string' || !cd.code) errs.push(`${t}.${path}.coding[${i}].code is required`);
    }
  };
  const dt = (path: string, v: unknown, required = false) => {
    if (v === undefined) return required ? errs.push(`${t}.${path} is required`) : undefined;
    if (typeof v !== 'string' || !DATETIME.test(v)) errs.push(`${t}.${path} "${String(v)}" is not a FHIR dateTime`);
  };
  const status = () => {
    need('status', r.status);
    if (STATUS[t] && !STATUS[t]!.includes(r.status as string)) errs.push(`${t}.status "${String(r.status)}" is not in the R4 value set`);
  };

  if (typeof r.id !== 'string' || !ID.test(r.id)) errs.push(`${t}.id "${String(r.id)}" is not a valid FHIR id`);
  noEmpty(r, t, errs);

  switch (t) {
    case 'Patient':
      if (r.gender !== undefined && !['male', 'female', 'other', 'unknown'].includes(r.gender as string)) errs.push('Patient.gender is not in the value set');
      if (r.birthDate !== undefined && !DATE.test(r.birthDate as string)) errs.push('Patient.birthDate is not a FHIR date');
      for (const id of (r.identifier as Json[]) ?? []) if (!URI.test(String(id.system)) || !id.value) errs.push('Patient.identifier needs an absolute system and a value');
      for (const l of (r.link as Json[]) ?? []) reference('link.other', l.other);
      break;
    case 'Encounter':
      status();
      need('class', r.class);
      if (r.class && (!URI.test(String((r.class as Json).system)) || !(r.class as Json).code)) errs.push('Encounter.class needs system and code');
      reference('subject', r.subject, false);
      dt('period.start', (r.period as Json | undefined)?.start);
      dt('period.end', (r.period as Json | undefined)?.end);
      break;
    case 'Condition': {
      reference('subject', r.subject);
      codeable('code', r.code, false);
      codeable('verificationStatus', r.verificationStatus, false);
      const ver = ((r.verificationStatus as Json | undefined)?.coding as Json[] | undefined)?.[0]?.code;
      if (ver && !['unconfirmed', 'provisional', 'differential', 'confirmed', 'refuted', 'entered-in-error'].includes(ver as string)) errs.push('Condition.verificationStatus is not in the value set');
      if (ver === 'refuted' && r.clinicalStatus !== undefined) errs.push('Condition con-5: a refuted condition must not have a clinicalStatus');
      dt('recordedDate', r.recordedDate);
      break;
    }
    case 'Observation': {
      status();
      codeable('code', r.code);
      reference('subject', r.subject, false);
      const values = Object.keys(r).filter((k) => k.startsWith('value'));
      if (values.length > 1) errs.push('Observation has more than one value[x]');
      dt('effectiveDateTime', r.effectiveDateTime);
      dt('issued', r.issued);
      break;
    }
    case 'DiagnosticReport':
      status();
      codeable('code', r.code);
      reference('subject', r.subject, false);
      for (const [i, x] of ((r.result as Json[]) ?? []).entries()) reference(`result[${i}]`, x);
      dt('issued', r.issued);
      break;
    case 'ServiceRequest':
      status();
      need('intent', r.intent);
      reference('subject', r.subject);
      if (r.priority !== undefined && !['routine', 'urgent', 'asap', 'stat'].includes(r.priority as string)) errs.push('ServiceRequest.priority is not in the value set');
      dt('authoredOn', r.authoredOn);
      break;
    case 'MedicationRequest':
      status();
      need('intent', r.intent);
      if (r.medicationCodeableConcept === undefined && r.medicationReference === undefined) errs.push('MedicationRequest.medication[x] is required');
      reference('subject', r.subject);
      dt('authoredOn', r.authoredOn);
      break;
    case 'Appointment': {
      status();
      const parts = (r.participant as Json[]) ?? [];
      if (!parts.length) errs.push('Appointment.participant is required (1..*)');
      for (const [i, p] of parts.entries()) {
        if (!['accepted', 'declined', 'tentative', 'needs-action'].includes(p.status as string)) errs.push(`Appointment.participant[${i}].status is required`);
        reference(`participant[${i}].actor`, p.actor, false);
      }
      if ((r.start === undefined) !== (r.end === undefined)) errs.push('Appointment app-3: start and end go together');
      dt('start', r.start);
      dt('end', r.end);
      if (r.start && r.end && new Date(r.end as string) <= new Date(r.start as string)) errs.push('Appointment.end must be after start');
      break;
    }
    case 'Practitioner':
      break;
    default:
      errs.push(`Unsupported resourceType ${t}`);
  }
  return errs;
}

/** FHIR: elements are never present but empty (no null, "", [] or {}). */
function noEmpty(v: unknown, path: string, errs: string[]) {
  if (v === null || v === '') errs.push(`${path} is empty`);
  else if (Array.isArray(v)) {
    if (!v.length) errs.push(`${path} is an empty array`);
    v.forEach((x, i) => noEmpty(x, `${path}[${i}]`, errs));
  } else if (typeof v === 'object') {
    const keys = Object.keys(v as object).filter((k) => (v as Json)[k] !== undefined);
    if (!keys.length) errs.push(`${path} is an empty object`);
    for (const k of keys) noEmpty((v as Json)[k], `${path}.${k}`, errs);
  }
}

export function validateBundle(b: Json): string[] {
  const errs: string[] = [];
  if (b.resourceType !== 'Bundle') return ['not a Bundle'];
  if (b.type !== 'searchset') errs.push('Bundle.type must be searchset');
  if (typeof b.total !== 'number') errs.push('Bundle.total is required for a searchset');
  for (const [i, e] of ((b.entry as Json[]) ?? []).entries()) {
    const res = e.resource as Json;
    if (typeof e.fullUrl !== 'string' || !e.fullUrl.endsWith(`/${res.resourceType}/${res.id}`)) errs.push(`Bundle.entry[${i}].fullUrl does not match the resource`);
    errs.push(...validateResource(res).map((m) => `entry[${i}]: ${m}`));
  }
  return errs;
}
