# Spec — Pro Exchange Microstructure and Professional Order Execution (`PX-S03`)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Status:** Authoritative product contract; implementation maturity remains mixed and named owner sockets remain refuse-closed

**Authority:** `PX-S03`; bounded child of [`PRO_TRADER_EXCHANGE_DEFINITIVE_SCOPE.md`](../PRO_TRADER_EXCHANGE_DEFINITIVE_SCOPE.md)

**Requirements:** `PTX-M03-R01–R08`, `PTX-M04-R01–R12`

**Hard predecessors:** [`PX-S01`](SPEC-PRO-EXCHANGE-RULEBOOK-LIFECYCLE-INTEGRITY-2026-08-23.md), [`PX-S02`](SPEC-PRO-EXCHANGE-AUTHORITY-AND-PARTICIPANT-SECURITY-2026-08-23.md)

**Primary systems of record:** `svc-trade` order/command records, the append-only matching input journal and engine sequence, and `ledger-client` postings; an execution is final on the Fiat Plane only when its ledger transaction posts

This contract defines how authorized intent becomes a deterministic order, match, execution, cancellation, correction, or explicit unresolved state. It applies to the Fiat Plane matching service and is the shared semantic target for any future INTACORE runtime. It does not authorize a live market, risk magnitude, internal house-desk access, or synthetic feature.

## 1. Product promise, professional jobs, and non-goals

A professional chooses this venue as a primary venue only if they can:

- express intent without silent semantic weakening;
- know exactly when an order entered the queue, changed priority, filled, cancelled, or became indeterminate;
- cancel risk during disconnects, partitions, and volatile markets;
- operate market-making and systematic flow with deterministic bulk controls, stable identifiers, and replay;
- trace every parent, child, fill, fee, hold, correction, and refusal across UI and API;
- prove that venue, affiliate, liquidation, and customer flow received the same published matching treatment.

The contract serves discretionary traders, systematic traders, market makers, execution algos, broker/DMA clients, care-order desks, risk operators, surveillance, and support. Terminal workflow, FIX and market-data transport, portfolio risk methodology, cross-venue route selection, options MMP, and care-order/TCA products consume this contract but are primarily owned by `PX-S04`, `PX-S05`, `PX-S06`, `PX-S08`, `PX-S14`, and `PX-S15`.

Non-goals:

- no endpoint, database, transport, or language choice is mandated;
- no second order book, money book, product shell, or synthetic liquidity source is created;
- no live leverage, collar, throttle, timeout, capacity, fee, or auction magnitude is invented;
- iceberg/hidden quantity remains out under the accepted algo law;
- cross-venue routing and care-order ownership are not re-specified here.

## 2. Research delta and durable patterns

The 24 August 2026 primary-source delta found no new mountain and no reason to split M03 from M04. It sharpened four implementation rules:

