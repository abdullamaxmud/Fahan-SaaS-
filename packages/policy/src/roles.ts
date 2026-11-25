import { isModuleKey, type ModuleKey } from './modules';

/** V view · E create & edit · S sign / verify / dispense · A approve & configure. Ordered weakest → strongest. */
export const LEVELS = ['V', 'E', 'S', 'A'] as const;
export type Level = (typeof LEVELS)[number];
export const LEVEL_LABEL: Record<Level, string> = {
  V: 'View',
  E: 'Create & edit',
  S: 'Sign, verify or dispense',
  A: 'Approve & configure',
};
export const levelRank = (l: Level | undefined): number => (l ? LEVELS.indexOf(l) + 1 : 0);

/** Spec §3.2 scopes, widest → narrowest. */
export const SCOPES = ['platform', 'tenant', 'hospital', 'branch', 'department', 'assigned-patient', 'own-record'] as const;
export type Scope = (typeof SCOPES)[number];
/** True when the scope is limited to a single branch (or narrower). */
export const isBranchBound = (s: Scope): boolean => SCOPES.indexOf(s) >= SCOPES.indexOf('branch');

export type Permissions = Partial<Record<ModuleKey, Level>>;

export interface RoleDef {
  id: string;
  tier: number;
  name: string;
  scope: Scope;
  /** Workspace the web app opens for this role. */
  home: string;
  /** Multi-factor authentication required (spec §3.4: privileged users). */
  mfa: boolean;
  perms: Permissions;
  note: string;
}

export const TIERS: Record<number, { en: string; so: string }> = {
  1: { en: 'Platform (SaaS)', so: 'Madasha (SaaS)' },
  2: { en: 'Hospital administration', so: 'Maamulka isbitaalka' },
  3: { en: 'Front desk', so: 'Soo-dhoweynta' },
  4: { en: 'Clinical care', so: 'Daryeelka caafimaadka' },
  5: { en: 'Diagnostics & pharmacy', so: 'Baaritaanka & farmashiyaha' },
  6: { en: 'Finance', so: 'Maaliyadda' },
  7: { en: 'Operations', so: 'Hawlgallada' },
  8: { en: 'Quality & governance', so: 'Tayada & hufnaanta' },
  9: { en: 'Security & technical', so: 'Amniga & farsamada' },
  10: { en: 'Patients & external', so: 'Bukaanka & dibadda' },
};

function parsePerms(s: string): Permissions {
  const out: Permissions = {};
  for (const part of s.split(' ').filter(Boolean)) {
    const [k, v] = part.split(':');
    if (!k || !isModuleKey(k) || !v || !(LEVELS as readonly string[]).includes(v)) {
      throw new Error(`Invalid permission token "${part}"`);
    }
    out[k] = v as Level;
  }
  return out;
}

const r = (id: string, tier: number, name: string, home: string, scope: Scope, perms: string, note: string, mfa = false): RoleDef => ({
  id,
  tier,
  name,
  home,
  scope,
  perms: parsePerms(perms),
  note,
  mfa,
});

