# svc-p2p

**Peer-to-peer trading with escrow (§6.2).** Phase 3, alongside svc-pay.

Direct maker/taker trading in 100+ fiat currencies, ledger-backed escrow, moderated disputes, and a reputation record that feeds the same XP graph as everything else — so a spotless P2P history raises limits platform-wide (§6.2 → §4.1).

**What this service is not:** it does not hold balances. `p2p_trades.amount` is the quantity that was locked, recorded once and never mutated. The value itself lives in svc-ledger's `escrow` account kind. `escrowIntegrity()` exists so those two independent answers can be compared, and a test asserts they agree.

**What it does hold, and holds carefully:** a seller's **payment instrument** — the account the buyer actually sends money to. It is the only personal data in the service and the most attractive row in it to steal. One rule governs it: _an instrument is disclosed only while the escrow it is attached to is held, and a disclosure that is not logged cannot happen._

---

## The one thing this service is for

> Locked funds must always reach exactly one terminal state. Not usually. Not after an operator intervenes. Always, including when the process dies at the worst possible instruction.

Two properties do the work. Everything else is bookkeeping around them.

### 1 · Decide, then post

A terminal decision is written and **committed** to `p2p_trades.resolution` _before_ the ledger post that acts on it. The database allows exactly one resolution per trade (`p2p_trades_resolution_matches_status_ck`), so "released to both parties" is not a race to lose — it is a row that cannot be written.

Crash between the decision and the post and the funds are **late, not stranded**: `sweepSettlements()` finds `resolved_at IS NOT NULL AND settled_at IS NULL` and re-posts. Every recipe is keyed on the trade id, so re-posting moves nothing twice.

This is also why §5's rule about moderators falls out for free — the ruling _is_ the decision record, and it commits in the same transaction as the trade's resolution. There is no movement the audit trail cannot explain, because the explanation is written first.

### 2 · Re-drive, don't interrogate

"Did the escrow lock post?" is answered by **calling `escrowLock` again**. Its business key `p2p.escrow.lock:<tradeId>` makes a retry return the original transaction if it did, and fail on `ledger.insufficient_funds` if it did not — because the ledger checks idempotency _before_ it checks funds.

A transport error, failed SQL commit, or lost acknowledgement can leave a trade in `created` with an uncertain ledger outcome. Only a complete definitive `ledger.insufficient_funds` refusal on the first durably claimed attempt permits a void; concurrent attempts serialize on the same trade row through the post and its outcome. This matters more than it looks: each lock lands in a **per-trade** escrow pot (`tradeEscrowAccount(seller, asset, tradeId)`), but a refund posted against a lock that never happened would still be wrong — it would invent a pot credit with no matching lock history, and the refund path is therefore unreachable from `created`. `created` is the only state where the lock is not provably done.

The service-local ledger HTTP client has a 15,000 ms transport budget covering response headers and body reads. An abort releases the SQL transaction without treating the timeout as proof that the ledger did nothing. The SQL statement timeout does not bound an HTTP await. This transport budget does not set an escrow or business deadline.

Before every remote lock request, a separate transaction commits its possible attempt on the trade. A timeout stops the local HTTP await, not an accepted remote ledger handler. Later funds refusals cannot erase earlier uncertain attempts or restore inventory. A validated positive acknowledgement lets the existing sweep converge on the exact original recipe and business key. Existing attempt history stays NULL on upgrade; no count or receipt is inferred. Counter down migration refuses to erase unresolved history from claimed created trades. The migration runner executes each complete down and its tracking-row deletion in one transaction; 0014 acquires an exclusive table lock before checking history and holds it through DDL. Direct callers must use the same transaction contract.

A destructive first funds refusal must be a complete structured HTTP400 response whose decimal shortage matches the posted credit's asset and amount. An additional bounded read-only balance lookup verifies the opaque account identity, including explicit absence; its current amount is never evidence about the earlier post. Missing fields, inconsistent quantities, identity mismatch or a failed lookup retain uncertain intent. This read adds one HTTP budget to the refusal path.

Post acknowledgements must contain nonblank transaction ID and hash strings plus the server's valid canonical ISO timestamp. Missing, malformed or incomplete acknowledgements retain uncertain intent and publish no escrow event. No transaction-ID or hash format is inferred beyond the published response contract.

New trades claim their complete original terms before the first ledger intent. Those terms, the payment destination, terminal decision and human ruling cannot subsequently change. The claim timestamp proves the initial terms; it is not a ledger receipt or an acknowledgement that funds locked.

Upgraded legacy trades retain their populated terms and a NULL claim. Escrow actions and payment-detail disclosure refuse with `p2p.escrow_terms_unproven`; the migration does not fabricate proof from a mutable legacy amount. The current HTTP client exposes no readable transaction receipt, so it cannot prove legacy terms automatically. Duplicate take requests still return `p2p.trade_exists`; recovery uses the existing sweeper and the original immutable recipe and business key.

---

## Trade state machine

```
                     ┌──────────── cancelled (voided) ──────────┐
                     │              nothing was ever locked      │
 created ─── lock ──▶ escrowed ─── buyer marks paid ──▶ fiat_sent
    │                    │                                  │
    │                    ├──── cancel / payment timeout ────┤
    │                    │            ▼                     │
    │                    └──▶ cancelled (refunded) ◀────────┤
    │                                                        │
    │                    seller confirms fiat received       │
    │                             ▼                          │
    │                        released ◀──────────────────────┘
    │                             ▲
    └── escrow-lock failed        │  moderator: release
        (voided)             disputed ── moderator: refund ──▶ cancelled
                                  ▲
                     either party, or the release timeout
```

The six states are §6.2's enum exactly. `resolution` (`released` · `refunded` · `voided`) records where the value went; `voided` means the lock never happened, so nothing had to move.

| State       | Holds escrow? | Deadline                | What the clock does about it                                   |
| ----------- | ------------- | ----------------------- | -------------------------------------------------------------- |
| `created`   | not provably  | owner-published integer | re-drive the lock, then refund or void                         |
| `escrowed`  | yes           | owner-published integer | **refund** — the buyer never even claimed to pay               |
| `fiat_sent` | yes           | owner-published integer | **open a dispute** — never auto-release                        |
| `disputed`  | yes           | owner-published integer | **escalate and re-arm** — nothing moves without a human ruling |
| `released`  | no            | —                       | terminal                                                       |
| `cancelled` | no            | —                       | terminal                                                       |

The four clocks in that table are owner-published integers. `index.ts` installs only `publishedEscrowDeadlineSeconds`, `publishedPaymentDeadlineSeconds`, `publishedReleaseDeadlineSeconds`, and `publishedDisputeSlaSeconds`. A blank env throws `p2p.escrow_deadline_unset`, `p2p.payment_deadline_unset`, `p2p.release_deadline_unset`, or `p2p.dispute_sla_unset`. The payment and release clocks keep the existing 60-second floor.

The three states that hold escrow are also **exactly** the three in which the seller's payment destination is disclosed to the buyer. That is not a coincidence and it is not two rules: the buyer needs somewhere to pay for precisely as long as the seller's asset is locked against that payment, and not one moment before or after. See the payment-instruments section below.

`fiat_sent` deliberately does **not** auto-release. The buyer says they paid and the seller has not confirmed: that is two people disagreeing, not a stall. Auto-releasing would hand the asset to anyone willing to click "I've paid" and wait out the clock.

`disputed` deliberately does **not** terminate on a clock, and this is the one behaviour in the service that changed rather than being added to.

It used to. A 7-day timer called `backstop_resolve` refunded the buyer and attributed the refund to `system:p2p-backstop` — an automated resolution of a disputed release, which SPEC-OTC-RFQ-AND-EARN (removed) says is the one place in the platform where a human decision is the design rather than the fallback. It fired while there was **no queue** to find a dispute in, **no way to read the evidence** filed on it, and **no session that could hold `admin:compliance`**. A timer that acts because nobody could have looked is not a fallback; it is the only path.

Past its SLA a dispute now **escalates**: `escalated_at` is stamped, the count goes up, the dispute keeps its (now past) deadline so the moderator queue's "most overdue first" ordering keeps telling the truth, and the trade's own `deadline_at` re-arms on `P2P_DISPUTE_ESCALATION_RECHECK_SECONDS` so it stays visible to the sweeper. The escrow does not move.

**Who can moderate.** `disputes.list` / `disputes.resolve` require a human: either a principal that holds `admin:compliance`, or a natural-person id listed in `P2P_MODERATOR_USER_IDS` (ordinary `p2p:read` is enough for those ids). An empty allowlist is not a soft default — the API returns `p2p.moderation_unreachable` rather than pretending a console is staffed. `disputes.open` and `/health` disclose `moderationConfigured` plus `moderation.status` (`absent` / `configured`) — a named allowlist is not a live probe. The `p2p:moderate` scope split remains an owner sign-off and is not minted here.

That reads like a conflict with `p2p_trades_live_has_deadline_ck`, which makes "a trade sits in escrow with no clock on it" unrepresentable. It is not: **the constraint requires a live trade to carry a deadline; it does not require the deadline to dispose of value.**

