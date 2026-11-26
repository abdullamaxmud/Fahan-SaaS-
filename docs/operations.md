# Operations runbook — Fahan

Spec §11.1 (backups, disaster recovery exercises, incident response), §13.2 (availability and recovery objectives), §13.4 (monitoring) and §14.3 (every story needs operational metrics and a runbook).

## Keys

| Key | Purpose | Where it lives |
|---|---|---|
| `DATA_KEY` | Encrypts secrets inside the database (MFA seeds, provider secrets) | Secrets manager; required in production |
| `BACKUP_KEY` | Encrypts and signs backups | Secrets manager, **separate** from `DATA_KEY` (the API refuses to start if they are equal) |
| `METRICS_TOKEN` | Lets the monitoring system read `/metrics` | Monitoring system only; unset = endpoint off |

A backup is useless without both keys: `BACKUP_KEY` to open it, `DATA_KEY` to read the encrypted fields inside. Store copies of both offline under dual control.

## Backups and restore drills

```powershell
npm -w @fahan/api run backup -- --tenant hiil --out D:\backups\hiil-2026-11-26
npm -w @fahan/api run restore-drill -- --from D:\backups\hiil-2026-11-26
```

- A backup is one folder per hospital: each collection as canonical EJSON, gzipped and sealed with AES-256-GCM, plus `manifest.json` (counts, SHA-256 of every file, audit-chain head) signed with the backup key. Copy it to immutable, off-site storage (spec §11.3 ransomware).
- The drill refuses to start if the manifest signature, any checksum or the key is wrong, never restores over the live database, restores into `fahan_t_drill-<hospital>`, then checks: every collection count, the audit hash chain and its last hash, a patient record, and that encrypted fields open with `DATA_KEY`. It writes `drill-report.json` with the duration, then removes the drill copy (`--keep` to inspect it).
- **Schedule:** daily logical backup; restore drill at least monthly and after every release that changes storage. File the drill report with the release record.
- **RPO 15 minutes** needs the database's own continuous backup (point-in-time recovery / oplog); the logical backup covers the "immutable, independently encrypted copy" and the drill evidence. Configure both in production.

**First drill (dev data, 2026-11-26):** 78 collections, 192 documents, 9 audit events — every check passed; restore and verification took 5.0 s. This proves the procedure, not the RTO at production volume; time a drill on a production-sized copy in staging.

## Health and metrics

| Endpoint | Use |
|---|---|
| `GET /health` | Liveness — the process answers |
| `GET /health/ready` | Readiness — 503 when the database does not answer; load balancers stop sending traffic |
| `GET /metrics` | Prometheus text, `Authorization: Bearer <METRICS_TOKEN>` |

Metrics carry route templates, error codes and audit actions only — never ids, names or other patient data.

| Metric | Alert when (suggested; owners agree the numbers) | Owner |
|---|---|---|
| `fahan_http_request_duration_seconds` | p95 of reads > 500 ms for 10 min | Platform on-call |
| `fahan_http_requests_total{status="5xx"}` | > 1% of requests for 5 min | Platform on-call |
| `fahan_errors_total{code="BED_ALREADY_OCCUPIED" / "SLOT_TAKEN"}` | sudden rise — booking conflicts | Operations manager |
| `fahan_errors_total{code="UNBALANCED_ENTRY"}` | any | Finance director |
| `fahan_payment_webhook_duplicates_total` | spike — provider retry storm | Finance + platform |
| `fahan_audit_events_total{outcome="deny"}` | spike for one action | Security reviewer |
| `fahan_audit_events_total{action="auth.mfa.lockout"}` | any | Security reviewer |
| `fahan_audit_events_total{action="bill.refund.request"}` | unusual volume | Finance director |
| `fahan_audit_events_total{action=~"ai.*generate",outcome="success"}` vs `checkOk` | AI drafts failing the number check | Clinical safety officer |

## Performance

```powershell
npm -w @fahan/api run load-test -- --concurrency 20 --seconds 20
```

**First run (developer laptop, dev server, demo data, 2026-11-26):** 5,801 reads in 20 s (290/s) with 20 concurrent clients, 0 errors, overall p95 115 ms (slowest: invoice list p95 129 ms) against the 500 ms target. Indicative only — repeat on staging hardware with the agreed load profile and production-sized data before sign-off.

## Incident response (spec §5.35: Detected → Investigated → Remediated → Closed)

1. **Detect** — alert, user report, or audit anomaly. Record it immediately (time, who, what was seen).
2. **Contain** — suspend affected accounts or API clients (`/admin/users`, integrations "Suspend" revokes tokens at once); rotate provider and client secrets if exposed.
3. **Investigate** — use the audit trail (verify the hash chain first), correlation ids from error reports, and metrics.
4. **Remediate** — fix, restore from the latest verified backup if data was lost or altered, re-run the restore drill.
5. **Close** — write what happened, what changed and who approved; notify patients or regulators where the jurisdiction requires (spec §11.2).
