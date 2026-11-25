/** Functional modules from spec §5 (plus the platform console from §3.1). */
export const MODULE_GROUPS = {
  platform: { en: 'Platform', so: 'Madasha' },
  care: { en: 'Patient care', so: 'Daryeelka bukaanka' },
  dx: { en: 'Diagnostics', so: 'Baaritaannada' },
  meds: { en: 'Medicines & supply', so: 'Daawooyinka & sahayda' },
  rev: { en: 'Revenue', so: 'Dakhliga' },
  people: { en: 'People', so: 'Dadka' },
  intel: { en: 'Intelligence', so: 'Sirdoonka' },
  admin: { en: 'Administration', so: 'Maamulka' },
  patient: { en: 'Patient', so: 'Bukaanka' },
} as const;
export type ModuleGroup = keyof typeof MODULE_GROUPS;

export interface ModuleDef {
  key: string;
  spec: string;
  name: string;
  so: string;
  group: ModuleGroup;
  icon: string;
}

const m = (key: string, spec: string, name: string, so: string, group: ModuleGroup, icon: string): ModuleDef => ({
  key,
  spec,
  name,
  so,
  group,
  icon,
});

export const MODULES = [
  m('plat', '3.1', 'Platform console', 'Maamulka madasha', 'platform', 'globe'),
  m('org', '5.1', 'Organization & facilities', 'Ururka & xarumaha', 'admin', 'building-2'),
  m('iam', '5.2', 'Users, roles & permissions', 'Isticmaalayaasha & doorarka', 'admin', 'key-round'),
  m('mpi', '5.3', 'Patients', 'Bukaanka', 'care', 'users'),
  m('appt', '5.4', 'Appointments & queues', 'Ballamaha & safafka', 'care', 'calendar-clock'),
  m('opd', '5.5', 'Outpatient (OPD)', 'Bukaan-socodka', 'care', 'stethoscope'),
  m('er', '5.6', 'Emergency', 'Gurmadka degdegga', 'care', 'siren'),
  m('adm', '5.7', 'Admissions & discharge', 'Dhigista & ka-bixitaanka', 'care', 'door-open'),
  m('bed', '5.8', 'Wards & beds', 'Qolalka & sariiraha', 'care', 'bed-double'),
  m('nur', '5.9', 'Nursing & vitals', 'Kalkaalinta & calaamadaha', 'care', 'heart-pulse'),
  m('icu', '5.10', 'ICU / NICU / PICU', 'ICU / NICU / PICU', 'care', 'activity'),
  m('sx', '5.16', 'Surgery & theatre', 'Qalliinka', 'care', 'scissors'),
  m('mat', '5.17', 'Maternity & pediatrics', 'Umulaha & carruurta', 'care', 'baby'),
  m('tele', '5.27', 'Telemedicine', 'Telemedicine', 'care', 'video'),
  m('amb', '5.25', 'Ambulance & referrals', 'Ambalaas & gudbinta', 'care', 'ambulance'),
  m('lab', '5.11', 'Laboratory', 'Shaybaarka', 'dx', 'flask-conical'),
  m('rad', '5.12', 'Radiology', 'Raajada & sawirka', 'dx', 'scan-line'),
  m('dx', '5.13', 'ECG, echo & endoscopy', 'ECG, echo & baaritaanno', 'dx', 'waves'),
  m('bb', '5.18', 'Blood bank', 'Bangiga dhiigga', 'dx', 'droplet'),
  m('rx', '5.14', 'Pharmacy', 'Farmashiyaha', 'meds', 'pill'),
  m('inv', '5.15', 'Inventory', 'Kaydka', 'meds', 'package'),
  m('proc', '5.23', 'Procurement', 'Iibka', 'meds', 'truck'),
  m('eq', '5.24', 'Equipment & CSSD', 'Qalabka & CSSD', 'meds', 'wrench'),
  m('bill', '5.19', 'Billing & cashier', 'Biilasha & khasnajiga', 'rev', 'receipt'),
  m('ins', '5.21', 'Insurance & claims', 'Caymiska & sheegashooyinka', 'rev', 'shield-check'),
  m('acct', '5.20', 'Accounting', 'Xisaabaadka', 'rev', 'landmark'),
  m('hr', '5.22', 'HR, rosters & payroll', 'Shaqaalaha & mushaharka', 'people', 'briefcase'),
  m('qual', '5.28', 'Quality & infection control', 'Tayada & xakamaynta infekshanka', 'intel', 'clipboard-check'),
  m('bi', '5.29', 'Reports & BI', 'Warbixinnada & BI', 'intel', 'bar-chart-3'),
  m('aifin', '5.30', 'AI financial intelligence', 'AI maaliyadda', 'intel', 'sparkles'),
  m('aidis', '5.31', 'AI disease intelligence', 'AI cudurrada', 'intel', 'microscope'),
  m('ai360', '5.32', 'Hospital 360 report', 'Warbixinta 360', 'intel', 'file-text'),
  m('studio', '5.33', 'Forms & workflow studio', 'Foomamka & socodka', 'admin', 'workflow'),
  m('intg', '5.34', 'Integrations & API', 'Isku-xirka & API', 'admin', 'plug'),
  m('sec', '5.35', 'Security & audit', 'Amniga & hubinta', 'admin', 'lock'),
  m('portal', '5.26', 'Patient portal', 'Bogga bukaanka', 'patient', 'smartphone'),
] as const satisfies readonly ModuleDef[];

export type ModuleKey = (typeof MODULES)[number]['key'];
export const MODULE_KEYS = MODULES.map((x) => x.key) as ModuleKey[];
export const MODULE_BY_KEY = Object.fromEntries(MODULES.map((x) => [x.key, x])) as Record<ModuleKey, ModuleDef>;

/** Modules whose permissions control the system itself. Grants on these are capped by the granter's own level. */
export const ADMIN_MODULES: readonly ModuleKey[] = ['plat', 'org', 'iam', 'studio', 'intg', 'sec'];

export function isModuleKey(k: string): k is ModuleKey {
  return k in MODULE_BY_KEY;
}
