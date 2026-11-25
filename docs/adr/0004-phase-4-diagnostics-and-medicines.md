# ADR 0004 — Phase 4 diagnostics & medicines decisions

Status: accepted · 2026-11-25

| # | Decision | Why |
|---|---|---|
| 1 | **Stock by batch.** Every decrement is conditional on enough quantity remaining (`quantity ≥ n`) inside a transaction; issue, transfer and dispense take the earliest-expiring unexpired batch first. | Spec §5.15: never negative; lot consistency under concurrent issue. |
| 2 | **Ordering** (lab, imaging, diagnostics, prescriptions, transfusion) needs a clinician who signs on that visit; nurses and technicians cannot order. Every order records orderer, patient, visit, priority and status. | Spec §4.2. |
| 3 | **Laboratory**: unique accession numbers per branch and day; results flagged against reference and critical limits; verification by a second person and blocked while the latest QC for that test failed (2SD warn / 3SD fail); clinicians see results only after release; critical values stay open until a clinician on the visit acknowledges them; released results are amended with history. | Spec §5.11, §6. |
| 4 | **Radiology and diagnostics** share one engine with different signers (radiologist; specialist for ECG/echo/endoscopy). Ionising studies for anyone who could be pregnant need a pregnancy status (and a justification unless not pregnant). Images stay in PACS — we store StudyInstanceUID and hand out 15-minute HMAC-signed viewer links, audited. | Spec §5.12, §5.13, §12.1. |
| 5 | **Equipment**: a device is usable only when Available and not past its calibration date; scheduling refuses unusable devices and overlapping bookings. Only the biomedical lead returns a device to service, never with an open repair or calibration job. | Spec §5.24 "broken device cannot be scheduled". |
| 6 | **Pharmacy**: prescriber signs with recent MFA; signing checks allergies by ingredient, name and drug class, and duplicate therapy; overrides need a reason and are audited. A different pharmacist verifies. Dispensing requires an `Idempotency-Key`; a replay returns the original dispense and never takes stock twice. Nurses chart doses as given/held/refused. Prescribers read a stock-free **formulary**. | Spec §4.2, §5.14, §8.1. |
| 7 | **Blood bank**: a patient group counts only when two samples typed by two different people agree; ABO/RhD compatibility per component; reservation in a transaction; bedside administration needs an independent second checker; unit history supports recall. | Spec §5.18. The compatibility table needs transfusion-committee sign-off. |

## Not done in Phase 4
- LIS/analyser and PACS/DICOMweb adapters (interfaces only; Phase 4 integrations backlog).
- Barcode label printing for specimens and wristbands.
- Procurement (purchase orders, 3-way match) — Phase 5 with finance.
- Dose-range and drug–drug interaction checking (needs a licensed drug knowledge base).