And the database enforces the rest. `p2p_trades_disputed_needs_ruling_trg` refuses any write that terminates a `disputed` trade unless the dispute row is already `resolved` and attributed to a moderator id that is not a `system:` principal. A future timer cannot become a moderator again without impersonating a person, which is a thing a reviewer sees rather than a default nobody read.

---

## API

tRPC (`src/router.ts`). Money crosses the boundary as **decimal strings**, in and out — including the fiat leg. `Amount` (scaled bigint) in memory; a JS `number` never touches a P2P amount.

Every procedure is `scopedProcedure(scope, { module: 'p2p' })`, which checks the scope _and_ runs the jurisdiction matrix (§7). P2P is custodial on the Fiat Plane, so §22 puts it behind tiered verification — and that follows from `module: 'p2p'`, not from a check written in this service.

| Procedure                            | Scope                    | Purpose                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------ | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fiat.list`                          | public                   | The enabled currency registry, straight from `packages/config`                                                                                                                                                                                                                                                                                                                                                  |
| `offers.create`                      | `p2p:write`              | Publish an offer, fixed or floating price                                                                                                                                                                                                                                                                                                                                                                       |
| `offers.list`                        | `p2p:read`               | The board — active offers with liquidity left to take                                                                                                                                                                                                                                                                                                                                                           |
| `offers.page`                        | `p2p:read`               | The board by cursor (P-trade-orders-01): filters `asset`, `fiatCurrency`, `side`, `methodId`, `makerId`, `fiatAmount` (fixed-price ads that can take that fiat amount whole); `sort` `price_asc` (default) or `price_desc`, floating ads last; a floating ad carries `referencePrice`, null when no market feed prices its pair. A cursor carries its sort and refuses `p2p.offer_cursor_invalid` under another |
| `offers.get` / `offers.close`        | `p2p:read` / `p2p:write` | Closing withdraws remaining liquidity; while an order on the ad is open it refuses `p2p.offer_has_open_trades` with `data.p2pLimit` `{ openTrades, openTradeIds }` and never cancels an order. The maker reads their own ad as stored, paused included                                                                                                                                                          |
| `offers.mine`                        | `p2p:read`               | The caller's own ads in one status (`active`, `paused` or `closed`), with `pauseReason`, `closeReason`, `statusSince` and, for closed ads, `relistedAs`; the board lists active ads only                                                                                                                                                                                                                        |
| `offers.relist` / `offers.editQuota` | `p2p:write` / `p2p:read` | Relist a closed ad as a new ad (every create check, one per closed ad); the caller's ad edits today against `P2P_OFFER_EDITS_PER_DAY`                                                                                                                                                                                                                                                                           |
| `offers.pause` / `offers.resume`     | `p2p:write`              | Hide / restore remaining liquidity without cancelling open trades. A sell ad resumes only while one of its methods is payable                                                                                                                                                                                                                                                                                   |
| `access.eligibility`                 | `p2p:read`               | Each take requirement (verification, contact, region, deposit): met, not met with its fix, or unknown                                                                                                                                                                                                                                                                                                           |
| `trades.quote`                       | `p2p:read`               | The figures a take would place: by `amount` or by `fiatAmount` (converted at the ad's price, rounded down; finer than the currency's unit refuses `p2p.invalid_amount`). Reserves nothing                                                                                                                                                                                                                       |
| `trades.lockQuote`                   | `p2p:write`              | P-trade-orders-06. Holds those figures for the escrow window under a client `quoteId` (`p2p.take_quotes`); `trades.take` with it places exactly them or refuses `p2p.quote_expired` / `p2p.quote_changed` before anything is reserved                                                                                                                                                                           |
| `trades.take`                        | `p2p:write`              | **→ `escrowLock`.** Requirements, bounds, liquidity **and destination** before any lock                                                                                                                                                                                                                                                                                                                         |
| `trades.markFiatSent`                | `p2p:write`              | Buyer only                                                                                                                                                                                                                                                                                                                                                                                                      |
| `trades.confirmReceived`             | `p2p:write`              | Seller only. **→ `escrowRelease`**                                                                                                                                                                                                                                                                                                                                                                              |
| `trades.cancel`                      | `p2p:write`              | **→ `escrowRefund`**, in full; refused from `fiat_sent` (`p2p.cancel_after_paid`)                                                                                                                                                                                                                                                                                                                               |
| `trades.get` / `trades.list`         | `p2p:read`               | Never carry a payment instrument — see below                                                                                                                                                                                                                                                                                                                                                                    |
| `trades.paymentInstrument`           | `p2p:read`               | **Where to send the money.** Party-or-moderator, live escrow only, logged                                                                                                                                                                                                                                                                                                                                       |
| `disputes.open`                      | `p2p:write`              | Either party. Discloses `ifNobodyRules` + `moderationConfigured` (not reachable)                                                                                                                                                                                                                                                                                                                                |
| `disputes.appendEvidence`            | `p2p:write`              | Either party, while open. **Append-only** — no edit, no remove                                                                                                                                                                                                                                                                                                                                                  |
| `disputes.get`                       | `p2p:read`               | Party sees their own evidence; moderator sees all of it                                                                                                                                                                                                                                                                                                                                                         |
| `disputes.list`                      | `p2p:read` + moderator   | **The queue** — allowlisted id or `admin:compliance`; else honest refuse                                                                                                                                                                                                                                                                                                                                        |
| `disputes.resolve`                   | `p2p:read` + moderator   | **Moderator only** — release or refund; empty allowlist → unreachable                                                                                                                                                                                                                                                                                                                                           |
| `reputation.get`                     | `p2p:read`               | Snapshot + derived badges + `merchant` vouch (false when frozen)                                                                                                                                                                                                                                                                                                                                                |
| `instruments.methods.list`           | `p2p:read`               | What each method needs, per country. About methods, never about people                                                                                                                                                                                                                                                                                                                                          |
| `instruments.methods.register`       | `admin:compliance`       | **Operator only** — declare a market's field requirements                                                                                                                                                                                                                                                                                                                                                       |
| `instruments.methods.setEnabled`     | `admin:compliance`       | Stop accepting new instruments for a method/country                                                                                                                                                                                                                                                                                                                                                             |
| `instruments.create`                 | `p2p:write`              | Register a destination. Needs a fresh confirmation of exactly this change (`stepUpApprovalId`)                                                                                                                                                                                                                                                                                                                  |
| `instruments.update`                 | `p2p:write`              | Edit. Does not reach a trade already holding a snapshot. Needs a fresh confirmation                                                                                                                                                                                                                                                                                                                             |
| `instruments.removalImpact`          | `p2p:read`               | The caller's active sell ads that list this method, and which ones it is the last payable method for (`pauses`)                                                                                                                                                                                                                                                                                                 |
| `instruments.remove`                 | `p2p:write`              | A state change, never a DELETE. Needs a fresh confirmation; `pauseOfferIds` names the ads it is the last method for, which pause with it                                                                                                                                                                                                                                                                        |
| `instruments.list`                   | `p2p:read`               | The caller's own — **headers only, no field values, ever**                                                                                                                                                                                                                                                                                                                                                      |
| `instruments.reveal`                 | `p2p:write`              | The owner reads their own values. Logged like anyone else's read                                                                                                                                                                                                                                                                                                                                                |
| `instruments.revealMasked`           | `p2p:write`              | The owner reads their own values masked: the account holder whole, the rest by their last four. Logged                                                                                                                                                                                                                                                                                                          |
| `instruments.accessLog`              | `p2p:read`               | "Who has looked at my account details, and when"                                                                                                                                                                                                                                                                                                                                                                |
| `merchants.me`                       | `p2p:read`               | Caller's merchant standing + history headers (Stage 1–2 programme)                                                                                                                                                                                                                                                                                                                                              |
| `merchants.apiAccess`                | `p2p:read`               | Current standing → API eligibility; names shared identity/edge planes; `disputeResolution: interactive_human_only`                                                                                                                                                                                                                                                                                              |
| `merchants.offerLimits`              | `p2p:read`               | Deployment ceilings: `posture` unset / unlimited / configured; null max = no numeric cap                                                                                                                                                                                                                                                                                                                        |
| `merchants.myOfferCeiling`           | `p2p:read`               | Ceiling that binds the caller now (band + standing + limitMode; null max = no numeric cap)                                                                                                                                                                                                                                                                                                                      |
| `merchants.submitApplication`        | `p2p:write`              | Apply for merchant standing                                                                                                                                                                                                                                                                                                                                                                                     |
| `merchants.withdraw`                 | `p2p:write`              | Withdraw a pending application                                                                                                                                                                                                                                                                                                                                                                                  |
| `merchants.decide`                   | `admin:compliance`       | Operator approve / reject / freeze (`suspended`); approve and unfreeze re-check live reputation snapshot                                                                                                                                                                                                                                                                                                        |
| `merchants.history`                  | `admin:compliance`       | Audit trail of standing changes                                                                                                                                                                                                                                                                                                                                                                                 |
| `ops.lateSettlements`                | `admin:compliance`       | Committed decisions with no ledger stamp yet (+ durable last settle error)                                                                                                                                                                                                                                                                                                                                      |
| `data.export`                        | `p2p:read`               | §0.9 — everything this service holds about **the caller**                                                                                                                                                                                                                                                                                                                                                       |
| `data.erase`                         | `p2p:write`              | §0.9 — self-only. Refuses while escrow is live; names what it retained                                                                                                                                                                                                                                                                                                                                          |

**Before a take** (`src/take-eligibility.ts`, P-trade-orders-02). `trades.take` refuses before it reserves or locks anything with `p2p.contact_required` when the caller's email address is not confirmed. Contact is svc-identity's fact, read from its `me` under this request's edge-signed principal (so it can only ever be the caller's own answer); unreachable identity or no `IDENTITY_URL` refuses `p2p.contact_unverifiable`. `access.eligibility` reports the same checks, so the panel and the refusal cannot disagree. No risk notice gates a take (owner decision 2026-10-27, until launch prep): the `risk.notice` / `risk.accept` procedures and `P2P_RISK_NOTICE_VERSION` are gone, and the `p2p.risk_acceptances` table stays in the schema: no take reads it, and `data.export` / `data.erase` list and delete the caller's rows.

**Take limits** (`src/take-limits.ts`, P-trade-orders-03; `src/verification-limits.ts`, P-disputes-security-15). `trades.quote`, `trades.lockQuote` and `trades.take` refuse before anything is reserved when the taker already holds `P2P_ACTIVE_ORDER_CAP` ongoing orders as taker (`created`, `escrowed`, `fiat_sent`, `disputed`; `p2p.active_order_cap`), when the order's fiat amount is outside the pair's bounds in `P2P_PAIR_LIMITS` (`p2p.pair_limit_exceeded`), or when a published verification-level allowance would be passed. The take checks the cap again under a per-taker lock, so two takes at once cannot both take the last place. A blank cap, a blank or partial pair table, or a pair the table leaves out refuses every take `p2p.config_unset`. Each refusal carries its figures on the error as `data.p2pLimit` (contracts `p2pLimitOf`): `until` (the soonest open order's deadline on the cap, the next UTC day on the daily allowance, `null` where the limit has no end time), the bounds or `remaining`, the `currency`, and the caller's own open order ids on the cap.

**Buying pause** (P-trade-orders-05). A person who cancelled `P2P_BUYER_CANCEL_LIMIT` orders as buyer within `P2P_BUYER_CANCEL_WINDOW_HOURS` (their own cancels, `buyer.*`, and payment windows they let run out, `timeout.payment_window_elapsed`; a seller's cancel or a moderator's refund does not count) may not buy until the oldest of those leaves the window: a take of a sell ad and a new buy ad refuse `p2p.buying_restricted` with `data.p2pLimit` `{ until, cap, windowHours }`, and a seller taking their buy ad meanwhile gets `p2p.offer_not_active`, nothing about the pause. Selling is not paused. Either value blank refuses every buy `p2p.config_unset`. A retry of a take that already placed is still `p2p.trade_exists`.

**Seller reminders** (P-trade-orders-15). On a paid order (`fiat_sent`) the buyer may call `trades.remind` once `P2P_REMIND_WAIT_SECONDS` have passed since the order was marked paid, and again that long after each reminder, up to `P2P_REMIND_MAX` reminders per order. Too early refuses `p2p.remind_too_early` with `data.p2pLimit.until`; past the count `p2p.remind_rate_limited` with `data.p2pLimit.cap`; either value blank refuses `p2p.config_unset`. The seller, a stranger and an order in any other state are refused as for any other move. Each reminder is a numbered row in `p2p.trade_reminders`, written under the order's lock, and the outbox for `p2p.trade_reminder.sent` (key `p2p.trade_reminder.sent:<tradeId>:<n>`); the sweep hands over any the fast path missed and closes those whose order has left `fiat_sent`. `trades.get` carries `reminders { count, lastAt, nextAt, max }`. Nothing moves.

**Advertiser terms and the free balance at post** (P-ads-merchant-01, `src/advertiser-terms.ts`). Every new ad, from the form or a merchant key, needs the person to have accepted the owner-published advertiser terms (`P2P_ADVERTISER_TERMS_VERSION`; blank refuses every post `p2p.config_unset` naming the setting). `merchants.advertiserTerms` says the version and when the caller accepted it; `merchants.acceptAdvertiserTerms { version }` accepts exactly the published version (any other refuses `p2p.terms_version_stale`), once per person and version in `p2p.advertiser_terms_acceptances`, and only interactively (an API key cannot). Posting without it refuses `p2p.terms_not_accepted` (FORBIDDEN); the form sends the version it showed as `advertiserTermsVersion`, and an older one refuses `p2p.terms_version_stale`. A sell ad whose total is above the maker's free balance of the coin (the ledger's `userAvailable`, also readable as `offers.sellBalance`) refuses `p2p.insufficient_balance` with `data.p2pLimit { available, shortBy }`. The check is advisory: nothing is reserved at post, and the escrow still locks per order at take, so two sell ads may promise the same balance. A retry under a key that already published skips both checks and answers the posted ad.

**Per-order limits by level at post, and edits** (P-ads-merchant-02, `buyAdRangeRefusal` in `src/verification-limits.ts`). On a buy ad the maker is the buyer in every order, and every take of it meets the maker's verification level (`P2P_VERIFICATION_LIMITS`, the tier stored at create). So a fixed-price buy ad whose per-order range (the smallest and the largest order priced as a take prices them, to the currency's smallest unit) passes that level's band refuses at post and at edit with the take's own codes, `p2p.verification_order_max` or `p2p.verification_order_min`, and `data.p2pLimit { min, max, currency }`. A buy ad in another currency than the table's refuses `p2p.verification_limit_currency`, and an unwired level `p2p.verification_level_unwired`, as every take of it would. A floating buy ad has no fiat range until a take resolves it, and a sell ad's buyers meet their own levels, so both are left to the take; an unpublished table checks nothing, as at take. `limits.verification` is the band the form shows. An edit is checked only when it widens a buy ad's range, so an ad listed before the table was published or tightened can be brought down step by step; a retry of a post that already published answers the ad. An edit that makes a sell ad offer more than before (its remaining amount goes up) checks the free balance as a new ad does; offering less never reads it.

**Content rules for an ad's terms** (P-ads-merchant-05, `src/ad-content-rules.ts`). Compliance publishes `P2P_AD_CONTENT_RULES`, a JSON object of rule class to the phrases an ad may not carry (`{"messenger":["telegram"],"link":["https://"]}`). Terms that carry one refuse at post, and at an edit that changes the terms to something non-blank, with `p2p.content_rule_violation` and `data.p2pLimit { ruleClass }`; the refusal names the class and never the phrase that matched. Matching is on folded text (NFKC, lower case, invisible format characters removed, white space runs read as one space), whole-word where a phrase starts or ends with a letter. Blank means no list is published and the filter is off; a value that is not a whole list refuses every post `p2p.content_rules_invalid` (PRECONDITION_FAILED). Terms an edit leaves alone are not re-judged, and a retry of a post that already published answers the ad.

**Posting thresholds per fiat** (P-ads-merchant-12, `src/posting-eligibility.ts`). Compliance publishes `P2P_POSTING_THRESHOLDS`, a JSON object of fiat to `{ minKycTier?, minCompletedOrders?, minCompletionRatePct? }` (strings) or `"none"`. A new ad in a fiat with thresholds needs every one met, or refuses `p2p.posting_threshold_not_met`; `"none"` leaves posting to the jurisdiction gate; a fiat not listed, or the setting blank, refuses posting in it `p2p.config_unset` naming the fiat (spec C3); a value that is not a whole list refuses every post `p2p.posting_thresholds_invalid` (PRECONDITION_FAILED). The level is the signed-in tier, finished orders and the completion rate are the lifetime figures of `completion-rate.ts` (no finished order is no rate, which is unknown and refuses). The rate threshold is judged exactly on the counts (finished × 10000 ≥ threshold in hundredths × counted), so a rate shown rounded up to the target does not meet it. A fiat that publishes `minCompletionRatePct` refuses everyone who has no finished order yet, so a new advertiser cannot post a first ad in that fiat; publish it only where that is meant. `merchants.postingEligibility { fiatCurrency }` is the checklist the form shows: the fiat's policy and every check, met, not met or unknown, with the caller's value and the target; the same `postingChecks` judges a post, so the list and the refusal agree (the fiat is read in capitals, as a post stores it). Order history is read only when a threshold needs it. A retry of a post that already published answers the ad. Edits are not re-judged.

**A floating price needs a reference at post** (P-ads-merchant-03). A floating ad is priced at take from the market reference for its coin and fiat. When no reference is published for that pair, `offers.create` refuses the floating ad with `p2p.reference_price_unavailable` (BAD_REQUEST) and posts nothing, so the board never lists an ad nobody can price; a fixed-price ad in the same pair still posts. The check runs with the other post checks, after the retry short-circuit, and is refused after the advertiser terms and the posting thresholds. An ad already listed whose reference stops later stays on the board with `referencePrice: null` (the board says "Needs a market feed") and every take of it refuses the same code until the reference is back.

**Amount mismatch** (P-trade-orders-20). On a paid order (`fiat_sent`) the seller may call `trades.reportMismatch { kind: under | over | partial, amountReceived }` with what arrived in their own bank. It is classified by `P2P_MISMATCH_TOLERANCE_BPS` (basis points of the order's fiat amount): `within_tolerance` logs it and the order goes on; `outside_tolerance` leaves the order paid, the seller is never made to release, and a dispute is the way on; a blank value classifies nothing (`reported`), so a person decides through a dispute. An amount that contradicts the kind, or is finer than the currency's unit, refuses `p2p.invalid_amount`. One report per order in `p2p.trade_mismatches`, written under the order's lock: the same report again answers the first, a different one refuses `p2p.mismatch_report_exists`. `trades.get` carries `mismatch`. Nothing moves. Refund deadlines, escalation and restriction (the rest of the spec's states) are a later slice.

**Payment validation** (P-trade-orders-11). `trades.validatePayment { tradeId }` lets the seller of a paid order have a bank rail check the payment. The rail is a port (`rail-validate.ts`); no banking partner is wired in this build, so it refuses `rail.bank` and `trades.get` carries `paymentValidation.blocker: 'rail.bank'`. With a rail, a method it does not cover refuses `p2p.method_not_rail_validated`; nothing arrived answers `pending`; an exact match (currency, amount, and the order id as the reference) releases through the same decide-then-post as the seller's release (`releaseForSeller`) (so a release by hand at the same moment posts once, and a second check answers the released order); anything else writes one `p2p.rail_exceptions` row per rail confirmation and refuses `p2p.rail_mismatch`, releasing nothing. A check that can release (seller, paid order, rail covering the method) asks for the same release confirmation as `trades.confirmReceived` (`stepUpApprovalId`, or the session's release window); references are compared as a bank renders them (case and separators aside).

**Retired payment methods** (P-trade-orders-03, migration 0022). An operator switches a method off in a market only through `instruments.methods.setEnabled` with a reason (`regulation`, `provider_withdrawn`, `fraud_risk`, `low_demand`; contracts `P2P_DELIST_REASONS`), and the reason is part of the two-person approval's payload hash. A register cannot switch a live method off. Once no market accepts the method, a quote on an ad that still lists it, and a take refused for it, answer `p2p.method_delisted` with `data.p2pLimit` `{ until: null, reason }`. The take asks only after its transaction has refused and rolled back, so a retry of a take that already placed is still `p2p.trade_exists`. Switching it back on, or registering it with `enabled: true`, clears the reason.

**Take confirmation** (P-trade-orders-07, migration 0023, `src/take-step-up.ts`). After the eligibility checks and before anything is reserved, `trades.take` needs a fresh passkey or authenticator code. The person confirms the exact take at identity (`stepUp.begin` / `stepUp.complete`, scope `p2p.step_up.trades.take`, fields `offerId`, `amount`, `method` and `quoteId` when a quote is held; the order id is not hashed) and sends the single-use `stepUpApprovalId` with it. svc-p2p recomputes the hash from the take's own strings, consumes the approval once with the caller's user and session (request id `p2p:take-step-up:<tradeId>`, so a lost reply replays), and records it in `p2p.take_step_ups`. That same session may take again for ten minutes (the D-145 window, fixed; a token refresh starts a new session and ends it) without a new confirmation; `trades.stepUpWindow` says until when. The use row keeps the confirmed terms' hash, so a retry of the same order id passes only with the same terms inside the window. The confirmation is spent before the take's own checks, so a take refused after it still opens the window: the window means the person proved a factor in this session. No confirmation refuses `auth.step_up_required`, an ended window `auth.step_up_expired`, and a spent, foreign or mismatched one `auth.step_up_failed`, all FORBIDDEN with nothing reserved. Identity unreachable, or no `IDENTITY_URL`, refuses `p2p.step_up_unverifiable` (PRECONDITION_FAILED), so the person is not asked for a factor that cannot be checked. An API key never confirms a take: merchant keys keep ads and their orders, and taking an ad needs a signed-in person.

**My Ads lifecycle** (P-ads-merchant-06, J-p2p-05 #1-#2, migration `20261030125739_p2p_ad_lifecycle`). Each ad carries `status_since` (a trigger sets it on every status change) and, when closed, `close_reason`: `by_you`, or `sold_out` when the decision that left it under its per-order minimum with no order open (a release, a refund after the minimum was raised, an edit) closed it, under the ad's row lock. `offers.close` refuses while an order on the ad is created, escrowed, paid or disputed, under the row lock a take holds. `offers.relist` posts a closed ad again as a new ad (`relisted_from`, id derived from the closed ad's, key `relist:<closedId>`) through `createOffer`, so every create check runs; asking again returns that ad. `offers.update` counts each accepted edit in `p2p.offer_edits` (keyed by the edit's idempotency key, under a per-person transaction lock) against `P2P_OFFER_EDITS_PER_DAY` per UTC day: blank refuses every edit and `offers.editQuota` `p2p.config_unset`; past the cap `p2p.edit_quota_reached` (TOO_MANY_REQUESTS) with `data.p2pLimit` `{ until: next UTC midnight, cap, remaining: '0' }`. An erase deletes the edit rows and exports them.

**Private ads and share links** (P-ads-merchant-07, J-p2p-05 #3, migration `20261030135324_p2p_private_ads`). `offers.setVisibility` makes the caller's open ad `public` (on the board) or `private`; the board lists public ads plus the viewer's own. `offers.shareLinks.create` makes a link (`linkId` chosen by the client) living `seconds` or the owner's longest, never longer (`P2P_SHARE_LINK_MAX_SECONDS`; blank refuses `p2p.config_unset`); the 32-character token is returned once and only its SHA-256 is kept. `offers.shareLinks.list` (no tokens) and `revoke` (at once; twice is one revoke) are the maker's alone. Every reader of an offer takes `shareToken`: `offers.get`, `trades.quote`, `trades.lockQuote`, `trades.take` (checked under the ad's row lock). A private ad without a live link refuses `p2p.offer_private` (NOT_FOUND), an ended link `p2p.share_link_expired`, a withdrawn one `p2p.share_link_revoked` (CONFLICT); a dead or foreign token never blocks a public ad or the maker. An order taken through a live link has `sharedFrom: true`, written once (a trigger refuses a change). Links are exported and erased with their maker.

**Merchant console** (P-ads-merchant-08, J-p2p-05 #4, migration `20261030194000_p2p_presence_console`). `merchants.setPresence` sets the caller `online`, `offline` or `scheduled`: a week of windows (`day` 1 Monday to 7 Sunday, `start` and `end` as `HH:MM`, `end` up to `24:00`) in an IANA `timezone`. An invalid week, an unknown zone or overlapping windows refuse `p2p.schedule_invalid`. An offline maker's ads, or a scheduled one's outside every window, leave the board for everyone else (`p2p.maker_on_board` in SQL); open orders carry on. `merchants.presence` reads it back with `onBoard` and `nextChangeAt`, the next time the board changes. `merchants.todos` lists the caller's open orders that wait on someone, soonest deadline first: `payment_required`, `release_required`, `counterparty_action`, and `dispute_open` with the moderator deadline. Each item links to its order. `offers.bulk` pauses, resumes or removes (closes) named ads, or `all` the action applies to (at most 100). Each ad answers for itself, for example `p2p.offer_closed` or `p2p.offer_has_open_trades`. The `idempotencyKey` is answered once: the same request returns the stored results, and another request under that key refuses `p2p.idempotency_conflict`. Presence and bulk runs are exported and erased with their person.

**Removing a method an ad needs** (P-ads-merchant-18, J-p2p-04 #4, migration `20261025003000_p2p_method_removal_pauses`). `instruments.removalImpact` lists the caller's active sell ads, in the instrument's currency, that declare its method, with `pauses: true` where it is the ad's last payable method. `instruments.remove` refuses `p2p.method_in_use` (CONFLICT) unless `pauseOfferIds` names every ad that would pause (the ones the person was shown), and refuses before the confirmation is spent; then, in one transaction under the maker's instrument key, the instrument is removed, those ads are set `paused` with `pause_reason = 'method_removed'`, ads the maker had paused by hand that lose their last method take the same reason, and a row in `p2p.method_removal_pauses` makes the maker's notice owed (erased with the maker). Posting or editing a sell ad checks its destinations again under the same key, so an ad never goes up on a method whose removal is committing. After the commit `p2p.offer.paused` (`p2pOfferPaused`, idempotency key `p2p.offer.paused:<instrumentId>`) goes to the bus, and the sweep hands over any row still unhanded. `offers.resume` of a sell ad refuses `p2p.offer_method_no_destination` until a method is payable again, and clears the reason; closing clears it too. The maker finds paused ads with `offers.mine` and reads them with `offers.get`.

**Payment-method confirmation** (P-ads-merchant-18, J-p2p-04 #3, migration `20261024233000_p2p_instrument_step_ups`, `src/instrument-step-up.ts`). `instruments.create`, `instruments.update` and `instruments.remove` each need a fresh passkey or authenticator code, every time: scope `p2p.step_up.instruments.change`, fields `instrumentId`, `change` (`create`, `update` or `remove`) and `detailsDigest`, the SHA-256 of the details the change saves as contracts' `p2pInstrumentDetailsDigest` computes it (empty when it saves none). svc-p2p recomputes the digest from the request, so one confirmation approves one account number on one method and identity never sees the details. It is consumed once under request id `p2p:instrument-step-up:<change>:<instrumentId>` and recorded in `p2p.instrument_step_ups`. There is no window, unlike a take or a release: the saved destination is what a stolen session would change. The record only lets the same session resend that very change with that approval for ten minutes after a lost answer. Without the instrument key the change refuses `p2p.instrument_kms_required` before a confirmation is spent; then the same refusals as a take. An API key never changes payment methods.

**Release confirmation** (P-trade-orders-07 and -16, migration `20261024111016_p2p_release_step_ups`, `src/release-step-up.ts`). `trades.confirmReceived` on a held escrow (`escrowed` or `fiat_sent`) needs the seller's fresh passkey or authenticator code too: scope `p2p.step_up.trades.confirmReceived`, field `tradeId` (the order's coin, amount and buyer are fixed at take, so the id names the release), sent as `stepUpApprovalId`, consumed once under request id `p2p:release-step-up:<tradeId>`, recorded in `p2p.release_step_ups`. As for takes, that session may release its other orders for ten minutes without another confirmation (`trades.releaseStepUpWindow`); a take's confirmation never covers a release. The same refusals as a take, before anything is decided; an API key never releases. A second press on an order this seller already released returns that order and asks for nothing. The buyer, a stranger, and a disputed or terminal order get the service's own refusal before any confirmation is asked for. `trades.get` adds `releasePreview` (the fee and buyer's share a release would post, while held) and `escrowHeld` (all of it until the decision is posted, zero after, null while `created`). `fees.schedule` (public) is the published `P2P_FEE_BPS`, charged on release off the released amount; unset refuses `p2p.fee_bps_unset`.

**Counterparty handle.** With `IDENTITY_URL` set, `reputation.get` names the other side by identity's `/internal/handle/:userId` (`src/public-profile.ts`); the door carries no member-since date, so `memberSince` stays null. Without it, the profile reads `p2p.public_profile_unwired`.

HTTP (`src/index.ts`):

| Route                              | Purpose                                                                                                                          |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                      | liveness; discloses `moderationConfigured` + `moderation` (absent/unprobed) + offer-limit posture                                |
| `GET /ready`                       | readiness; discloses `tradingEnabled` + `moderationConfigured` (not reachable)                                                   |
| `GET /internal/escrow-integrity`   | Doctrine §0.6 as an endpoint — this service's per-trade escrow view vs the ledger's per-trade pots. Non-zero drift returns 500   |
| `GET /internal/reputation/:userId` | Same snapshot as `reputation.get`: counters, derived badges, `merchant` freeze. Not a `p2pLimitMultiplier` (identity owns rank). |
| `GET /internal/moderation-backlog` | open / overdue / escalated / **never seen by a moderator**. Nothing drains this on a timer any more                              |

Three background sweeps start before the HTTP listener. The first two are why escrow cannot strand; the third is why we do not keep personal data after we need it:

- **timeout sweep** — resolves any trade whose deadline has passed
- **settlement sweep** — posts any resolution that was decided but not yet acted on. Failures stamp `last_settle_error` on the trade so `ops.lateSettlements` survives a process restart (not only process logs)
- **retention sweep** — wipes the payment details off closed trades past `P2P_INSTRUMENT_RETENTION_DAYS`

---

## Payment instruments — where the buyer actually sends the money

Escrow could lock, release, refund and go to a moderator, and a trade still could not complete: at the moment the buyer had to pay, there was no bank account, no wallet handle, no destination of any kind. The payment leg was a `method` string and a `terms` paragraph.

### The model, and why it is data rather than code

Three tables, and the split is the design:

| Table                       | What it is                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| `payment_method_schemas`    | **What a method needs, per country** — operator-supplied. Ships **empty**                        |
| `payment_instruments`       | A seller's destination. The live one they maintain                                               |
| `trade_payment_instruments` | **What the buyer was told to pay**, frozen at take. One row per trade                            |
| `instrument_access_log`     | Who looked at whose details, when, and whether they were allowed to. **Append-only, by trigger** |

What a payer needs in order to send money differs by method and by country, and **it is not this repo's knowledge to invent.** A hardcoded list of methods with hardcoded field names would be this codebase asserting what a bank transfer requires in one market or what a mobile-money handle looks like in another — assertions nobody here is entitled to make, and which would be wrong silently rather than loudly.

So the registry is data, and it ships with **no rows**. An operator with `admin:compliance` registers what a market actually requires; until they do, that market refuses instruments and no trade can be opened in it. That refusal is the honest behaviour — the alternative is a plausible-looking guess that produces instruments which pass validation and cannot be paid, discovered by a buyer after escrow is already locked.

An exact country always beats the `*` wildcard, and never falls back past it: a country-specific entry is the operator saying "this market is different", and ignoring that is how a complete-looking instrument turns out to be unpayable.

**Undeclared keys are refused, not dropped.** Silently ignoring an unknown field lets a client push arbitrary personal data into a blob nobody designed, nobody validates, and everybody then has to protect and eventually delete. Refusing it is what makes "what personal data do we hold about this person" a question with a finite answer.

### One active destination per `(owner, method, currency)`

A partial unique index. Not a limit for its own sake — it is what makes "which account does the buyer pay?" have exactly one answer.

The seller is resolved _from the trade_, because on a `buy` offer the seller is the **taker**, so the offer cannot carry the instrument. That makes it a lookup rather than a choice, and a lookup that can return two rows picks one by an ordering nobody designed — on the single field where the wrong choice sends a stranger's money to the wrong bank account. Rotation is sequential: remove, then add.

### Who can see an instrument, and when

> **An instrument is disclosed only while the escrow it is attached to is HELD — and a disclosure that is not logged cannot happen.**

| Who                                          | Sees it?                                       | Where                                                                            |
| -------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------- |
| A browsing user / a public offer             | **No**                                         | Offers carry method **ids**, never a destination                                 |
| Any `p2p:read` holder who is not a party     | **No** — `NOT_FOUND`                           | And the attempt is logged                                                        |
| The buyer, `escrowed`/`fiat_sent`/`disputed` | **Yes**                                        | `trades.paymentInstrument` only                                                  |
| The buyer, `created` (pre-lock)              | **No**                                         | Nothing is committed yet; disclosing here would be a free harvest                |
| Either party, `released`/`cancelled`         | **No**                                         | A finished trade is not a permanent licence                                      |
| The owner, their own                         | **Yes**, and logged                            | `instruments.reveal` (or masked, `instruments.revealMasked`) — never on any list |
| A moderator (`admin:compliance`)             | **Only while a dispute on that trade is open** | Logged as `viewer_role = 'moderator'`                                            |

`escrowed | fiat_sent | disputed` is exactly `ESCROW_HOLDING_STATUSES`. It is a better boundary than "while the trade exists" in both directions: not before the lock, so a taker cannot harvest details in the pre-escrow window; not after settlement, so dealing with someone once does not buy permanent access to their account.

**The moderator case is the one judgement call**, and it is deliberate. §A2 requires a human to resolve a disputed release and requires both sides to see the same evidence set; a human asked to rule on "I paid" / "nothing arrived" without seeing the account the payment was meant to reach is being asked to guess. It is bounded to an **open** dispute on that specific trade, and it shows up in the owner's own access log — compliance access nobody can see afterwards would be the thing to object to.

**Every refusal is `NOT_FOUND`, never `FORBIDDEN`.** "This exists but is not yours" tells a stranger that a trade with that id exists and that its seller has an account on file, which is the first half of what they were trying to learn.

### Why it is its own procedure, not a field on `trades.get`

Three bugs stop being possible:

1. `trades.get` and `trades.list` cannot leak an instrument, because they never load one. A routine trade read is not a disclosure.
2. Every disclosure is an explicit call, so the log has one row per intent rather than one per screen refresh.
3. The authorisation for reading account details is written in one place, instead of being a clause inside a trade serialiser.

`instruments.list` returns **no field values at all** — not even a masked hint. A mask is still the data, it rides a path that is not access-logged, and it is one helpful refactor away from being the whole value. The owner tells two destinations apart by the label they chose. The `fingerprint` is not exposed either: it is a hash of the account details, and a hash handed to a caller is an oracle a guessed account number can be checked against.

### The snapshot: removal cannot break a live trade, and neither can an edit

`trade_payment_instruments` freezes the destination in the **same transaction** that creates the trade. Two things follow, and the second is the bigger one:

1. The owner may edit or remove their instrument at any time without blanking the screen a buyer is halfway through copying an account number out of. Removal is a state change (`status = 'removed'`), never a `DELETE`, because the snapshot, the access log and any future appeal all still point at that row — but the account number itself is nulled on removal, not kept (see [Retention](#retention)). The row that survives is a header, not the data.
2. **The destination cannot change mid-trade.** Show account A, wait for the buyer to start the transfer, switch to account B, then truthfully report that nothing arrived at B — that is a scam with a clean audit trail, and a live pointer instead of a snapshot is exactly what makes it work.

### The access log, and why it cannot be avoided

The reveal is **one SQL statement** in which the `SELECT` of the details is cross-joined to a data-modifying CTE that writes the log row. The details are only produced when the log row was produced. There is no ordering of a crash, no early return, and no future edit to the file that reads the details and forgets the log — they are the same statement. The status test lives inside that statement too, so a trade that terminated a millisecond ago discloses nothing.

The database holds up the other end: `instrument_access_log` has a `BEFORE UPDATE OR DELETE` trigger that raises. A log the service could tidy is a log whose value depends on the service not having been the thing that was compromised. A test issues raw `UPDATE` and `DELETE` behind the service's back and the database refuses both.

**Refusals are recorded too, and they are the more interesting half.** One reveal is a buyer paying. Eleven refusals against eleven different sellers in an hour is someone harvesting, and that looks like nothing at all in a table that only records successes. The owner can read their own log (`instruments.accessLog`) — a log only compliance can see is a log the person whose data it is cannot use, and they are the one who knows whether a look was expected.

A refusal's log write is the **one** write on this path that is best-effort, and the reason is the paragraph above it: raising on a failed write would turn "you may not see this" into an error a prober can tell apart from "no such trade" — the existence oracle everything else here denies them. It is swallowed, not hidden: the failure is recorded on the span as `intafaced.swallowed_failure`, so a log that quietly stopped recording refusals is something an operator can alert on rather than something found as an empty table during the incident. The asymmetry with a **disclosure** is deliberate — a disclosure cannot go unlogged at all, because it and its log row are one statement.

### Retention

There are **two** things to forget, and they expire on different clocks.

**The owner's own instrument — the moment they remove it.** `instruments.remove` nulls `details` in the same statement that sets `status = 'removed'`. Not on a sweep, not after a window: "remove my bank account" has to mean the account is gone. The row survives, because the snapshot, the access log and any future appeal all still point at it, and the `fingerprint` survives with it — but the account number does not. `payment_instruments_details_ck` states both halves as a constraint (`active` ⇒ details present, `removed` ⇒ details `NULL`), so this is not a rule that depends on `removeInstrument` remaining the only writer. Removal is also the reason to reveal _before_ removing: `instruments.reveal` is the owner's export, it works while the instrument is active, and afterwards there is nothing left to export.

**A closed trade's frozen snapshot — `P2P_INSTRUMENT_RETENTION_DAYS` (owner-published; blank refuses, never invents 90d).** This one has to outlive the removal, or a seller could blank the evidence of where a buyer was told to pay by deleting their instrument mid-dispute. The API already refuses to disclose a terminal trade's snapshot; the sweep is the other half of the same promise, because "you cannot read it" and "we no longer have it" are different statements and only the second survives a database being copied. The purge nulls `details` and keeps the `fingerprint`, so a late appeal can still be told whether the account a seller now names is the one the buyer was shown — without us holding the account in order to say so.

The **number** is an operator decision, not an engineering one, and where a market imposes its own retention rule that rule wins. When published, retention must be at least the dispute SLA so a purge can never race an open appeal.

### The residual risk, stated

A taker who genuinely takes an offer becomes a counterparty and is entitled to the seller's destination. Someone willing to open small trades can therefore collect account details from many sellers. That is inherent to P2P — a buyer who cannot see where to pay cannot pay — and it is not solved here. What exists against it is the access log (every look attributed, visible to the seller), the minimum-amount bound on every offer, and the reputation record. It is named here so nobody assumes it was overlooked.

**Sell offers only list methods with a live destination.** Create refuses methods the maker cannot be paid on; the board and `offers.get` project methods to live rails and drop a sell offer with none left. Buy offers are unchanged (seller is the taker). This closes the take-oracle residual named on the uniform take refusal.

**Not encrypted at rest.** `details` is `jsonb` in Postgres. Envelope encryption is the right next step and it needs a key-management decision that is owner-gated (Class X, `AGENTS.md`); doing it with a key improvised in this service would be the appearance of the protection without the substance. Until that exists, live `offers.create` named-refuses (`p2p.instrument_kms_required`). No env unblocks plaintext. No method registry is seeded. §13 socket: **payment-instrument encryption at rest**.

---

## Export and erasure (§0.9)

Before this, `blueprint.export` / `blueprint.erase` were the only ones in the platform and every statement in them is prefixed `blueprint.` — **no p2p table was covered by anything.** The de facto answers were `instruments.reveal` for export and `instruments.remove` for erase: one instrument at a time, only while active, covering none of the offers, trades, disputes or reputation this service holds about a person.

**Neither procedure takes a `userId`.** The caller is the subject, always. An export endpoint that accepts one is a data-breach endpoint with a friendly name.

`data.export` returns the raw rows — offers, trades, disputes **with their evidence** (including the ones filed _about_ the caller, which is the clearest Art. 15 case in the service), reputation, and instrument **headers**. Not instrument values: those come from `instruments.reveal`, which writes an access-log row in the same statement that reads them, and an export that also served them would be a second way to read an account number with nothing recording that anyone did. `notCovered` names that path, and svc-identity, svc-ledger and blueprint — an export that implies it is the whole platform is a lie told by omission.

`data.erase` is built on two rules.

**1 · It refuses outright while any trade is open or unsettled.** svc-ledger is holding that value. Deleting our copy of who it belongs to does not remove the money; it removes the only record that can explain it, which is the stranded-funds condition this whole service exists to prevent. "The user asked" does not make it safe. The refusal names the count, and nothing is half-done on the way to it — including the destination the buyer is mid-payment to.

**2 · It returns a manifest of what it KEPT, and why.** An erase that silently retains half the record is worse than one that refuses — the person believes something untrue and finds out in a dispute. Every reason is a sentence that would survive being read out loud; a test asserts none of them is the word "compliance".

| Category                                        | What happens                                                                                                            |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| reputation                                      | **erased** — counters keyed on the user id, referenced by no foreign key                                                |
| offers never traded against                     | **erased** — they never became part of anyone else's record                                                             |
| payment instrument details                      | **erased** — `status = 'removed'`, which `payment_instruments_details_ck` makes mean `details IS NULL`                  |
| payment details frozen onto the caller's trades | **erased** — the retention window is how long we keep these when nobody asked; somebody asked                           |
| offers that were traded against                 | kept — a settled trade references the offer, and the price and terms it was taken at                                    |
| settled trades                                  | kept — §5 audit trail, and they name a counterparty who did not ask to be erased                                        |
| disputes and their evidence                     | kept — append-only, filed **by and about** both parties                                                                 |
| the instrument rows themselves, minus details   | kept — the access log and the snapshots point at them, and the `fingerprint` answers a later appeal                     |
| the instrument access log                       | kept — append-only by trigger. Erasing it on request deletes the evidence of a leak at the request of whoever caused it |

A **counterparty's** snapshot is never touched: that is their account, on a trade they did not ask to be erased from.

**Stage 3, named rather than discovered later:** settled trades are retained, not pseudonymised. Replacing a user id with a surrogate everywhere it appears is a migration across every referencing row, and getting it half-right leaves a trade whose two sides disagree about who traded. It needs the owner's answer on how long a settled P2P trade must stay attributable.

**There is no cross-service orchestration.** svc-p2p subscribes to no events, so it could not hear an account-deletion signal if one existed. When one does, `data.erase` is what it calls.

---

## Events

**Publishes**

| Subject                          | When                                                                     |
| -------------------------------- | ------------------------------------------------------------------------ |
| `intafaced.p2p.offer.created`    | a maker publishes an offer                                               |
| `intafaced.p2p.escrow.locked`    | taker accepted; the seller's asset is in escrow                          |
| `intafaced.p2p.escrow.released`  | escrow went to the buyer, minus the fee. Terminal                        |
| `intafaced.p2p.escrow.refunded`  | escrow went back to the seller, in full. Terminal                        |
| `intafaced.p2p.trade.disputed`   | a trade entered dispute; funds hold until a moderator decides            |
| `intafaced.p2p.dispute.resolved` | a moderator ruled. `automatic` is always `false` — nothing else can rule |
| `intafaced.p2p.trade.expired`    | a deadline elapsed and the sweeper resolved the trade                    |
| `intafaced.identity.xp.earned`   | §6.2 → §4.1 — completion and dispute-loss into the one XP graph          |

Every publish carries a **business** idempotency key (`p2p.escrow.release:<tradeId>`, `p2p:trade.completed.seller:<tradeId>:<userId>`), never a random uuid. A redelivered envelope finds the original, which is what makes svc-identity's XP dedupe work.

**Consumes** — nothing yet. When svc-trade's mark-price surface lands it supplies the `ReferencePriceSource` that floating offers need; until then a floating offer is **refused** rather than priced from a stale number (§13 socket: cross-venue pricing).

Event subjects live in `packages/events` (catalog). Payloads are additive; business idempotency keys (not random uuids) are what make redelivery safe.

---

## Ledger

**All three escrow recipes already existed in `packages/ledger-client`.** This service adds none.

| Recipe          | Reason code          | Accounts                                             | Idempotency key                |
| --------------- | -------------------- | ---------------------------------------------------- | ------------------------------ |
| `escrowLock`    | `p2p.escrow.lock`    | seller available → seller escrow                     | `p2p.escrow.lock:<tradeId>`    |
| `escrowRelease` | `p2p.escrow.release` | seller escrow → buyer available + `houseFees('p2p')` | `p2p.escrow.release:<tradeId>` |
| `escrowRefund`  | `p2p.escrow.refund`  | seller escrow → seller available                     | `p2p.escrow.refund:<tradeId>`  |

The keys are business keys and are **not** overridden. They are load-bearing in three separate ways:

1. a retried release cannot pay twice;
2. a re-driven lock tells us whether the original posted;
3. the settlement sweep can re-post any decision without checking whether it already did.

**The fee comes out of the escrowed amount**, before the buyer is credited — never as a second post. A separate fee charge could fail after the release succeeded, leaving the house short of a fee it had already accounted for and the books needing a manual repair. `buyerReceives + fee == amountLocked`, exactly, and a test asserts it.

**No fee is taken on a refund.** The platform did not provide the service it charges for.

---

## Can funds ever be stranded?

No. Three things have to hold, and each is enforced somewhere the service cannot bypass.

**Every live state has a clock, and every clock does something.** `p2p_trades_live_has_deadline_ck` refuses to store a live trade without a deadline, so a trade invisible to the sweeper cannot be written. `timeoutActionFor()` is total over the status enum, so there is no live state the sweeper picks up and leaves unchanged. A test walks the graph breadth-first from every state and asserts a terminal state is reachable, and asserts the live subgraph is acyclic.

**Every terminal state has exactly one resolution, and it is immutable.** `p2p_trades_resolution_matches_status_ck` allows `released`+`released`, `cancelled`+`refunded|voided`, or live+NULL — nothing else. A test tries to write the double resolution with raw SQL, behind the service's back, and the database refuses it.

**Every recorded decision is eventually posted.** `resolved_at IS NOT NULL AND settled_at IS NULL` is a queryable work list, `settled_at` is only stamped after the post returns, and every recipe is idempotent on the trade id. A test simulates the crash — writes the resolution, leaves `settled_at` null, leaves the escrow held — and shows the sweep converging.

The remaining question is the one worth stating plainly: **funds can be late.** Between a recorded decision and its ledger post, the value is still in escrow and neither party can spend it. That window is bounded by the owner-published sweep interval (`P2P_SWEEP_INTERVAL_SECONDS`; blank refuses, never invents 30s) and is the deliberate trade for the alternative, which is posting first and discovering afterwards that we cannot say why.

_If it crashes exactly here, whose funds are stranded?_

| Crash point                                        | Whose funds                 | Why not                                                                                                                                               |
| -------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| after the inventory reserve, before `escrowLock`   | nobody's                    | nothing is locked; `created` expires on the owner-published escrow clock and voids, or refuses when that clock is blank (`p2p.escrow_deadline_unset`) |
| after `escrowLock`, before the row says `escrowed` | nobody's, but non-obviously | the sweep re-calls `escrowLock`, which is idempotent, so the lock becomes a fact rather than a guess — then refunds                                   |
| after the resolution is recorded, before the post  | nobody's, but they are late | `sweepSettlements()` re-posts; the recipe key stops it doubling; `last_settle_error` names why if a post keeps failing                                |
| after the post, before `settled_at`                | nobody's                    | the re-post is idempotent and the stamp is retried                                                                                                    |
| during a concurrent release/refund race            | nobody's                    | both take the trade's row lock; the loser sees a terminal status and posts nothing at all                                                             |

### Not built here (named so nobody invents them)

| Socket                                    | Status                                                                                                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat_thread_id` on `p2p_trades`          | Column exists for a future chat product. **No API field, no service method, no chat delivery.** A UI that shows "open trade chat" from this service alone is lying. |
| Method registry seed content              | Operator-supplied. Empty on purpose — not this repo's knowledge of bank rails.                                                                                      |
| Rank fee discounts / `p2pLimitMultiplier` | Identity owns rank; this service stamps `P2P_FEE_BPS` only (no per-take fee override). Multiplier apply is not invented here.                                       |
| `p2p:moderate` who                        | Class X — allowlist / scope mint is Nitro. Empty allowlist honest-refuses.                                                                                          |

