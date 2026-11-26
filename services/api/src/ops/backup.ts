import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { BSON, type Db } from 'mongodb';

const { EJSON } = BSON;
import { verifyAuditChain } from '../audit/audit';
import { decrypt } from '../lib/crypto';

/**
 * Logical, encrypted backups of one hospital database and the restore drill (spec §11.1 "backups, disaster recovery
 * exercises", §11.3 ransomware/data loss, §14.2 "clinical records remain accessible in a tested restore environment
 * with proper encryption keys"). Each collection is written as canonical EJSON, gzipped and sealed with AES-256-GCM
 * under the backup key; a manifest of checksums is signed with an HMAC of the same key. Restores go into a separate
 * database and are verified before anyone relies on them.
 *
 * This complements, not replaces, the database's own continuous backups (point-in-time recovery for the RPO target).
 */
export const BACKUP_FORMAT = 'fahan-backup-v1';

export interface Manifest {
  format: string;
  tenant: { slug: string; dbName: string };
  createdAt: string;
  collections: { name: string; count: number; file: string; plainSha256: string; sealedSha256: string }[];
  auditHead: { count: number; lastHash: string | null };
  signature?: string;
}

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const sign = (m: Manifest, key: Buffer) => createHmac('sha256', key).update(JSON.stringify({ ...m, signature: undefined })).digest('hex');

function seal(plain: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}
function open(sealed: Buffer, key: Buffer): Buffer {
  const d = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
  d.setAuthTag(sealed.subarray(12, 28));
  return Buffer.concat([d.update(sealed.subarray(28)), d.final()]);
}

export async function backupTenant(db: Db, tenant: { slug: string; dbName: string }, key: Buffer, dir: string): Promise<Manifest> {
  mkdirSync(dir, { recursive: true });
  const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).filter((n) => !n.startsWith('system.')).sort();
  const collections: Manifest['collections'] = [];
  for (const name of names) {
    const lines: string[] = [];
    for await (const doc of db.collection(name).find({}).sort({ _id: 1 })) lines.push(EJSON.stringify(doc, { relaxed: false }));
    const plain = Buffer.from(lines.join('\n'), 'utf8');
    const sealed = seal(gzipSync(plain), key);
    const file = `${name}.ejson.gz.enc`;
    writeFileSync(join(dir, file), sealed, { mode: 0o600 });
    collections.push({ name, count: lines.length, file, plainSha256: sha(plain), sealedSha256: sha(sealed) });
  }
  const last = await db.collection('audit_events').find({}).sort({ seq: -1 }).limit(1).next();
  const manifest: Manifest = {
    format: BACKUP_FORMAT,
    tenant,
    createdAt: new Date().toISOString(),
    collections,
    auditHead: { count: await db.collection('audit_events').countDocuments(), lastHash: (last?.hash as string) ?? null },
  };
  manifest.signature = sign(manifest, key);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  return manifest;
}

export class RestoreRefused extends Error {}

/** Checks the signature and every file before touching any database. */
export function readBackup(dir: string, key: Buffer): { manifest: Manifest; collections: Map<string, Buffer> } {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;
  if (manifest.format !== BACKUP_FORMAT) throw new RestoreRefused(`Unknown backup format ${manifest.format}`);
  const expected = Buffer.from(sign(manifest, key), 'hex');
  const given = Buffer.from(manifest.signature ?? '', 'hex');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new RestoreRefused('Manifest signature does not match (wrong key, or the manifest was changed)');
  const present = new Set(readdirSync(dir));
  const collections = new Map<string, Buffer>();
  for (const c of manifest.collections) {
    if (!present.has(c.file)) throw new RestoreRefused(`${c.file} is missing`);
    const sealed = readFileSync(join(dir, c.file));
    if (sha(sealed) !== c.sealedSha256) throw new RestoreRefused(`${c.file} was altered`);
    let plain: Buffer;
    try {
      plain = gunzipSync(open(sealed, key));
    } catch {
      throw new RestoreRefused(`${c.file} cannot be decrypted with this key`);
    }
    if (sha(plain) !== c.plainSha256) throw new RestoreRefused(`${c.file} content does not match its checksum`);
    collections.set(c.name, plain);
  }
  return { manifest, collections };
}

/** Restores into an empty database that is not the live one. */
export async function restoreInto(target: Db, liveDbName: string, backup: ReturnType<typeof readBackup>): Promise<void> {
  if (target.databaseName === liveDbName) throw new RestoreRefused('Refusing to restore over the live database; restore into a drill database');
  if ((await target.listCollections({}, { nameOnly: true }).toArray()).length) throw new RestoreRefused(`${target.databaseName} is not empty`);
  for (const c of backup.manifest.collections) {
    const text = backup.collections.get(c.name)!.toString('utf8');
    const docs = text ? text.split('\n').map((l) => EJSON.parse(l, { relaxed: false })) : [];
    await target.createCollection(c.name);
    for (let i = 0; i < docs.length; i += 1000) await target.collection(c.name).insertMany(docs.slice(i, i + 1000), { ordered: true });
  }
}

export interface DrillReport {
  ok: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
}

/**
 * What "the restore worked" means: same counts, the audit chain intact and ending where it did, a patient record
 * readable, and encrypted secrets readable with the hospital's data key (and only with it).
 */
export async function verifyRestore(target: Db, manifest: Manifest, dataKey: Buffer): Promise<DrillReport> {
  const checks: DrillReport['checks'] = [];
  for (const c of manifest.collections) {
    const n = await target.collection(c.name).countDocuments();
    checks.push({ name: `count:${c.name}`, ok: n === c.count, detail: `${n}/${c.count}` });
  }
  const chain = await verifyAuditChain(target);
  const last = await target.collection('audit_events').find({}).sort({ seq: -1 }).limit(1).next();
  checks.push({ name: 'audit-chain', ok: chain.ok && chain.count === manifest.auditHead.count && ((last?.hash as string) ?? null) === manifest.auditHead.lastHash, detail: `${chain.count} events${chain.ok ? '' : `, broken at ${chain.brokenAtSeq}`}` });
  const patient = await target.collection('patients').findOne({}, { sort: { _id: 1 } });
  checks.push({ name: 'patient-record', ok: (await target.collection('patients').countDocuments()) === 0 || Boolean(patient?.mrn && patient?.names), detail: patient ? `MRN ${String(patient.mrn)}` : 'no patients in this hospital' });
  const withSecret = await target.collection('users').findOne({ 'mfa.secret': { $type: 'string' } });
  if (withSecret) {
    let readable = false;
    try {
      readable = decrypt(withSecret.mfa.secret as string, dataKey).length > 0;
    } catch {
      readable = false;
    }
    checks.push({ name: 'encrypted-fields', ok: readable, detail: readable ? 'MFA secrets decrypt with the data key' : 'MFA secrets do NOT decrypt with this data key' });
  }
  return { ok: checks.every((c) => c.ok), checks };
}
