/**
 * Read-path load test (spec §13.2: p95 read under 500 ms on an agreed load profile; validate, do not assume).
 *   npm run load-test -- [--base http://localhost:4000] [--user reception] [--concurrency 20] [--seconds 20]
 * Signs in once with the demo credentials (local development only), then keeps N clients busy reading common screens.
 * Results are written to .data/load/<time>.json. Numbers from a laptop and a dev server are indicative only; repeat
 * on the staging hardware with the agreed profile before relying on them.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { authenticator } from 'otplib';

const { values } = parseArgs({ options: { base: { type: 'string', default: 'http://localhost:4000' }, user: { type: 'string', default: 'reception' }, concurrency: { type: 'string', default: '20' }, seconds: { type: 'string', default: '20' } } });
const base = values.base!;
const conc = Math.max(1, Number(values.concurrency));
const seconds = Math.max(5, Number(values.seconds));

const creds = readFileSync(resolve('.data/demo-credentials.txt'), 'utf8');
const password = /password for every hospital user: (\S+)/.exec(creds)?.[1];
const secret = new RegExp(`${values.user}@hiil\\.test\\s+TOTP (\\S+)`).exec(creds)?.[1];
if (!password || !secret) throw new Error(`No demo credentials for ${values.user}; run npm run seed:demo first`);

let cookie = '';
async function call(path: string, init: RequestInit = {}) {
  const r = await fetch(`${base}/api/v1${path}`, { ...init, headers: { 'content-type': 'application/json', cookie, ...(init.headers ?? {}) } });
  const set = r.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  return r;
}
const login = await call('/auth/login', { method: 'POST', body: JSON.stringify({ email: `${values.user}@hiil.test`, password, tenant: 'hiil' }) });
if (login.status !== 200) throw new Error(`Sign-in failed: ${login.status}`);
const csrf = ((await login.json()) as { data: { csrfToken: string } }).data.csrfToken;
const mfa = await call('/auth/mfa/verify', { method: 'POST', body: JSON.stringify({ code: authenticator.generate(secret) }), headers: { 'x-csrf-token': csrf } });
if (mfa.status !== 200) throw new Error(`MFA failed: ${mfa.status} (wait 30 s if this code was just used)`);

const patients = ((await (await call('/patients')).json()) as { data: { id: string }[] }).data;
const pid = patients[0]?.id;
const paths = ['/auth/me', '/patients', '/patients?q=asha', ...(pid ? [`/patients/${pid}`] : []), '/billing/invoices'];

const samples = new Map<string, number[]>(paths.map((p) => [p, []]));
const errors = new Map<string, number>();
const until = Date.now() + seconds * 1000;
let i = 0;
async function worker() {
  while (Date.now() < until) {
    const p = paths[i++ % paths.length]!;
    const t0 = performance.now();
    const r = await fetch(`${base}/api/v1${p}`, { headers: { cookie } }).catch(() => null);
    const ms = performance.now() - t0;
    if (!r || r.status >= 400) errors.set(p, (errors.get(p) ?? 0) + 1);
    else samples.get(p)!.push(ms);
    await r?.arrayBuffer().catch(() => undefined);
  }
}
const started = Date.now();
await Promise.all(Array.from({ length: conc }, worker));
const elapsed = (Date.now() - started) / 1000;

const pct = (xs: number[], q: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(q * xs.length) - 1)]! : NaN);
const rows = paths.map((p) => {
  const xs = samples.get(p)!;
  return { path: p.replace(pid ?? '__', ':id'), requests: xs.length, errors: errors.get(p) ?? 0, p50: Math.round(pct(xs, 0.5)), p95: Math.round(pct(xs, 0.95)), p99: Math.round(pct(xs, 0.99)) };
});
const all = [...samples.values()].flat();
const summary = { base, user: values.user, concurrency: conc, seconds: elapsed, requests: all.length, rps: Math.round(all.length / elapsed), p95: Math.round(pct(all, 0.95)), targetP95Ms: 500, meetsTarget: pct(all, 0.95) < 500, endpoints: rows, at: new Date().toISOString() };
console.table(rows);
console.log(`${summary.requests} requests in ${elapsed.toFixed(1)} s (${summary.rps}/s) with ${conc} concurrent clients; overall p95 ${summary.p95} ms — target 500 ms: ${summary.meetsTarget ? 'met' : 'NOT met'}`);
mkdirSync(resolve('.data/load'), { recursive: true });
writeFileSync(resolve(`.data/load/${summary.at.replace(/[:.]/g, '-')}.json`), JSON.stringify(summary, null, 2));
