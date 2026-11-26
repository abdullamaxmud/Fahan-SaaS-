import { Router, type Request } from 'express';
import type { Document, ObjectId } from 'mongodb';
import { z } from 'zod';
import { can } from '@fahan/policy';
import type { Deps } from '../../context';
import { AppError, Errors } from '../../lib/errors';
import { idParam, parse } from '../../lib/validate';
import { audit } from '../../middleware/audit';
import { deny, need } from '../../middleware/authorize';
import { assertRecentMfa } from '../../middleware/session';

/**
 * Spec §5.35 security, audit & operations, and §11.1 "privilege review": periodic access reviews in which every account
 * is certified or revoked by someone other than its owner, and confidential security incidents that move
 * Detected → Investigated → Remediated → Closed with written remediation and root cause.
 */
const id = (x: Document) => (x._id as ObjectId).toHexString();
const INCIDENT_FLOW = ['Detected', 'Investigated', 'Remediated', 'Closed'] as const;

export function securityRoutes(deps: Deps): Router {
  const r = Router();
  const db = (req: Request) => req.actor!.db!;
  const reviews = (req: Request) => db(req).collection('access_reviews');
  const incidents = (req: Request) => db(req).collection('security_incidents');
  const push = (req: Request, action: string, note?: string) => ({ history: { at: new Date(), action, by: req.actor!.userId, byName: req.actor!.name, note } });

  async function reviewViewer(req: Request) {
    const p = req.actor!.perms;
    if (!can(p, 'iam', 'E') && !can(p, 'sec', 'V')) await deny(deps, req, 'access-reviews', 'requires user administration or security access');
  }
  const reviewView = (x: Document) => ({
    id: id(x),
    title: x.title,
    status: x.status,
    startedAt: x.startedAt,
    startedByName: x.startedByName,
    completedAt: x.completedAt ?? null,
    items: (x.items as Document[]).map((i) => ({ userId: (i.userId as ObjectId).toHexString(), name: i.name, email: i.email, roles: i.roles, lastLoginAt: i.lastLoginAt ?? null, decision: i.decision ?? null, decidedByName: i.decidedByName ?? null, note: i.note ?? null })),
    summary: { total: (x.items as Document[]).length, kept: (x.items as Document[]).filter((i) => i.decision === 'keep').length, revoked: (x.items as Document[]).filter((i) => i.decision === 'revoke').length },
  });

  // ---- access reviews ----
  r.get('/access-reviews', async (req, res) => {
    await reviewViewer(req);
    const list = await reviews(req).find({ tenantId: req.actor!.tenantId }).sort({ startedAt: -1 }).limit(24).toArray();
    res.json({ data: list.map(reviewView) });
  });

  r.get('/access-reviews/:id', async (req, res) => {
    await reviewViewer(req);
    const x = await reviews(req).findOne({ _id: idParam(req.params.id, 'Review'), tenantId: req.actor!.tenantId });
    if (!x) throw Errors.notFound('Access review');
    res.json({ data: reviewView(x) });
  });

  r.post('/access-reviews', async (req, res) => {
    const { title } = parse(z.object({ title: z.string().trim().min(3).max(120) }), req.body);
    const a = req.actor!;
    if (!can(a.perms, 'iam', 'A') && !can(a.perms, 'sec', 'E')) await deny(deps, req, 'access-reviews', 'starting a review requires iam:A or sec:E');
    if (await reviews(req).findOne({ tenantId: a.tenantId, status: 'Open' })) throw Errors.conflict('REVIEW_OPEN', 'Finish the open access review first');
    const users = await db(req).collection('users').find({ tenantId: a.tenantId, status: 'Active' }, { projection: { name: 1, email: 1, roles: 1, lastLoginAt: 1 } }).sort({ name: 1 }).toArray();
    const doc = { tenantId: a.tenantId, title, status: 'Open', startedAt: new Date(), startedBy: a.userId, startedByName: a.name, items: users.map((u) => ({ userId: u._id, name: u.name, email: u.email, roles: u.roles, lastLoginAt: u.lastLoginAt })) };
    const ins = await reviews(req).insertOne(doc);
    await audit(deps, req, { action: 'sec.access_review.start', resource: `access_review:${ins.insertedId.toHexString()}`, outcome: 'success', meta: { accounts: users.length } });
    res.status(201).json({ data: reviewView({ _id: ins.insertedId, ...doc }) });
  });

  r.post('/access-reviews/:id/items/:userId/decide', need(deps, 'iam', 'E'), async (req, res) => {
    const body = parse(z.object({ decision: z.enum(['keep', 'revoke']), note: z.string().trim().max(300).optional() }), req.body);
    const a = req.actor!;
    const userId = idParam(req.params.userId, 'User');
    if (userId.equals(a.userId)) throw new AppError(403, 'FOUR_EYES', 'Someone else certifies your own access');
    assertRecentMfa(deps, req);
    const x = await reviews(req).findOne({ _id: idParam(req.params.id, 'Review'), tenantId: a.tenantId, status: 'Open' });
    if (!x) throw Errors.notFound('Open access review');
    const item = (x.items as Document[]).find((i) => (i.userId as ObjectId).equals(userId));
    if (!item) throw Errors.notFound('Account in this review');
    if (body.decision === 'revoke') {
      // Same effect as suspending the user: no further requests, every session ends now.
      await db(req).collection('users').updateOne({ _id: userId, tenantId: a.tenantId, status: 'Active' }, { $set: { status: 'Suspended', updatedAt: new Date(), updatedBy: a.userId }, $inc: { version: 1 } });
      await deps.data.control().collection('sessions').deleteMany({ userId });
      await audit(deps, req, { action: 'iam.user.suspend', resource: `user:${userId.toHexString()}`, outcome: 'success', meta: { via: 'access-review' } });
    }
    await reviews(req).updateOne(
      { _id: x._id, 'items.userId': userId },
      { $set: { 'items.$.decision': body.decision, 'items.$.decidedBy': a.userId, 'items.$.decidedByName': a.name, 'items.$.note': body.note, 'items.$.decidedAt': new Date() } },
    );
    const after = await reviews(req).findOne({ _id: x._id });
    const done = (after!.items as Document[]).every((i) => i.decision);
    if (done) await reviews(req).updateOne({ _id: x._id, status: 'Open' }, { $set: { status: 'Completed', completedAt: new Date() } });
    await audit(deps, req, { action: 'sec.access_review.decide', resource: `access_review:${id(x)}`, outcome: 'success', meta: { user: userId.toHexString(), decision: body.decision } });
    res.json({ data: { decision: body.decision, reviewStatus: done ? 'Completed' : 'Open' } });
  });

  // ---- security incidents (confidential: security roles only) ----
  const incidentView = (x: Document) => ({
    id: id(x),
    number: x.number,
    title: x.title,
    severity: x.severity,
    category: x.category,
    description: x.description,
    status: x.status,
    remediation: x.remediation ?? null,
    rootCause: x.rootCause ?? null,
    relatedAuditSeqs: x.relatedAuditSeqs ?? [],
    reportedByName: x.reportedByName,
    detectedAt: x.detectedAt,
    history: ((x.history as Document[]) ?? []).map((h) => ({ at: h.at, action: h.action, byName: h.byName, note: h.note ?? null })),
  });

  r.get('/incidents', need(deps, 'sec', 'V'), async (req, res) => {
    const list = await incidents(req).find({ tenantId: req.actor!.tenantId }).sort({ detectedAt: -1 }).limit(200).toArray();
    res.json({ data: list.map(incidentView) });
  });

  r.post('/incidents', need(deps, 'sec', 'V'), async (req, res) => {
    const body = parse(
      z.object({
        title: z.string().trim().min(5).max(160),
        severity: z.enum(['low', 'medium', 'high', 'critical']),
        category: z.enum(['security', 'privacy', 'clinical-data', 'availability', 'fraud']),
        description: z.string().trim().min(10).max(4000),
        relatedAuditSeqs: z.array(z.number().int().positive()).max(50).default([]),
      }),
      req.body,
    );
    const a = req.actor!;
    const y = new Date().getUTCFullYear();
    const c = await db(req).collection<{ _id: string; seq: number }>('counters').findOneAndUpdate({ _id: `inc:${y}` }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
    const doc = { tenantId: a.tenantId, number: `SEC-${y}-${String(c!.seq).padStart(4, '0')}`, ...body, status: 'Detected', reportedBy: a.userId, reportedByName: a.name, detectedAt: new Date(), history: [push(req, 'detected').history] };
    const ins = await incidents(req).insertOne(doc);
    await audit(deps, req, { action: 'sec.incident.report', resource: `incident:${ins.insertedId.toHexString()}`, outcome: 'success', meta: { severity: body.severity, category: body.category } });
    res.status(201).json({ data: incidentView({ _id: ins.insertedId, ...doc }) });
  });

  r.post('/incidents/:id/advance', need(deps, 'sec', 'E'), async (req, res) => {
    const body = parse(z.object({ note: z.string().trim().min(5).max(2000), remediation: z.string().trim().min(10).max(4000).optional(), rootCause: z.string().trim().min(10).max(4000).optional(), relatedAuditSeqs: z.array(z.number().int().positive()).max(50).optional() }), req.body);
    const a = req.actor!;
    const x = await incidents(req).findOne({ _id: idParam(req.params.id, 'Incident'), tenantId: a.tenantId });
    if (!x) throw Errors.notFound('Incident');
    const i = INCIDENT_FLOW.indexOf(x.status);
    const to = INCIDENT_FLOW[i + 1];
    if (!to) throw Errors.conflict('INVALID_TRANSITION', 'This incident is closed');
    if (to === 'Remediated' && !body.remediation) throw Errors.validation([{ path: 'remediation', message: 'Describe what was done to fix it' }]);
    if (to === 'Closed') {
      if (!body.rootCause) throw Errors.validation([{ path: 'rootCause', message: 'Record the root cause before closing' }]);
      if ((x.reportedBy as ObjectId).equals(a.userId)) throw new AppError(403, 'FOUR_EYES', 'Someone other than the reporter closes an incident');
    }
    const set: Document = { status: to };
    if (body.remediation) set.remediation = body.remediation;
    if (body.rootCause) set.rootCause = body.rootCause;
    const upd = await incidents(req).updateOne(
      { _id: x._id, status: x.status },
      { $set: set, ...(body.relatedAuditSeqs ? { $addToSet: { relatedAuditSeqs: { $each: body.relatedAuditSeqs } } } : {}), $push: push(req, to.toLowerCase(), body.note) as Document },
    );
    if (!upd.modifiedCount) throw Errors.conflict('INVALID_TRANSITION', 'Someone else moved this incident meanwhile');
    await audit(deps, req, { action: `sec.incident.${to.toLowerCase()}`, resource: `incident:${id(x)}`, outcome: 'success' });
    res.json({ data: { id: id(x), status: to } });
  });

  return r;
}