---

## State × timeout matrix

Source of truth: `src/state.ts` (`timeoutActionFor`, `assertTransition`) + `src/state.test.ts` (full graph).

| Status      | Holds escrow?        | Timeout action                                       | Moves value?       | Who can terminal without clock                                                                   |
| ----------- | -------------------- | ---------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------ |
| `created`   | not yet / re-drive   | `settle_or_void` (re-lock, then refund or void)      | yes if lock posted | —                                                                                                |
| `escrowed`  | yes                  | `refund`                                             | yes                | seller cancel; buyer mark fiat sent                                                              |
| `fiat_sent` | yes                  | `open_dispute` (never auto-release)                  | no                 | seller confirm → release; either open dispute; cancel refused from `fiat_sent` and once disputed |
| `disputed`  | yes                  | `escalate_dispute` (re-arm SLA; **no** machine rule) | no                 | natural-person moderator only                                                                    |
| `released`  | no (posted)          | none                                                 | —                  | terminal                                                                                         |
| `cancelled` | no (refunded/voided) | none                                                 | —                  | terminal                                                                                         |

Value-moving timeout actions are only `settle_or_void` and `refund`. `fiat_sent` and `disputed` deliberately do **not** move value on a clock.

## Database constraints as a backstop

The service checks these. The database enforces them regardless.

