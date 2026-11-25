import { hash, verify } from '@node-rs/argon2';
import { authenticator } from 'otplib';

authenticator.options = { window: 1 };

/** Argon2id (the @node-rs/argon2 default) with library-recommended cost parameters. */
export const hashPassword = (pw: string) => hash(pw);

let dummy: Promise<string> | undefined;
/** Verifies a password; when the account does not exist, burns equal time against a dummy hash. */
export async function checkPassword(stored: string | undefined, pw: string): Promise<boolean> {
  if (!stored) {
    dummy ??= hash('timing-equaliser-not-a-password');
    await verify(await dummy, pw).catch(() => false);
    return false;
  }
  return verify(stored, pw).catch(() => false);
}

export const totp = {
  newSecret: () => authenticator.generateSecret(),
  uri: (account: string, secret: string) => authenticator.keyuri(account, 'Fahan', secret),
  check: (code: string, secret: string) => authenticator.check(code, secret),
};
