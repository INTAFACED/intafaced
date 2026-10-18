# Spec — the Pay verticals: psp · payfac · fraud · subscriptions · routing · settlement

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

For **M1**, written because these six were named as a next task with no product law behind them. Each is a real regulated product with a well-known shape, and each has one decision that determines whether it is buildable now or is a licence conversation. Those decisions are made here so they do not get made by accident inside an implementation.

**The single rule underneath all six:** we may build the _mechanics_ of any of these against a sandbox and be honest about it. What we may not do is **hold, route, or settle other people's money as a principal** without the licence that permits it. Most of the difficulty below is that distinction, applied six times.

---

## 0 · The distinction that decides everything

For each vertical, ask one question:

> **Whose money is it while we are touching it, and are we ever the counterparty?**

| answer                                                           | consequence                                                                |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------- |
| We never touch it; we produce instructions someone else executes | **Technical service provider.** Buildable now.                             |
| We touch it, but as agent of a licensed partner, in their name   | **Buildable now, behind their licence** — and their name governs, not ours |
| We hold it, even briefly, in our own name, before passing it on  | **Money transmission / e-money.** Licence, or do not build.                |
| We take the credit risk of a transaction                         | **Acquiring.** Sponsor bank. Not a code problem.                           |

**Being "non-custodial" does not rescue a fiat rail the way it rescues a crypto one.** In the Protocol Plane the user holds a key and we genuinely cannot move their asset. Fiat has no equivalent: a bank account in our name holding a merchant's takings is custody however the code is written. So the §22 sovereign routing rule in [`SPEC-SOVEREIGN-ROUTING-AND-COPY-2026-08-01.md`](SPEC-SOVEREIGN-ROUTING-AND-COPY-2026-08-01.md) **does not extend here** — these are Fiat Plane by construction, and pretending otherwise would be the most expensive mistake available in this mountain.

---

## 1 · `pay.psp` — payment service provider

**Build: yes, as an orchestration layer. Not as a principal.**

A PSP in the buildable sense is a **router and normaliser**: one API over many rails, consistent status, retries, reconciliation. That is a technical service and it is genuinely valuable.

- **In scope:** rail abstraction (`RailAdapter` already exists), normalised status machine, idempotent submission, webhook verification, reconciliation against the rail boundary, retry with a durable outbox.
- **Out of scope until licensed:** funds ever landing in an account we control before reaching the merchant. That is the line, and it is not subtle.
- **Done bar:** a payment traverses two different rails through one API with identical semantics, and a rail outage produces a typed refusal rather than a wrong status.

**Partner names live in adapters, never in user-facing copy** — already a rule in the ownership doc, restated because PSP is where it is most tempting to break.

---

## 2 · `pay.payfac` — payment facilitator

**Build: the mechanics. Do not become one.**

A payfac aggregates sub-merchants under its own acquiring relationship and **takes on their liability** — underwriting, chargebacks, and the regulatory obligation for who they are. That is a commercial and licensing posture, not a feature flag.

What is buildable now, and is most of the work anyway:

- **Sub-merchant onboarding**: KYB collection, document capture, tiering, approval workflow, audit trail.
- **Split payments**: the ledger recipes for platform fee vs sub-merchant proceeds.
- **Payout scheduling** and holds.

What we do **not** do until there is a sponsor: settle sub-merchants from our own account, or represent to anyone that we underwrite them.

**Design constraint that keeps the door open:** model the sub-merchant relationship so the _settling party_ is a field, not an assumption. If it is hardcoded as us, adopting a partner later is a rewrite; if it is a party reference, it is configuration.

---

## 3 · `pay.fraud` — risk and screening

**Build: yes, fully. This is the one with no licence gate.**

Fraud controls are ours to build and the most under-rated item on the list. Two hard rules:

**Never auto-decline without a stated reason and a route to review.** A silent decline is indistinguishable from a broken integration, and the person it hurts most is a legitimate customer who cannot find out why.

**Decisions must be explainable and logged.** "The model said no" is not a reason we can give a merchant, a regulator, or ourselves at 3am.

- **In scope:** velocity rules, device and IP signals, amount anomaly, blocklists, manual review queue, per-rule kill-switch.
- **Explicitly out:** any scoring that uses protected characteristics or proxies for them. Not a legal hedge — it is unjustifiable and would be indefensible if examined.
- **Interaction with sanctions screening:** fraud is a _business_ decision and may be tuned freely; **sanctions screening is not fraud and must never be tuned by the same knobs.** Keep them separate modules so nobody can loosen a sanctions check while tuning a false-positive rate. Blocklist content remains owner + counsel (§8).