| Constraint                                  | What it catches                                                     |
| ------------------------------------------- | ------------------------------------------------------------------- |
| `p2p_trades_resolution_matches_status_ck`   | **released to both parties** — the state cannot be written down     |
| `p2p_trades_live_has_deadline_ck`           | a live trade invisible to the sweeper, i.e. funds stranded          |
| `p2p_trades_terminal_has_no_deadline_ck`    | the sweeper picking up a trade it would resolve twice               |
| `p2p_trades_settled_implies_resolved_ck`    | value that moved with no recorded reason                            |
| `p2p_trades_escrow_timestamp_ck`            | a trade claiming to be past escrow with no lock behind it           |
| `p2p_trades_distinct_parties_ck`            | self-trading a flawless record, which raises limits platform-wide   |
| `p2p_trades_fee_bps_ck`                     | a fee above 100% crediting the buyer a negative amount              |
| `offers_bounds_ordered_ck`                  | inverted bounds, or an offer promising more per trade than it holds |
| `offers_remaining_in_range_ck`              | two takers reserving the same units                                 |
| `p2p_disputes_trade_idx` (unique)           | two moderators reaching two decisions about one escrow              |
| `p2p_disputes_resolved_is_attributed_ck`    | a ruling with no moderator, decision, or timestamp                  |
| `p2p_reputation_counters_conserved_ck`      | a completion rate above 1 turning into a raised limit               |
| `payment_instruments_active_slot_idx`       | two destinations for one slot — a coin-flip over whose bank is paid |
| `payment_instruments_removed_paired_ck`     | a row that is removed to one reader and active to another           |
| `payment_method_schemas_fields_ck`          | a schema with no fields, i.e. a destination with no address         |
| `trade_payment_instruments_purge_paired_ck` | a retention claim we could not defend either way                    |
| `instrument_access_log_append_only`         | **the record of who saw account details being tidied afterwards**   |

