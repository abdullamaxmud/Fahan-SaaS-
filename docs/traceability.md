# Requirements traceability — Fahan

Spec: *Advanced Hospital Management System — Developer Documentation*. This matrix is the evidence the phase exit gates ask for (spec §15: "signed requirements traceability + QA evidence"). Every row points at the code and the automated tests that prove it; the sign-off table at the end is for the people who must approve it.

Legend: **Built** — implemented and tested · **Partial** — core implemented, named gaps listed · **Not built** — not started.

## Functional modules (spec §5)

| § | Module | Status | API (`services/api/src/modules`) | Screen (`apps/web`) | Tests (`services/api/test`) |
|---|---|---|---|---|---|
| 5.1 | Organization & facilities | Built | `org` | `/admin/branches` | `phase1` |
| 5.2 | Identity, roles & permissions | Built | `auth`, `iam`, `packages/policy` | `/admin/users` | `phase1`, `security`, policy package |
| 5.3 | Registration & MPI | Built | `patients`, `migrations` | `/patients`, `/patients/merges`, `/patients/import` | `mpi`, `migration` |
| 5.4 | Appointments & queues | Built | `appointments` | `/appointments` | `appointments` |
| 5.5 | Outpatient encounters | Built | `encounters` | `/encounters` | `encounters` |
| 5.6 | Emergency department | Built | `emergency` | `/emergency` | `emergency` |
| 5.7 | Inpatient admissions & discharge | Built | `admissions` | `/wards` | `admissions` |
| 5.8 | Ward, room & bed management | Built | `admissions` | `/wards` | `admissions` |
| 5.9 | Nursing & vitals | Built | `nursing`, `encounters` | `/wards` | `nursing`, `encounters` |
| 5.10 | ICU / NICU / PICU | Partial — device readings and charting; no device integration | `nursing` | `/wards` | `nursing` |
| 5.11 | Laboratory / LIS | Partial — no analyser (LIS) adapter | `lab` | `/lab` | `lab` |
| 5.12 | Radiology / RIS | Partial — no live PACS/DICOMweb connection | `imaging` | `/radiology` | `imaging` |
| 5.13 | ECG, echo, endoscopy | Built | `imaging` | `/diagnostics` | `imaging` |
| 5.14 | Pharmacy & e-prescribing | Partial — no licensed interaction/dose knowledge base | `pharmacy` | `/pharmacy` | `pharmacy` |
| 5.15 | Inventory & supply chain | Built | `inventory` | `/inventory` | `inventory` |
| 5.16 | Surgery & theatre | Built | `surgery` | `/surgery` | `surgery` |
| 5.17 | Maternity, neonatal & paediatrics | Built | `maternity` | `/maternity` | `maternity` |
| 5.18 | Blood bank & transfusion | Built | `bloodbank` | `/bloodbank` | `bloodbank` |
| 5.19 | Billing & cashier | Built | `billing` | `/billing` | `billing`, `webhook` |
| 5.20 | Accounting & revenue intelligence | Built | `accounting` | `/finance` | `accounting` |
| 5.21 | Insurance & claims | Built | `insurance` | `/insurance` | `insurance` |
| 5.22 | HR, scheduling & payroll | Built | `hr` | `/hr` | `hr` |
| 5.23 | Procurement & suppliers | Built | `procurement` | `/procurement` | `procurement` |
| 5.24 | Equipment, CSSD & facilities | Partial — equipment and calibration; CSSD cycles not built | `equipment` | `/equipment` | `equipment` |
| 5.25 | Ambulance & referrals | Built | `referrals` | `/referrals` | `referrals` |
| 5.26 | Patient portal & communications | **Not built** | — | — | — |
| 5.27 | Telemedicine | **Not built** | — | — | — |
| 5.28 | Quality, infection control & incidents | **Not built** (shown as "unavailable" in reports) | — | — | — |
| 5.29 | Reporting & BI | Built | `intel` | `/reports` | `intel` |
| 5.30 | AI financial intelligence | Built | `intel/insights` | `/ai-finance` | `insights` |
| 5.31 | AI disease intelligence | Built | `intel/insights` | `/ai-disease` | `intel`, `insights` |
| 5.32 | Monthly Hospital 360 | Built | `intel/h360` | `/hospital-360` | `h360` |
| 5.33 | Forms & workflow studio | Partial — approval rules; no notification triggers | `studio` | `/studio`, `/forms` | `studio` |
| 5.34 | Integrations & developer API | Partial — FHIR R4 read facade, scoped clients, signed payment webhooks; no HL7 v2 / DICOMweb adapters or FHIR writes | `fhir`, `integrations`, `billing/webhook` | `/admin/integrations` | `fhir`, `webhook` |
| 5.35 | Security, audit & operations | Built — hash-chained audit, access reviews, incidents, backups and restore drill, readiness and metrics; SIEM export not built | `audit`, `security`, `ops` | `/admin/audit`, `/admin/security` | `phase1`, `security`, `secops`, `restore`, `ops` |

