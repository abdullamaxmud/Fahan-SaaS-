import { pino } from 'pino';
import { createApp } from './app';
import { loadConfig } from './config';
import { Data } from './db/mongo';

const log = pino({ level: 'info' });
const config = loadConfig();
const data = await Data.connect(config.mongoUri, config.controlDb);
const server = createApp({ data, config }, log).listen(config.port, () => {
  log.info({ port: config.port, env: config.env }, 'HospitalOS API listening');
});

async function shutdown(signal: string) {
  log.info({ signal }, 'shutting down');
  server.close();
  await data.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
