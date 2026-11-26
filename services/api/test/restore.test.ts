import { mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RestoreRefused, backupTenant, readBackup, restoreInto, verifyRestore, type Manifest } from '../src/ops/backup';
import { setupHospital, type Hospital } from './fixtures';
import { startHarness, type Harness } from './helpers';

/** Spec §11.1 / §11.3 / §14.2 #10: encrypted backups and a verified restore drill with the right keys. */
let h: Harness;
let H: Hospital;
let dir: string;
let manifest: Manifest;
const live = 'fahan_t_hiil';

beforeAll(async () => {
  h = await startHarness();
  H = await setupHospital(h, [
    { key: 'reception', role: 'reception' },
    { key: 'doctor', role: 'physician' },
  ]);
  const pid = (await H.staff.reception!.c.post('/patients', { branchId: H.branchId, givenName: 'Hooyo', familyName: 'Backup', dob: '1960-06-06' })).body.data.id;
  const enc = (await H.staff.reception!.c.post('/appointments/walk-in', { patientId: pid, providerId: H.staff.doctor!.id, reason: 'Check-up' })).body.data.encounterId;
  await H.staff.doctor!.c.post(`/encounters/${enc}/diagnoses`, { code: 'BA00', display: 'Essential hypertension', certainty: 'confirmed', primary: true });
  dir = mkdtempSync(join(tmpdir(), 'fahan-backup-'));
});
afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await h?.stop();
});

describe('backup', () => {
  it('writes every collection sealed with the backup key, plus a signed manifest', async () => {
    manifest = await backupTenant(h.data.tenant(live), { slug: 'hiil', dbName: live }, h.config.backupKey, dir);
    expect(manifest.collections.map((c) => c.name)).toEqual(expect.arrayContaining(['patients', 'encounters', 'diagnoses', 'users', 'audit_events']));
    expect(manifest.auditHead.count).toBeGreaterThan(0);
    expect(manifest.signature).toMatch(/^[0-9a-f]{64}$/);
    // Nothing readable on disk: no names, no MRNs.
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.enc'))) expect(readFileSync(join(dir, f)).toString('latin1')).not.toMatch(/Hooyo|Backup|MGD-/);
  });
});

describe('refusals before anything is restored', () => {
  it('the wrong key, an edited file, an edited manifest or a missing file all stop the restore', () => {
    expect(() => readBackup(dir, Buffer.alloc(32, 1))).toThrow(RestoreRefused);
    const f = join(dir, 'patients.ejson.gz.enc');
    const good = readFileSync(f);
    const bad = Buffer.from(good);
    bad[bad.length - 1] = bad[bad.length - 1]! ^ 0xff;
    writeFileSync(f, bad);
    expect(() => readBackup(dir, h.config.backupKey)).toThrow(/altered/);
    writeFileSync(f, good);
    const m = join(dir, 'manifest.json');
    const original = readFileSync(m, 'utf8');
    writeFileSync(m, original.replace(/"count": (\d+)/, (_s, n) => `"count": ${Number(n) + 1}`));
    expect(() => readBackup(dir, h.config.backupKey)).toThrow(/signature/);
    writeFileSync(m, original);
    unlinkSync(join(dir, 'diagnoses.ejson.gz.enc'));
    expect(() => readBackup(dir, h.config.backupKey)).toThrow(/missing/);
  });

  it('never restores over the live database', async () => {
    // Recreate the backup (one file was removed above).
    rmSync(dir, { recursive: true, force: true });
    manifest = await backupTenant(h.data.tenant(live), { slug: 'hiil', dbName: live }, h.config.backupKey, dir);
    await expect(restoreInto(h.data.tenant(live), live, readBackup(dir, h.config.backupKey))).rejects.toThrow(/live database/);
  });
});

describe('restore drill', () => {
  it('a restored copy has the same records, an intact audit chain, and readable encrypted fields', async () => {
    const drill = h.data.tenant('fahan_t_drill-hiil');
    const started = Date.now();
    await restoreInto(drill, live, readBackup(dir, h.config.backupKey));
    await h.data.ensureTenantIndexes(drill);
    const report = await verifyRestore(drill, manifest, h.config.dataKey);
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checks.find((c) => c.name === 'audit-chain')!.ok).toBe(true);
    expect(report.checks.find((c) => c.name === 'encrypted-fields')!.ok).toBe(true);
    const p = await drill.collection('patients').findOne({ 'names.given': 'Hooyo' });
    expect(p).toMatchObject({ dob: '1960-06-06' });
    expect(await drill.collection('diagnoses').countDocuments({ patientId: p!._id })).toBe(1);
    expect(Date.now() - started).toBeLessThan(60_000);
    // A second restore into a non-empty database is refused.
    await expect(restoreInto(drill, live, readBackup(dir, h.config.backupKey))).rejects.toThrow(/not empty/);
  });

  it('with the wrong data key the drill fails instead of pretending', async () => {
    const report = await verifyRestore(h.data.tenant('fahan_t_drill-hiil'), manifest, Buffer.alloc(32, 3));
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === 'encrypted-fields')).toMatchObject({ ok: false });
  });

  it('the live database was not changed by the drill', async () => {
    const r = await H.staff.reception!.c.get('/patients');
    expect(r.status).toBe(200);
    expect(r.body.data.some((x: { names: { given: string } }) => x.names.given === 'Hooyo')).toBe(true);
  });
});
