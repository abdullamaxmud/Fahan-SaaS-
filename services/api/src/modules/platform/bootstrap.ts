import { writeAudit } from '../../audit/audit';
import type { Config } from '../../config';
import type { Data } from '../../db/mongo';
import { encrypt, newToken } from '../../lib/crypto';
import { hashPassword, totp } from '../../lib/secrets';

export class AlreadyBootstrappedError extends Error {
  constructor() {
    super('The platform owner already exists. Bootstrap is disabled.');
  }
}

/**
 * Spec §3.1: one-time, audited owner bootstrap with MFA enrolment. The `platform_state/bootstrap`
 * marker is written in the same transaction as the owner, so a second run always fails.
 */
export async function bootstrapOwner(data: Data, config: Config, input: { email: string; name: string }) {
  const control = data.control();
  const password = newToken(18);
  const secret = totp.newSecret();
  const passwordHash = await hashPassword(password);
  const now = new Date();
  let ownerId = '';

  const session = data.client.startSession();
  try {
    await session.withTransaction(async () => {
      await control.collection<{ _id: string }>('platform_state').insertOne({ _id: 'bootstrap', at: now, email: input.email } as never, { session });
      const res = await control.collection('platform_users').insertOne(
        {
          email: input.email,
          name: input.name,
          roles: ['platform-owner'],
          status: 'Active',
          passwordHash,
          mfa: { secret: encrypt(secret, config.dataKey), enrolledAt: now },
          createdAt: now,
          version: 1,
        },
        { session },
      );
      ownerId = res.insertedId.toHexString();
    });
  } catch (e) {
    if ((e as { code?: number }).code === 11000) throw new AlreadyBootstrappedError();
    throw e;
  } finally {
    await session.endSession();
  }

  await writeAudit(control, {
    actorId: ownerId,
    actorRoles: ['platform-owner'],
    action: 'platform.bootstrap',
    resource: `platform_user:${ownerId}`,
    outcome: 'success',
    meta: { via: 'cli' },
  });
  return { ownerId, password, secret, otpauthUri: totp.uri(input.email, secret) };
}
