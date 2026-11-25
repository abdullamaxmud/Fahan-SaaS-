# ADR 0002 — Phase 2 clinical core decisions

Status: accepted · 2026-11-25

| # | Decision | Why |
|---|---|---|
| 1 | Patients belong to a hospital, linked to one or more branches (`branchIds`). Duplicate search runs hospital-wide; branch staff "use this record" to link it to their branch. | Spec §4.1/§5.3: one identity across facilities; branch scope still limits day-to-day access. |
| 2 | Duplicate detection = deterministic (national ID / phone) + fuzzy (consonant-skeleton name keys that fold Somali transliteration: Xasan/Hasan, Maxamed/Mohamed, Cali/Ali) + DOB. Score ≥ 0.85 blocks registration until staff confirm; the override is audited. | Spec §4.1 "deterministic + fuzzy candidate matching with human approval". |
| 3 | Merges **link** (duplicate → `mergedInto` survivor, old MRN kept as `mrn-alias`); no clinical data moves. Approval by a different person with `mpi:A` (new role **Medical Records Officer**), re-auth required; fully reversible. | Spec §5.3 "merges are approved and reversible by linking". |
| 4 | Care relationship (`careTeam`) is created by booking (provider), check-in, walk-in and explicit care-team additions. Care-team roles see only those patients. | Spec §3.4 relationship-bound access. Break-glass comes in Phase 3. |
| 5 | Clinical content (encounters, vitals, notes, diagnoses, timeline) needs a clinical module (`opd/nur/er/icu/mat`), not just `mpi`. Timeline reads are audited. | Spec §14.2: cashier cannot read clinical histories. |
| 6 | No double-booking via a **partial unique index** on `{tenantId, providerId, startsAt}` where `slotLock: true`; cancel / no-show / complete release the lock. | Spec §5.4 / §14.2 concurrency; verified with parallel bookings. |
| 7 | Schedules are weekly sessions in **branch local time**; instants are stored in UTC; tz conversion via `Intl` (no library). Clock is injectable for tests. | Spec §2.4. |
| 8 | Notes: private drafts → author signs (recent MFA) → amendments create a new signed version and mark the old one `Amended`. Signed notes are never edited or deleted; only own drafts can be discarded. | Spec §4.1 corrections appended, never silently overwritten. |
| 9 | Vitals use canonical units with plausibility ranges (typing-error guard, not clinical judgement). Corrections append a new value and mark the old one `Corrected`. | Spec §5.9 timestamp/source/unit required. |
| 10 | Diagnoses: ICD-11 code-shape validation + starter pick-list; certainty `suspected / confirmed / ruled_out` kept separate; exactly one primary; changes keep history. Closing a visit needs ≥1 signed note, no open drafts and a primary diagnosis. | Spec §7.3, §9.3 disease metrics need clean certainty. |

## Follow-ups
- Allergies and problem list as first-class records (Phase 3 with nursing).
- Licensed WHO ICD-11 API search (Phase 4 integrations).
- SMS appointment reminders honour `sms-reminders` consent (Phase 6 portal).
- The design prototype still shows 54 roles; the catalogue now has 55 (records officer).
