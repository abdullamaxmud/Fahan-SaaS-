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
for (const key of ['obs', 'midwife']) {
  await db.collection('provider_schedules').insertMany(
    [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ tenantId: t.insertedId, providerId: ids[key], branchId: branch.insertedId, weekday, start: '08:00', end: '16:00', slotMinutes: 30, createdAt: now })),
  );
}

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

const dir = resolve(process.cwd(), '.data');
mkdirSync(dir, { recursive: true });
const file = resolve(dir, 'demo-credentials.txt');
writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
console.log(`Demo data created. Credentials written to ${file}`);
await data.close();
