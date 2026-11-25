# ADR 0001 — Phase 1 foundation decisions

Status: accepted · 2026-11-25

## Context
The specification (§16.3) left deployment scope, hosting and several platform choices open.
The product owner chose **SaaS, multi-hospital from day one**.

## Decisions

| # | Decision | Why |
|---|---|---|
| 1 | **Database per hospital tenant** (`fahan_t_<code>`), plus one control-plane DB (`fahan_control`) for tenants, platform users and sessions. | Spec §7.6 prefers dedicated databases for unrelated organisations. Isolation does not depend on every query remembering a filter. Tenant DB names come only from the registry, never from a request. |
| 2 | Tenant documents still carry `tenantId` and every query filters on it. | Defence in depth; keeps the spec §7.1 envelope; allows a shared-cluster tier later. |
| 3 | **Modular monolith** (Express 5 + TypeScript + Zod + MongoDB native driver). | Spec §2.1. One deployable, clear module boundaries under `services/api/src/modules`. |
| 4 | Roles and permissions live in a shared package `@fahan/policy` used by API and web. | One source of truth; the web only *hides* what the API already *denies*. |
| 5 | Permission levels `V < E < S < A` per module; deny by default; actor rebuilt from the DB on every request. | Spec §3.2/§3.4: revocation must be immediate; no cached grants to reconcile. |
| 6 | **Grant ceiling**: platform-tier roles are never grantable in a tenant; nobody can grant a level on `plat/org/iam/studio/intg/sec` above their own; nobody can change their own access. | Spec §3.4 non-delegable owner + server-enforced ceiling. |
| 7 | Sessions: random token in an HttpOnly, Secure, SameSite=Strict cookie; only its SHA-256 is stored. Double-submit CSRF token for writes. Token rotated on MFA. | Spec §3.4. |
| 8 | Passwords: Argon2id. MFA: TOTP, secrets encrypted at rest with AES-256-GCM (`DATA_KEY`). Re-authentication within 10 minutes for access and tenant changes. | Spec §3.4. |
| 9 | Audit log: append-only, SHA-256 hash chain per tenant, unique `seq` prevents forks; refusals are logged. | Spec §11.1. Export to an external append-only sink is Phase 7. |
| 10 | One web app (`apps/web`, Next.js) with role-adaptive workspaces instead of three apps. | Matches the approved prototype; the patient portal can be split out when it ships (Phase 6). |
| 11 | Local dev and tests use `mongodb-memory-server` replica sets. | No Docker/MongoDB on the dev machine; transactions still work. Docker/IaC arrive with CI/CD. |

## Known gaps carried to the backlog
- Appointing **Security Auditor / DPO** inside a tenant needs a dual-control flow (the grant ceiling blocks the Super Admin by design).
- TOTP replay protection (remember last used time-step).
- Invitations are returned once in the API response; production needs email delivery.
- Break-glass access (spec §3.4) — Phase 3 with emergency workflows.
- CI pipeline, container images, IaC (spec §13.3).
