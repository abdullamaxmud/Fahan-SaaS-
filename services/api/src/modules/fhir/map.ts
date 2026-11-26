import type { Document, ObjectId } from 'mongodb';

/**
 * FHIR R4 (4.0.1) mappings, spec §12.1. Read-only. Codes use published systems where one exists (ICD-11 MMS, LOINC,
 * UCUM, HL7 terminology); hospital-local codes use a `urn:fahan:` system so receivers know they are local.
 */
export const FHIR_VERSION = '4.0.1';
export const SYS = {
  icd11: 'http://id.who.int/icd/release/11/mms',
  loinc: 'http://loinc.org',
  ucum: 'http://unitsofmeasure.org',
  actCode: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
  obsCategory: 'http://terminology.hl7.org/CodeSystem/observation-category',
  conditionClinical: 'http://terminology.hl7.org/CodeSystem/condition-clinical',
  conditionVer: 'http://terminology.hl7.org/CodeSystem/condition-ver-status',
  interpretation: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation',
  diagService: 'http://terminology.hl7.org/CodeSystem/v2-0074',
  labTest: 'urn:fahan:lab-test',
  labAnalyte: 'urn:fahan:lab-analyte',
  imaging: 'urn:fahan:imaging-modality',
};
export const mrnSystem = (tenantSlug: string) => `urn:fahan:${tenantSlug}:mrn`;

const hex = (x: unknown) => (x as ObjectId).toHexString();
const iso = (d: unknown) => (d ? new Date(d as Date).toISOString() : undefined);
const ref = (type: string, id: unknown) => ({ reference: `${type}/${typeof id === 'string' ? id : hex(id)}` });

// Vital signs: our codes → LOINC + UCUM (FHIR vital-signs profile codes).
export const VITAL_LOINC: Record<string, { code: string; display: string; ucum: string }> = {
  'bp-systolic': { code: '8480-6', display: 'Systolic blood pressure', ucum: 'mm[Hg]' },
  'bp-diastolic': { code: '8462-4', display: 'Diastolic blood pressure', ucum: 'mm[Hg]' },
  'heart-rate': { code: '8867-4', display: 'Heart rate', ucum: '/min' },
  'resp-rate': { code: '9279-1', display: 'Respiratory rate', ucum: '/min' },
  temperature: { code: '8310-5', display: 'Body temperature', ucum: 'Cel' },
  spo2: { code: '59408-5', display: 'Oxygen saturation in Arterial blood by Pulse oximetry', ucum: '%' },
  weight: { code: '29463-7', display: 'Body weight', ucum: 'kg' },
  height: { code: '8302-2', display: 'Body height', ucum: 'cm' },
};

export function patient(p: Document, tenantSlug: string) {
  const n = p.names ?? {};
  return {
    resourceType: 'Patient',
    id: hex(p._id),
    meta: { lastUpdated: iso(p.updatedAt ?? p.createdAt) },
    identifier: [{ use: 'usual', system: mrnSystem(tenantSlug), value: p.mrn }],
    active: p.status !== 'Merged',
    name: [{ use: 'official', family: n.family, given: [n.given, n.middle].filter(Boolean) }],
    gender: p.sexAtBirth === 'male' ? 'male' : p.sexAtBirth === 'female' ? 'female' : 'unknown',
    birthDate: p.dob,
    // Data minimisation (spec §11.1): no phone, address or national id unless an agreement needs them.
    ...(p.mergedInto ? { link: [{ other: ref('Patient', p.mergedInto), type: 'replaced-by' }] } : {}),
  };
}

export function encounter(e: Document) {
  const cls = e.type === 'ER' ? { code: 'EMER', display: 'emergency' } : e.type === 'IP' ? { code: 'IMP', display: 'inpatient encounter' } : { code: 'AMB', display: 'ambulatory' };
  return {
    resourceType: 'Encounter',
    id: hex(e._id),
    status: e.status === 'Closed' || e.endedAt ? 'finished' : 'in-progress',
    class: { system: SYS.actCode, ...cls },
    subject: ref('Patient', e.patientId),
    participant: ((e.clinicianIds as ObjectId[]) ?? []).map((c) => ({ individual: ref('Practitioner', c) })),
    period: { start: iso(e.startedAt), ...(e.endedAt ? { end: iso(e.endedAt) } : {}) },
    ...(e.reason ? { reasonCode: [{ text: e.reason }] } : {}),
  };
}