1. An order, cancel, or amend gateway acknowledgement may mean only “request accepted”; terminal truth must come from the sequenced order state. [OKX's current guide](https://www.okx.com/docs-v5/trick_en/) says this explicitly for cancel and amend.
2. Amend fields need explicit inheritance. A current [OKX API change](https://www.okx.com/docs-v5/log_en/) makes an access attribute amendable but non-inherited, illustrating why omission must never silently change execution eligibility.
3. Mass quote acknowledgements and execution reports may travel on different queues and arrive in either order. [Deribit FIX mass quote](https://docs.deribit.com/fix-api/production/mass-quote) requires correlation rather than arrival-order inference.
4. Professional recovery uses independent order-state/drop-copy evidence, not the command socket alone. [Coinbase Prime FIX](https://docs.cdp.coinbase.com/prime/concepts/trading/fix) documents persistent local state, reconnect replay, status lookup, and portfolio-wide drop copy.

The existing benchmark remains material: [Kraken L3](https://docs.kraken.com/api/docs/fix-api/mdsfr-fix) exposes queue-entry and event timestamps; [CME Globex kill switch](https://www.cmegroup.com/tools-information/webhelp/globex-credit-controls/Content/Kill-Switch.html) shows that scope, exclusions, blocking, and cancellation completion are separate facts; [MiCA Article 76](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32023R1114) requires capacity for peak message volume and controls for erroneous orders. These are evidence of durable professional jobs, not mechanisms to clone.

## 3. Existing INTAFACED authority and evidence to reuse

- `svc-trade` is the Fiat Plane market registry and durable order source of truth; symbols never substitute for canonical market IDs.
- `svc-matching` is a pure, deterministic price-time engine with input journal, per-book sequence, maker-price fills, IOC/FOK/post-only behavior, stop activation, account-level cancel-resting self-trade prevention, snapshots, replay, and engine/counterpart reconciliation.
- The existing order path records intent before hold, posts `orderHold`, submits only funded orders, settles fills through `tradeFill`, and releases unused hold through `orderHoldRelease`.
- [`2026-07-27-trade-order-store-source-of-truth.md`](adr/2026-07-27-trade-order-store-source-of-truth.md) makes the trade order store—not a matching event—the authority for money dimensions.
- [`2026-08-04-matching-dual-target.md`](adr/2026-08-04-matching-dual-target.md) makes Fiat fills pending until ledger posting and requires common semantics but separate runtime/finality per plane.
- [`2026-08-04-algo-execution-law.md`](adr/2026-08-04-algo-execution-law.md) makes an algo parent a valueless schedule whose children take the ordinary order path.
- [`2026-08-08-house-desk-and-market-making-fairness.md`](adr/2026-08-08-house-desk-and-market-making-fairness.md) forbids matching priority by tenant identity and keeps the house desk external-only for v1.
- Exact money, sub-account isolation, scoped authority, immutable rule/instrument versions, market states, corrections, and surveillance inheritance remain binding from doctrine, PX-S01, and PX-S02.

Current evidence is narrower than this contract. There is no native amend, auction family, dead-man control, atomic mass action, complete advanced-order family, or retained capacity proof. `cancelAllOrders` is a sequential convenience loop. Engine duplicate-ID protection covers only currently live orders; durable identity is enforced in `svc-trade`. The HTTP order path is a recoverable distributed workflow, not a database transaction spanning ledger and engine.

## 4. Boundaries, actors, and trust

| Boundary                                | Authority                                                 | May not be inferred                                                              |
| --------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Legal owner/account/sub-account/session | PX-S02 authority decision                                 | Same organization, aggregate visibility, client tag, or API authentication alone |
| Market and instrument version           | PX-S01 rule package and `svc-trade` registry              | Engine journal presence or display symbol                                        |
| Order/command lifecycle                 | Durable order and command records                         | HTTP status, timeout, local UI state, or receipt of one event                    |
| Queue and match                         | Matching engine sequence under the governing rule version | Gateway receive order, wall-clock timestamp, tenant identity, or network path    |
| Funds and final fill                    | `ledger-client` transaction                               | Engine fill, fill event, provisional position, or parent progress                |
| Risk permission                         | Product risk authority; PX-S06 for collateral products    | A matching acceptance or an available-balance display                            |
| External execution                      | Venue-specific child evidence under PX-S14                | Internal engine semantics or normalized status alone                             |

Actors include participant, legal owner, account/sub-account, human trader, broker/DMA client, API session, strategy parent, child order, matching runtime, trade/order service, risk authority, ledger, market operations, surveillance, and incident command. Platform and affiliate accounts are ordinary participants inside matching and are separately identified for surveillance and conflict controls.

## 5. Canonical objects, identifiers, precision, and clocks

### 5.1 Instruction and command

An immutable `OrderInstructionVersion` contains:

- `orderId`, durable `clientOrderId`, `instructionVersion`, `commandId`, and idempotency scope;
- legal owner, account/sub-account, actor, session/key, grant, broker/client tag, origin channel, environment, and plane;
- rule and instrument version, canonical market ID, side, type, total quantity, price/trigger/protection/display/minimum quantity, TIF/expiry, reduce/close intent, self-trade group/mode, and execution provenance;
- parent/strategy/basket/leg/hedge IDs where applicable;
- receive, authority, risk, hold, engine, match, ledger, event, and correction timestamps with clock source and precision;
- policy decisions and refusal codes, never secret material.

`orderId` is venue-assigned and immutable. `clientOrderId` uniqueness covers the declared legal-owner/account/environment domain and a published retention horizon; reuse inside that domain is refused. An expired retention horizon never makes a prior financial record disappear. Each amend, cancel, or operator command has its own idempotency key and targets an expected instruction version so stale commands cannot overwrite newer intent.

### 5.2 Exact values

Prices, quantities, notionals, fees, holds, thresholds, ratios, and rates cross boundaries as canonical decimal strings and use scaled bigint or another exact non-floating representation internally. Tick/lot/multiplier, rounding direction, and precision come from the immutable instrument version. Timestamp integers are not money; their unit and clock domain are explicit. Sequence numbers are monotonically increasing integers within a declared domain and never reused after recovery.

### 5.3 Provenance

Every order is one of:

- `NATIVE`: persisted and executed by the named venue/runtime;
- `VENUE_NATIVE`: parented locally but executed as a native order at an external venue;
- `PLATFORM_SYNTHETIC`: watched and emitted by an INTAFACED service;
- `CLIENT_SYNTHETIC`: behavior remains owned by the client and is never advertised as venue protection.

The provenance, persistence owner, trigger/data source, failure domain, child policy, cancel propagation, and reconnect behavior are visible before commitment and retained afterward. Unsupported provenance refuses; a client-side emulation is not relabeled native.

## 6. State and linearization contract

### 6.1 Command state

```text
RECEIVED → AUTHORIZED → RISK_APPROVED → INTENT_DURABLE → HOLD_CONFIRMED
        → ENGINE_SUBMITTING → ENGINE_ACCEPTED/ENGINE_REJECTED
                           ↘ SUBMIT_UNKNOWN → RECONCILING

AMEND/CANCEL_RECEIVED → COMMAND_ACCEPTED → APPLIED/REFUSED
                                        ↘ OUTCOME_UNKNOWN → RECONCILING
```

A synchronous response states which state it proves. “Command accepted” is never “order amended/cancelled.” A timeout after `ENGINE_SUBMITTING` is `SUBMIT_UNKNOWN`, not rejected. The hold remains encumbered and new risk-increasing retries are fenced until lookup/replay resolves the original command.

### 6.2 Order state

```text
DRAFT → PENDING_AUTHORITY → PENDING_RISK → PENDING_HOLD → SUBMITTING
      → OPEN/PARTIALLY_FILLED → FILLED_PENDING_SETTLEMENT → FILLED_FINAL
      ↘ REJECTED

OPEN/PARTIALLY_FILLED → AMEND_PENDING → OPEN/PARTIALLY_FILLED
OPEN/PARTIALLY_FILLED → CANCEL_PENDING → CANCELLED
OPEN/PARTIALLY_FILLED → EXPIRED
any non-final state → SUSPENDED/RECOVERY_REQUIRED
any match state → CORRECTION_PENDING → CORRECTED/BUSTED/REINSTATED
```

States are monotonic except through an explicit correction link. `FILLED_FINAL` on the Fiat Plane requires the referenced balanced ledger transaction. Engine matching creates `FILLED_PENDING_SETTLEMENT`. On-chain finality is separate and plane-labelled. No UI, API, report, PnL, or strategy progress may collapse pending and final.

### 6.3 Linearization points

- **Order acceptance:** the funded instruction and matching journal input are durable, and the engine assigns its acceptance sequence under the bound rule/instrument version.
- **Queue entry:** the engine assigns the resting sequence after all matchable quantity ahead of it is determined.
- **Cancel/amend completion:** the matching sequence records the applied transition; gateway receipt is not completion.
- **Match:** the engine assigns one immutable match sequence and identifies maker/taker and price.
- **Fiat fill finality:** the `tradeFill` ledger transaction posts atomically.
- **Release finality:** `orderHoldRelease` posts and the order can no longer create exposure.

## 7. Core invariants

1. Only an authorized, eligible, risk-approved, fully funded instruction reaches matching.
2. The matching engine sees account/STP identity but never owns balances, fees, users, or legal policy.
3. One market has one active sequence authority per runtime; split brain refuses order entry.
4. Price priority precedes time priority. Within a price level, earlier queue sequence wins.
5. The maker is the resting order and its price is the fill price unless a published auction rule applies.
6. Rejected intent consumes no book sequence and changes no book, hold, or exposure after compensation completes.
7. A match cannot create a final balance or position until the one ledger posts it.
8. Original records are immutable. Busts, corrections, refunds, and repairs add linked events/postings.
9. Platform, affiliate, liquidation, broker, API, UI, and algo flow share the same matching priority; no identity branch may improve priority or private visibility.
10. Every working child belongs to a visible owner and parent or is explicitly flagged orphaned/unattended.
11. Cancellation remains available when new order entry is halted, subject only to stronger security or ownership refusal.
12. Unsupported order intent refuses by field; it is never mapped to a weaker behavior without an explicit preview and new consent.

## 8. Continuous-book microstructure

### 8.1 Priority and allocation

The rule package pins price-time priority, maker-price execution, rounding, crossed-book handling, partial-fill allocation, and sequence domains. Partial fills retain queue position for the remaining quantity. Stop/conditional orders gain queue priority only when activated. A market order never rests. FOK viability is calculated without mutation and excludes liquidity that self-trade prevention would remove.

Self-trade prevention is evaluated using a rule-defined common-beneficial-owner/STP group resolved before matching, not merely a leaf account. The current v1 behavior is `CANCEL_RESTING_CONTINUE`; the cancelled resting quantity receives a reason and hold release. Any future cancel-aggressor, cancel-both, or decrement mode requires a new rule version, API field, surveillance review, and conformance tests. Missing or stale STP identity refuses affected new intent.

### 8.2 Native amend

Native amend is one engine command against an expected order version:

- reducing remaining quantity at the same price retains the original queue sequence;
- increasing quantity, changing price, or changing any execution-affecting attribute loses priority and receives a new queue sequence if accepted;
- order ID, legal owner, account, market, side, already-filled quantity, and original provenance are immutable;
- omitted fields inherit exactly unless the versioned schema explicitly marks a field reset-on-amend; the preview and result identify every changed/reset field;
- an amend racing fill operates on remaining quantity and reports both outcomes causally;
- a refused amend leaves the original order unchanged unless `cancelOnAmendFailure=true` was explicit, authorized, and separately reported;
- cancel-plus-new is named `CANCEL_REPLACE`, exposes both legs, and is never advertised as atomic amend or queue-preserving.

### 8.3 Core and conditional order semantics

The contract supports, when enabled by instrument/rule version:

| Family                                | Required semantic truth                                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Limit/market                          | price protection, tick/lot, remainder, and market-empty behavior                                                    |
| GTC/IOC/FOK/PO/GTD                    | expiry clock, full-fill test, maker guarantee, and restart behavior                                                 |
| Reduce-only/close-position            | product position authority, no exposure increase, concurrent-fill handling                                          |
| Stop/stop-limit/take-profit           | trigger source/version, direction, staleness, gap behavior, activation sequence, persistence owner                  |
| Bracket/OCO                           | parent quantity cap, sibling cancel timing, partial-fill resizing, disconnect/recovery                              |
| Trailing                              | reference source, watermark, offset representation, sampling, stale state, correction behavior                      |
| Pegged/relative/midpoint              | reference source, reprice sequence/priority, collar, inaccessible reference behavior                                |
| Minimum quantity/AON/display quantity | matching/allocation effect and information disclosure; hidden quantity remains disabled until separately authorized |
| Auction/benchmark                     | eligible session, price source, cutoff, allocation, residual handling, correction                                   |

Absent product risk or trigger authority refuses the affected order family. Conditional triggers cannot use a stale, one-sided, invented, or platform-conflicted price. Reduce-only and close semantics are delegated to the authoritative position/risk product and cannot be inferred by the engine.

## 9. Auctions, collars, throttles, and severe markets

PX-S01 owns market states and emergency authority. This contract owns deterministic order treatment inside them.

Launch, reopen, volatility, and closing/fixing auctions use a versioned `AuctionPolicy` defining eligible orders, entry/cancel/amend cutoffs, indicative price/imbalance publication, reference price, collars, uncross algorithm, allocation, tie-breaks, residual transition, and correction. The uncross algorithm must deterministically maximize executable quantity, apply the published imbalance/reference criteria, and use a final explicit tie-break. A missing criterion prevents the auction from opening; operator discretion cannot choose among otherwise equal prices after seeing interest.

Price collars, fat-finger checks, message throttles, order-to-trade controls, circuit breakers, and severe-market modes bind policy version and reason. They state whether they reject, queue, slow, cancel, or change market state. Throttling cannot reorder already accepted commands within a participant/session sequence or grant a hidden tier. Risk-reducing orders may receive a published admission class, never hidden price/time priority.

## 10. Holds, fills, fees, reversals, and reconciliation

### 10.1 Hold contract

The product/risk adapter computes an exact `requiredHold` from immutable instruction and policy versions. For spot sells it includes base quantity; for spot buys it includes the worst executable quote obligation at the order's protection price plus any fee reserve required by the fee policy. Derivative, multi-leg, portfolio, credit, and external-venue holds are owned by PX-S06/PX-S14 and must return one exact bound. A missing protection price, fee rule, collateral decision, or risk result refuses before hold.

Money lifecycle:

```text
available --orderHold--> hold
hold --tradeFill--> counterparty available + fee accounts (+ exact residual handling)
hold --orderHoldRelease--> available
original posting --linked correction recipe--> corrected economic state
```

Parents, strategies, auctions, queues, and matching services hold no money. Each executable child uses the ordinary order hold/fill/release path. Holds are purpose-keyed by order and cannot fund a sibling order.

### 10.2 Distributed consistency

The workflow is a durable saga with compensations, not a cross-service ACID claim:

- intent row precedes hold so orphan money remains discoverable;
- hold precedes engine submission so no free book risk is admitted;
- transport uncertainty preserves the hold and enters reconciliation;
- fill rows may precede the idempotent ledger post only if this can never over-release; final display waits for the post;
- cancellation cannot release funds merely because a live-order lookup returned absent while an unsettled fill may exist;
- every release proves the engine can no longer fill that quantity and all earlier match sequences are settled or explicitly correction-pending.

The current `cancelOrder`/event race and separate file journal/order database are therefore audit boundaries, not proof of atomicity. The implementation must fence by engine sequence and reconcile match, fill row, ledger transaction, remaining hold, and final order state before release.

### 10.3 Breaks and correction

Reconciliation covers at least engine-live/order-missing, order-open/engine-missing, funded/unfunded mismatch, quantity/market/version disagreement, terminal-order/engine-live, match-without-ledger, ledger-without-match, duplicate sequence, stranded residual, and partial correction. Auto-repair is allowed only when it provably moves no value or repeats an idempotent posting. Every value ambiguity refuses and raises an owned break.

If an engine match cannot post atomically to the ledger, it remains non-final, affected exposure is frozen, and a governed bust/correction path under PX-S01 restores book/order/ledger truth. The venue does not pay from another account, invent a receivable, or silently honor the engine as a second book.

## 11. Bulk, mass quote, dead-man, and kill controls

Every control has `commandId`, actor/grant/session, scope, expected policy version, deadline, target snapshot or selector, mode, and per-target result.

- Bulk place/amend/cancel is non-atomic by default and returns `APPLIED`, `REFUSED`, or `OUTCOME_UNKNOWN` per item. An advertised atomic group proves all-or-none at every affected book/hold boundary.
- Cancel-all scopes may include order, parent, strategy, session, credential, sub-account, account, broker client, market, instrument group, side, and venue. Broad scope requires proportional approval and preview.
- Dead-man/cancel-on-disconnect is a renewable lease with server receipt time, expiry, scope, excluded order classes, activation event, completion report, and recovery policy. Client clock alone never determines expiry.
- Kill switch first blocks new risk for its scope, fences later commands, then cancels/reduces according to policy. Blocking and cascading cancellation are separately observable.
- Mass quote requires quote-set/version IDs, per-entry results, MMP group, expiry, asynchronous correlation, and cancel-on-disconnect. Acknowledgement order never establishes execution order.
- MMP thresholds and reset authority are PX-S08/PX-S10 owner sockets; missing values disable mass quoting rather than defaulting.

Partial success is durable. Retry targets unresolved items only and never recomputes a moving selector without showing the new target set.

## 12. Parent, child, algo, basket, and multi-leg execution

### 12.1 Causal tree

Every parent defines total intent, account per leg, authority, risk envelope, execution policy, child cap, deadline, failure policy, and aggregate idempotency. Children record parent version, slice/leg, native/synthetic provenance, order IDs, venue, decision inputs, and terminal result. The tree never derives fills from schedule progress.

Cancelling/pausing/abandoning a parent has an explicit child disposition: leave, cancel, drain, or flatten within granted authority. Unknown child state prevents a “complete” parent. Orphaned children and failed hedges are first-class exception states.

### 12.2 Native algos

TWAP, tape-backed VWAP, and POV preserve the accepted algo law:

- parent is a valueless schedule;
- each child passes ordinary authority, market, risk, hold, matching, fee, and ledger paths;
- missing real liquidity/volume/mark produces a visible miss or halt, never fabricated progress or fallback;
- pause/resume does not replay elapsed slices; cancel emits no new children;
- every filled quantity and average price is derived from final child fills;
- price, participation, duration, schedule, slippage, message, loss, and capital limits are explicit owner/user inputs within policy.

Future benchmark, basket, rebalance, scale, accumulate/distribute, and implementation-shortfall parents use the same law. Custom strategy deployment remains PX-S15.

### 12.3 Multi-leg and hedge repair

An `ExecutionGroup` states whether it is engine-atomic, venue-atomic, or legged. It defines ratios, account per leg, worst-case exposure, order sequence, hedge instrument, residual tolerance socket, abandon/cancel behavior, and repair choices. “All-or-none” applies only at a boundary that can enforce it. Otherwise preview discloses legging risk and each leg has an independent terminal state.

A hedge failure never disappears into parent PnL. It records working exposure, attempted repairs, prices/fees, authority, and the choice to retry, cross, leave, or unwind. Automatic repair must stay inside the pre-approved worst-case envelope; otherwise it pauses for approval while risk remains visible.

## 13. User, API, event, terminal, and reporting contract

Order preview returns resolved owner/account/market/rule/instrument, normalized intent, provenance, required hold/margin source, fee basis, price protection, estimated impact confidence, queue/priority consequence, child/legging policy, expiry, and all refusal reasons. Estimates are labelled and never become final money.

Order/execution reports distinguish received, accepted, rejected, resting, amend pending/applied/refused, cancel pending/applied/refused, partial fill, match pending settlement, final fill, expiry, trigger, operator/liquidation action, recovery, bust, and correction. Each carries stable IDs, causal predecessor, sequence, version, timestamps, reason, and freshness.

Events are append-only, versioned, idempotent, and ordered in declared domains. At minimum they represent command receipt/outcome, order acceptance/state, queue-affecting amend, cancellation, match, settlement finality, hold release, trigger, parent/child, break, and correction. Unknown breaking schemas refuse writes. Consumer lag and gaps are visible; replay cannot duplicate holds, fills, fees, releases, or child intent.

PX-S04 chooses REST/WebSocket/FIX/drop-copy/binary transports and recovery protocol. PX-S05 renders the causal tree, queue truth, hotkey blast radius, connection/feed health, and deterministic reconnect. Neither may infer finality or state from transport acknowledgements.

## 14. Security, abuse, integrity, compliance, and privacy

Controls and tests cover spoofing/layering, wash/self trade, quote stuffing, momentum ignition, marking, order flooding, cancel abuse, stale-quote exploitation, stop hunting/oracle manipulation, auction gaming, client-ID collision, replay, credential theft, broker tag forgery, cross-account evasion, mass-control abuse, compromised operator, and affiliate/house advantage.

Every decision retains owner/beneficial-owner group, account, actor/session/key, broker/client and parent/strategy attribution required by PX-S01/PX-S02. Surveillance receives the complete order-event lifecycle including rejected, cancelled, amended, synthetic, liquidation, platform/affiliate, RFQ-derived, and corrected flow. Privacy and entitlement prevent another participant from learning private order identity or strategy while preserving regulator-grade reconstruction.

Jurisdiction/product eligibility binds at acceptance and again where a later trigger creates new executable intent. A compliance restriction cannot secretly change price/time priority; it either refuses, cancels, reduces, or changes published market state under explicit authority.

## 15. Degraded state, recovery, and operator truth

| Failure                              | Required behavior                                                                                    |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Authority/rule/instrument/risk stale | Refuse new or risk-increasing intent; scoped cancel/reduce may use a pre-authorized path             |
| Ledger unavailable                   | No new funded acceptance; preserve existing holds; finality remains pending                          |
| Matching timeout                     | `SUBMIT_UNKNOWN`; retain hold, fence duplicate, reconcile by durable ID/sequence                     |
| Journal unavailable/corrupt          | Stop order entry; never start an empty book as authoritative                                         |
| Event bus unavailable                | Matching outcome remains durable; outbox/replay heals without republishing recovery as new execution |
| Split writer/sequence regression     | Fence the market/runtime, halt new entry, preserve evidence, reconcile before reopen                 |
| Trigger/reference stale              | Suspend affected synthetic/conditional orders per published policy; never fire on stale data         |
| Cancel storm/partial mass control    | Block new risk first, expose progress and unresolved targets, retry idempotently                     |
| Ledger-engine disagreement           | Ledger wins for final financial truth; freeze, investigate, correct, and notify                      |
| Client reconnect                     | Recover server state and unresolved commands before enabling duplicate intent                        |

Operators receive scoped commands, dual control where policy requires, progress, errors, unresolved exposure, and post-action reconciliation. They cannot edit queue, fill, order, or ledger history.

## 16. Observability, SLO categories, and proof

Raw measurements exist even while targets remain owner-set:

- gateway receive-to-auth/risk/hold/journal/ack and engine accept-to-book/match/event/ledger/final-report latency, including tails;
- accept/reject/amend/cancel effectiveness, unknown-outcome age, duplicate suppression, sequence gaps, replay lag, and reconciliation breaks;
- book depth/levels, hot-symbol skew, queue age, cancel-to-fill races, trigger lag, auction imbalance/uncross, throttle and collar activations;
- message/order/fill rates by session/account/market/order family, order-to-trade ratios, mass quote load, and control completion;
- hold age/residuals, match-to-ledger pending age, correction/bust counts, and exact zero-drift evidence;
- customer-visible market/order/session status, last-good sequence, clock offset, degraded dependencies, and incident reference.

Capacity proof covers steady peak and burst order messages, hot symbols, deep L3 books, mass quote, cancel storms, liquidation bursts, conditional cascades, auction uncross, ledger/event backpressure, writer failover, restart/replay, and region loss. Tests report achieved capacity and failure shape against owner-set headroom/SLO sockets; no number in doctrine or dev hardware is silently promoted to a production promise.

## 17. Compatibility, rollout, rollback, and decommission

- Schema and semantic changes are additive/versioned; clients receive diff, migration, deprecation, and replay fixtures under PX-S04.
- Native amend, auctions, conditionals, and mass controls launch disabled per market until conformance, replay, money, surveillance, load, terminal, and rollback evidence passes.
- Existing resting orders retain their accepted rule/instrument/order semantics across deployment or are explicitly cancelled/migrated under PX-S01.
- A matching-runtime migration compares shadow replay byte-for-byte, fences both writers, snapshots a declared sequence, reconciles orders/holds/fills, and proves rollback before cutover.
- Rollback cannot reinterpret journal records or reuse sequences. Unsupported new order versions remain readable/cancellable during the compatibility window.
- Decommission stops new risk, drains/cancels children, settles/corrects matches, releases holds, archives replay/audit evidence, and proves no live order, liability, or orphan remains.

## 18. Definition of Done

PX-S03 is implementation-proven only when:

1. All 20 linked PTX requirements map to the sections and proof matrix below with no silently weakened intent.
2. A shared conformance suite pins priority, maker price, rounding, STP, every enabled order/TIF, amend priority, auction allocation, sequence, and deterministic replay for each runtime.
3. Every order path proves authority → market/risk → durable intent → hold → journal → match → ledger/release ordering under concurrency and crash injection.
4. Submit/cancel/amend timeouts, retries, races, duplicates, reorder, partial success, and reconnect resolve through terminal-state lookup without duplicate intent or over-release.
5. Engine/order/hold/fill/fee/position/ledger reconciliation reaches exact zero drift; every non-zero case is refused, owned, aged, and correctable without history mutation.
6. Dead-man, cancel-all, mass cancel, mass quote/MMP, kill, halt, and severe-market controls pass scoped partial-failure and recovery tests.
7. Parent/child, conditional, synthetic/native, multi-leg, hedge-repair, and algo lifecycle tests prove authority, caps, provenance, orphan detection, and final-fill-derived progress.
8. Load/fault evidence covers the scenarios in §16 with retained artifacts and honest owner-set target comparison.
9. Surveillance reconstructs every accepted/rejected/amended/cancelled/matched/corrected action with common IDs and detects identity-based priority or private-intent leakage.
10. UI/API/drop-copy/reporting fixtures distinguish command acknowledgement, order state, match, settlement finality, stale/degraded state, and correction.
11. Rollout, compatibility, rollback, runtime migration, and decommission drills leave no live orphan, reused sequence, or stranded hold.
12. All unset policy, magnitude, legal, or external dependencies are typed sockets whose blank behavior refuses only the affected capability.

### 18.1 Requirement proof map

| Requirement       | Contract/proof owner in this spec                                      |
| ----------------- | ---------------------------------------------------------------------- |
| `PTX-M03-R01`     | §§5–8; shared microstructure conformance suite                         |
| `PTX-M03-R02`     | §§6, 7, 10, 15; distributed acceptance/finality fault suite            |
| `PTX-M03-R03`     | §8.2; native-amend priority/race conformance                           |
| `PTX-M03-R04`     | §11; scoped control, lease, fencing, and partial-result proof          |
| `PTX-M03-R05`     | §9; auction determinism and recovery proof                             |
| `PTX-M03-R06`     | §§9, 14; erroneous-flow/severe-market tests                            |
| `PTX-M03-R07`     | §§5, 6, 13; causal reconstruction and clock/sequence evidence          |
| `PTX-M03-R08`     | §§16, 18; retained peak/fault/recovery evidence                        |
| `PTX-M04-R01–R03` | §§5, 8, 11; semantic and bulk conformance                              |
| `PTX-M04-R04`     | §12.2; parent/child algo and refusal proof                             |
| `PTX-M04-R05`     | §12.3; atomicity/legging proof                                         |
| `PTX-M04-R06–R07` | §§6, 10, 13; preview and lifecycle/finality fixtures                   |
| `PTX-M04-R08`     | §§5.3, 12; execution envelope consumed by PX-S14                       |
| `PTX-M04-R09`     | §8.3; advanced-attribute enablement/refusal conformance                |
| `PTX-M04-R10`     | §§5.3, 12, 13; provenance and causal-tree proof                        |
| `PTX-M04-R11–R12` | §12; aggregate cap, worst-case risk, partial failure, and hedge repair |

## 19. Owner and external sockets

- Production latency, throughput, headroom, queue, timeout, throttle, collar, breaker, and recovery targets.
- Per-market enabled order families, auction policy/tie-break, trigger sources, severe-market treatment, and cancel/reduce priority class.
- Beneficial-owner/STP grouping policy and any modes beyond current cancel-resting behavior.
- Fee/reserve, market-buy protection, minimum quantity, slippage, residual, and multi-leg/hedge-repair magnitudes.
- Dead-man lease ranges/defaults, cancel/kill scopes and exclusions, mass-quote/MMP eligibility, thresholds, reset, and approval.
- Native versus platform-synthetic product choices beyond the accepted TWAP/VWAP/POV law; iceberg remains unavailable.
- Product risk, collateral, liquidation, options, RFQ, external venue, and on-chain finality adapters owned by later specs.
- Replicated matching journal, single-writer/failover mechanism, and production time-synchronization source; mechanisms require ADRs without changing this semantic contract.

Every blank required socket yields a typed refusal and visible remediation category. No example value is a default.

## 20. Cross-spec dependencies and contradiction register

- **PX-S01:** owns market/rule state, emergency authority, corrections, surveillance cases, and disputes. PX-S03 cannot open an auction or alter a fill outside that authority.
- **PX-S02:** owns legal/account/session/grant authority. PX-S03 consumes resolved authority and preserves attribution; it never expands it.
- **PX-S04:** owns transport, data feeds, L3/drop copy, client sequencing, and certification. It must expose—not redefine—PX-S03 state/sequence/finality.
- **PX-S05:** owns terminal/OMS/TCA workflow. It consumes causal trees and cannot infer server truth from local state.
- **PX-S06:** owns collateral/risk/liquidation/default formulas and risk-reducing authority. PX-S03 supplies the deterministic admission and execution boundary.
- **PX-S08/PX-S09:** own options MMP and RFQ/block allocation semantics beyond the shared order/group envelope.
- **PX-S12:** owns venue-wide custody/reconciliation/wind-down; it consumes order/hold/fill breaks and one-ledger finality.
- **PX-S14:** owns venue selection, external child normalization, counterparty/capital truth, and best-execution evidence. PX-S03 owns only intent preservation and child causality.
- **PX-S15/PX-S16:** own governed strategy/agent lifecycle. Their children remain ordinary PX-S03 orders.

Known repository contradictions/gaps are explicit implementation inputs:

1. Doctrine's prose can read as if hold → engine → fill settlement were atomic; current services are separate authorities. This contract replaces that implication with the durable saga and linearization points in §§6 and 10.
2. Matching journal durability is single-process file based; multi-replica single-writer/failover is not proven.
3. Current self-trade prevention compares leaf account IDs; the north-star requirement aggregates common beneficial ownership under PX-S02/PX-S01.
4. Current engine has no native amend or auction family and current cancel-all is sequential, so those requirements remain unimplemented despite core order maturity.
5. Matching duplicate-ID memory is narrower than durable order idempotency; every caller, including seed/MM paths, must use the durable uniqueness law.
6. A cancel lookup can race an unsettled fill. No implementation may release merely from engine absence without fencing and settling all prior sequences.
7. Current engine emits after mutating the book and recovery emits nothing; production proof needs a durable outcome/outbox or equivalent replay contract without duplicating financial effects.
8. At assurance baseline `1a17a85ab03cf549243d0b62565eeec4ecd84b11`, `services/svc-execution/README.md` was stale at the 17 August Stage-1 house-tenant slice and falsely said the service was not an SOR, OMS, or EMS. Later merged code, tracker history, and the current service test corpus prove a bounded core: `execution.oms` plan/execute/cancel/fetch, open-order/account/position/market observations, venue-adapter wiring, execution reports, and a durable EMS acknowledgement journal. The assurance run after building workspace dependencies passed 345 tests and exposed one stale source-shape pin after capture wrapping replaced a direct object assignment; the later service-scoped correction updated that pin and passed all 346 tests. Neither an exact suite count nor a source-text assertion is product proof. This is real `BUILT`/`PARTIAL` OMS/SOR/EMS infrastructure, not the complete professional execution product: durable whole-order lifecycle, care/staged orders, desk ownership and handoff, allocations, independent drop copy, full best-execution reconstruction, and TCA remain with PX-S04/PX-S05/PX-S14. Repository history records the baseline artifact's correction; it cannot override stronger evidence.
9. Doctrine mentions internal MM seeding while the accepted house-desk ruling blocks internal house execution and excludes its quotes from payout-grade marks. The accepted ruling wins; this spec grants no exception.

These gaps do not block the specification. They prevent maturity from being promoted to `PROVEN` until the Definition of Done passes.