---

## Fiat

§6.2: _"100+ fiat currencies = config, not code."_ The registry is `packages/config/src/fiat.ts` and this service has **no currency table**. Adding a currency is a data change in that file; nothing here is touched.

Minor units come from the registry too, and the fiat leg is quantised to them at take time — a trade for ¥1234.56 is a trade for an amount no bank will move, and "which way did you round" is a dispute nobody can adjudicate. `fiat_amount` is written once and frozen, so a floating offer cannot re-price a trade already in escrow.

---

## Kill-switch

`P2P_TRADING_ENABLED=false` stops new offers and new takes.

It deliberately does **not** stop release, refund, dispute resolution, or either sweep. A switch that could freeze settlement would be a switch that strands every open escrow — the exact failure this service exists to make impossible. A test asserts settlement still works with the switch off.

---

## Out of scope / residual parks (do not invent)

**Merchants (built Stage 1–3; numeric policy still open).** The programme tables, apply/approve/suspend transitions, badge surface, offer-ceiling **mechanism**, honest limit API (`merchants.offerLimits` · `merchants.myOfferCeiling` · health `offerLimitsConfigured` / `offerLimitsPosture`), and programme-gated API access ship in this service. Identity remains the only named-key/scopes/revocation plane and the edge remains the only request-throttle plane; svc-p2p stores neither keys nor a second quota book. Every identity-issued P2P key request re-reads current standing, so only `approved` may proceed and suspension removes access immediately. Interactive sessions retain ordinary P2P access. API keys can never list, inspect as moderator, or resolve disputes: D-S-08 requires an interactive human session regardless of scopes. Default limit policy is **unset** (no numeric ceiling, same as pre-Stage-2) until an operator sets `P2P_OFFER_MAX_*` to a decimal or the literal `unlimited` — inventing magnitudes here is product law, not craft residual. Stage-3 erase/pseudonymise of settled trades is owner-gated.