---

## 4 · `pay.subscriptions` — recurring billing

**Build: yes. The hard part is not the schedule.**

Recurring billing is easy to get 90% right and the last 10% is where every complaint lives.

- **Mandate is the object, not the schedule.** Store what the customer _authorised_ — amount or ceiling, frequency, start, end. A charge that cannot be traced to a mandate does not go out.
- **A price change requires re-consent** at or above whatever threshold we set. Silently raising a recurring charge is the single most common abuse in this product category.
- **Cancellation is immediate and self-serve, always.** No retention flow that delays it, no support-only path. If a user can subscribe in one click they must be able to cancel in one click.
- **Dunning is bounded** — a fixed retry ladder, then stop. Retrying a failing card indefinitely generates fees for the customer and looks identical to an attack.
- **Every charge is notified before it lands**, not after.

**Done bar:** a mandate exists, a charge can be traced to it, cancellation takes effect at once, and a price change without re-consent is _refused by the code_, not by policy.

---

## 5 · `pay.routing` — rail selection

**Build: yes, and state the objective out loud.**

Routing decides which rail a payment takes. The design question is what it optimises, and the honest answer must be visible.

- **Optimise for success and cost, in that order** — and log the reason per decision. A routing engine that cannot say why it chose a rail cannot be debugged or defended.
- **Never route based on which rail pays us more, without disclosure.** If we ever take rail-side incentives, that becomes a conflict of interest and it must be surfaced, not buried in a weighting.
- **Failover must not double-charge.** Idempotency keys are per _payment_, not per attempt. This is the highest-risk bug in the whole vertical: a retry on a second rail while the first is merely slow spends the customer's money twice, and both look successful.
- **A rail that cannot honestly accept is skipped, not tried and failed** — see the existing posture gate; sandbox rails stay off the public path.

---

## 6 · `pay.settlement` — money out to merchants

**Build: the ledger truth now, the movement when licensed.**

Settlement is where money actually leaves, so it is the most constrained of the six.

- **Buildable now:** the complete settlement _ledger_ — what each merchant is owed, fees netted, holds and reserves applied, settlement runs computed, statements generated. All of it §0.6 recipes through `ledger-client`.
- **Gated on licence/partner:** the payout instruction itself, once it is us instructing a bank in our own name.
- **Reserves and holds must be disclosed before they apply**, with the reason and the release date. An undisclosed reserve is indistinguishable from us keeping a merchant's money.
- **A settlement statement must reconcile to the penny** against the ledger, and a mismatch **halts the run** rather than settling an approximate figure. Settling "about right" is how a small drift becomes an unattributable one.

---

## 7 · Cross-cutting non-negotiables

Apply to all six:

1. **§0.6** — value moves only through `ledger-client`. No vertical holds its own balance.
2. **Money is never a `number`** — decimal strings on the wire, scaled bigint in memory, `numeric(38,18)` in Postgres.
3. **Sandbox `Done` is acceptable and must say so.** A vertical proven against a sandbox is real work; it is `Done (sandbox)` and the surface says which. Never `Done` bare.
4. **Every vertical is killable** from the kill-switch board, per-rail and per-vertical.
5. **Refuse rather than invent** — no invented status, no assumed success, no "probably settled". If we do not know, the API says we do not know.
6. **Idempotency everywhere money moves.** Per payment, not per attempt (see §5).

---

## 8 · Owner-gated — do not build around these

Per `DIRECTION-2026-07-31.md` §8. Building the mechanics is fine; **claiming the posture is not.**

1. **Sponsor bank / acquiring BIN** — gates payfac settlement and card acquiring
2. **Money transmission / e-money licence** — gates anything in §1's "holds it" row
3. **Merchant KYB gate behind `pay:write`** — still no granting mechanism exists
4. **Fee and revenue splits** — every one is a §0.6 recipe
5. **Sanctions blocklist content** — counsel, and never tuned alongside fraud

---

## 9 · Suggested order

**fraud → subscriptions → psp → routing → settlement ledger → payfac onboarding.**

Rationale: fraud has **no licence gate at all** and protects everything after it. Subscriptions is self-contained and fully buildable. PSP and routing are orchestration over rails that already exist. Settlement's ledger half is buildable while its payout half waits. Payfac is last because most of its value is the commercial relationship we do not yet have.

**Two-thirds of this mountain is buildable today.** The parts that are not are commercial, and they are on the owner's list — so the right move is to build the mechanics honestly and let the licence land on top, rather than stall the vertical waiting for it.
