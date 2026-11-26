import type { RequestHandler } from 'express';

/**
 * Operational metrics (spec §13.4) in Prometheus text format, with no external dependency.
 * Labels are route templates (`/patients/:id`), error codes and audit actions — never ids or patient data — so
 * cardinality stays bounded and nothing identifying reaches the monitoring system.
 */
const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

type Labels = Record<string, string>;
const key = (l: Labels) =>
  Object.keys(l)
    .sort()
    .map((k) => `${k}="${String(l[k]).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`)
    .join(',');

class Counter {
  private v = new Map<string, number>();
  constructor(readonly name: string, readonly help: string) {}
  inc(l: Labels = {}, n = 1) {
    const k = key(l);
    this.v.set(k, (this.v.get(k) ?? 0) + n);
  }
  get(l: Labels = {}) {
    return this.v.get(key(l)) ?? 0;
  }
  render() {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [k, n] of this.v) out.push(`${this.name}${k ? `{${k}}` : ''} ${n}`);
    return out.join('\n');
  }
}

class Histogram {
  private v = new Map<string, { buckets: number[]; sum: number; count: number }>();
  constructor(readonly name: string, readonly help: string) {}
  observe(l: Labels, seconds: number) {
    const k = key(l);
    const h = this.v.get(k) ?? { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 };
    BUCKETS.forEach((b, i) => {
      if (seconds <= b) h.buckets[i]!++;
    });
    h.sum += seconds;
    h.count++;
    this.v.set(k, h);
  }
  render() {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [k, h] of this.v) {
      const pre = k ? `${k},` : '';
      BUCKETS.forEach((b, i) => out.push(`${this.name}_bucket{${pre}le="${b}"} ${h.buckets[i]}`));
      out.push(`${this.name}_bucket{${pre}le="+Inf"} ${h.count}`);
      out.push(`${this.name}_sum${k ? `{${k}}` : ''} ${h.sum.toFixed(6)}`);
      out.push(`${this.name}_count${k ? `{${k}}` : ''} ${h.count}`);
    }
    return out.join('\n');
  }
}

export const metrics = {
  requests: new Counter('fahan_http_requests_total', 'HTTP requests by route template, method and status class'),
  latency: new Histogram('fahan_http_request_duration_seconds', 'HTTP request latency by route template and method'),
  errors: new Counter('fahan_errors_total', 'Business and technical errors by code (booking conflicts, unbalanced journals, overpayments, four-eyes refusals, ...)'),
  audit: new Counter('fahan_audit_events_total', 'Audit events by action and outcome (denials, refunds, webhook rejections, AI checks, ...)'),
  webhookDuplicates: new Counter('fahan_payment_webhook_duplicates_total', 'Provider callbacks recognised as replays and not posted again'),
  started: Date.now(),
};

export function renderMetrics(): string {
  return [
    metrics.requests.render(),
    metrics.latency.render(),
    metrics.errors.render(),
    metrics.audit.render(),
    metrics.webhookDuplicates.render(),
    '# HELP fahan_process_uptime_seconds Seconds since the API started',
    '# TYPE fahan_process_uptime_seconds gauge',
    `fahan_process_uptime_seconds ${Math.round((Date.now() - metrics.started) / 1000)}`,
    '# HELP fahan_process_resident_memory_bytes Resident memory of the API process',
    '# TYPE fahan_process_resident_memory_bytes gauge',
    `fahan_process_resident_memory_bytes ${process.memoryUsage().rss}`,
    '',
  ].join('\n');
}

/** Times every request; the route template is known only after routing, so it is read when the response finishes. */
export const requestMetrics: RequestHandler = (req, res, next) => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const route = req.route?.path ? `${req.baseUrl}${String(req.route.path)}` : res.statusCode === 404 ? 'unmatched' : `${req.baseUrl || ''}*`;
    const labels = { route, method: req.method };
    metrics.requests.inc({ ...labels, status: `${Math.floor(res.statusCode / 100)}xx` });
    metrics.latency.observe(labels, Number(process.hrtime.bigint() - start) / 1e9);
  });
  next();
};