**The method registry is empty and stays empty until an operator fills it.** That is not a gap in the mechanism — it is where the mechanism ends and researched, jurisdictional content begins. Nobody can register a payment destination in a market until `instruments.methods.register` has been called for it, and any attempt to save that as engineering work by seeding a guess would produce destinations that validate and cannot be paid.

**Not encrypted at rest** — live `offers.create` named-refuses (`p2p.instrument_kms_required`) until OWNER KMS. See the payment-instruments section above. Envelope encryption is Class X. No env unblocks plaintext.

**Also parked (not agent free craft):** `p2p:moderate` who / scope mint · auto-ruling (law forbids; escalate-and-hold) · rank fee discount / `p2pLimitMultiplier` apply (identity + product) · chat product (`chat_thread_id` column only) · floating mark-price wire (contracts first) · apps/admin dispute console (outside wall) · outbox (events plane). Engine side (queue, evidence, backlog, open-origin honesty, ruling notes on the wire, escalate-and-hold) is product code in this service — not refuse theater.

---

## Running it

```bash
docker compose up -d
pnpm --filter @intafaced/svc-p2p db:migrate
pnpm --filter @intafaced/svc-p2p test
```

## Tests

**Pure suite (no Postgres) + money suite (Postgres).** The state machine, pricing, reputation and instrument field validation are pure functions tested by enumeration without a database — every state, every edge, every timeout, plus graph properties (reachability of a terminal state from every state; acyclicity among live states) that are the machine-checkable form of "funds cannot be stranded". Re-count with `pnpm exec vitest run` in this package — do not pin a stale headcount in prose.

