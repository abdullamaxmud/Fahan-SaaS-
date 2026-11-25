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
      db.collection('patients').createIndex({ tenantId: 1, branchIds: 1, createdAt: -1 }),
      db.collection('patients').createIndex({ tenantId: 1, nameKeys: 1 }),
      db.collection('patients').createIndex({ tenantId: 1, phone: 1 }),
      db.collection('patients').createIndex({ tenantId: 1, 'identifiers.value': 1 }),
      db.collection('patients').createIndex({ tenantId: 1, careTeam: 1 }),
      db.collection('patients').createIndex({ tenantId: 1, mergedInto: 1 }, { sparse: true }),
      db.collection('merge_requests').createIndex({ tenantId: 1, status: 1, createdAt: -1 }),
      db.collection('consents').createIndex({ tenantId: 1, patientId: 1, recordedAt: -1 }),
      db.collection('provider_schedules').createIndex({ tenantId: 1, providerId: 1, weekday: 1 }),
      // No double-booking (spec §5.4): only active appointments hold the slot lock.
      db.collection('appointments').createIndex(
        { tenantId: 1, providerId: 1, startsAt: 1 },
        { unique: true, partialFilterExpression: { slotLock: true }, name: 'one_active_per_provider_slot' },
      ),
      db.collection('appointments').createIndex({ tenantId: 1, branchId: 1, startsAt: 1 }),
      db.collection('appointments').createIndex({ tenantId: 1, patientId: 1, startsAt: -1 }),
      db.collection('encounters').createIndex({ tenantId: 1, patientId: 1, startedAt: -1 }),
      db.collection('encounters').createIndex({ tenantId: 1, clinicianIds: 1, status: 1 }),
      db.collection('encounters').createIndex({ tenantId: 1, appointmentId: 1 }, { unique: true, partialFilterExpression: { appointmentId: { $exists: true } } }),
      db.collection('observations').createIndex({ tenantId: 1, patientId: 1, effectiveAt: -1 }),
      db.collection('observations').createIndex({ tenantId: 1, encounterId: 1 }),
      db.collection('clinical_notes').createIndex({ tenantId: 1, encounterId: 1, createdAt: 1 }),
      db.collection('clinical_notes').createIndex({ tenantId: 1, patientId: 1, signedAt: -1 }),
      db.collection('diagnoses').createIndex({ tenantId: 1, code: 1, certainty: 1, recordedAt: 1 }),
      db.collection('diagnoses').createIndex({ tenantId: 1, encounterId: 1 }),
      db.collection('diagnoses').createIndex({ tenantId: 1, patientId: 1, recordedAt: -1 }),
      db.collection('wards').createIndex({ tenantId: 1, branchId: 1, code: 1 }, { unique: true }),
      db.collection('beds').createIndex({ tenantId: 1, branchId: 1, code: 1 }, { unique: true }),
      db.collection('beds').createIndex({ tenantId: 1, wardId: 1, status: 1 }),
      // Spec §5.8: one active occupant per bed; one active bed per admission.
      db.collection('bed_assignments').createIndex({ tenantId: 1, bedId: 1 }, { unique: true, partialFilterExpression: { active: true }, name: 'one_active_per_bed' }),
      db.collection('bed_assignments').createIndex({ tenantId: 1, admissionId: 1 }, { unique: true, partialFilterExpression: { active: true }, name: 'one_active_bed_per_admission' }),
      // Spec §5.7: no simultaneous active admissions for one patient.
      db.collection('admissions').createIndex({ tenantId: 1, patientId: 1 }, { unique: true, partialFilterExpression: { activeLock: true }, name: 'one_active_admission' }),
      db.collection('admissions').createIndex({ tenantId: 1, branchId: 1, status: 1, createdAt: -1 }),
      db.collection('allergies').createIndex({ tenantId: 1, patientId: 1, status: 1 }),
      db.collection('break_glass').createIndex({ tenantId: 1, userId: 1, patientId: 1, expiresAt: -1 }),
      db.collection('break_glass').createIndex({ tenantId: 1, review: 1, createdAt: -1 }),
      db.collection('audit_events').createIndex({ seq: 1 }, { unique: true }),
      db.collection('audit_events').createIndex({ tenantId: 1, occurredAt: -1, actorId: 1 }),
      db.collection('audit_events').createIndex({ actorId: 1, resource: 1 }),
    ]);
  }

  /** Brings every existing tenant up to the current index set (idempotent; run at startup). */
  async migrateAllTenants(): Promise<number> {
    const tenants = await this.control().collection('tenants').find({}, { projection: { dbName: 1 } }).toArray();
    for (const t of tenants) await this.ensureTenantIndexes(this.tenant(t.dbName as string));
    return tenants.length;
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