export function condition(d: Document) {
  const ver = d.certainty === 'confirmed' ? 'confirmed' : d.certainty === 'ruled_out' ? 'refuted' : 'provisional';
  return {
    resourceType: 'Condition',
    id: hex(d._id),
    // FHIR invariant con-5: a refuted condition carries no clinical status.
    ...(ver === 'refuted' ? {} : { clinicalStatus: { coding: [{ system: SYS.conditionClinical, code: 'active' }] } }),
    verificationStatus: { coding: [{ system: SYS.conditionVer, code: ver }] },
    category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-category', code: 'encounter-diagnosis' }] }],
    code: { coding: [{ system: SYS.icd11, code: d.code, display: d.display }], text: d.display },
    subject: ref('Patient', d.patientId),
    encounter: ref('Encounter', d.encounterId),
    recordedDate: iso(d.recordedAt),
    recorder: ref('Practitioner', d.authorId),
  };
}

export function vitalObservation(o: Document) {
  const l = VITAL_LOINC[o.code];
  return {
    resourceType: 'Observation',
    id: hex(o._id),
    status: o.status === 'Corrected' ? 'entered-in-error' : 'final',
    category: [{ coding: [{ system: SYS.obsCategory, code: 'vital-signs', display: 'Vital Signs' }] }],
    code: { coding: [{ system: SYS.loinc, code: l?.code ?? o.code, display: l?.display ?? o.code }], text: l?.display ?? o.code },
    subject: ref('Patient', o.patientId),
    encounter: ref('Encounter', o.encounterId),
    effectiveDateTime: iso(o.effectiveAt),
    valueQuantity: { value: o.value, unit: o.unit, system: SYS.ucum, code: l?.ucum ?? o.unit },
  };
}

const FLAG: Record<string, string> = { H: 'H', L: 'L', HH: 'HH', LL: 'LL', N: 'N' };

/** One Observation per analyte of a released lab order; ids are stable: <orderId>-<analyte>. */
export function labObservations(o: Document) {
  return ((o.results as Document[]) ?? []).map((r) => ({
    resourceType: 'Observation',
    id: `${hex(o._id)}-${String(r.analyteCode).toLowerCase()}`,
    status: o.amendedAt ? 'amended' : 'final',
    category: [{ coding: [{ system: SYS.obsCategory, code: 'laboratory', display: 'Laboratory' }] }],
    code: { coding: [{ system: SYS.labAnalyte, code: r.analyteCode, display: r.name }], text: r.name },
    subject: ref('Patient', o.patientId),
    encounter: ref('Encounter', o.encounterId),
    effectiveDateTime: iso(o.collectedAt ?? o.orderedAt),
    issued: iso(o.releasedAt),
    ...(typeof r.value === 'number' ? { valueQuantity: { value: r.value, ...(r.unit ? { unit: r.unit } : {}) } } : { valueString: String(r.value) }),
    ...(r.flag && FLAG[r.flag] ? { interpretation: [{ coding: [{ system: SYS.interpretation, code: FLAG[r.flag] }] }] } : {}),
    ...(r.refLow !== null && r.refLow !== undefined && r.refHigh !== null && r.refHigh !== undefined ? { referenceRange: [{ low: { value: r.refLow, ...(r.unit ? { unit: r.unit } : {}) }, high: { value: r.refHigh, ...(r.unit ? { unit: r.unit } : {}) } }] } : {}),
  }));
}

export function labReport(o: Document) {
  return {
    resourceType: 'DiagnosticReport',
    id: hex(o._id),
    status: o.amendedAt ? 'amended' : 'final',
    category: [{ coding: [{ system: SYS.diagService, code: 'LAB', display: 'Laboratory' }] }],
    code: { coding: [{ system: SYS.labTest, code: o.testCode, display: o.testName }], text: o.testName },
    subject: ref('Patient', o.patientId),
    encounter: ref('Encounter', o.encounterId),
    effectiveDateTime: iso(o.collectedAt ?? o.orderedAt),
    issued: iso(o.releasedAt),
    result: labObservations(o).map((x) => ({ reference: `Observation/${x.id}` })),
  };
}

