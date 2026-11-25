/** Local development only: drops the Fahan databases on the dev replica set (port 27018) so seed:demo can run again. */
import { MongoClient } from 'mongodb';
import { loadConfig } from '../config';

const config = loadConfig();
const port = new URL(config.mongoUri.replace(/^mongodb(\+srv)?:\/\//, 'http://')).port;
if (config.env === 'production' || port !== '27018') {
  console.error(`Refused: only the local dev database on port 27018 is reset (got port ${port || 'default'}).`);
  process.exit(1);
}
const client = new MongoClient(config.mongoUri);
await client.connect();
const { databases } = await client.db().admin().listDatabases();
for (const d of databases.filter((x) => x.name === config.controlDb || /^fahan_t_/.test(x.name))) {
  await client.db(d.name).dropDatabase();
  console.log(`dropped ${d.name}`);
}
await client.close();
