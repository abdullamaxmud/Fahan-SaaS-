import { createHmac, timingSafeEqual } from 'node:crypto';
import express, { Router } from 'express';
import type { Db, Document } from 'mongodb';
import { z } from 'zod';
import { writeAudit } from '../../audit/audit';
import type { Deps } from '../../context';
import { decrypt } from '../../lib/crypto';
import { localDate } from '../../lib/time';
import { CURRENCIES } from '../accounting/ledger';
import { applyPayment } from './service';

/** Spec §8.1 / §12.1: provider callbacks are signed, fresh (5 minutes), and idempotent by provider transaction id. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;
export const PROVIDERS = ['evc-plus', 'zaad', 'sahal', 'edahab', 'card-acquirer'] as const;

const Event = z.object({
  eventId: z.string().trim().min(4).max(80),
  transactionId: z.string().trim().min(4).max(80),
  status: z.enum(['succeeded', 'failed', 'reversed']),
  invoiceNumber: z.string().trim().max(40),
  amountMinor: z.number().int().positive().max(1e12),
  currency: z.enum(CURRENCIES),
  payer: z.string().trim().max(40).optional(),
});

export const signPayload = (secret: string, timestamp: string, raw: string) => createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');

function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** Mounted at /api/v1/webhooks/payments, outside the cookie session and CSRF guard, with its own raw body parser. */
export function paymentWebhookRoutes(deps: Deps): Router {
  const r = Router();
  r.use(express.raw({ type: 'application/json', limit: '32kb' }));

  r.post('/:tenant/:provider', async (req, res) => {
    const reject = () => res.status(401).json({ error: { code: 'INVALID_SIGNATURE', message: 'Signature or timestamp is not valid' } });
    const tenant = /^[a-z0-9-]{3,40}$/.test(req.params.tenant) ? await deps.data.control().collection('tenants').findOne({ slug: req.params.tenant, status: 'Active' }) : null;
    if (!tenant) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } });
    const db = deps.data.tenant(tenant.dbName as string);
    const log = (outcome: 'success' | 'deny', action: string, meta: Record<string, string | number | boolean | null>) =>
      writeAudit(db, { action, resource: `payment_provider:${req.params.provider}`, outcome, meta, tenantId: tenant._id.toHexString(), actorId: null, actorRoles: ['payment-provider'], correlationId: req.correlationId });

    // 1. Authenticate the sender before reading anything it says.
    const cfg = await db.collection('payment_providers').findOne({ tenantId: tenant._id, provider: req.params.provider, active: true });
    const ts = req.get('x-fahan-timestamp') ?? '';
    const sig = req.get('x-fahan-signature') ?? '';
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    const age = Math.abs(Math.floor(deps.config.now().getTime() / 1000) - Number(ts));
    if (!cfg || !/^\d{9,11}$/.test(ts) || !(age <= WEBHOOK_TOLERANCE_SECONDS) || !safeEqualHex(sig, signPayload(decrypt(cfg.secretEnc, deps.config.dataKey), ts, raw))) {
      await log('deny', 'bill.webhook.reject', { reason: !cfg ? 'unknown provider' : age > WEBHOOK_TOLERANCE_SECONDS ? 'stale timestamp' : 'bad signature' });
      return reject();
    }

    let ev: z.infer<typeof Event>;
    try {
      const parsed = Event.safeParse(JSON.parse(raw));
      if (!parsed.success) return res.status(400).json({ error: { code: 'VALIDATION_FAILED', message: 'Payload does not match the event schema' } });
      ev = parsed.data;
    } catch {
      return res.status(400).json({ error: { code: 'VALIDATION_FAILED', message: 'Body is not JSON' } });
    }

    // 2. Record the event once; the unique (provider, transaction) index makes retries harmless.
    const base = { tenantId: tenant._id, provider: cfg.provider, transactionId: ev.transactionId, eventId: ev.eventId, invoiceNumber: ev.invoiceNumber, amountMinor: ev.amountMinor, currency: ev.currency, payer: ev.payer, receivedAt: new Date() };
    const s = deps.data.client.startSession();
    let outcome: Document = {};
    try {
      await s.withTransaction(async () => {
        const inv = ev.status === 'succeeded' ? await db.collection('invoices').findOne({ tenantId: tenant._id, invoiceNumber: ev.invoiceNumber }, { session: s }) : null;
        const why =
          ev.status !== 'succeeded' ? null
          : !inv ? 'invoice not found'
          : !['Issued', 'PartiallyPaid'].includes(inv.status) ? `invoice is ${String(inv.status).toLowerCase()}`
          : inv.currency !== ev.currency ? 'currency does not match the invoice'
          : ev.amountMinor > inv.balanceMinor - (inv.insuranceHoldMinor ?? 0) ? 'amount is more than the balance due'
          : null;
        if (ev.status !== 'succeeded' || why) {
          // Unmatched money is parked for the billing officer rather than guessed at.
          const status = ev.status !== 'succeeded' ? 'ignored' : 'unmatched';
          await db.collection('payment_events').insertOne({ ...base, providerStatus: ev.status, status, reason: why ?? `provider reported ${ev.status}` }, { session: s });
          outcome = { status, reason: why };
          return;
        }
        const ins = await db.collection('payment_events').insertOne({ ...base, providerStatus: ev.status, status: 'applied' }, { session: s });
        const p = await applyPayment(db as Db, s, {
          tenantId: tenant._id,
          invoice: inv!,
          amountMinor: ev.amountMinor,
          method: cfg.provider === 'card-acquirer' ? 'card' : 'mobile-money',
          reference: ev.transactionId,
          idempotencyKey: `${cfg.provider}:${ev.transactionId}`,
          by: cfg._id,
          receivedOn: localDate(deps.config.now(), 'Africa/Mogadishu'),
          provider: cfg.provider,
        });
        await db.collection('payment_events').updateOne({ _id: ins.insertedId }, { $set: { receiptNo: p.receiptNo, invoiceId: inv!._id } }, { session: s });
        outcome = { status: 'applied', receiptNo: p.receiptNo };
      });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) return res.json({ data: { duplicate: true } });
      throw e;
    } finally {
      await s.endSession();
    }
    await log('success', 'bill.webhook.accept', { transactionId: ev.transactionId, status: String(outcome.status), receiptNo: (outcome.receiptNo as string) ?? null });
    res.json({ data: outcome });
  });

  return r;
}