export function imagingReport(o: Document) {
  return {
    resourceType: 'DiagnosticReport',
    id: hex(o._id),
    status: (o.addenda as unknown[] | undefined)?.length ? 'appended' : 'final',
    category: [{ coding: [{ system: SYS.diagService, code: o.modality && ['ECG', 'ECHO', 'EEG'].includes(o.modality) ? 'OTH' : 'RAD' }] }],
    code: { coding: [{ system: SYS.imaging, code: o.modality, display: o.examination }], text: o.examination },
    subject: ref('Patient', o.patientId),
    encounter: ref('Encounter', o.encounterId),
    issued: iso(o.signedAt),
    performer: o.signedBy ? [ref('Practitioner', o.signedBy)] : [],
    conclusion: o.report?.impression,
    ...(o.accessionNumber ? { identifier: [{ system: 'urn:fahan:accession', value: o.accessionNumber }] } : {}),
  };
}

const PRIORITY: Record<string, string> = { routine: 'routine', urgent: 'urgent', stat: 'stat' };

export function serviceRequest(o: Document, kind: 'lab' | 'imaging') {
  const done = ['Released', 'Final'].includes(o.status);
  return {
    resourceType: 'ServiceRequest',
    id: hex(o._id),
    status: o.status === 'Cancelled' ? 'revoked' : done ? 'completed' : 'active',
    intent: 'order',
    priority: PRIORITY[o.priority] ?? 'routine',
    category: [{ coding: [{ system: SYS.diagService, code: kind === 'lab' ? 'LAB' : 'RAD' }] }],
    code: kind === 'lab' ? { coding: [{ system: SYS.labTest, code: o.testCode, display: o.testName }], text: o.testName } : { coding: [{ system: SYS.imaging, code: o.modality, display: o.examination }], text: o.examination },
    subject: ref('Patient', o.patientId),
    encounter: ref('Encounter', o.encounterId),
    authoredOn: iso(o.orderedAt),
    requester: ref('Practitioner', o.orderedBy),
  };
}

const RX_STATUS: Record<string, string> = { Draft: 'draft', Signed: 'active', Verified: 'active', Dispensed: 'completed', Cancelled: 'cancelled', Rejected: 'stopped' };

export function medicationRequest(x: Document) {
  const drug = x.drug ?? {};
  return {
    resourceType: 'MedicationRequest',
    id: hex(x._id),
    status: RX_STATUS[x.status] ?? 'unknown',
    intent: 'order',
    medicationCodeableConcept: { text: [drug.name, drug.strength].filter(Boolean).join(' ') || 'medicine' },
    subject: ref('Patient', x.patientId),
    encounter: ref('Encounter', x.encounterId),
    ...(x.signedAt ? { authoredOn: iso(x.signedAt) } : {}),
    requester: ref('Practitioner', x.prescriberId),
    dosageInstruction: [{ text: [x.dose, x.frequency, x.durationDays ? `for ${x.durationDays} days` : null, x.instructions].filter(Boolean).join(', ') }],
    ...(x.quantity ? { dispenseRequest: { quantity: { value: x.quantity } } } : {}),
  };
}

const APPT_STATUS: Record<string, string> = { Confirmed: 'booked', CheckedIn: 'arrived', Completed: 'fulfilled', Cancelled: 'cancelled', NoShow: 'noshow' };

export function appointment(a: Document) {
  const start = new Date(a.startsAt as Date);
  return {
    resourceType: 'Appointment',
    id: hex(a._id),
    status: APPT_STATUS[a.status] ?? 'booked',
    ...(a.reason ? { description: a.reason } : {}),
    start: start.toISOString(),
    end: new Date(start.getTime() + (a.minutes ?? 15) * 60_000).toISOString(),
    participant: [
      { actor: ref('Patient', a.patientId), status: 'accepted' },
      { actor: ref('Practitioner', a.providerId), status: 'accepted' },
    ],
  };
}

export function practitioner(u: Document) {
  return {
    resourceType: 'Practitioner',
    id: hex(u._id),
    active: u.status === 'Active',
    name: [{ text: u.name }],
  };
}

export function operationOutcome(code: string, diagnostics: string) {
  return { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code, diagnostics }] };
}
