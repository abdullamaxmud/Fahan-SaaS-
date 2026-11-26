/**
 * Demo data for local development only:
 *   npm run seed:demo
 * Creates the platform owner, hospital "hiil" (branch MGD), one user per key role, a clinic
 * schedule and a few patients. Credentials are written to services/api/.data/demo-credentials.txt
 * (git-ignored) — never to the console log or the repository.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { nameKeys } from '@fahan/terminology';
import { loadConfig } from '../config';
import { Data, tenantDbName } from '../db/mongo';
import { encrypt, newToken } from '../lib/crypto';
import { hashPassword, totp } from '../lib/secrets';
import { ensureChart } from '../modules/accounting/ledger';
import { bootstrapOwner } from '../modules/platform/bootstrap';

const config = loadConfig();
if (config.env === 'production') {
  console.error('Refused: seed:demo never runs in production.');
  process.exit(1);
}
const data = await Data.connect(config.mongoUri, config.controlDb);
const control = data.control();
if (await control.collection('tenants').findOne({ slug: 'hiil' })) {
  console.error('Refused: demo hospital "hiil" already exists. Use a fresh CONTROL_DB or drop the dev database.');
  await data.close();
  process.exit(1);
}

const lines: string[] = ['Fahan demo credentials (local development only)', ''];
const owner = await bootstrapOwner(data, config, { email: 'owner@fahan.test', name: 'Ilhaan Daahir' });
lines.push(`platform owner   owner@fahan.test   ${owner.password}   TOTP ${owner.secret}   (sign in with no hospital code)`, '');

const now = new Date();
const t = await control.collection('tenants').insertOne({
  slug: 'hiil',
  name: 'Hiil Medical Group',
  dbName: tenantDbName('hiil'),
  isolation: 'dedicated-db',
  status: 'Active',
  createdAt: now,
  version: 1,
});
const db = data.tenant(tenantDbName('hiil'));
await data.ensureTenantIndexes(db);
const branch = await db.collection('branches').insertOne({ tenantId: t.insertedId, code: 'MGD', name: 'Mogadishu Central', timezone: 'Africa/Mogadishu', status: 'Active', createdAt: now, version: 1 });

const password = newToken(12);
const pwHash = await hashPassword(password);
lines.push(`hospital code: hiil      password for every hospital user: ${password}`, '');

const people: [string, string, string, boolean][] = [
  ['admin', 'Mustafe Xirsi', 'super-admin', false],
  ['reception', 'Ifrah Muxumed', 'reception', true],
  ['records', 'Bashiir Gedi', 'records-officer', false],
  ['doctor', 'Dr. Hodan Warsame', 'physician', true],
  ['nurse', 'Deeqa Ali', 'nurse', true],
  ['cashier', 'Hamdi Yuusuf', 'cashier', true],
  ['officer', 'Bashiir Gedi', 'admission-officer', true],
  ['wardmgr', 'Xaawo Elmi', 'ward-manager', true],
  ['warddoc', 'Dr. Mahad Nuur', 'ward-physician', true],
  ['ernurse', 'Ubah Kahin', 'er-nurse', true],
  ['erdoc', 'Dr. Liibaan Dualeh', 'er-clinician', true],
  ['surgeon', 'Dr. Abshir Samatar', 'surgeon', true],
  ['anest', 'Dr. Leyla Osman', 'anesthetist', true],
  ['tnurse', 'Zamzam Hirsi', 'theatre-nurse', true],
  ['obs', 'Dr. Ladan Ismail', 'obstetrician', true],
  ['midwife', 'Maryan Gure', 'midwife', true],
  ['dispatch', 'Abdirisaaq Hurre', 'dispatch', true],
  ['auditor', 'Axmed Gaas', 'security-auditor', false],
  ['labtech', 'Hamse Aar', 'lab-tech', true],
  ['pathologist', 'Dr. Siciid Xuseen', 'pathologist', true],
  ['radiographer', 'Mowliid Kaariye', 'radiographer', true],
  ['radiologist', 'Dr. Asha Galaal', 'radiologist', true],
  ['pharmacist', 'Ugaaso Diiriye', 'pharmacist', true],
  ['storekeeper', 'Cali Bulxan', 'storekeeper', true],
  ['bloodbank', 'Shukri Dhimbil', 'bloodbank', true],
  ['biomedical', 'Eng. Jaamac Dirir', 'biomedical', false],
  ['billing', 'Nimco Faarax', 'billing-officer', true],
  ['claims', 'Sagal Jaamac', 'claims', false],
  ['accountant', 'Maxamed Cabdi', 'accountant', false],
  ['fd', 'Faadumo Aadan', 'finance-director', false],
  ['approver', 'Yuusuf Warsame', 'finance-approver', false],
  ['buyer', 'Khadar Ciise', 'procurement', false],
  ['hr', 'Ruqiya Maxamed', 'hr', false],
  ['analyst', 'Abdiqani Farah', 'analyst', false],
  ['governance', 'Dr. Ifrah Aden', 'clinical-governance', false],
  ['safety', 'Dr. Yasmin Ali', 'clinical-safety-officer', false],
  ['creviewer', 'Dr. Omar Hassan', 'clinical-reviewer', false],
  ['designer', 'Sahra Abdi', 'designer', true],
  ['records2', 'Fartun Ismail', 'records-officer', false],
  ['integrations', 'Yasin Hirad', 'integration-engineer', false],
  ['dpo', 'Amina Said', 'dpo', false],
  ['quality', 'Hodan Aw Ali', 'quality-officer', false],
  ['hadmin', 'Liban Warsame', 'hospital-admin', false],
  ['icu', 'Dr. Khadar Jaamac', 'icu-team', true],
  ['tele', 'Dr. Samira Nuur', 'tele-clinician', true],
  ['ipc', 'Fartun Warsame', 'ipc', false],
  ['cssd', 'Cabdi Xasan', 'facilities-cssd', true],
  ['dxtech', 'Ayaan Faarax', 'dx-tech', true],
  ['shiftlead', 'Sucaad Axmed', 'shift-lead', true],
  ['peds', 'Dr. Nasra Cumar', 'pediatrician', true],
  ['branchmgr', 'Guuleed Cabdi', 'branch-manager', true],
  ['referrer', 'Dr. Axmed Kulmiye', 'referring-provider', true],
];
const ids: Record<string, unknown> = {};
for (const [key, name, role, branchBound] of people) {
  const secret = totp.newSecret();
  const ins = await db.collection('users').insertOne({
    tenantId: t.insertedId,
    email: `${key}@hiil.test`,
    name,
    roles: [role],
    branchId: branchBound ? branch.insertedId : undefined,
    status: 'Active',
    passwordHash: pwHash,
    mfa: { secret: encrypt(secret, config.dataKey), enrolledAt: now },
    createdAt: now,
    activatedAt: now,
    version: 1,
  });
  ids[key] = ins.insertedId;
  lines.push(`${role.padEnd(16)} ${`${key}@hiil.test`.padEnd(22)} TOTP ${secret}`);
}

await db.collection('provider_schedules').insertMany(
  [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ tenantId: t.insertedId, providerId: ids.doctor, branchId: branch.insertedId, weekday, start: '08:00', end: '16:00', slotMinutes: 20, createdAt: now })),
);
// Facilities for Phase 3: two wards with beds, two theatres, two ambulances.
for (const [code, name, kind, count] of [
  ['3B', 'Ward 3B Medical', 'general', 8],
  ['ICU', 'Intensive care', 'icu', 4],
] as const) {
  const w = await db.collection('wards').insertOne({ tenantId: t.insertedId, branchId: branch.insertedId, code, name, kind, status: 'Active', createdAt: now });
  await db.collection('beds').insertMany(
    Array.from({ length: count }, (_, i) => ({ tenantId: t.insertedId, wardId: w.insertedId, branchId: branch.insertedId, code: `${code}-${String(i + 1).padStart(2, '0')}`, status: 'Available', createdAt: now, version: 1 })),
  );
}
await db.collection('theatres').insertMany(
  ['OT-1', 'OT-2'].map((code) => ({ tenantId: t.insertedId, branchId: branch.insertedId, code, name: `Main theatre ${code.slice(-1)}`, status: 'Available', lockSeq: 0, createdAt: now })),
);
await db.collection('vehicles').insertMany(
  [
    ['AMB-04', 'advanced'],
    ['AMB-07', 'basic'],
  ].map(([code, kind]) => ({ tenantId: t.insertedId, branchId: branch.insertedId, code, kind, status: 'Available', createdAt: now })),
);
for (const key of ['obs', 'midwife', 'tele', 'peds']) {
  await db.collection('provider_schedules').insertMany(
    [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ tenantId: t.insertedId, providerId: ids[key], branchId: branch.insertedId, weekday, start: '08:00', end: '16:00', slotMinutes: 30, createdAt: now })),
  );
}

// Phase 4: lab catalogue, pharmacy stock, devices and blood units.
const tid = t.insertedId;
const bid = branch.insertedId;
await db.collection('lab_tests').insertMany([
  { tenantId: tid, code: 'K', name: 'Potassium', specimen: 'serum', turnaroundMinutes: 60, active: true, analytes: [{ code: 'K', name: 'Potassium', kind: 'numeric', unit: 'mmol/L', refLow: 3.5, refHigh: 5.1, criticalLow: 2.5, criticalHigh: 6.0 }], createdAt: now },
  { tenantId: tid, code: 'CBC', name: 'Full blood count', specimen: 'blood', turnaroundMinutes: 90, active: true, analytes: [{ code: 'HB', name: 'Haemoglobin', kind: 'numeric', unit: 'g/dL', refLow: 12, refHigh: 16, criticalLow: 7 }, { code: 'WBC', name: 'White cells', kind: 'numeric', unit: '10^9/L', refLow: 4, refHigh: 11 }], createdAt: now },
  { tenantId: tid, code: 'MRDT', name: 'Malaria rapid test', specimen: 'blood', turnaroundMinutes: 30, active: true, analytes: [{ code: 'PF', name: 'P. falciparum antigen', kind: 'text' }], createdAt: now },
]);
const pharmacy = await db.collection('stores').insertOne({ tenantId: tid, branchId: bid, code: 'PHARM', name: 'Main pharmacy', kind: 'pharmacy', createdAt: now });
await db.collection('stores').insertOne({ tenantId: tid, branchId: bid, code: 'MAIN', name: 'Main store', kind: 'main', createdAt: now });
const nextYear = `${now.getUTCFullYear() + 1}-06-30`;
for (const [code, name, unit, ingredient, strength, form, classes] of [
  ['PCM500', 'Paracetamol 500 mg tablet', 'tablet', 'paracetamol', '500 mg', 'tablet', []],
  ['AMOX500', 'Amoxicillin 500 mg capsule', 'capsule', 'amoxicillin', '500 mg', 'capsule', ['penicillin', 'beta-lactam']],
  ['AL80', 'Artemether-lumefantrine 80/480 mg tablet', 'tablet', 'artemether-lumefantrine', '80/480 mg', 'tablet', ['antimalarial']],
  ['AMLO5', 'Amlodipine 5 mg tablet', 'tablet', 'amlodipine', '5 mg', 'tablet', ['calcium-channel-blocker']],
] as const) {
  const it = await db.collection('items').insertOne({ tenantId: tid, code, name, unit, kind: 'medicine', reorderLevel: 50, medicine: { ingredient, strength, form, route: 'oral', classes: [...classes] }, createdAt: now });
  await db.collection('stock_lots').insertOne({ tenantId: tid, storeId: pharmacy.insertedId, itemId: it.insertedId, branchId: bid, batch: `${code}-01`, expiry: nextYear, quantity: 500, version: 1, createdAt: now });
}
await db.collection('assets').insertMany([
  { tenantId: tid, branchId: bid, code: 'XR-1', name: 'Digital X-ray room 1', kind: 'imaging', modality: 'XR', status: 'Available', createdAt: now },
  { tenantId: tid, branchId: bid, code: 'CT-1', name: 'CT scanner 64-slice', kind: 'imaging', modality: 'CT', status: 'Available', createdAt: now },
  { tenantId: tid, branchId: bid, code: 'ECG-1', name: '12-lead ECG', kind: 'diagnostic', modality: 'ECG', status: 'Available', createdAt: now },
  { tenantId: tid, branchId: bid, code: 'AC-1', name: 'Steam steriliser (autoclave)', kind: 'autoclave', status: 'Available', nextCalibrationDue: nextYear, createdAt: now },
  { tenantId: tid, branchId: bid, code: 'MON-01', name: 'ICU bedside monitor 1', kind: 'monitor', status: 'Available', nextCalibrationDue: nextYear, createdAt: now },
  { tenantId: tid, branchId: bid, code: 'VENT-01', name: 'ICU ventilator 1', kind: 'ventilator', status: 'Available', nextCalibrationDue: nextYear, createdAt: now },
]);
const unitExpiry = new Date(now.getTime() + 30 * 86_400_000).toISOString().slice(0, 10);
await db.collection('blood_units').insertMany(
  ['O-', 'O+', 'A+', 'B+'].map((group, i) => ({ tenantId: tid, branchId: bid, unitNumber: `U-DEMO-00${i + 1}`, group, component: 'red-cells', volumeMl: 280, collectedOn: now.toISOString().slice(0, 10), expiry: unitExpiry, status: 'Available', history: [{ event: 'received', at: now }], createdAt: now })),
);

const yy = now.getUTCFullYear().toString().slice(2);
const pts: [string, string, string, string, string][] = [
  ['Faadumo', 'Cali', 'Xasan', '1992-03-14', 'female'],
  ['Maxamed', 'Yuusuf', 'Guuleed', '1968-07-02', 'male'],
  ['Cabdiraxmaan', 'Faarax', 'Nuur', '2019-01-20', 'male'],
];
for (const [i, [g, m, f, dob, sex]] of pts.entries()) {
  await db.collection('patients').insertOne({
    tenantId: t.insertedId,
    branchIds: [branch.insertedId],
    mrn: `MGD-${yy}-${String(i + 1).padStart(6, '0')}`,
    names: { given: g, middle: m, family: f },
    nameKeys: nameKeys(g, m, f),
    dob,
    sexAtBirth: sex,
    identifiers: [],
    contacts: [],
    status: 'Verified',
    careTeam: [],
    createdAt: now,
    version: 1,
  });
}
await db.collection('counters').insertOne({ _id: `mrn:MGD:${yy}` as never, seq: pts.length });

// Patient portal: the first patient can sign in to the portal with the same demo password.
const firstPatient = await db.collection('patients').findOne({ tenantId: t.insertedId, mrn: `MGD-${yy}-000001` });
await db.collection('users').insertOne({
  tenantId: t.insertedId,
  email: 'faadumo@patient.test',
  name: 'Faadumo Cali Xasan',
  roles: ['patient'],
  patientIds: [firstPatient!._id],
  portalLinks: [{ patientId: firstPatient!._id, relationship: 'self', invitedAt: now, approvedAt: now }],
  status: 'Active',
  passwordHash: pwHash,
  createdAt: now,
  activatedAt: now,
  version: 1,
});
lines.push('', 'patient portal   faadumo@patient.test   (same password, no authenticator needed)');

// ---- Phase 5: finance, insurance, procurement, HR ----
await ensureChart(db, tid);
const priceList: [string, string, string, number][] = [
  ['CONS-OPD', 'Outpatient consultation', 'consultation', 1_000],
  ['LAB-K', 'Potassium', 'laboratory', 800],
  ['LAB-CBC', 'Full blood count', 'laboratory', 1_200],
  ['LAB-MRDT', 'Malaria rapid test', 'laboratory', 500],
  ['RAD-XR', 'X-ray', 'imaging', 2_500],
  ['RAD-US', 'Ultrasound', 'imaging', 3_000],
  ['RAD-CT', 'CT scan', 'imaging', 12_000],
  ['DX-ECG', 'Electrocardiogram', 'imaging', 1_500],
  ['RX-PCM500', 'Paracetamol 500 mg', 'pharmacy', 5],
  ['RX-AMOX500', 'Amoxicillin 500 mg', 'pharmacy', 15],
  ['RX-AL80', 'Artemether-lumefantrine', 'pharmacy', 40],
  ['RX-AMLO5', 'Amlodipine 5 mg', 'pharmacy', 10],
];
await db.collection('service_prices').insertMany(priceList.map(([code, name, category, priceMinor]) => ({ tenantId: tid, code, name, category, priceMinor, currency: 'USD', version: 1, active: true, effectiveFrom: now, createdBy: ids.fd })));
const [p1, p2] = await db.collection('patients').find({ tenantId: tid }).sort({ mrn: 1 }).limit(2).toArray();
for (const [code, qty, src] of [['CONS-OPD', 1, 'seed-visit-1'], ['LAB-CBC', 1, 'seed-lab-1'], ['RX-AMOX500', 21, 'seed-rx-1']] as const) {
  const pr = priceList.find((x) => x[0] === code)!;
  await db.collection('charges').insertOne({ tenantId: tid, branchId: bid, patientId: p1!._id, serviceCode: code, description: pr[1], category: pr[2], quantity: qty, unitPriceMinor: pr[3], currency: 'USD', priceVersion: 1, status: 'unbilled', sourceType: 'seed', sourceId: src, active: true, capturedAt: now, capturedBy: ids.doctor });
}
const payer = await db.collection('payers').insertOne({ tenantId: tid, code: 'TAKAFUL', name: 'Takaful Somalia', kind: 'insurer', currency: 'USD', paymentTermsDays: 30, active: true, createdAt: now });
await db.collection('payers').insertOne({ tenantId: tid, code: 'UNICEF', name: 'UNICEF child health programme', kind: 'ngo', currency: 'USD', paymentTermsDays: 45, active: true, createdAt: now });
await db.collection('policies').insertOne({ tenantId: tid, patientId: p2!._id, payerId: payer.insertedId, payerName: 'Takaful Somalia', memberNumber: 'TK-55120', coveragePercent: 80, validFrom: `${now.getUTCFullYear()}-01-01`, validTo: `${now.getUTCFullYear()}-12-31`, createdAt: now });
await db.collection('suppliers').insertOne({ tenantId: tid, code: 'MEDSUP', name: 'Medsup Trading', currency: 'USD', phone: '+252 61 000 0000', active: true, createdAt: now });
for (const [code, name, unit] of [['GLOVE-M', 'Exam gloves (M)', 'box'], ['SYR-5', 'Syringe 5 ml', 'each']] as const) {
  await db.collection('items').insertOne({ tenantId: tid, code, name, unit, kind: 'consumable', reorderLevel: 20, createdAt: now });
}
const soon = new Date(now.getTime() + 20 * 86_400_000).toISOString().slice(0, 10);
for (const [i, [key, title, base]] of ([['doctor', 'Physician', 180_000], ['nurse', 'Staff nurse', 60_000], ['cashier', 'Cashier', 40_000], ['hr', 'HR officer', 55_000]] as const).entries()) {
  const person = people.find((x) => x[0] === key)!;
  const e = await db.collection('employees').insertOne({ tenantId: tid, staffNumber: `S-${String(i + 1).padStart(4, '0')}`, name: person[1], jobTitle: title, branchId: bid, userId: ids[key], hireDate: '2024-01-15', salary: { currency: 'USD', baseMinor: base, allowancesMinor: 10_000, deductionsMinor: Math.round(base * 0.05) }, status: 'active', createdAt: now });
  if (key === 'nurse') await db.collection('credentials').insertOne({ tenantId: tid, employeeId: e.insertedId, employeeName: person[1], kind: 'nursing-licence', number: 'SNMC-2231', issuer: 'Somali Nursing & Midwifery Council', expiresOn: soon, createdAt: now });
  if (key === 'doctor') await db.collection('credentials').insertOne({ tenantId: tid, employeeId: e.insertedId, employeeName: person[1], kind: 'medical-licence', number: 'SMC-0091', issuer: 'Somali Medical Council', expiresOn: `${now.getUTCFullYear() + 2}-03-31`, createdAt: now });
}

// ---- Phase 6: coded visits for disease intelligence, and one published form ----
const visitPts: [string, string, string][] = [
  ['Asha', 'Warsame', '1985-04-11'], ['Hassan', 'Abdi', '1972-09-30'], ['Nimco', 'Farah', '2012-02-14'],
  ['Mohamud', 'Ali', '1958-11-03'], ['Hibo', 'Yusuf', '1999-07-21'], ['Bile', 'Osman', '1990-12-08'],
];
for (const [i, [g, f, dob]] of visitPts.entries()) {
  const pt = await db.collection('patients').insertOne({ tenantId: tid, mrn: `MGD-${yy}-${String(pts.length + i + 1).padStart(6, '0')}`, names: { given: g, family: f }, nameKeys: nameKeys(g, undefined, f), dob, sexAtBirth: i % 2 ? 'male' : 'female', branchIds: [bid], status: 'Active', careTeam: [ids.doctor], createdAt: now, version: 1 });
  const enc = await db.collection('encounters').insertOne({ tenantId: tid, type: 'OPD', status: 'Open', patientId: pt.insertedId, branchId: bid, clinicianIds: [ids.doctor], reason: 'Fever', startedAt: now, createdAt: now, createdBy: ids.reception, version: 1 });
  const dx = (code: string, display: string, certainty: string, primary: boolean) => ({ tenantId: tid, encounterId: enc.insertedId, patientId: pt.insertedId, branchId: bid, codeSystem: 'ICD-11', code, display, certainty, primary, recordedAt: now, authorId: ids.doctor, history: [], version: 1 });
  await db.collection('diagnoses').insertOne(dx('1F40', 'Malaria due to Plasmodium falciparum', 'confirmed', true));
  if (i < 5) await db.collection('diagnoses').insertOne(dx('CA40', 'Pneumonia', 'suspected', false));
  if (i < 2) await db.collection('diagnoses').insertOne(dx('BA00', 'Essential hypertension', 'confirmed', false));
}
await db.collection('counters').updateOne({ _id: `mrn:MGD:${yy}` as never }, { $set: { seq: pts.length + visitPts.length } }, { upsert: true });
await db.collection('form_definitions').insertOne({
  tenantId: tid, key: 'fall-risk', version: 1, name: 'Fall risk assessment', module: 'nur', highRisk: true, approval: { module: 'nur', level: 'S' },
  fields: [
    { type: 'number', key: 'score', label: 'Morse fall score', labelSo: 'Dhibcaha Morse', required: true, min: 0, max: 125, integer: true },
    { type: 'select', key: 'risk', label: 'Risk level', labelSo: 'Heerka khatarta', required: true, options: ['low', 'medium', 'high'] },
    { type: 'checkbox', key: 'bed_rails', label: 'Bed rails up', labelSo: 'Birta sariirta', required: false },
    { type: 'longtext', key: 'notes', label: 'Notes', labelSo: 'Qoraal', required: false, maxLength: 2000 },
  ],
  status: 'Published', publishedAt: now, safetySignoff: { by: ids.safety, byName: 'Dr. Yasmin Ali', at: now }, createdBy: ids.designer, approvedBy: ids.admin, createdAt: now,
  history: [{ at: now, action: 'created', by: ids.designer, byName: 'Sahra Abdi' }, { at: now, action: 'published', by: ids.admin, byName: 'Mustafe Xirsi' }],
});

const dir = resolve(process.cwd(), '.data');
mkdirSync(dir, { recursive: true });
const file = resolve(dir, 'demo-credentials.txt');
writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
console.log(`Demo data created. Credentials written to ${file}`);
await data.close();