The two Postgres suites are serialised by `vitest.config.ts` (`fileParallelism: false`) and bring the schema up under a shared advisory lock. Both truncate the same connected set of tables — an instrument is attached to a trade, which belongs to an offer — and vitest runs test files in parallel by default, which deletes one suite's rows out from under the other mid-assertion. It does not fail cleanly: it surfaces as "trade not found" immediately after a successful take, in tests that have nothing to do with the change being made.

The money paths run against real Postgres with the ledger's in-memory reference implementation, which the conformance suite proves equivalent to svc-ledger's Postgres engine (§4.4). Almost every one of them ends by asserting `totalsByAsset()` is zero and `reconcile()` is clean — escrow is the one place value sits between two owners, and a book that does not close is a book where some of it went somewhere nobody asked for.

**Escrow failure branches covered:**

- double release attempted → rejected, value moves once (and eight concurrent releases → exactly one winner)
- release after refund, and refund after release → both rejected on the terminal guard
- a concurrent release/refund race → exactly one winner, total conserved
- the double resolution written with raw SQL behind the service → refused by the database
- release on an unescrowed trade → rejected; the trade was already voided by the failed take
- a never-locked trade refunded out of **another** trade's escrow → prevented, and tested directly
- a voided trade posting anything at all → zero `p2p` transactions on the book
- take above max, below min, above remaining liquidity → rejected before any lock, no trade row
- self-trade, unsupported payment method, closed offer, unavailable reference price → rejected before any lock
- concurrent takers on one offer → exactly one escrows; 12 racing takes never over-draw the inventory
- timeout from `escrowed` → refund; from `fiat_sent` → dispute, never auto-release; from `disputed` → **escalate, and move nothing** — five sweeps in a row leave the escrow exactly where it was
- the database refusing to terminate a disputed escrow without an attributed human ruling, including for a `system:` moderator id
- dispute evidence edited, reordered, truncated or removed by raw SQL → refused by the append-only trigger
- timeout from `created` where the lock **had** posted → re-driven and refunded
- timeout from `created` where the lock **never** posted → voided, nothing moved
- a resolution recorded but never settled → the sweep posts it, once
- moderator ruling twice → rejected
- two disputes on one trade → rejected
- a non-party cancelling, or a buyer cancelling after declaring payment → rejected
- kill-switch on → new takes blocked, settlement unaffected
- API key with P2P scope but no approved merchant standing → refused before P2P service work; approval enables it and suspension removes it on the next call
- API key belonging to an allowlisted moderator, or carrying `admin:compliance` → never treated as the human required to rule on a dispute
- a full mixed run across every branch → every trade terminal, every terminal trade settled, `escrowIntegrity()` and `reconcile()` clean, total value conserved to the unit

