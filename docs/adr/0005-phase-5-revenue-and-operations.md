# ADR 0005 — Phase 5 revenue & operations decisions

Status: accepted · 2026-11-25

| # | Decision | Why |
|---|---|---|
| 1 | **Money is an integer in minor units with its currency** (USD or SOS); amounts in different currencies are never added together. Every report takes one currency. | Spec §4.3, §9.4: no floating-point money, no silent conversion. |
| 2 | **Double-entry ledger.** Journal entries are immutable and balanced (debits = credits > 0). Each source event posts once: a unique index on (source type, id, kind) makes retries harmless. Corrections are reversals posted in the open month; a closed month accepts nothing and is never reopened. Manual journals are drafted by one person and approved by another with recent MFA. | Spec §5.21 "posted entries cannot be edited", segregation of duties. |
| 3 | **Billed, recognised and collected are separate numbers.** Issuing an invoice recognises revenue by service category (Dr receivable, Dr discounts, Cr revenue); a payment is cash against receivable; refunds and write-offs are contra-revenue. The finance summary carries `metricVersion: finance-v1`. | Spec §9.4: cash collected is never reported as revenue. |
| 4 | **Charges come from clinical events** — lab release, signed imaging/diagnostic report, dispensing, closed OPD visit — keyed by (source, service) so the same event never charges twice. A missing price holds the charge as *unpriced* for billing instead of losing it or billing zero. Capture is best-effort: a billing problem never blocks clinical work. Charges keep the price version they were captured at. | Spec §5.19 "no duplicate charges"; patient safety first. |
| 5 | **Payments need an `Idempotency-Key`**; a replay returns the original receipt. Cash needs an open till in the invoice currency. A till that does not balance waits for a finance administrator — never the cashier. Refunds are requested by one person and approved by another with recent MFA; above the threshold only the finance director approves, and the refusal is in the audit trail. | Spec §8.1, §14.2 acceptance test. |
| 6 | **Payment provider callbacks** (EVC Plus, Zaad, Sahal, eDahab, card) are verified before anything is read: HMAC-SHA256 over `timestamp.rawBody` with a per-hospital secret stored encrypted and shown once, timestamps within 5 minutes, one event per (provider, transaction). Money that matches no payable invoice is parked as *unmatched* for the billing officer, not guessed. | Spec §12.1. |
| 7 | **Insurance**: submitting a claim moves the claimed amount from patient to insurer receivable and holds it on the invoice, so the cashier cannot collect it from the patient too. Denials (coded reasons) and partial approvals move the cut back to the patient; a short remittance is written off with a reason. One open claim per invoice. | Spec §5.20. |
| 8 | **Procurement**: orders are approved by someone other than the buyer, within an approval limit (above $500 the finance director). Goods receipt adds stock by batch and posts Dr inventory / Cr goods-received-not-invoiced at the order price. Supplier invoices are 3-way matched (order price × received quantity); exceptions post nothing; a supplier's invoice number is unique; payment is by finance, never the person who recorded the invoice. | Spec §5.16, §6 procure-to-pay. |
| 9 | **HR & payroll**: salary is visible only to HR and finance administrators and never written to the audit trail. One shift per person per day; approved leave marks overlapping shifts as gaps. Payroll is prepared by HR, approved and paid by finance with recent MFA; approval posts gross salary expense, payment releases net pay from the bank, deductions stay as a liability. | Spec §5.22. |

## Not done in Phase 5
- Live connections to mobile-money providers (the signed webhook is ready; each provider's onboarding and field mapping is per contract).
- Exchange-rate revaluation and consolidated multi-currency reports.
- Budgets, fixed assets and depreciation, bank reconciliation import.
- Tax and statutory payroll deductions (the payroll uses each employee's fixed deductions until rules are configured per jurisdiction).
- Linking expired credentials to account suspension (credentials are watched and listed; blocking is a policy decision for the hospital).
