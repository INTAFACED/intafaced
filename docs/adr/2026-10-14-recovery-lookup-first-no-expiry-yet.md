# ADR: Recovery looks the key up first and books it at any age; re-sends are bounded in flight, with no expiry yet

**Status:** accepted (phased). Phase 1 = bug fixes and the in-flight bound (this PR). Phase 2 = a fence for price-dependent system posts (liquidation rungs, a re-driven loan draw). Phase 3 = scheduled recovery jobs and age alerts.
**Date:** 2026-10-14
**Deciders:** agents (lead plus two independent Opus refuters). Nitro decides any step that would expire a customer-authorised request (deferred, see "Deferred decisions").
**Area:** money spine (svc-bank, svc-ledger; svc-pay later). Recovery jobs.
**Supersedes:** the first draft of this record (the same day), which proposed a per-flow expiry window enforced by the ledger. It is dropped for now, with reasons below.

## Context and problem

When the ledger's reply to a bank post is lost, the claim row stays `pending` on its original terms (PR #4560). Then a recovery job, the risk sweep or a same-key retry re-sends the post on the original key, with no time limit. The question this record settles: may a request the ledger never booked be booked hours or days later without a fresh yes?

What the code does (origin/main, 2026-10-14):

- **The ledger never forgets a booked key.** `ledger_tx.idempotency_key` has a unique index (`svc-ledger/drizzle/0000_ledger_init.sql`). `ledger_posted_keys` is append-only and triggers refuse UPDATE and DELETE (`0017_posted_key_lock.sql`). The same key with a different body is refused as `ledger.idempotency_conflict` (`0021`). The key check runs before validation and before the freeze check. There is no TTL. **A re-send can never double-book.** An expiry is a consent and price-staleness rule, not a duplicate guard.
- **Nothing stops a late commit.** svc-bank's post budget is 10 s per attempt, 2 retries and a 25 s deadline (`services/svc-bank/src/ledger-client.ts`). A request already inside svc-ledger keeps running after the caller gives up. The server's bounds were `statement_timeout` 15 s per statement and, until this PR, no bound on the gap between statements. "The key lookup says not booked" is strong evidence, not proof that the original can never commit.
- Recovery paths without an age bound: loan repayments (`recoverRepayments`), earn deposits (`resumePending`), loan opens (`resumePending`), liquidation rungs (the stored sale is re-booked at its stored mark), scheduled-transfer stranded claims, pay withdrawals, payouts.
- **Bugs found while checking** (fixed in phase 1):
  1. `abandonPending` (operator door `abandonPendingLoan`, `admin:treasury`) released collateral on any `pending` loan without looking up the draw key. If the draw committed and its reply was lost, the collateral was released and the drawn loan was left unsecured.
  2. Loan `resumePending` re-posted the draw with no fresh LTV check, so it could draw principal on a stale mark. It also re-posted a collateral lock that the ledger had definitely refused (`lockCollateral` returns `claimed:false, ledgerTxId:null` for a rejected row, and `drivenPost` posts again).
  3. Earn `resumePending` kept a definitely refused deposit pending, to book when funds arrived later.
  4. Card settlement and auto-invest wrote `rejected` on any failure, including an unknown outcome. A durable `rejected` for a committed post is a false statement.

## Decision drivers

- No movement the customer no longer expects, and no booking on a stale price.
- A transient blip (a deploy restart, one timeout) must not become a customer-visible failure.
- An expiry must be a guarantee, not a hope. Expiring a claim while the original can still commit is a double movement once the customer retries on a new key.
- Small engineering cost, reversible numbers, no new ledger API without a need.
- Do not make things worse for the borrower, the saver or the payer in order to protect the platform.

## Considered options

