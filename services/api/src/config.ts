import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  MONGO_URI: z.string().min(1).default('mongodb://127.0.0.1:27018/?replicaSet=rs0&directConnection=true'),
  CONTROL_DB: z.string().regex(/^[a-z0-9_]+$/).default('fahan_control'),
  DATA_KEY: z.string().optional(),
  BACKUP_KEY: z.string().optional(),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(12),
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),
});

export interface Config {
  env: 'development' | 'test' | 'production';
  port: number;
  mongoUri: string;
  controlDb: string;
  dataKey: Buffer;
  /** Encrypts and signs backups (spec §11.3 ransomware / data loss). Kept apart from the data key. */
  backupKey: Buffer;
  sessionTtlMs: number;
  cookieSecure: boolean;
  /** How recently MFA must have been confirmed for sensitive changes (spec §3.4 re-authentication). */
  reauthWindowMs: number;
  /** Injectable clock for scheduling rules (tests pin it). */
  now: () => Date;
}

/** Fixed key used only outside production so local dev and tests work without setup. */
const DEV_DATA_KEY = Buffer.alloc(32, 7);
const DEV_BACKUP_KEY = Buffer.alloc(32, 9);

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const e = Env.parse(source);
  let dataKey = DEV_DATA_KEY;
  if (e.DATA_KEY) {
    dataKey = Buffer.from(e.DATA_KEY, 'base64');
    if (dataKey.length !== 32) throw new Error('DATA_KEY must be 32 bytes, base64 encoded');
  } else if (e.NODE_ENV === 'production') {
    throw new Error('DATA_KEY is required in production');
  }
  let backupKey = DEV_BACKUP_KEY;
  if (e.BACKUP_KEY) {
    backupKey = Buffer.from(e.BACKUP_KEY, 'base64');
    if (backupKey.length !== 32) throw new Error('BACKUP_KEY must be 32 bytes, base64 encoded');
    if (backupKey.equals(dataKey)) throw new Error('BACKUP_KEY must differ from DATA_KEY');
  } else if (e.NODE_ENV === 'production') {
    throw new Error('BACKUP_KEY is required in production');
  }
  return {
    env: e.NODE_ENV,
    port: e.PORT,
    mongoUri: e.MONGO_URI,
    controlDb: e.CONTROL_DB,
    dataKey,
    backupKey,
    sessionTtlMs: e.SESSION_TTL_HOURS * 3_600_000,
    cookieSecure: e.COOKIE_SECURE ? e.COOKIE_SECURE === 'true' : e.NODE_ENV === 'production',
    reauthWindowMs: 10 * 60_000,
    now: () => new Date(),
  };
}
