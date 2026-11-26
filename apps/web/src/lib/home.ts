import type { Level, ModuleKey } from '@fahan/policy';

export type Tone = 'crit' | 'warn' | 'info' | 'acc';

/** Work waiting for someone: shown in "Needs your attention" only when the count is above zero. */
export interface TaskDef {
  en: string;
  so: string;
  href: string;
  icon: string;
  tone: Tone;
}
/** A figure for today: always shown when the role can see it. */
export interface StatDef {
  en: string;
  so: string;
  href: string;
  icon: string;
}

const tk = (en: string, so: string, href: string, icon: string, tone: Tone = 'info'): TaskDef => ({ en, so, href, icon, tone });
const st = (en: string, so: string, href: string, icon: string): StatDef => ({ en, so, href, icon });

/** Ordered by urgency: the list on the home screen keeps this order. */
export const TASKS: Record<string, TaskDef> = {
  criticals: tk('Critical results to acknowledge', 'Natiijooyin khatar ah oo la aqoonsado', '/lab', 'triangle-alert', 'crit'),
  erUntriaged: tk('Emergency patients not yet triaged', 'Bukaan gurmad oo aan la kala-saarin', '/emergency', 'siren', 'crit'),
  tillClosed: tk('Open your till to take cash', 'Fur khasnadda si aad lacag u qaadato', '/billing', 'wallet', 'warn'),
  apptWaiting: tk('Patients checked in and waiting', 'Bukaan sugaya', '/appointments', 'clock', 'warn'),
  awaitingBed: tk('Admissions waiting for a bed', 'Dhigis sugaysa sariir', '/wards', 'bed-double', 'warn'),
  rxToVerify: tk('Prescriptions to verify', 'Warqado daawo oo la xaqiijiyo', '/pharmacy', 'pill', 'warn'),
  rxToDispense: tk('Prescriptions to dispense', 'Daawo la bixiyo', '/pharmacy', 'package-check'),
  labToCollect: tk('Samples to collect', 'Muunado la qaado', '/lab', 'test-tube'),
  labInProgress: tk('Samples in the lab', 'Muunado shaybaarka ku jira', '/lab', 'flask-conical'),
  labToVerify: tk('Results to verify', 'Natiijooyin la xaqiijiyo', '/lab', 'badge-check', 'warn'),
  labToRelease: tk('Verified results to release', 'Natiijooyin la sii daayo', '/lab', 'send', 'warn'),
  radOpen: tk('Imaging orders to schedule or scan', 'Dalabyo raajo', '/radiology', 'scan-line'),
  radToReport: tk('Imaging studies to report', 'Sawirro la qoro warbixintooda', '/radiology', 'file-pen', 'warn'),
  dxOpen: tk('ECG / echo orders open', 'Dalabyo ECG / echo', '/diagnostics', 'waves'),
  bbRequests: tk('Blood requests open', 'Codsiyo dhiig', '/bloodbank', 'droplet', 'warn'),
  draftNotes: tk('Your notes not yet signed', 'Qoraalladaada aan la saxiixin', '/encounters', 'file-signature', 'warn'),
  messagesOpen: tk('Patient messages to answer', 'Fariimo bukaan oo la jawaabo', '/messages', 'messages-square', 'warn'),
  bedsCleaning: tk('Beds being cleaned', 'Sariiro la nadiifinayo', '/wards', 'sparkles'),
  refundsPending: tk('Refunds to approve', 'Lacag-celin la ansixiyo', '/billing', 'undo-2', 'warn'),
  tillsToApprove: tk('Till differences to approve', 'Farqiga khasnadda', '/billing', 'scale', 'warn'),
  chargesUnpriced: tk('Charges without a price', 'Kharashyo aan qiimo lahayn', '/billing', 'tag'),
  invoicesDraft: tk('Draft invoices to issue', 'Biilal qabyo ah', '/billing', 'receipt'),
  claimsDraft: tk('Insurance claims to submit', 'Sheegashooyin la gudbiyo', '/insurance', 'shield-check'),
  journalsToApprove: tk('Journals to approve', 'Qoraallo xisaab oo la ansixiyo', '/finance', 'book-check', 'warn'),
  supplierInvoicesToPay: tk('Supplier invoices to pay', 'Biilal alaab-qeybiye', '/procurement', 'banknote'),
  posToApprove: tk('Purchase orders to approve', 'Dalabyo iib oo la ansixiyo', '/procurement', 'truck', 'warn'),
  payrollToApprove: tk('Payroll to approve', 'Mushahar la ansixiyo', '/hr', 'briefcase', 'warn'),
  payrollToPay: tk('Payroll to pay', 'Mushahar la bixiyo', '/hr', 'banknote'),
  leavePending: tk('Leave requests to decide', 'Codsiyo fasax', '/hr', 'calendar-x', 'warn'),
  credentialsExpiring: tk('Staff licences expiring', 'Shatiyo dhacaya', '/hr', 'id-card', 'warn'),
  mergesPending: tk('Duplicate records to review', 'Diiwaanno labalaab ah', '/patients/merges', 'git-merge', 'warn'),
  eqDown: tk('Devices out of service', 'Qalab aan shaqaynayn', '/equipment', 'wrench', 'warn'),
  calibrationDue: tk('Calibrations due soon', 'Hagaajin qalab oo dhow', '/equipment', 'gauge'),
  cssdOpen: tk('Sterilisation loads running', 'Nadiifin qalab socota', '/equipment', 'flame'),
  expiringLots: tk('Stock batches expiring in 90 days', 'Kayd dhacaya 90 maalmood', '/inventory', 'package'),
  incidentsOpen: tk('Safety incidents open', 'Dhacdooyin badbaado oo furan', '/quality', 'clipboard-check', 'warn'),
  ipcOpen: tk('Infection cases under review', 'Kiisas infekshan', '/quality', 'bug', 'warn'),
  financeInsights: tk('Finance summaries to review', 'Soo koobid maaliyadeed', '/ai-finance', 'sparkles'),
  diseaseInsights: tk('Disease summaries to validate', 'Soo koobid cudur', '/ai-disease', 'microscope'),
  h360ToSign: tk('Monthly report sections to sign', 'Warbixinta bisha oo la saxiixo', '/hospital-360', 'file-text', 'warn'),
  h360ToApprove: tk('Monthly report to approve', 'Warbixinta bisha oo la ansixiyo', '/hospital-360', 'file-check', 'warn'),
  formsSafety: tk('Forms needing safety sign-off', 'Foomam u baahan ansixin badbaado', '/studio', 'shield-alert', 'warn'),
  formsToApprove: tk('Forms to approve', 'Foomam la ansixiyo', '/studio', 'workflow'),
  usersInvited: tk('Invitations not yet accepted', 'Casuumaado aan la aqbalin', '/admin/users', 'mail'),
  breakGlassToReview: tk('Emergency access to review', 'Gelitaan degdeg ah oo la eego', '/admin/break-glass', 'shield-alert', 'warn'),
  securityOpen: tk('Security incidents open', 'Dhacdooyin amni', '/admin/security', 'lock', 'warn'),
  tenantsSuspended: tk('Hospitals suspended', 'Isbitaalo la hakiyay', '/platform/tenants', 'building'),
};

