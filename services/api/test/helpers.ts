import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { authenticator } from 'otplib';
import supertest from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app';
import { loadConfig, type Config } from '../src/config';
import { Data } from '../src/db/mongo';

export interface Harness {
  rs: MongoMemoryReplSet;
  data: Data;
  config: Config;
  app: Express;
  stop(): Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  const rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  const config = loadConfig({ NODE_ENV: 'test', MONGO_URI: rs.getUri(), CONTROL_DB: `ctl_${Date.now()}` });
  const data = await Data.connect(config.mongoUri, config.controlDb);
  const app = createApp({ data, config });
  return {
    rs,
    data,
    config,
    app,
    async stop() {
      await data.close();
      await rs.stop();
    },
  };
}

/** A cookie-carrying client that adds the CSRF header like the web app does. */
export class Client {
  readonly agent: ReturnType<typeof supertest.agent>;
  csrf = '';
  constructor(app: Express) {
    this.agent = supertest.agent(app);
  }
  get(path: string) {
    return this.agent.get(`/api/v1${path}`);
  }
  post(path: string, body?: object) {
    return this.agent.post(`/api/v1${path}`).set('x-csrf-token', this.csrf).send(body ?? {});
  }
  put(path: string, body?: object) {
    return this.agent.put(`/api/v1${path}`).set('x-csrf-token', this.csrf).send(body ?? {});
  }
  patch(path: string, body?: object) {
    return this.agent.patch(`/api/v1${path}`).set('x-csrf-token', this.csrf).send(body ?? {});
  }

  async login(email: string, password: string, tenant?: string) {
    const res = await this.agent.post('/api/v1/auth/login').send({ email, password, tenant });
    if (res.status === 200) this.csrf = res.body.data.csrfToken;
    return res;
  }

  /** Completes MFA enrolment (first login) or verification and returns the TOTP secret. */
  async completeMfa(secret?: string): Promise<string> {
    let s = secret;
    if (!s) {
      const en = await this.post('/auth/mfa/enroll');
      if (en.status !== 200) throw new Error(`enroll failed: ${en.status} ${JSON.stringify(en.body)}`);
      s = en.body.data.secret as string;
    }
    let v = await this.post('/auth/mfa/verify', { code: authenticator.generate(s) });
    // A code is accepted once; like a person, take the next one if this one was just used.
    if (v.status === 401 && v.body?.error?.code === 'INVALID_MFA_CODE') v = await this.post('/auth/mfa/verify', { code: authenticator.clone({ epoch: Date.now() + 30_000 }).generate(s) });
    if (v.status !== 200) throw new Error(`verify failed: ${v.status} ${JSON.stringify(v.body)}`);
    return s;
  }
}
