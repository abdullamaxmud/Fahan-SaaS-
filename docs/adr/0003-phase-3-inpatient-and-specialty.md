# ADR 0003 — Phase 3 inpatient & specialty decisions

Status: accepted · 2026-11-25

| # | Decision | Why |
|---|---|---|
| 1 | Emergency and inpatient stays are **encounters** (`type: ER` / `IP`) so notes, vitals and diagnoses work the same everywhere. The governing module follows the type: OPD → `opd/tele`, ER → `er`, IP → `opd/icu/mat/nur`. | One clinical record model; permissions stay precise per setting. |
| 2 | **Opening a visit never creates a care relationship.** Reception checks in walk-ins (`/appointments/walk-in`); clinicians open follow-ups only for patients already in their care; emergencies without a relationship use break-glass. | Found during Phase 3 testing: the old walk-in let any branch doctor give themselves access to any branch patient. |
| 3 | **Break-glass**: clinical staff state a reason (≥ 20 chars), get 45 minutes of access to one patient, every action is audited, and the security auditor reviews it (four eyes); a review also ends the access. | Spec §3.4. |
| 4 | Security Auditor and DPO are appointed by the **platform owner**, not the hospital's own admins. | Independent oversight; resolves the Phase 1 gap where the grant ceiling blocked these roles. |
| 5 | Beds: one active occupant per bed and one active bed per admission via **partial unique indexes**, inside transactions; repeating the same assignment is idempotent; concurrent attempts return `BED_ALREADY_OCCUPIED`. | Spec §5.8 / §14.2 race-condition acceptance. |
| 6 | One active admission per patient (partial unique index). Discharge by a doctor with recent MFA writes a signed summary, closes the inpatient visit and sends the bed to cleaning. Open drafts block discharge; shift leads verify nurses' notes. | Spec §5.7 discharge reconciliation. |
| 7 | Emergency: unidentified patients get a temporary name and MRN with estimated age; triage uses ESI 1–5; any change after the first is an audited override with a reason; disposition "admitted" creates the admission request in the same transaction. | Spec §5.6 "audit all overrides". |
| 8 | Theatre bookings serialise per theatre (the transaction touches the theatre document) and also block a surgeon in two places. Out-of-service theatres cannot be booked. Each case step is gated: consent → sign-in → Prepared → time-out → InProcedure → operative note + sign-out → Recovery → Completed. | Spec §4.2 / §5.16 / §5.24. Clinical protocol content still needs local sign-off. |
| 9 | Maternity: one active pregnancy per mother; EDD by Naegele's rule; antenatal **flags** (BP ≥ 140/90, FHR outside 110–160) are prompts, not diagnoses; each live birth becomes its own patient record linked by `motherId`. | Spec §5.17 newborn linkage. |
| 10 | Referrals: a vehicle is taken atomically for one run; handover links the referral to the receiving visit; external referrers see status only. | Spec §5.25. |

## Not done in Phase 3
- Medication administration records (needs pharmacy, Phase 4).
- Live device integration for ICU monitors (Phase 4 integrations); readings can be entered with a device label.
- Ward-level nurse rosters as an access source (nurses are added to the care team today).
