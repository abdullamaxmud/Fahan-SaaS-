/**
 * One-time platform owner bootstrap (spec §3.1).
 *   npm run bootstrap:owner -- --email owner@example.com --name "Platform Owner"
 * Requires direct database access (deployment privilege). A second run is refused.
 */
import { parseArgs } from 'node:util';
import { loadConfig } from '../config';
import { Data } from '../db/mongo';
import { AlreadyBootstrappedError, bootstrapOwner } from '../modules/platform/bootstrap';

const { values } = parseArgs({ options: { email: { type: 'string' }, name: { type: 'string' } } });
if (!values.email || !values.name) {
  console.error('Usage: npm run bootstrap:owner -- --email <email> --name "<full name>"');
  process.exit(2);
}

const config = loadConfig();
const data = await Data.connect(config.mongoUri, config.controlDb);
try {
  const r = await bootstrapOwner(data, config, { email: values.email.trim().toLowerCase(), name: values.name.trim() });
  console.log('\nPlatform owner created. These values are shown ONCE — store them in your password manager now.\n');
  console.log(`  Email:            ${values.email}`);
  console.log(`  Temporary password: ${r.password}`);
  console.log(`  Authenticator URI:  ${r.otpauthUri}`);
  console.log(`  (manual key:        ${r.secret})\n`);
  console.log('Add the URI to an authenticator app, then sign in without a hospital code.\n');
} catch (e) {
  if (e instanceof AlreadyBootstrappedError) {
    console.error(`Refused: ${e.message}`);
    process.exitCode = 1;
  } else throw e;
} finally {
  await data.close();
}