export const ROLES: readonly RoleDef[] = [
  r('platform-owner', 1, 'Platform Owner', 'platform', 'platform', 'plat:A org:A iam:A intg:V sec:V bi:V', 'Creates hospital tenants and appoints their admins. Cannot open patient records. Non-delegable.', true),
  r('super-admin', 2, 'Hospital Super Admin', 'admin', 'tenant', 'org:A iam:A studio:A intg:A sec:V bi:V aifin:V ai360:A qual:V hr:V', 'Controls modules, roles, forms, workflows and AI policy for this hospital only.', true),
  r('hospital-admin', 2, 'Hospital Administrator', 'admin', 'hospital', 'org:E iam:E studio:V bi:V aifin:V ai360:V hr:V qual:V sec:V', 'Runs departments, users and services within their own grant ceiling.', true),
  r('branch-manager', 2, 'Branch Manager', 'admin', 'branch', 'org:E iam:V appt:V bed:V bi:V hr:V inv:V eq:V', 'Manages one branch: hours, capacity, staff coverage.', true),
  r('designer', 2, 'Workflow & Form Designer', 'module:studio', 'hospital', 'studio:E org:V', 'Builds no-code forms and workflows. Nothing publishes without approval.', true),
  r('reception', 3, 'Reception & Registration', 'reception', 'branch', 'mpi:E appt:E adm:V amb:V bill:V portal:V', 'Registers patients and runs queues. Demographics only.'),
  r('admission-officer', 3, 'Admission Officer', 'reception', 'branch', 'adm:E bed:E mpi:V appt:V ins:V', 'Reserves beds and opens admissions.'),
  r('physician', 4, 'Physician / Specialist', 'clinical', 'assigned-patient', 'mpi:V appt:V opd:S adm:E nur:V sx:E tele:S lab:E rad:E dx:E bb:E rx:S', 'Signs notes, diagnoses and prescriptions for assigned patients.', true),
  r('surgeon', 4, 'Surgeon', 'theatre', 'assigned-patient', 'mpi:V opd:S adm:E bed:V sx:S lab:E rad:E bb:E rx:S', 'Owns procedure records.', true),
  r('anesthetist', 4, 'Anesthetist', 'theatre', 'assigned-patient', 'mpi:V nur:V icu:E sx:S lab:V rx:S', 'Signs pre-anesthesia assessment and recovery.', true),
  r('theatre-nurse', 4, 'Theatre Nurse', 'theatre', 'department', 'mpi:V nur:E sx:E inv:V eq:V', 'Runs surgical safety checklists.'),
  r('nurse', 4, 'Nurse', 'ward', 'assigned-patient', 'mpi:V opd:E adm:V bed:V nur:E lab:E', 'Records vitals with time, source and unit.'),
  r('shift-lead', 4, 'Nursing Shift Lead', 'ward', 'department', 'mpi:V adm:V bed:E nur:S hr:V', 'Verifies nursing records and owns the handover.'),
  r('ward-manager', 4, 'Ward Manager', 'ward', 'department', 'mpi:V adm:E bed:A nur:S inv:V hr:V qual:E', 'Controls the bed board and isolation cohorts.'),
  r('ward-physician', 4, 'Ward Physician', 'clinical', 'assigned-patient', 'mpi:V opd:S adm:S bed:V nur:V lab:E rad:E rx:S', 'Admits, transfers and signs discharge summaries.', true),
  r('er-clinician', 4, 'Emergency Clinician', 'er', 'department', 'mpi:E er:S adm:E bed:V amb:V lab:E rad:E rx:S', 'Triage overrides are audited.', true),
  r('er-nurse', 4, 'Emergency Nurse', 'er', 'department', 'mpi:E er:E nur:E bed:V amb:V lab:E', 'Records triage and observations.'),
  r('icu-team', 4, 'ICU / NICU / PICU Team', 'ward', 'department', 'mpi:V nur:E icu:S bed:V lab:E rad:E dx:E rx:S', 'Reviews labelled device feeds.', true),
  r('obstetrician', 4, 'Obstetrician', 'clinical', 'assigned-patient', 'mpi:V opd:S sx:E mat:S lab:E rad:E bb:E rx:S', 'Owns antenatal and delivery records.', true),
  r('midwife', 4, 'Midwife', 'clinical', 'assigned-patient', 'mpi:V nur:E mat:E lab:E', 'Records antenatal visits and deliveries.'),
  r('pediatrician', 4, 'Pediatrician', 'clinical', 'assigned-patient', 'mpi:V opd:S icu:E mat:S lab:E rx:S', 'Child services under reviewed proxy rules.', true),
  r('bloodbank', 4, 'Blood Bank Specialist', 'lab', 'department', 'mpi:V bb:S lab:E inv:V', 'Unit-level traceability and recall.'),
  r('tele-clinician', 4, 'Telemedicine Clinician', 'clinical', 'assigned-patient', 'mpi:V appt:V opd:S tele:S lab:E rx:S portal:E', 'Virtual visits; never recorded without consent.', true),
  r('lab-tech', 5, 'Laboratory Technician', 'lab', 'department', 'mpi:V lab:E inv:V eq:V', 'Accessions and processes samples. Cannot release results.'),
  r('pathologist', 5, 'Pathologist', 'lab', 'department', 'mpi:V lab:A bb:V qual:V', 'Verifies and releases results.', true),
  r('radiographer', 5, 'Radiographer', 'rad', 'department', 'mpi:V appt:V rad:E eq:V', 'Schedules and acquires studies.'),
  r('radiologist', 5, 'Radiologist', 'rad', 'department', 'mpi:V rad:A dx:V qual:V', 'Only a radiologist signature makes a report final.', true),
  r('dx-tech', 5, 'Diagnostics Technician', 'rad', 'department', 'mpi:V dx:E eq:V', 'Performs ECG, echo and endoscopy studies.'),
  r('pharmacist', 5, 'Pharmacist', 'rx', 'branch', 'mpi:V rx:S inv:E proc:V', 'Verifies orders and dispenses by batch.', true),
  r('storekeeper', 5, 'Inventory Officer / Storekeeper', 'rx', 'branch', 'rx:V inv:E proc:V', 'Available quantity never goes negative.'),
  r('cashier', 6, 'Cashier', 'cashier', 'branch', 'mpi:V bill:E ins:V', 'Takes payments. Cannot read clinical histories.'),
  r('billing-officer', 6, 'Billing Officer', 'cashier', 'branch', 'mpi:V bill:S ins:E acct:V', 'Issues and voids invoices.'),
  r('claims', 6, 'Insurance Claims Specialist', 'module:ins', 'hospital', 'mpi:V bill:V ins:S', 'Submits claims and tracks denials.'),
  r('accountant', 6, 'Accountant', 'finance', 'hospital', 'bill:V acct:E proc:V hr:V bi:V', 'Posts balanced journals.', true),
  r('finance-director', 6, 'Finance Director', 'finance', 'hospital', 'bill:A ins:V acct:A proc:A hr:V bi:V aifin:V ai360:S', 'Approves refunds above threshold and closes periods.', true),
  r('finance-approver', 6, 'Finance Approver', 'finance', 'hospital', 'bill:V acct:S aifin:V ai360:S', 'Signs the finance section of the monthly report.', true),
  r('hr', 7, 'HR Officer', 'ops', 'hospital', 'org:V iam:V hr:A', 'Salary access is restricted.', true),
  r('procurement', 7, 'Procurement Officer', 'ops', 'hospital', 'inv:V proc:E eq:V acct:V', '3-way match before supplier payment.'),
  r('biomedical', 7, 'Biomedical Officer', 'ops', 'hospital', 'inv:V proc:V eq:A', 'Out-of-service devices block bookings.'),
  r('facilities-cssd', 7, 'Facilities & CSSD', 'ops', 'branch', 'sx:V inv:V eq:E', 'Sterilization, maintenance, housekeeping.'),
  r('dispatch', 7, 'Ambulance Dispatch', 'er', 'branch', 'mpi:V er:V amb:E', 'Location access is bounded.'),
  r('quality-officer', 8, 'Quality Officer', 'ai', 'hospital', 'sec:V qual:A bi:V aidis:V ai360:V', 'Incidents are confidential.'),
  r('ipc', 8, 'Infection Prevention (IPC)', 'ai', 'hospital', 'bed:V lab:V qual:E aidis:V', 'Infection surveillance.'),
  r('analyst', 8, 'Data Analyst', 'ai', 'hospital', 'bi:E aifin:V aidis:V ai360:V', 'Small cohorts are suppressed.'),
  r('clinical-governance', 8, 'Clinical Governance Lead', 'ai', 'hospital', 'qual:V bi:V aidis:A ai360:V', 'Validates disease intelligence.', true),
  r('clinical-safety-officer', 8, 'Clinical Safety Officer', 'ai', 'hospital', 'studio:V qual:A aidis:S ai360:S', 'Signs off high-risk workflows and AI uses.', true),
  r('clinical-reviewer', 8, 'Clinical Reviewer', 'ai', 'hospital', 'bi:V aidis:V ai360:S', 'Reviews the clinical section of the monthly report.', true),
  r('security-auditor', 9, 'Security Auditor', 'security', 'tenant', 'iam:V intg:V sec:A', 'Reads the protected audit trail. Cannot change data.', true),
  r('dpo', 9, 'Data Protection Officer', 'security', 'tenant', 'iam:V sec:E bi:V portal:V', 'Data requests, retention, exceptional access.', true),
  r('devops', 9, 'DevOps Engineer', 'security', 'platform', 'plat:V intg:E sec:E', 'Deployments and restores. No patient content.', true),
  r('integration-engineer', 9, 'Integration Engineer', 'module:intg', 'tenant', 'intg:A sec:V', 'Credentials live only in the secrets manager.', true),
  r('patient', 10, 'Patient', 'portal', 'own-record', 'appt:E tele:V portal:E', 'Own record only.'),
  r('caregiver', 10, 'Caregiver / Proxy', 'portal', 'own-record', 'appt:E portal:E', 'Acts for a dependant under proxy rules.'),
  r('referring-provider', 10, 'Referring Provider', 'portal', 'own-record', 'amb:E portal:V', 'Status of referrals they sent.'),
];

export const ROLE_BY_ID: Record<string, RoleDef> = Object.fromEntries(ROLES.map((x) => [x.id, x]));
/** Roles that live inside a hospital tenant (everything except the platform tier). */
export const TENANT_ROLES = ROLES.filter((x) => x.tier !== 1);