## Mandatory acceptance scenarios (spec §14.2)

| # | Scenario | Proven by |
|---|---|---|
| 1 | A cashier cannot read clinical histories or elevate privileges via direct API calls | `phase1` › cashier cannot read clinical data or manage users via direct API calls; `security` › a cashier cannot raise their own price or role through extra fields; `lab` › cashier cannot see lab results |
| 2 | A hospital administrator cannot access another hospital tenant using guessed IDs or filters | `phase1` › a hospital admin cannot reach another hospital with guessed ids; `security` › another hospital gets nothing back for any of our ids, read or write; › a tenant header or body field cannot switch hospitals |
| 3 | Two users cannot assign the same available bed concurrently | `admissions` › two people cannot put two patients in the same bed, even at the same moment |
| 4 | Lab results and radiology final reports show the signer and immutable amendment history | `lab` › released results are amended with history, never overwritten; `imaging` › only the radiologist reports and signs; › final reports change only by addendum |
| 5 | Payment provider replay does not create duplicate payments or ledger postings | `webhook` › a signed payment is applied once, however often the provider retries; `billing` › a replayed payment returns the same receipt and posts nothing twice |
| 6 | A refund above threshold is rejected without authorised approval and preserved in audit | `billing` › a refund above threshold is rejected without authorised approval and preserved in audit |
| 7 | Disease metric excludes ruled-out diagnoses and deduplicates repeat visits by stated definition | `intel` › counts unique patients, separates suspected, excludes ruled-out, and suppresses small cohorts |
| 8 | Monthly AI report figures reconcile to the immutable snapshot; reviewer may reject the draft | `insights` › the AI summary carries the official figures; › a reviewer can reject a draft; `h360` › every figure cites its certified metric and snapshot |
| 9 | Super Admin changes to roles propagate to authenticated sessions | `phase1` › role changes apply to live sessions on the next request; › suspension revokes access immediately |
| 10 | Clinical records remain accessible in a tested restore environment with proper encryption keys | `restore` › a restored copy has the same records, an intact audit chain, and readable encrypted fields; › with the wrong data key the drill fails; first real drill recorded in `docs/operations.md` |

## Test matrix coverage (spec §14.1)

| Category | Where |
|---|---|
| Unit | `packages/policy` (permissions), `packages/terminology` (ICD-11, name folding), `insights` (number check), money in minor units throughout |
| API / contract | every module test: Zod field errors, status codes, error envelope (`security` › standard envelope) |
| Concurrency | `admissions` (bed race), `appointments` (slot race), `billing` (duplicate charge, replayed payment), `pharmacy` (idempotent dispense), `inventory` (no negative stock) |
| Integration | `webhook` (signed callbacks, retries), `fhir` (R4 conformance, scopes, branch and hospital isolation), `migration` (legacy import with reconciliation) |
| Security | `security` (cross-tenant, injection, mass assignment, MFA bypass and replay, session reuse, headers), `phase1` (CSRF, grant ceiling) |
| E2E | Browser walk-throughs per phase (recorded in each phase's summary); scripted clinical UAT in `docs/uat/clinical-uat.md` |
| AI validation | `insights`, `h360` (numeric grounding, reproducibility, reviewer approval, privacy: no identifiers in outputs) |
| Resilience | `restore` (encrypted backup, refusal on tampering, verified restore drill), `ops` (readiness); load test in `docs/operations.md` |
| Accessibility | Labelled inputs and keyboard-reachable actions in all screens; a formal audit is still to be done |

## Needs people, not code

| Item | Owner | Evidence expected |
|---|---|---|
| Clinical UAT | Clinical leads per department | Signed `docs/uat/clinical-uat.md` |
| Independent penetration test (spec §11.1) | External assessor | Report and remediation log |
| Legal and clinical governance review per jurisdiction (spec §11.2) | Hospital / legal counsel | Written approval |
| Disease-metric and transfusion-table sign-off | Clinical governance | Signed definitions |

## Sign-off

| Role | Name | Decision | Date |
|---|---|---|---|
| Product owner | | | |
| Clinical safety officer | | | |
| Security reviewer | | | |
| Finance reviewer | | | |
