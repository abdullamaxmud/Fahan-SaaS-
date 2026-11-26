import { can, type Level, type ModuleKey, type Permissions } from '@fahan/policy';

export interface NavItem {
  href: string;
  en: string;
  so: string;
  icon: string;
  /** Shown when the user has any of these modules. */
  any: ModuleKey[];
  /** Hidden for people whose access is limited to their own patients (worklists are for department staff). */
  staffOnly?: boolean;
  /** Also shown with this module at this level (e.g. reception books video visits through appointments). */
  alt?: [ModuleKey, Level];
}
export interface NavGroup {
  en: string;
  so: string;
  items: NavItem[];
}

const i = (href: string, en: string, so: string, icon: string, any: ModuleKey[], staffOnly = false): NavItem => ({ href, en, so, icon, any, staffOnly });

/** One entry per screen. Several modules can open the same screen, so the sidebar never repeats a page. */
export const NAV: NavGroup[] = [
  {
    en: 'Platform',
    so: 'Madasha',
    items: [i('/platform/tenants', 'Hospitals', 'Isbitaalada', 'building', ['plat'])],
  },
  {
    en: 'Front desk',
    so: 'Soo-dhoweynta',
    items: [
      i('/patients', 'Patients', 'Bukaanka', 'users', ['mpi']),
      i('/appointments', 'Appointments', 'Ballamaha', 'calendar-clock', ['appt']),
      { ...i('/telemedicine', 'Video visits', 'Booqasho fiidiyow', 'video', ['tele']), alt: ['appt', 'E'] },
      { ...i('/messages', 'Patient messages', 'Fariimaha bukaanka', 'messages-square', []), alt: ['portal', 'E'] },
    ],
  },
  {
    en: 'Clinical care',
    so: 'Daryeelka',
    items: [
      i('/encounters', 'Visits', 'Booqashooyinka', 'stethoscope', ['opd']),
      i('/emergency', 'Emergency', 'Gurmadka', 'siren', ['er']),
      i('/wards', 'Wards & beds', 'Qolalka & sariiraha', 'bed-double', ['adm', 'bed', 'nur']),
      i('/icu', 'Intensive care', 'Daryeelka degdegga ah', 'activity', ['icu']),
      i('/surgery', 'Theatres', 'Qalliinka', 'scissors', ['sx']),
      i('/maternity', 'Maternity', 'Umulaha', 'baby', ['mat']),
      i('/referrals', 'Referrals & ambulance', 'Gudbinta & ambalaas', 'ambulance', ['amb']),
    ],
  },
  {
    en: 'Diagnostics',
    so: 'Baaritaanka',
    items: [
      i('/lab', 'Laboratory', 'Shaybaarka', 'flask-conical', ['lab'], true),
      i('/radiology', 'Radiology', 'Raajada', 'scan-line', ['rad'], true),
      i('/diagnostics', 'ECG & echo', 'ECG & echo', 'waves', ['dx'], true),
      i('/bloodbank', 'Blood bank', 'Bangiga dhiigga', 'droplet', ['bb'], true),
    ],
  },
  {
    en: 'Pharmacy & stores',
    so: 'Farmashiyaha & bakhaarka',
    items: [
      i('/pharmacy', 'Pharmacy', 'Farmashiyaha', 'pill', ['rx'], true),
      i('/inventory', 'Inventory', 'Kaydka', 'package', ['inv']),
      i('/procurement', 'Procurement', 'Iibsiga', 'truck', ['proc']),
      i('/equipment', 'Equipment & CSSD', 'Qalabka & CSSD', 'wrench', ['eq']),
    ],
  },
  {
    en: 'Money',
    so: 'Lacagta',
    items: [
      i('/billing', 'Billing & cashier', 'Biilasha & khasnajiga', 'receipt', ['bill']),
      i('/insurance', 'Insurance', 'Caymiska', 'shield-check', ['ins']),
      i('/finance', 'Finance', 'Maaliyadda', 'landmark', ['acct']),
    ],
  },
  {
    en: 'People',
    so: 'Shaqaalaha',
    items: [i('/hr', 'Staff & payroll', 'Shaqaalaha & mushaharka', 'briefcase', ['hr'])],
  },
  {
    en: 'Quality & reports',
    so: 'Tayada & warbixinnada',
    items: [
      i('/quality', 'Quality & safety', 'Tayada & badbaadada', 'clipboard-check', ['qual']),
      i('/reports', 'Reports', 'Warbixinnada', 'bar-chart-3', ['bi']),
      i('/ai-finance', 'Finance insights', 'Falanqaynta maaliyadda', 'sparkles', ['aifin']),
      i('/ai-disease', 'Disease insights', 'Falanqaynta cudurrada', 'microscope', ['aidis']),
      i('/hospital-360', 'Monthly report', 'Warbixinta bisha', 'file-text', ['ai360']),
    ],
  },
  {
    en: 'Administration',
    so: 'Maamulka',
    items: [
      i('/admin/users', 'Users & roles', 'Isticmaalayaasha', 'key-round', ['iam']),
      i('/admin/branches', 'Hospital setup', 'Habaynta isbitaalka', 'building-2', ['org']),
      i('/studio', 'Forms studio', 'Foomamka', 'workflow', ['studio']),
      i('/admin/integrations', 'Integrations', 'Isku-xirka', 'plug', ['intg']),
      i('/admin/audit', 'Security & audit', 'Amniga & hubinta', 'lock', ['sec']),
    ],
  },
];

/** Platform users only reach the tenant console and the control-plane audit check. */
const PLATFORM_PAGES = new Set(['/platform/tenants', '/admin/audit']);

export function navFor(perms: Permissions, opts: { platform: boolean; ownPatients: boolean; disabled?: string[] }): NavGroup[] {
  const off = new Set(opts.disabled ?? []);
  return NAV.map((g) => ({
    ...g,
    items: g.items.filter(
      (x) =>
        (x.any.some((m) => perms[m] && !off.has(m)) || (x.alt && can(perms, x.alt[0], x.alt[1]) && !off.has(x.any[0] ?? x.alt[0]))) &&
        (!opts.platform || PLATFORM_PAGES.has(x.href)) &&
        !(x.staffOnly && opts.ownPatients),
    ),
  })).filter((g) => g.items.length);
}