export const STATS: Record<string, StatDef> = {
  tenantsActive: st('Active hospitals', 'Isbitaalo firfircoon', '/platform/tenants', 'building'),
  apptToday: st('Appointments today', 'Ballamaha maanta', '/appointments', 'calendar-clock'),
  myVisits: st('My open visits', 'Booqashooyinkayga', '/encounters', 'stethoscope'),
  teleToday: st('Video visits today', 'Fiidiyow maanta', '/telemedicine', 'video'),
  erActive: st('In emergency now', 'Gurmadka hadda', '/emergency', 'siren'),
  admitted: st('Admitted patients', 'Bukaan jiifa', '/wards', 'bed-double'),
  bedsFree: st('Free beds', 'Sariiro bannaan', '/wards', 'bed-single'),
  icuStays: st('In intensive care', 'Daryeel degdeg ah', '/icu', 'activity'),
  casesToday: st('Operations today', 'Qalliinnada maanta', '/surgery', 'scissors'),
  pregnancies: st('Active pregnancies', 'Uur socda', '/maternity', 'baby'),
  referralsActive: st('Referrals in progress', 'Gudbin socota', '/referrals', 'ambulance'),
  invoicesUnpaid: st('Unpaid invoices', 'Biilal aan la bixin', '/billing', 'receipt'),
  claimsSubmitted: st('Claims with insurers', 'Sheegashooyin caymis', '/insurance', 'shield-check'),
  staffActive: st('Staff on payroll', 'Shaqaale', '/hr', 'briefcase'),
  usersActive: st('People with access', 'Isticmaalayaal', '/admin/users', 'users'),
};

export interface QuickAction {
  en: string;
  so: string;
  href: string;
  icon: string;
  need: [ModuleKey, Level];
  staffOnly?: boolean;
}
export const QUICK: QuickAction[] = [
  { en: 'New hospital', so: 'Isbitaal cusub', href: '/platform/tenants', icon: 'plus', need: ['plat', 'A'] },
  { en: 'Register patient', so: 'Diiwaangeli bukaan', href: '/patients', icon: 'user-plus', need: ['mpi', 'E'] },
  { en: 'Book appointment', so: 'Qabso ballan', href: '/appointments', icon: 'calendar-plus', need: ['appt', 'E'] },
  { en: 'New emergency arrival', so: 'Bukaan gurmad cusub', href: '/emergency', icon: 'siren', need: ['er', 'E'] },
  { en: 'Admit a patient', so: 'Dhig bukaan', href: '/wards', icon: 'bed-double', need: ['adm', 'E'] },
  { en: 'Lab worklist', so: 'Liiska shaybaarka', href: '/lab', icon: 'flask-conical', need: ['lab', 'E'], staffOnly: true },
  { en: 'Dispense medicines', so: 'Bixi daawo', href: '/pharmacy', icon: 'pill', need: ['rx', 'S'], staffOnly: true },
  { en: 'Take a payment', so: 'Qaado lacag', href: '/billing', icon: 'wallet', need: ['bill', 'E'] },
  { en: 'Receive stock', so: 'Qaado kayd', href: '/inventory', icon: 'package-plus', need: ['inv', 'E'] },
  { en: 'New purchase order', so: 'Dalab iib cusub', href: '/procurement', icon: 'truck', need: ['proc', 'E'] },
  { en: 'Invite staff', so: 'Casuun shaqaale', href: '/admin/users', icon: 'user-plus', need: ['iam', 'E'] },
  { en: 'Month figures', so: 'Tirooyinka bisha', href: '/reports', icon: 'bar-chart-3', need: ['bi', 'V'] },
];