1. **Always re-send (the status quo after #4560).** Cons: an outage that ends on day 3 moves money with nobody's current consent. Liquidation and loan-draw re-sends book at stale prices. Four bugs above.
2. **Never auto re-send.** Look up; if not booked, fail at once. Cons: every blip becomes a failure, and it is unsafe without a fence because the in-flight original can still land.
3. **Lookup first, plus one global window of 30 minutes.** Too long for a liquidation, too short for a standing order, wrong for a merchant payout, and not fenced.
4. **Lookup first, per-flow windows enforced by the ledger (the first draft): `valid_until` on every claim, `validUntil` on every post, a `ledger_expired_keys` table, `ledger.request_expired` as a definite refusal.** Dropped for now, see below.
5. **Lookup first, no expiry yet, an in-flight bound for the one release that needs it, and a later fence only for price-dependent system posts (chosen, phased).**

### Why option 4 was dropped

Two independent refuters (A on the fence's correctness, B on scope and judgement) both returned "holds with changes", and B recommended a much smaller scope. Accepted reasons:

- **Our competitors' windows are the opposite of 15 minutes.** Every cited idempotency window is a minimum retry-safe window of 24 hours to 30 days. None is a ledger-level fence, and none supports 15 minutes.
- **A 15-minute expiry on a loan repayment works against the borrower.** The risk sweep re-drives repayments before it reads the debt. An expired repayment would make the debt read in full and could liquidate a borrower who paid to cure a margin call.
- **"The customer may have spent the money" barely applies.** An internal outage that blocks the ledger also blocks every other movement of those funds.
- **The customer app keeps the request id stable across uncertain outcomes** (`apps/customer/src/features/money/pending-outcomes.ts`, a `localStorage` journal; `rooms.tsx` sends `eventId: requestId`). An expiry would burn a key the app will send again.
- **The fence as drafted was unsound.** It rolled back its own burn when the transaction aborted, and it read `now()`, which is the transaction start, before a lock wait of up to 15 s.
- **The field never reached the ledger.** `validUntil` would be dropped by both post doors (`s2s-http.ts`, `router.ts`) and ignored by an older ledger. Mixed-version safety needs the ledger to echo what it enforced.

## Decision outcome

Option 5. Rule for every recovery path:

1. **Look the key up first (`getTxByKey`).** If it is booked, adopt it at any age. Adopting means recording the booked transaction, never re-posting.
2. **Not booked: re-send on the original key and terms**, except where re-sending needs a price. Then the price is re-checked first (loan draw) or, in phase 2, fenced (liquidation rung).
3. **A release or a delete that assumes the key is dead** (the only one in phase 1 is `abandonPending` releasing collateral) waits until the original call can no longer commit: **7 minutes** after the last post attempt, on the database clock. The four limits: a 25 s caller deadline, a 300 s signed-call skew (`SERVICE_CALL_MAX_SKEW_SECONDS`), a 15 s statement timeout and a 60 s idle-in-transaction limit, 400 s in total.
4. **A definite refusal during recovery is final.** An unknown outcome is never written as `rejected`.

### Phase 1: this PR (bug fixes, no new ledger API, no new table, no migration)

- `abandonPending`: lookup first. Booked: adopt (the loan goes `active`, no collateral moves). Not booked and the last attempt is under 7 minutes old: refuse `bank.loan_attempt_too_recent` (HTTP 409) with the wait. Otherwise release. The last-attempt time is the loan row's `updated_at`, written on the database clock before each lock and draw post (nothing else touches a pending row), so no schema change. A per-loan advisory lock stops an abandon from running beside a resume.
- Loan `resumePending`: a rejected lock is final; a booked draw is adopted; otherwise a fresh LTV check on a mark no older than `maxAgeSeconds` (300 s) runs before the draw is re-posted, and a failed check leaves the loan pending for abandon.
- Earn `resumePending`: a definite refusal deletes the claim, as `deposit()` does.
- svc-ledger pool: `idle_in_transaction_session_timeout` 60 000 ms, the same value as `packages/db`.
- Card settlement and auto-invest: only a definite refusal (`isDefiniteLedgerRefusal`, or a typed bank refusal) becomes `rejected`; an unknown outcome stays `pending` and the same key is re-driven.
- Runbook: [`docs/runbooks/bank-recovery-ops.md`](../runbooks/bank-recovery-ops.md).

### Phase 2: fence only price-dependent system posts

Liquidation rungs (`validUntil` = the mark's observed time plus 60 s, never `created_at`) and a re-driven loan draw (a short window plus the fresh LTV check). A stateless check inside the ledger lock: read `clock_timestamp()` after the chain-tip lock is held, before the freeze check, and after the posted-key check (a booked key is always replayed). Forward `validUntil` through both doors, have the acknowledgement and `txByKey` echo the enforced value, and gate the bank and trade use on that echo (mixed-version safety). `ledger.request_expired` joins the definite refusals with an explicit mapping to `bank.liquidation_sale_expired` or `bank.intent_expired` (`drivenPost` writes `rejection_code = err.code` today). A stateless check protects every post that carries `validUntil`, because the in-flight original carries the same one. The expired-keys table stays deferred.

### Phase 3: recovery operations

Schedule the existing recovery jobs (lookup first, adopt at any age, re-send on the original key and terms). Alert on the age of the oldest pending claim per flow (15 minutes warn, 1 hour page-equivalent log). A merchant payout's 72 hours is an alert threshold, not a window. A stuck-payout operator queue does not exist in svc-pay and is new work.

### Deferred decisions (each its own decision)

- Expiry for customer-authorised intents (repay, earn deposit, collateral top-up, pay withdrawal hold). If ever: hours, not minutes, and only together with the customer-app journal changes, refusal-code mapping and copy. **Nitro's call.**
- The `ledger_expired_keys` table and a body-free `expireKey` door (the refuter's design: commit the burn after the transaction via a sentinel, use `clock_timestamp()`, take `pg_advisory_xact_lock(hashtextextended(key, 0))` until per-asset sharding is wired).
- A scheduled-transfer skip rule (`transfer-service.ts` documents the opposite intent; the money stays inside the customer's own spaces).
- A pay-withdrawal recovery job (take `withPayoutLock(withdraw:[userId, clientRef])`; decide what to do with a booked hold without a rail attempt).
- Customer copy never promises a time limit: "We're confirming this. You won't be charged twice."

## Evidence

Corrected after the refutation. The first draft over-read some sources.

| Name                 | What they do                                                                                                                                                                                           | Source                                                                                                       | Confidence                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| Stripe               | Keys may be pruned after at least 24 h. **A later reuse is a NEW request: the opposite of a burn.** A replay returns the saved response, including a 500. A different body is an error.                | https://docs.stripe.com/api/idempotent_requests                                                              | High (fetched 2026-10-14)                         |
| Stripe (API v2)      | "Retries failed or partially failed work to completion", which supports unattended completion.                                                                                                         | Stripe docs, cited in the refutation notes. Not re-fetched for this record.                                  | Medium                                            |
| Adyen                | Keys valid for 7 to 14 days after first submission.                                                                                                                                                    | https://docs.adyen.com/development-resources/api-idempotency                                                 | Medium                                            |
| Checkout.com         | Keys expire after 72 h by default; only 2xx responses are cached.                                                                                                                                      | https://www.checkout.com/docs/payments/manage-payments/idempotency                                           | Medium (an older page said 24 h)                  |
| Column               | "Reserves the right to expire idempotency keys after 30 days."                                                                                                                                         | https://docs.column.com/markdown/working-with-the-api/idempotency.md                                         | Medium                                            |
| Stripe (cards)       | Authorisation holds last 7 days online and 2 days in person, then the funds are released. A card authorisation is a hold, not a lost-reply retry window.                                               | https://docs.stripe.com/payments/place-a-hold-on-a-payment-method                                            | High                                              |
| SEPA SCT Inst        | 10 s target, 20 s hard time-out; the payer's bank "cannot unilaterally reject … until … it receives a negative confirmation". The claim that "the scheme fences late confirmations" is **unverified**. | https://www.iso20022payments.com/the-key-features-of-sct-inst/ (secondary). The EPC rulebook was not opened. | Medium for the time-outs; low for the fence claim |
| Kraken               | The one-hour expiry is for **confirming a new withdrawal address**, not for a withdrawal request.                                                                                                      | https://support.kraken.com/articles/15578074174996                                                           | Low (search snippet)                              |
| Wise                 | About two weeks to auto-cancel an **unfunded** order.                                                                                                                                                  | https://docs.wise.com/guides/product/send-money/funding/bulk-settlement/transfer-funding                     | Low (snippet)                                     |
| PSD2 Art. 64, 80, 83 | After receipt a payment order is irrevocable and funds must reach the payee's provider by the end of the next business day. Relevant only if we offer regulated payment orders to external payees.     | EBA Q&A https://www.eba.europa.eu/single-rule-book-qa/qna/view/publicId/2023_6873 (EUR-Lex was blocked)      | Medium                                            |
| **15 minutes**       | An internal engineering estimate for a rolling restart plus a few attempts. **Not evidence, and not used now.**                                                                                        | n/a                                                                                                          | n/a                                               |

## Consequences

- Good: the `abandonPending` collateral bug, the stale-price draw, the re-booked refused lock, the lingering refused earn deposit and the false `rejected` rows are closed. The one release that assumes a dead key now has a stated, tested bound. No new ledger API, table or migration.
- Bad: a request the ledger never booked can still book late. Phase 1 does not change that, it only stops the price-dependent draw and the unsafe release. An operator now waits up to 7 minutes after the last attempt to abandon a loan. A threshold-sweep or DCA run left `pending` is not re-driven by the runner (it was `rejected` and not re-driven before).
- Risks:
  - The 60 s idle limit is real only once svc-ledger with the setting is deployed. Until then the 7-minute bound is unproven. The runbook says so.
  - The DCA convert port reports a timeout after the order was sent as a typed refusal, so a DCA run can still be marked `rejected` wrongly. Out of scope; the runbook lists it.
  - The bank and ledger database clocks can differ. The bound uses only the bank database's clock on both sides of the comparison.
- Monitor (phase 3): the age of the oldest pending claim per flow; the count of `bank.loan_attempt_too_recent` refusals; any `adopted` loan.

## Reversibility

Two-way. Phase 1 adds no schema, no ledger API and no data format. Reverting the code restores the old behaviour (and its bugs). The 7-minute constant and the 60 s ledger setting are one-line changes. Phase 2 adds an optional field that an old ledger ignores. The deferred expired-keys table is the only piece that would be hard to remove, and it is not built.

## Revisit when

- The first customer-authorised flow where booking late harms the customer.
- Any flow with a client journal change (the customer app's pending-outcomes journal).
- An incident where a late booking was reported, or a ledger incident longer than 7 minutes.
- INTAFACED offers regulated payment orders to external payees (counsel; Nitro's call).
- The liquidation venue starts executing external fills before booking: a fill is then a fact and gets no window.
- Six months from now (2027-04).
