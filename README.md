# Fahan

Multi-tenant SaaS hospital operating platform. Built from the *Advanced Hospital Management System Developer Documentation* (v1.0).

**Status: Phase 2 — Clinical core.**

- Phase 1 (done): identity, MFA, 55 roles, one database per hospital, organisation setup, tamper-evident audit trail.
- Phase 2 (done): patient index with duplicate detection and reversible merges, consent, clinic schedules and appointments without double-booking, check-in queue, outpatient visits with vitals, signed and amended notes, ICD-11 diagnoses, patient timeline.
- Next: Phase 3 — emergency, admissions, beds, nursing, ICU, surgery, maternity.

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

The API suite checks the Phase 1 exit criteria directly through HTTP: MFA enforcement, cashier denial, cross-hospital isolation, the grant ceiling, immediate revocation and the audit hash chain.

## Configuration

See `services/api/.env.example`. In production `DATA_KEY` is required and cookies are `Secure`.
