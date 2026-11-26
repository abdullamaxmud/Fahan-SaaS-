import type { Db, ObjectId } from 'mongodb';
import type { Permissions, Scope } from '@fahan/policy';
import type { Config } from './config';
import type { Data } from './db/mongo';

export type MfaState = 'ok' | 'pending' | 'enroll';

export interface SessionDoc {
  _id: ObjectId;
  tokenHash: string;
  kind: 'platform' | 'tenant';
  userId: ObjectId;
  tenantId?: ObjectId;
  mfaState: MfaState;
  mfaAt?: Date;
  csrf: string;
  createdAt: Date;
  expiresAt: Date;
}

/** The authenticated caller, rebuilt from the database on every request so role changes apply immediately. */
export interface Actor {
  kind: 'platform' | 'tenant';
  userId: ObjectId;
  email: string;
  name: string;
  roles: string[];
  perms: Permissions;
  scope: Scope;
  tenantId?: ObjectId;
  tenantSlug?: string;
  tenantName?: string;
  /** Tenant database, resolved server-side from the session. Never from the request. */
  db?: Db;
  branchId?: ObjectId;
  /** Portal accounts (patient, caregiver): the records this person may see — themselves or their dependants. */
  patientIds?: ObjectId[];
  /** Modules this hospital has switched off (spec §3.3 feature switchboard). */
  disabledModules?: string[];
}

export interface Deps {
  data: Data;
  config: Config;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      correlationId: string;
      session?: SessionDoc;
      actor?: Actor;
    }
  }
}
