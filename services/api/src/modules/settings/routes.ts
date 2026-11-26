import { Router, type Request } from 'express';
import { z } from 'zod';
import { ADMIN_MODULES, MODULE_KEYS, isModuleKey, type ModuleKey } from '@fahan/policy';
import type { Deps } from '../../context';
import { parse } from '../../lib/validate';
import { audit } from '../../middleware/audit';
import { need } from '../../middleware/authorize';
import { requireRecentMfa } from '../../middleware/session';
import { disabledModules } from './features';

/** Modules that keep the hospital administrable and auditable; they can never be switched off. */
export const ALWAYS_ON: readonly ModuleKey[] = [...ADMIN_MODULES, 'mpi'];

const Profile = z.object({
  displayName: z.string().trim().min(2).max(120),
  phone: z.string().trim().max(40).optional(),
  address: z.string().trim().max(300).optional(),
  currency: z.enum(['USD', 'SOS']),
  receiptFooter: z.string().trim().max(200).optional(),
});
const Features = z.object({
  disabled: z
    .array(z.string())
    .max(MODULE_KEYS.length)
    .transform((a) => [...new Set(a)])
    .refine((a) => a.every(isModuleKey), 'Unknown module')
    .refine((a) => !a.some((k) => ALWAYS_ON.includes(k as ModuleKey)), 'Administration, security and patient registration cannot be switched off'),
  reason: z.string().trim().min(3).max(300),
});

/** Spec §3.3 Super Admin console: hospital profile and the module switchboard. */
export function settingsRoutes(deps: Deps): Router {
  const r = Router();
  const col = (req: Request) => req.actor!.db!.collection<{ _id: string } & Record<string, unknown>>('settings');

  r.get('/settings', async (req, res) => {
    const [profile, features] = await Promise.all([col(req).findOne({ _id: 'profile' }), col(req).findOne({ _id: 'features' })]);
    res.json({
      data: {
        profile: {
          displayName: (profile?.displayName as string) ?? req.actor!.tenantName,
          phone: profile?.phone ?? null,
          address: profile?.address ?? null,
          currency: profile?.currency ?? 'USD',
          receiptFooter: profile?.receiptFooter ?? null,
        },
        disabled: features?.disabled ?? [],
        alwaysOn: ALWAYS_ON,
        history: ((features?.history as unknown[]) ?? []).slice(-20),
      },
    });
  });

  r.put('/settings/profile', need(deps, 'org', 'E'), async (req, res) => {
    const body = parse(Profile, req.body);
    await col(req).updateOne({ _id: 'profile' }, { $set: { ...body, updatedAt: new Date(), updatedBy: req.actor!.userId } }, { upsert: true });
    await audit(deps, req, { action: 'org.profile.update', resource: 'settings:profile', outcome: 'success' });
    res.json({ data: body });
  });

  r.put('/settings/features', need(deps, 'org', 'A'), requireRecentMfa(deps), async (req, res) => {
    const body = parse(Features, req.body);
    const before = await disabledModules(req.actor!.db!);
    await col(req).updateOne(
      { _id: 'features' },
      { $set: { disabled: body.disabled, updatedAt: new Date(), updatedBy: req.actor!.userId }, $push: { history: { at: new Date(), byName: req.actor!.name, disabled: body.disabled, reason: body.reason } } as never },
      { upsert: true },
    );
    await audit(deps, req, { action: 'org.features.update', resource: 'settings:features', outcome: 'success', meta: { from: before.join(','), to: body.disabled.join(','), reason: body.reason } });
    res.json({ data: { disabled: body.disabled } });
  });

  return r;
}
