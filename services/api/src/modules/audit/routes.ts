import { Router } from 'express';
import { z } from 'zod';
import { verifyAuditChain } from '../../audit/audit';
import type { Deps } from '../../context';
import { parse } from '../../lib/validate';
import { need } from '../../middleware/authorize';

const Query = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** Spec §5.35 audit explorer: newest first, cursor = sequence number. */
export function auditRoutes(deps: Deps): Router {
  const r = Router();

  r.get('/events', need(deps, 'sec', 'V'), async (req, res) => {
    const q = parse(Query, req.query);
    const list = await req
      .actor!.db!.collection('audit_events')
      .find(q.before ? { seq: { $lt: q.before } } : {}, { projection: { _id: 0 } })
      .sort({ seq: -1 })
      .limit(q.limit)
      .toArray();
    const last = list.at(-1);
    res.json({ data: list, meta: { nextCursor: list.length === q.limit && last ? last.seq : null } });
  });

  r.get('/verify', need(deps, 'sec', 'V'), async (req, res) => {
    res.json({ data: await verifyAuditChain(req.actor!.db!) });
  });

  return r;
}
