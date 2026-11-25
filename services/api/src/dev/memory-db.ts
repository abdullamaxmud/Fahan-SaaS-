/**
 * Local MongoDB replica set for development (no Docker or MongoDB install needed).
 * Data persists in services/api/.data/mongo between runs. Transactions work (replica set).
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const dbPath = resolve(process.cwd(), '.data/mongo');
mkdirSync(dbPath, { recursive: true });

const rs = await MongoMemoryReplSet.create({
  replSet: { count: 1, name: 'rs0', storageEngine: 'wiredTiger' },
  instanceOpts: [{ port: Number(process.env.DEV_DB_PORT ?? 27018), dbPath }],
});
console.log(`MongoDB replica set ready: ${rs.getUri()}&directConnection=true`);
console.log('Leave this running. Press Ctrl+C to stop.');

const stop = async () => {
  await rs.stop({ doCleanup: false });
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
