# Clinical user acceptance test (UAT) — Fahan

Spec §14.1 (E2E: register → visit → orders → results → discharge → bill → payment → report) and §15 Phase 7 "clinical UAT".
Run on a **staging copy with synthetic or de-identified data only** (spec §13.1). Each tester signs in with their own demo account (`npm run seed:demo`; sign-in details in `services/api/.data/demo-credentials.txt`).

Record **Pass / Fail** and a note for every step. A failed step is a finding: write what you expected and what happened, and do not continue that scenario until it is fixed or waived by the clinical safety officer.

## Scenario A — Outpatient with malaria

| # | Role | Action | Expected | Pass/Fail | Note |
|---|---|---|---|---|---|
| A1 | Reception | Register a new patient; search the name with a Somali spelling variant | Duplicate check offers likely matches; new MRN issued | | |
| A2 | Reception | Walk-in to a named doctor | Queue number given; visit opens in the doctor's list | | |
| A3 | Nurse | Record vitals including a temperature of 39.2 °C | Value flagged as abnormal | | |
| A4 | Doctor | Record allergy to penicillin; add suspected malaria (1F40) | Allergy banner shows on the visit | | |
| A5 | Doctor | Order malaria RDT and full blood count | Orders appear on the lab worklist with priority | | |
| A6 | Lab tech → pathologist | Collect, enter results, verify (different person), release | Doctor sees nothing until release; the person who entered cannot verify | | |
| A7 | Doctor | Change malaria to confirmed; prescribe amoxicillin | Allergy warning appears; override needs a reason | | |
| A8 | Doctor | Prescribe artemether-lumefantrine instead; sign | Prescription signed with MFA | | |
| A9 | Pharmacist (2nd) | Verify, dispense | Stock falls by batch, earliest expiry first; dispensing twice is impossible | | |
| A10 | Doctor | Sign note, close visit | Visit cannot close with drafts or without a primary diagnosis | | |

## Scenario B — Admission, theatre, discharge

| # | Role | Action | Expected | Pass/Fail | Note |
|---|---|---|---|---|---|
| B1 | Admission officer | Admit to a ward bed | The same bed cannot be given to two patients | | |
| B2 | Nurse | Care plan, handover | Handover lists open tasks and critical values | | |
| B3 | Surgeon / anaesthetist / theatre nurse | Book theatre, complete the WHO checklist | No phase starts before the previous checklist is complete | | |
| B4 | Doctor | Discharge with summary | Discharge refused while drafts remain; bed goes to cleaning | | |

## Scenario C — Results safety

| # | Role | Action | Expected | Pass/Fail | Note |
|---|---|---|---|---|---|
| C1 | Pathologist | Release a critical potassium (6.8) | Critical alert stays open until a clinician on the visit acknowledges it | | |
| C2 | Radiologist | Sign a CT report with a critical finding; add an addendum | Signer and addendum history visible; the signed text cannot be edited | | |
| C3 | Blood bank | Group, crossmatch, issue; bedside check by a second person | Incompatible units cannot be issued | | |

## Scenario D — Money and reports

| # | Role | Action | Expected | Pass/Fail | Note |
|---|---|---|---|---|---|
| D1 | Cashier | Invoice the patient's charges, open till, take cash | One receipt; the ledger shows the payment once | | |
| D2 | Cashier → finance director | Request a large refund; billing officer tries to approve | Refused; finance director approves; both recorded in the audit trail | | |
| D3 | Analyst | Capture this month's disease snapshot; generate the AI summary | Malaria counted once per patient; small groups hidden; text cites its figures | | |
| D4 | Clinical safety → governance | Validate and review the summary | Released only after two different people | | |
| D5 | Finance director, clinical reviewer, owner | Build, sign, approve and publish Hospital 360 | Figures match the finance screen; published version is signed | | |

## Sign-off

| Department | Clinical lead | Result (accept / accept with findings / reject) | Date | Signature |
|---|---|---|---|---|
| Outpatients | | | | |
| Inpatients & theatre | | | | |
| Laboratory | | | | |
| Radiology | | | | |
| Pharmacy | | | | |
| Finance | | | | |
| Clinical safety officer | | | | |
