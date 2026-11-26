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
      db.collection('encounters').createIndex({ tenantId: 1, type: 1, branchId: 1, 'ed.state': 1 }),
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
      db.collection('theatres').createIndex({ tenantId: 1, branchId: 1, code: 1 }, { unique: true }),
      db.collection('surgery_cases').createIndex({ tenantId: 1, theatreId: 1, startsAt: 1, endsAt: 1 }),
      db.collection('surgery_cases').createIndex({ tenantId: 1, surgeonId: 1, startsAt: 1 }),
      db.collection('pregnancies').createIndex({ tenantId: 1, patientId: 1 }, { unique: true, partialFilterExpression: { activeLock: true }, name: 'one_active_pregnancy' }),
      db.collection('antenatal_visits').createIndex({ tenantId: 1, pregnancyId: 1, at: -1 }),
      db.collection('newborn_records').createIndex({ tenantId: 1, motherId: 1 }),
      db.collection('patients').createIndex({ tenantId: 1, motherId: 1 }, { sparse: true }),
      db.collection('vehicles').createIndex({ tenantId: 1, branchId: 1, code: 1 }, { unique: true }),
      db.collection('referrals').createIndex({ tenantId: 1, branchId: 1, status: 1, createdAt: -1 }),
      db.collection('referrals').createIndex({ tenantId: 1, createdBy: 1, createdAt: -1 }),
      db.collection('stores').createIndex({ tenantId: 1, branchId: 1, code: 1 }, { unique: true }),
      db.collection('items').createIndex({ tenantId: 1, code: 1 }, { unique: true }),
      db.collection('items').createIndex({ tenantId: 1, kind: 1, name: 1 }),
      db.collection('stock_lots').createIndex({ tenantId: 1, storeId: 1, itemId: 1, batch: 1 }, { unique: true }),
      db.collection('stock_lots').createIndex({ tenantId: 1, storeId: 1, itemId: 1, expiry: 1 }),
      db.collection('inventory_movements').createIndex({ tenantId: 1, itemId: 1, at: -1 }),
      db.collection('lab_tests').createIndex({ tenantId: 1, code: 1 }, { unique: true }),
      db.collection('lab_orders').createIndex({ tenantId: 1, accessionNumber: 1 }, { unique: true, partialFilterExpression: { accessionNumber: { $exists: true } } }),
      db.collection('lab_orders').createIndex({ tenantId: 1, encounterId: 1, orderedAt: -1 }),
      db.collection('lab_orders').createIndex({ tenantId: 1, branchId: 1, status: 1, orderedAt: 1 }),
      db.collection('lab_qc').createIndex({ tenantId: 1, branchId: 1, testId: 1, at: -1 }),
      db.collection('assets').createIndex({ tenantId: 1, branchId: 1, code: 1 }, { unique: true }),
      db.collection('assets').createIndex({ tenantId: 1, branchId: 1, modality: 1 }),
      db.collection('maintenance_jobs').createIndex({ tenantId: 1, assetId: 1, scheduledFor: -1 }),
      ...['imaging_orders', 'diagnostic_orders'].flatMap((c) => [
        db.collection(c).createIndex({ tenantId: 1, accessionNumber: 1 }, { unique: true }),
        db.collection(c).createIndex({ tenantId: 1, studyInstanceUid: 1 }, { unique: true, partialFilterExpression: { studyInstanceUid: { $exists: true } } }),
        db.collection(c).createIndex({ tenantId: 1, encounterId: 1, orderedAt: -1 }),
        db.collection(c).createIndex({ tenantId: 1, assetId: 1, status: 1, scheduledFor: 1 }),
      ]),
      db.collection('prescriptions').createIndex({ tenantId: 1, encounterId: 1, createdAt: -1 }),
      db.collection('prescriptions').createIndex({ tenantId: 1, branchId: 1, status: 1, signedAt: 1 }),
      // Spec §8.1 idempotency: one dispense per key.
      db.collection('dispense_events').createIndex({ tenantId: 1, idempotencyKey: 1 }, { unique: true }),
      db.collection('dispense_events').createIndex({ tenantId: 1, prescriptionId: 1 }, { unique: true }),
      db.collection('administrations').createIndex({ tenantId: 1, prescriptionId: 1, at: -1 }),
      db.collection('blood_units').createIndex({ tenantId: 1, unitNumber: 1 }, { unique: true }),
      db.collection('blood_units').createIndex({ tenantId: 1, branchId: 1, status: 1, group: 1, component: 1, expiry: 1 }),
      db.collection('blood_typings').createIndex({ tenantId: 1, patientId: 1, at: -1 }),
      db.collection('transfusion_requests').createIndex({ tenantId: 1, branchId: 1, status: 1, requestedAt: 1 }),
      db.collection('accounts').createIndex({ tenantId: 1, code: 1 }, { unique: true }),
      db.collection('periods').createIndex({ tenantId: 1, key: 1 }, { unique: true }),
      // Each source transaction posts once (idempotent ledger postings).
      db.collection('journal_entries').createIndex({ tenantId: 1, 'source.type': 1, 'source.id': 1, 'source.kind': 1 }, { unique: true, name: 'one_posting_per_source' }),
      db.collection('journal_entries').createIndex({ tenantId: 1, currency: 1, periodKey: 1 }),
      db.collection('journal_entries').createIndex({ tenantId: 1, entryNo: 1 }, { unique: true }),
      // Billing (spec §5.19): one live price per service, one charge per clinical event, one payment per Idempotency-Key.
      db.collection('service_prices').createIndex({ tenantId: 1, code: 1 }, { unique: true, partialFilterExpression: { active: true }, name: 'one_active_price' }),
      db.collection('charges').createIndex({ tenantId: 1, sourceType: 1, sourceId: 1, serviceCode: 1 }, { unique: true, partialFilterExpression: { active: true }, name: 'one_charge_per_event' }),
      db.collection('charges').createIndex({ tenantId: 1, patientId: 1, status: 1 }),
      db.collection('invoices').createIndex({ tenantId: 1, invoiceNumber: 1 }, { unique: true, partialFilterExpression: { invoiceNumber: { $type: 'string' } } }),
      db.collection('invoices').createIndex({ tenantId: 1, patientId: 1, createdAt: -1 }),
      db.collection('payments').createIndex({ tenantId: 1, idempotencyKey: 1 }, { unique: true }),
      db.collection('payments').createIndex({ invoiceId: 1 }),
      db.collection('payments').createIndex({ sessionId: 1 }),
      db.collection('cashier_sessions').createIndex({ tenantId: 1, cashierId: 1 }, { unique: true, partialFilterExpression: { status: 'open' }, name: 'one_open_till' }),
      db.collection('refunds').createIndex({ tenantId: 1, status: 1, requestedAt: 1 }),
      db.collection('payment_providers').createIndex({ tenantId: 1, provider: 1 }, { unique: true }),
      // A provider transaction is applied once, however often the provider retries.
      db.collection('payment_events').createIndex({ tenantId: 1, provider: 1, transactionId: 1 }, { unique: true, name: 'one_event_per_transaction' }),
      db.collection('payment_events').createIndex({ tenantId: 1, status: 1, receivedAt: -1 }),
      // Insurance (spec §5.20): one open claim per invoice.
      db.collection('payers').createIndex({ tenantId: 1, code: 1 }, { unique: true }),
      db.collection('policies').createIndex({ tenantId: 1, patientId: 1 }),
      db.collection('claims').createIndex({ tenantId: 1, invoiceId: 1 }, { unique: true, partialFilterExpression: { open: true }, name: 'one_open_claim' }),
      db.collection('claims').createIndex({ tenantId: 1, status: 1, createdAt: -1 }),
      // Procurement (spec §5.16): a supplier's invoice number is recorded once.
      db.collection('suppliers').createIndex({ tenantId: 1, code: 1 }, { unique: true }),
      db.collection('purchase_orders').createIndex({ tenantId: 1, number: 1 }, { unique: true }),
      db.collection('purchase_orders').createIndex({ tenantId: 1, status: 1, createdAt: -1 }),
      db.collection('goods_receipts').createIndex({ orderId: 1 }),
      db.collection('supplier_invoices').createIndex({ tenantId: 1, supplierId: 1, invoiceNo: 1 }, { unique: true, name: 'one_invoice_per_supplier_number' }),
      // HR & payroll (spec §5.22): one shift per person per day, one payroll per month and currency.
      db.collection('employees').createIndex({ tenantId: 1, staffNumber: 1 }, { unique: true }),
      db.collection('employees').createIndex({ tenantId: 1, userId: 1 }, { unique: true, partialFilterExpression: { userId: { $type: 'objectId' } } }),
      db.collection('credentials').createIndex({ tenantId: 1, expiresOn: 1 }),
      db.collection('roster_shifts').createIndex({ employeeId: 1, date: 1 }, { unique: true, name: 'one_shift_per_day' }),
      db.collection('roster_shifts').createIndex({ tenantId: 1, date: 1 }),
      db.collection('leave_requests').createIndex({ tenantId: 1, status: 1, from: 1 }),
      db.collection('payroll_runs').createIndex({ tenantId: 1, period: 1, currency: 1 }, { unique: true }),
      // Reporting & AI (spec §5.29–5.32): immutable, versioned metric snapshots.
      db.collection('metric_snapshots').createIndex({ tenantId: 1, kind: 1, period: 1, currency: 1, seq: 1 }, { unique: true, name: 'one_snapshot_version' }),
      db.collection('diagnoses').createIndex({ tenantId: 1, recordedAt: 1, code: 1 }),
      db.collection('ai_insights').createIndex({ tenantId: 1, kind: 1, createdAt: -1 }),
      db.collection('care_plans').createIndex({ tenantId: 1, admissionId: 1, status: 1 }),
      db.collection('handovers').createIndex({ tenantId: 1, wardId: 1, createdAt: -1 }),
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
