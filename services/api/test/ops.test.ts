import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupHospital, type Hospital } from './fixtures';
import { startHarness, type Harness } from './helpers';

/** Spec §13.4 monitoring: readiness, protected metrics, error and denial counters, no identifiers in labels. */
let h: Harness;
let H: Hospital;
const TOKEN = 'monitoring-token-for-tests-only-0001';

beforeAll(async () => {
  h = await startHarness();
  H = await setupHospital(h, [
    { key: 'reception', role: 'reception' },
    { key: 'cashier', role: 'cashier' },
  ]);
});
afterAll(async () => {
  await h?.stop();
});

describe('health and metrics', () => {
  it('readiness answers only when the database does', async () => {
    const r = await supertest(h.app).get('/health/ready');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: 'ready', db: 'ok' });
  });

  it('metrics are off without a configured token, and need it when on', async () => {
    h.config.metricsToken = undefined;
    expect((await supertest(h.app).get('/metrics')).status).toBe(404);
    h.config.metricsToken = TOKEN;
    expect((await supertest(h.app).get('/metrics')).status).toBe(401);
    expect((await supertest(h.app).get('/metrics').set('authorization', 'Bearer wrong-token-wrong-token-0000')).status).toBe(401);
    expect((await supertest(h.app).get('/metrics').set('authorization', `Bearer ${TOKEN}`)).status).toBe(200);
  });

  it('counts requests by route template, errors by code and denials by action — never ids or names', async () => {
    const pid = (await H.staff.reception!.c.post('/patients', { branchId: H.branchId, givenName: 'Metric', familyName: 'Person', dob: '1990-01-01' })).body.data.id;
    await H.staff.reception!.c.get(`/patients/${pid}`);
    await H.staff.reception!.c.post('/patients', { givenName: '' });
    await H.staff.cashier!.c.get('/encounters');
    const text = (await supertest(h.app).get('/metrics').set('authorization', `Bearer ${TOKEN}`)).text;
    expect(text).toMatch(/fahan_http_requests_total\{[^}]*route="\/api\/v1\/patients\/:id"[^}]*\} \d+/);
    expect(text).toMatch(/fahan_http_request_duration_seconds_bucket\{[^}]*le="0.5"\} \d+/);
    expect(text).toMatch(/fahan_errors_total\{code="VALIDATION_FAILED"\} [1-9]/);
    expect(text).toMatch(/fahan_audit_events_total\{action="[^"]+",outcome="deny"\} [1-9]/);
    expect(text).not.toContain(pid);
    expect(text).not.toContain('Metric');
  });
});
