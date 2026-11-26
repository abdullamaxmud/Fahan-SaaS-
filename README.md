# Fahan

Multi-tenant SaaS hospital operating platform. Built from the *Advanced Hospital Management System Developer Documentation* (v1.0).

**Status: Phase 7 — Hardening & pilot.**

- Phase 1 (done): identity, MFA, 55 roles, one database per hospital, organisation setup, tamper-evident audit trail.
- Phase 2 (done): patient index with duplicate detection and reversible merges, consent, clinic schedules and appointments without double-booking, check-in queue, outpatient visits with vitals, signed and amended notes, ICD-11 diagnoses, patient timeline.
- Phase 3 (done): allergies, break-glass with review, emergency department, wards and beds, admissions and discharge, nursing care plans and handovers, ICU device readings, theatres with the WHO safety checklist, maternity with linked newborn records, ambulance and referrals.
- Phase 4 (done): inventory by batch and expiry, laboratory with verification, QC and critical values, radiology and diagnostics with signed reports, equipment and calibration, pharmacy with allergy checks and idempotent dispensing, medication chart, blood bank with compatibility and traceability.
- Phase 5 (done): double-entry ledger with period close, charges captured from clinical events, invoices, tills and idempotent payments, four-eyes refunds, signed mobile-money callbacks, insurance claims with denials and remittance, procurement with 3-way match, HR, rosters, leave and payroll.
- Phase 6 (done): certified, versioned metrics; immutable monthly snapshots with fingerprints; disease counts per spec §9.3 with small-cohort suppression; AI finance and disease summaries whose every number is checked against the snapshot and released only after review; the signed monthly Hospital 360 report; a no-code forms studio with versions and rollback.
- Phase 7 (done in code): security sweep and MFA hardening, dependency fixes and CI, FHIR R4 read API with scoped clients, verified patient migration, encrypted backups with restore drills, readiness and metrics, access reviews and incidents. Evidence: `docs/traceability.md`, `docs/operations.md`; clinical UAT script in `docs/uat/clinical-uat.md`.
- Next: Phase 8 — go-live: clinical UAT sign-off, independent penetration test, staging load and restore timing, controlled branch rollout.

## Layout

```
apps/web            Next.js web app (all roles, role-adaptive)
services/api        Express API — modular monolith
packages/policy       55 roles × 36 modules, permission engine (shared by API and web)
packages/terminology  vital-sign units, ICD-11 checks, Somali-aware name matching
docs/adr            Architecture decisions
```

## Run it locally

Requires Node.js 22+. No Docker or MongoDB install needed.

```powershell
npm install
```

Terminal 1, the database on port 27018 (keep it running). It is separate from any MongoDB service already on 27017:

```powershell
npm run dev:db
```

Terminal 2, either load demo data (owner, hospital `hiil`, one user per key role, three patients; sign-in details go to `services/api/.data/demo-credentials.txt`, which git ignores):

```powershell
npm run seed:demo
```

To start the demo again from scratch, `npm run reset:dev-db` drops the Fahan databases on the local dev replica set (it refuses any port other than 27018), then run `npm run seed:demo` again.

or create only the platform owner (once only):

```powershell
npm run bootstrap:owner -- --email you@example.com --name "Your Name"
```

Add the printed authenticator URI to an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…).

Terminal 2, the API on http://localhost:4000:

```powershell
npm run dev:api
```

Terminal 3, the web app on http://localhost:3000:

```powershell
npm run dev:web
```

Sign in with **no hospital code** as the owner, create a hospital, then use its invitation code at `/invite`.

## Tests

```powershell
npm test
```

The API suite checks the Phase 1 exit criteria directly through HTTP: MFA enforcement, cashier denial, cross-hospital isolation, the grant ceiling, immediate revocation and the audit hash chain. Phase 5 adds the finance acceptance checks: a refund above the threshold is refused without the finance director and kept in the audit trail, replayed payments and provider callbacks post once, every scenario leaves the trial balance balanced, and duplicate supplier invoices are refused.

## Configuration

See `services/api/.env.example`. In production `DATA_KEY` is required and cookies are `Secure`.