**Payment-instrument disclosure covered:**

The device throughout is a **canary** — the seller's account details contain a string that appears nowhere else in the system — so "it does not leak" is a mechanical question rather than a judgement. Every one of these is driven through the tRPC router with a real edge-signed principal, not by calling the service directly: authorisation only ever tested a layer below the door is authorisation nobody has checked the door for.

- a stranger calling **every procedure the router exposes**, against the real trade, offer and instrument ids → the canary appears in no response. The input map is exhaustive by construction: a procedure the router has and the map does not fails the test, so the next list endpoint someone adds has to be considered here before it ships
- the counterparty's ordinary reads — `trades.get`, `trades.list`, `offers.get`, `offers.list`, `instruments.list`, `reputation.get` → no canary; the buyer gets it from `trades.paymentInstrument` and nowhere else
- the owner's own list → no values, no mask, no fingerprint
- the public board and every published event → no canary
- a non-counterparty revealing → `NOT_FOUND`, not `FORBIDDEN`, and the attempt is logged
- before the lock (`created`) → refused; after `released` and after `cancelled` → refused for **both** parties
- a moderator with `admin:compliance` → refused with no dispute, allowed while the dispute is open, refused again once it is ruled on
- the seller removing the instrument mid-trade → the buyer still sees it (their trade's own frozen copy); new takes on that offer are refused; and the **live** row's `details` are already `NULL`
- removal → `details` nulled, `fingerprint` and header kept, canary unfindable in `payment_instruments`; the owner's `reveal` export works before removal and is `NOT_FOUND` after; raw SQL putting details back onto a removed row, or emptying an active one, → refused by the database
- the seller **editing** the instrument mid-trade → the buyer still sees the original. This is the account-swap scam, and the snapshot is what makes it fail
- a take where the seller has no destination for that currency → refused **before any lock**: no trade row, no snapshot, no reserved inventory, book at zero
- a maker who capitalised the method id (`"Bank_Transfer"`) against an instrument stored `bank_transfer` → the take **completes**. Case is not meaning: an offer's `methods` are the maker's own strings, an instrument's `method_id` is normalised, and comparing the two exactly made an offer nobody could take while telling the seller they had no destination. Tested in both directions, and a genuinely different method is still refused
- three reveals → exactly three access-log rows; the log cannot fall behind the reads
- refusals logged with their reason; the owner can read their own log and nobody else's
- raw `UPDATE` and `DELETE` on the access log, behind the service's back → refused by the database
- retention: nothing purged while live or before the window; past it, values gone, fingerprint kept, canary unfindable in the table
- the registry: empty → refuses; undeclared field → refused, not dropped; blank required field → missing; exact country beats the wildcard and does not fall back past it; a second active destination in one slot → `CONFLICT`, and rotation after removal works

## Service keys (S2S v3)

With `S2S_AUTH_MODE`, `S2S_SIGNING_KID` and `S2S_SIGNING_KEY` set, the calls to svc-ledger are signed with svc-p2p's own key, and the ledger names the caller from that key. `dual` also sends the shared secret; `keypair` sends the key signature only. Unset, the ledger calls are signed with the shared secret as before. The affiliate calls to identity still use the shared secret and move in their own PR. Setup and rotation: `services/svc-ledger/CALLER-BINDING.md`.

## Service keys: inbound doors

The internal GET doors (escrow integrity, moderation backlog, reputation) and the closure check name the caller from its own service key when `S2S_AUTH_MODE`, `S2S_KEYRING` and the signing pair are set: `dual` accepts the key and the shared secret, `keypair` the key only. Unset, the shared secret works exactly as before. A key-signed call that fails is refused and never retried against the shared secret. The closure check still answers only svc-identity. `/trpc` is unchanged: it names no service caller. Setup and rotation: `services/svc-ledger/CALLER-BINDING.md`.
