import { MongoClient, type Db } from 'mongodb';

const TENANT_DB = /^fahan_t_[a-z0-9-]{3,40}$/;
export const tenantDbName = (slug: string) => `fahan_t_${slug}`;

/**
 * Data access root. The control plane holds tenants, platform users and sessions — never clinical data.
 * Each hospital tenant gets its own database (spec §7.6: dedicated database preferred).
 */
export class Data {
  constructor(
    readonly client: MongoClient,
    private readonly controlName: string,
  ) {}

  static async connect(uri: string, controlName: string): Promise<Data> {
    const client = new MongoClient(uri, { ignoreUndefined: true });
    await client.connect();
    const data = new Data(client, controlName);
    await data.ensureControlIndexes();
    return data;
  }

  control(): Db {
    return this.client.db(this.controlName);
  }

  /** Only resolves names produced by the tenant registry — never a name taken from a request. */
  tenant(dbName: string): Db {
    if (!TENANT_DB.test(dbName)) throw new Error(`Refusing to open non-tenant database "${dbName}"`);
    return this.client.db(dbName);
  }

  async ensureControlIndexes(): Promise<void> {
    const db = this.control();
    await Promise.all([
      db.collection('tenants').createIndex({ slug: 1 }, { unique: true }),
      db.collection('platform_users').createIndex({ email: 1 }, { unique: true }),
      db.collection('sessions').createIndex({ tokenHash: 1 }, { unique: true }),
      db.collection('sessions').createIndex({ userId: 1 }),
      db.collection('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      db.collection('audit_events').createIndex({ seq: 1 }, { unique: true }),
      db.collection('audit_events').createIndex({ occurredAt: -1, actorId: 1 }),
    ]);
  }

  async ensureTenantIndexes(db: Db): Promise<void> {
    await Promise.all([
      db.collection('users').createIndex({ tenantId: 1, email: 1 }, { unique: true }),
      db.collection('users').createIndex({ 'invite.tokenHash': 1 }, { sparse: true }),
      db.collection('branches').createIndex({ tenantId: 1, code: 1 }, { unique: true }),
      db.collection('departments').createIndex({ tenantId: 1, branchId: 1, code: 1 }, { unique: true }),
      db.collection('patients').createIndex({ tenantId: 1, mrn: 1 }, { unique: true }),
      db.collection('patients').createIndex({ tenantId: 1, branchId: 1, createdAt: -1 }),
      db.collection('audit_events').createIndex({ seq: 1 }, { unique: true }),
      db.collection('audit_events').createIndex({ tenantId: 1, occurredAt: -1, actorId: 1 }),
    ]);
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
