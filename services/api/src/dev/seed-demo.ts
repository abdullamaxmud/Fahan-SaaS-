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
