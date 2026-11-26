/**
 * Restore drill (spec §11.1, §13.2, §14.2): restores a backup into a separate drill database, verifies it, records
 * how long it took (evidence for the RTO target), writes drill-report.json next to the backup, then removes the copy.
 *   npm run restore-drill -- --from <backup dir> [--keep]
 * The live database is never touched.
 */
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config';
import { Data } from '../db/mongo';
import { RestoreRefused, readBackup, restoreInto, verifyRestore } from '../ops/backup';

const { values } = parseArgs({ options: { from: { type: 'string' }, keep: { type: 'boolean', default: false } } });
if (!values.from) {
  console.error('Usage: npm run restore-drill -- --from <backup dir> [--keep]');
  process.exit(2);
}
const config = loadConfig();
const data = await Data.connect(config.mongoUri, config.controlDb);
const dir = resolve(values.from);
try {
  const started = Date.now();
  const backup = readBackup(dir, config.backupKey);
  const drillName = `fahan_t_drill-${backup.manifest.tenant.slug}`.slice(0, 48);
  const target = data.tenant(drillName);
  await target.dropDatabase();
  await restoreInto(target, backup.manifest.tenant.dbName, backup);
  await data.ensureTenantIndexes(target);
  const report = await verifyRestore(target, backup.manifest, config.dataKey);
  const out = { drillAt: new Date().toISOString(), backupCreatedAt: backup.manifest.createdAt, restoredInto: drillName, durationMs: Date.now() - started, ...report };
  writeFileSync(join(dir, 'drill-report.json'), JSON.stringify(out, null, 2));
  for (const c of report.checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(32)} ${c.detail}`);
  console.log(`\nRestore drill ${report.ok ? 'PASSED' : 'FAILED'} in ${out.durationMs} ms. Report: ${join(dir, 'drill-report.json')}`);
  if (!values.keep) await target.dropDatabase();
  if (!report.ok) process.exitCode = 1;
} catch (e) {
  console.error(`Restore drill refused: ${(e as Error).message}`);
  if (!(e instanceof RestoreRefused)) console.error(e);
  process.exitCode = 1;
} finally {
  await data.close();
}
