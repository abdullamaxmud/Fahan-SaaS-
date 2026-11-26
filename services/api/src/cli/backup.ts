/**
 * Encrypted logical backup of one hospital (spec §11.1, §11.3).
 *   npm run backup -- --tenant hiil [--out <dir>]
 * Needs BACKUP_KEY in production. Store the output off-site and immutable; the key is kept separately.
 */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config';
import { Data } from '../db/mongo';
import { backupTenant } from '../ops/backup';

const { values } = parseArgs({ options: { tenant: { type: 'string' }, out: { type: 'string' } } });
if (!values.tenant) {
  console.error('Usage: npm run backup -- --tenant <hospital code> [--out <dir>]');
  process.exit(2);
}
const config = loadConfig();
const data = await Data.connect(config.mongoUri, config.controlDb);
try {
  const t = await data.control().collection('tenants').findOne({ slug: values.tenant });
  if (!t) throw new Error(`No hospital with code ${values.tenant}`);
  const dir = resolve(values.out ?? `.data/backups/${values.tenant}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const started = Date.now();
  const m = await backupTenant(data.tenant(t.dbName as string), { slug: values.tenant, dbName: t.dbName as string }, config.backupKey, dir);
  const docs = m.collections.reduce((n, c) => n + c.count, 0);
  console.log(`Backup written to ${dir}`);
  console.log(`  ${m.collections.length} collections, ${docs} documents, ${m.auditHead.count} audit events, ${Date.now() - started} ms`);
} catch (e) {
  console.error(`Backup failed: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await data.close();
}
