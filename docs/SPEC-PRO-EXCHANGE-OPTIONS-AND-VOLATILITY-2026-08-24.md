# INTAFACED Options and Volatility Trading Specification

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Status:** Authoritative product contract; implementation incomplete and live product refuse-closed

**Authority:** `PX-S08`; bounded child of [`PRO_TRADER_EXCHANGE_DEFINITIVE_SCOPE.md`](../PRO_TRADER_EXCHANGE_DEFINITIVE_SCOPE.md)

**Primary requirements:** `PTX-M11-R01–R10`

**Predecessors:** `PX-S01` rule/instrument lifecycle, `PX-S02` account authority, `PX-S03` matching/orders, `PX-S04` connectivity/data, `PX-S05` terminal/OMS/TCA, `PX-S06` collateral/risk/liquidation/default, `PX-S07` linear products, `PX-S11` reporting, `PX-S12` custody/settlement/wind-down, `PX-S13` resilience

**Systems of record:** PX-S01 instrument/rule packages, PX-S03 order/execution SoRs, PX-S06 position/risk SoRs, and PX-S12 ledger/custody/settlement SoRs remain authoritative; `packages/ledger-client` plus `svc-ledger` remain the only money book; this contract owns options-series economics, volatility analytics, options portfolio construction, product-specific combo/RFQ/market-maker controls, exercise/assignment/expiry inputs, and options hedge semantics

---

## 1. Product promise, professional jobs, and boundary

Volatility traders, market makers, portfolio managers, hedgers, execution/RFQ desks, risk officers, settlement operations, finance, surveillance, brokers and API clients can discover a complete chain, price and stress portfolios, quote safely, execute linked strategies, manage Greeks, and reproduce every premium, exercise, assignment, fixing and settlement outcome.

This determines primary-venue adoption because an options desk cannot center risk where it must export the chain, Greeks, portfolio margin, combos, RFQ or expiry operations to another venue. A European call/put row and a generic order book are not a professional volatility venue.

Catastrophic or dishonest outcomes include an incorrect contract multiplier or settlement asset; a stale model presented as a live mark; uncapped short optionality called “fully collateralized”; a combo that leaves an unbounded orphan leg; MMP that races a quote storm; a risk engine granting offsets across prohibited accounts or assets; an expiry job executing twice; a corrected fixing rewriting money; or an automated delta hedge trading after revocation.

M11 remains one contract. Chain data, IV/Greeks, strategy construction, combo/RFQ execution, quote protection, scenario margin, lifecycle settlement, hedging and risk export are causally coupled. Splitting them would permit a polished analytics surface that cannot execute or settle, or a matching slice that hides unpriced portfolio risk.

Non-goals:

- no live instrument set, underlying, settlement asset, legal entity/counterparty, multiplier, expiry cadence, fixing, rate/carry/dividend input, model, fee, margin shock, offset, floor, MMP threshold, RFQ/block rule, hedge magnitude, SLO or capacity promise is invented;
- no American, barrier, binary, exotic, tokenized, physically delivered or partially collateralized product is authorized by this contract;
- no second matching engine, risk book, OMS, market-data platform, custody system, money book or product SPA is created;
- model IV/Greeks never determine contractual payoff or substitute for an owner-approved settlement fixing;
- paper activity, parser syntax, a green tracker row or a terminal fragment never implies live trading, positions, margin, premium or settlement.

## 2. Research delta and durable patterns

Current official sources materially sharpen the contract:

- [Deribit instrument metadata](https://docs.deribit.com/api-reference/market-data/public-get_instrument) separates option/combo kind, underlying/base/quote/settlement currency, contract size, expiry, strike, price index, lifecycle state and block parameters. Parseable symbols are not enough.
- [Deribit order-book data](https://docs.deribit.com/api-reference/market-data/public-get_order_book) publishes underlying source/price, interest-rate input, bid/ask/mark IV and named Greeks. Analytics need input/model/freshness provenance, not bare numbers.
- [Deribit combo books](https://docs.deribit.com/api-reference/combo-books/public-get_combos) expose a stable combo identity, signed leg ratios and lifecycle state. A visually grouped set of orders is not a combo instrument.
- [Deribit mass quote](https://docs.deribit.com/api-reference/trading/private-mass_quote), [FIX mass quote](https://docs.deribit.com/fix-api/production/mass-quote), and [MMP configuration](https://docs.deribit.com/api-reference/trading/private-get_mmp_config) reinforce quote/message/set IDs, validity, per-entry outcomes, cancel-on-disconnect, MMP grouping, quantity/delta/vega limits, freeze and reset.
- [Deribit Block RFQ](https://docs.deribit.com/articles/block-rfq-api-walkthrough) reinforces signed multi-leg strategies, optional hedge legs, targeted makers, pre-allocation, independent RFQ MMP and causal execution evidence.
- [Deribit portfolio simulation](https://docs.deribit.com/api-reference/upcoming/account-management/private-simulate_portfolio) exposes projected/current margin plus portfolio Greeks for simulated positions; [CME SPAN](https://www.cmegroup.com/solutions/risk-management/performance-bonds-margins/span-methodology-overview.html) reinforces reproducible price, volatility and time scenarios with venue-governed floors/parameters.
- [CME exercise and assignment guidance](https://www.cmegroup.com/clearing/files/IR-284_OptionsExercise.pdf) distinguishes series, exercise style, long exercise, short assignment and allocation methods. The constitution must define these even when v1 uses European cash settlement.

These are durable interaction and evidence patterns, not copied economics, model parameters, legal applicability, or permission to launch.

## 3. Repository evidence audit

| State       | Evidence and bounded truth                                                                                                                                                                                                                                                                                                                                       |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BUILT`     | The instrument enum/schema accepts options; DB constraints require complete European type/strike/expiry/fixing fields; blank settlement-law and fixing gates refuse by name; paper options can list and place exact limit intent with zero hold/ledger posting into the shared matching path; public capability policy and tests expose paper/live distinctions. |
| `PARTIAL`   | CCXT-shaped symbol parsing recognizes option suffixes; public market presentation identifies `type=option` and `paper`, while option expiry/strike/type/settlement remain `null`. The vendored terminal has a paper limit-order action. Generic PX-S03 multi-leg/mass-quote and PX-S06 scenario-risk contracts are reusable but no options adapters were found.  |
| `SPECIFIED` | PX-S01/PX-S03/PX-S04/PX-S05/PX-S06/PX-S11/PX-S12/PX-S13 already bind admission, orders, transport/data provenance, human controls, risk authority, reporting, settlement/correction and recovery.                                                                                                                                                                |
| `SOCKET`    | The accepted owner freeze sets the live options set empty and settlement asset unset. Fixing source/window/clock/payor, counterparty/capacity, payoff/multiplier, collateral treatment, model/risk inputs, MMP/RFQ/hedge parameters and production operations remain owner/legal/external decisions.                                                             |
| `EXTERNAL`  | Underlying/index/fixing/rate/volatility inputs, market-data licenses, liquidity makers, clearing/custody/settlement parties, audit/regulatory inputs and portability require external evidence.                                                                                                                                                                  |
| `ABSENT`    | No live options engine, premium/position/settlement ledger path, full chain, governed IV/Greeks/surface, position builder, combo book, options mass quote/MMP, options RFQ, scenario portfolio-margin implementation, expiry/exercise/assignment jobs, automated delta hedge, or professional what-if/risk export was found.                                     |

Focused options policy/listing/mount tests pass when workspace packages resolve; a direct isolated Vitest invocation proved the policy/compose/mount/status tests and exposed missing prebuilt workspace-package entries for listing/risk/public-REST suites. That test-environment limitation is not product evidence and does not weaken the code-level refusal proof.

The `trade.options` tracker row is green for its bounded paper engine and honesty door. Its own mount declares `gap.live_options_settlement`. It does not close any professional M11 outcome.

## 4. Authority, constitutions, objects, identifiers, and clocks

Every series derives from an immutable `OptionProductConstitutionVersion` linked to PX-S01. It declares legal service/counterparty capacity, eligible entities/accounts/jurisdictions, underlying/index, option type/style, exercise and settlement form, quote/premium/settlement/collateral assets, multiplier and quantity unit, tick/lot/minimums, listing/expiry/fixing/settlement calendars, price/mark/model rules, fees, collateral/risk/liquidation, assignment/allocation, disruption/correction, data entitlements, surveillance, migration and wind-down.

Canonical objects include `OptionFamily`, `OptionSeries`, `OptionInstrument`, `OptionChainSnapshot`, `VolatilitySurfaceVersion`, `AnalyticsObservation`, `OptionPosition`, `StrategyDraft`, `ScenarioSetVersion`, `ComboInstrument`, `ComboOrder`, `QuoteSet`, `MmpPolicyVersion`, `OptionRfq`, `ExerciseInstruction`, `AssignmentAllocation`, `ExpiryRun`, `FixingObservation`, `OptionSettlement`, `DeltaHedgePlan`, `RiskWorkspace`, `ModelException`, and `CorrectionCase`.

Stable IDs include legal owner/account/sub-account/actor/session, product/family/series/instrument/underlying/index, rule/model/surface/scenario/version, chain/snapshot/observation, strategy/leg/combo/order/client-order/quote-set/MMP/RFQ/quote/execution/fill/position, hedge parent/child, exercise/assignment/expiry-run/fixing/settlement, ledger transaction/entry, correction/case/incident and evidence artifact.

Clocks distinguish listing/open/last-trade/expiry/exercise-cutoff/fixing-window/fixing-publication/settlement, market-data event/receive/publish, model input/calculation/publication/valid-until, quote receipt/acceptance/expiry/freeze/reset, risk snapshot/evaluation, hedge trigger/order/fill, job lease/run/checkpoint and correction. Timezone, calendar, clock source/quality and late/corrected status are explicit.

## 5. Product, family, series, and chain constitution

V1 remains European call/put and cash-settled only if the owner later publishes a non-empty live set, named settlement asset, fixing law, counterparty capacity and complete constitution. European means exercise only at the governed expiry event; it does not silently choose auto-exercise threshold, ATM treatment, contrary-instruction rights or assignment method.

Each instrument binds family/series, underlying/index, call/put, strike, expiry, style, multiplier, quantity and premium convention, quote/premium/collateral/settlement assets, price and payoff formula, cap/coverage if any, last trade/exercise/fixing/settlement clocks, tick/lot/minimums, market state and rule versions. Instrument economics are server-resolved; symbol parsing is only transport syntax.

Series lifecycle is:

`PROPOSED → ADMITTED → PREOPEN → OPEN → CLOSE_ONLY → LAST_TRADING_ENDED → EXPIRY_PENDING → FIXING → EXERCISE_ASSIGNMENT_PENDING → SETTLEMENT_PENDING → SETTLED → ARCHIVED`

Exceptional states include `LOCKED_CANCEL_ONLY`, `HALTED`, `FIXING_DELAYED`, `MODEL_UNAVAILABLE`, `DISPUTED`, `CORRECTION_REQUIRED`, `EMERGENCY_SETTLEMENT_PENDING` and `WIND_DOWN`. Allowed quote/order/cancel/close/exercise/settlement actions are explicit per state. Adding strikes/expiries, changing ticks, expiry, multiplier, settlement or fixing creates governed versions; accepted economics are never mutated in place.

An `OptionChainSnapshot` enumerates every admitted strike and expiry plus instrument/series state. Missing strikes, partial expiries, delayed instruments, crossed/empty books and unavailable analytics remain explicit; the UI/API cannot fabricate a continuous chain from an incomplete set.

## 6. Premium, payoff, collateral, positions, and exact money

Premium and settlement are distinct economic events. Order acceptance obtains one exact PX-S06 hold using the effective option constitution and account risk mode. Fill settlement uses an approved balanced `ledger-client` recipe for premium/fee and creates or updates the PX-S06 position atomically or through a recoverable journaled state. Expiry payoff uses a separate stable economic idempotency root. Decimal strings cross boundaries, scaled bigint represents money in memory, and money never enters `number`.

The clearing/counterparty model states whether matching novates obligations, participants face one another, or an approved external clearer/intermediary is involved. Premium recipient, fee recipient, settlement obligor, custody location, default treatment and finality cannot be inferred from a CLOB fill.

“Full collateral v1” means an owner-approved model can prove the maximum remaining obligation in the named settlement asset and reserve it without a prohibited offset. It is not a label or fixed percentage. A cash-settled short call with uncapped upside does not have a finite maximum liability merely because premium is prepaid; absent an approved cap, covered-delivery transformation, or other bounded-liability constitution, opening that short refuses. Long premium-paid positions and closing orders do not authorize live trading while the global settlement socket remains open.

Positions preserve long/short quantity, average premium, realized/unrealized PnL, mark/model/fixing versions, Greeks, collateral, exercise/assignment/settlement state and causal fills. Unknown model, fixing, position or settlement data is not zero. Fees, premium, collateral, exercise payoff, release, liquidation/default, reversal and correction reconcile to orders/fills/positions/ledger at common watermarks.

## 7. Marks, IV, Greeks, and volatility-surface governance

Contractual payoff uses the constitution's fixing and never IV. Risk/analytics use a versioned `OptionAnalyticsModel` declaring model family/implementation, underlying/index/forward, spot/futures mapping, rates/carry/dividend or equivalent inputs, calendar/day count, volatility inputs/calibration, numerical method/tolerances, valid domains, rounding, source timestamps, correction and independent validation.

Every mark/IV/Greek observation carries instrument, input/model/surface versions, underlying source/value, rate/carry inputs, calculation and event times, freshness, confidence/quality, stale/fallback state and correction lineage. Boundary fields use decimal strings. Analytical computation may use a reviewed bounded numerical representation with error evidence; any money result is converted through approved exact rules before hold or posting.

Bid IV, ask IV, mark IV and model IV are distinct. Inversion failures, invalid inputs, no arbitrage-consistent solution or values outside the model domain yield `UNAVAILABLE`/`INVALID`, not zero, infinity, a last-good live color, or a clamp hidden from users. Delta convention and units, gamma/vega/theta scaling, sign, currency and time basis are named.

A `VolatilitySurfaceVersion` records family/universe, strike/moneyness/delta convention, expiries, observations, interpolation/extrapolation, weighting, filters, static-arbitrage diagnostics, sparse regions, calibration error, valid interval and publication status. Raw market observations remain available beside fitted values. Smoothing never rewrites trades, fixing or the canonical book.

Model lifecycle is `DRAFT → VALIDATED → SHADOW → APPROVED → ACTIVE → DEGRADED → SUSPENDED → RETIRED`, with rollback and parallel comparison. Owner-set model/risk governance follows PX-S06; missing or stale critical inputs stop new risk and automated quoting/hedging while preserving cancel/close/settle/evidence as authoritative.

## 8. Full chain, term structure, skew, and data contract

The chain exposes per instrument: bid/ask price and size, last/mark/index, bid/ask/mark IV, delta/gamma/vega/theta, volume, open interest, strike, expiry, time remaining, moneyness/delta bucket, instrument/market state, source, event/receive age, sequence/completeness and entitlement. Term structure and skew/smile views expose their exact universe, surface/model version, interpolation, sparse/excluded points and freshness.

PX-S04 owns REST/WebSocket/FIX/binary transport, sequence/replay, corrections, history, capture and entitlement. PX-S08 owns option field meaning and model provenance. Snapshots/deltas cannot mix series or surface versions without labeling. OI/volume are source facts, not derived from displayed depth; delayed or partial inputs remain distinct from live complete data.

Historical data retains instruments that expired or delisted, raw and fitted analytics, underlying/index inputs, books/trades, OI/volume, model/rule changes, exercise/assignment, fixing/settlement and corrections. Replay can reconstruct the chain and surface seen at a prior decision time without survivorship cleanup.

## 9. Position builder and pre-trade strategy analysis

A `StrategyDraft` is non-economic until submitted through ordinary PX-S02/PX-S03 authority. It supports saved/imported positions and candidate option, future/perpetual and spot legs with signed ratios, quantities, prices/IV assumptions, account, strategy label and scenario version. Imports are schema-validated, bounded, malware-safe and do not gain execution permission.

Preview reports payoff at expiry and before expiry, premium/cash flow, Greeks by leg and aggregate, scenario PnL, break-evens, margin/collateral change from authoritative PX-S06, fees, liquidity/market impact, execution choices, legging/hedge risk, assumptions, unsupported dimensions, data/model age and confidence. It distinguishes current positions, staged legs, executable quotes and hypothetical inputs.

Results are reproducible from retained inputs and never imply a guaranteed PnL or margin outcome. A changed book, model, risk state, rule, account authority or quote invalidates the affected preview before commitment. Submission creates a PX-S03 parent/combo/RFQ intent and reruns rule/risk checks; a saved analysis cannot post money or reserve collateral.

## 10. Native combos, custom strategies, and leg repair

A `ComboInstrument` declares stable ID/version, signed leg instruments and integer ratios, strategy class, quantity/price convention, tick, eligible series/accounts, lifecycle, fee/risk treatment and disclosure. Standard names are aliases for explicit legs; custom combos remain immutable for accepted orders.

Native combo execution is one PX-S03 atomic multi-leg economic event with deterministic leg prices/quantities, fill ID, position effects, fees and premium postings. If native atomic execution is absent, a synthetic parent declares sequencing, parallelism, protection, maximum residual, timeout, cancel policy, hedge/repair authority and terminal state before acceptance. UI grouping alone is not atomicity.

Partial, rejected, late, duplicate and outcome-unknown leg results enter explicit `HEDGE_REQUIRED`, `REPAIRING`, `RESIDUAL_ACCEPTED`, `FAILED_RESIDUAL` or `MANUAL_CASE` states. No automatic repair exceeds the original authority, risk, quantity or price envelope. Parent/leg/hedge causality appears in private data, drop copy, positions, ledger, TCA and surveillance.

## 11. Market-maker quote sets, mass quote, and MMP

Mass quote uses message/quote-set/version/entry/client IDs, account/sub-account, MMP group, instrument/side, exact price/size, validity, sequence and cancel-on-disconnect lease. Same message ID and payload is idempotent; collision refuses. Per-entry accept/reject/replace/cancel/fill outcomes are authoritative and asynchronous—message acknowledgement order does not establish matching order.

Each owner-approved `MmpPolicyVersion` defines scope, observation window, filled quantity/delta/vega and maximum-open-quote measures, treatment of partial fills/corrections, trigger ordering, freeze action, cancel completeness, cooldown or manual reset, approval, escalation and recovery. Thresholds use named units/conventions and current model versions. Missing/stale delta or vega triggers the safe configured response, never “zero exposure.”

State is `DISABLED → ARMED → TRIGGER_PENDING → FROZEN_CANCELING → FROZEN → RESET_PENDING → ARMED`, or `DEGRADED`, `KILLED`, `RECOVERY_REQUIRED`. Freeze fences new/replacement quotes at the authoritative ingress before or with scoped cancel. A reset cannot race unfinished cancellation or silently restore quotes; inventory/risk, market/model/data health, credentials and operator/participant authority are rechecked.

Kill, mass cancel and MMP scopes compose with PX-S03/PX-S10; the most restrictive effective control wins. Protections cannot give a maker undisclosed priority, access, data, fee or error treatment. Quote-to-trade, stale-quote exploitation, affiliate/house flow and repeated trigger/reset patterns enter surveillance.

## 12. Options RFQ, block, hedge leg, and allocations

PX-S09 owns generic RFQ/block participant, anonymity, principal/agency, allocation and reporting law. PX-S08 adds options-specific strategy legs, Greeks/scenario/risk, combo comparison, optional hedge leg, options MMP and expiry/model dependencies.

An option RFQ binds requester/beneficial owner/account, eligible/targeted maker set, anonymity stage, signed legs/ratios, aggregate quantity, package-price convention, hedge leg and relationship, response/acceptance expiries, disclosure/block class, allocation instruction, rule/model/risk snapshots and jurisdictions. A quote is firm only under its explicit capacity and terms.

Acceptance is atomic for the governed package or follows a predeclared partial-allocation law; it cannot silently leg a firm package. Targeting and anonymity never hide identity from authorization, compliance, surveillance or post-trade obligations. Pre-allocation totals, account eligibility, margin and settlement validate before acceptance; post-trade breaks remain case-bound rather than reassigned to conceal a failed account.

## 13. Scenario portfolio margin and liquidation inputs

PX-S06 remains the risk SoR and owns enrollment, aggregation boundaries, collateral, holds, offsets, IM/MM, liquidation/default, model governance and owner-set magnitudes. PX-S08 supplies exact option payoff, premium, model/Greek, expiry/fixing, liquidity/concentration and scenario inputs; neither terminal nor options service maintains a shadow margin book.

An options `ScenarioSetVersion` declares underlying spot/forward, volatility level/skew/surface, time decay, rate/carry, basis/correlation, liquidity/concentration and operational/fixing shocks; evaluation grid/order; offsets and prohibited boundaries; short-option/minimum floors; anti-procyclical controls; stale-input response; and independent calculator artifacts. Scenario values are owner-approved sockets, not copied from examples or external venues.

Pre-trade, intraday, liquidation and settlement use compatible model/rule versions and expose the binding worst scenarios and floors. New risk refuses when valuation or margin is unavailable. Liquidation recognizes nonlinear exposure, open quotes/combos/RFQs, expiry proximity, liquidity and hedge failure; a delta-neutral label never proves low risk.

## 14. Expiry, exercise, assignment, fixing, settlement, and correction

An expiry run freezes an immutable eligible-position membership at a reconciled order/fill/position watermark, cancels or expires open intent per rule, obtains the governed fixing, classifies positions, generates exercise/assignment/expiration outcomes, computes exact payoff and fees, posts/reconciles settlement, releases collateral and archives the series.

Run state is:

`SCHEDULED → LEASED → MEMBERSHIP_FROZEN → ORDERS_RESOLVED → FIXING_PENDING → FIXING_FINAL → CLASSIFIED → EXERCISE_ASSIGNMENT_APPLIED → SETTLEMENT_POSTED → RECONCILED → COMPLETE`

Failure states are `FIXING_DELAYED`, `PARTIAL`, `OUTCOME_UNKNOWN`, `RECONCILIATION_BREAK`, `DISPUTED`, `CORRECTION_REQUIRED` and `WIND_DOWN`. One fenced writer owns a run/partition. Stable economic IDs root each position outcome and posting; retries return the original result. Completion requires every eligible position exactly once and every ledger transaction balanced/reconciled.

The product constitution decides automatic exercise threshold, ATM treatment, exercise/abandonment or contrary-instruction rights, short assignment/allocation method, cash payoff, rounding, fees, payor/counterparty, settlement asset/account and finality. V1 European style forbids early exercise, but does not invent the remaining rules. Notifications are pre-announced and record delivery separately from acknowledgement.

Each `FixingObservation` records source set, window, method, excluded inputs, timestamps/clock quality, result, approval, publication, validity and correction. Missing/divergent/stale sources invoke only a published fallback or delay/halt. Last trade, mark IV, model price or terminal display is never silently substituted.

Corrections append a new fixing/outcome/position/settlement/report version and balanced compensating ledger postings. They never edit a fill, historical fixing or money row. Client evidence explains original and corrected outcome, authority, impact, appeal/dispute and residual claim under PX-S01/PX-S12.

## 15. Automated delta hedging

A `DeltaHedgePlan` is an ordinary governed strategy under PX-S02/PX-S03 and common PX-S15 lifecycle controls. It declares owner/account/sub-account, included positions, delta convention/model, target/range, eligible hedge instrument/venue, trigger/cadence, order type/protection, size/slippage/turnover/fee/capital caps, interaction with manual/open/other hedge orders, netting and priority, start/expiry and kill/revocation scope.

State is `DRAFT → VALIDATED → APPROVED → ARMED → TRIGGERED → ORDER_PENDING → HEDGING → IN_RANGE`, with `PAUSED`, `STALE_INPUT`, `RISK_REFUSED`, `PARTIAL`, `FAILED`, `KILLED`, `EXPIRED` and `RECONCILIATION_REQUIRED`. Every child order passes current account, market, order, risk, collateral and kill checks. Model output is not money authority.

Only acknowledged fills change observed residual delta. Timeout/unknown, partial fills, manual trades, exercise/assignment, liquidation, market/model/data outage and child rejection recompute or stop under policy; they never cause an unbounded catch-up order. Stop/kill cancels outstanding children within scope but does not erase filled hedge positions, fees or residual risk. Complete parent/child/fill/model causality and termination reason feed positions, reporting, TCA and surveillance.

## 16. Saved/imported what-if risk, drill-down, and export

A `RiskWorkspace` stores owner/account scope, selected live positions and hypothetical legs, scenario/model/rule versions, view dimensions, timestamps and permissions—not balances or authoritative margin. It supports user-defined spot/forward, volatility level/skew, time and rate/carry shocks subject to bounded schemas and resource limits.

Views drill from portfolio to underlying, expiry, strategy, instrument and leg across PnL, delta, gamma, vega, theta, margin, collateral, liquidity/concentration and fixing/settlement exposure. Unresolved positions, stale/missing inputs, unsupported exotics, pending corrections and external legs are prominent and excluded from totals only with an explicit reconciliation difference.

Hedge preview creates no authority and uses §15/PX-S03 submission for execution. Exports include original positions/amounts, scenario grid, input/model/rule versions, source times, assumptions, excluded items, result units/currency, calculation time and integrity hash. Re-import cannot overwrite live positions or smuggle commands.

## 17. UI, API, FIX, WebSocket, events, operators, and reports

The PX-S05 terminal supplies chain/surface/skew/term views, option ticket, position builder, payoff/Greek/risk surfaces, combo/RFQ workflow, quote/MMP controls, expiry calendar, blotters and exception dashboards. Every surface shows environment, account, product/series, data/model/fixing freshness and `LIVE`, `PAPER`, `SIMULATED`, `STALE`, `PARTIAL`, `DEGRADED`, `HALTED` or `UNAVAILABLE`. Paper orders show zero hold/no ledger/no position truth before and after submission.

REST/private/public WebSocket, FIX order/market data/drop copy and binary feeds reuse PX-S04. Schemas expose the objects/IDs/versions/clocks in §4, exact decimal strings, field conventions/units, sequence and correction. Capabilities distinguish listed, chain-visible, orderable, quoteable, RFQ-enabled, margin-enabled, hedge-enabled and settleable rather than one `options=true` bit.

Events cover instrument/series/surface/model/scenario state; chain correction; order/combo/quote-set/MMP/RFQ; position/Greek/risk; hedge; expiry/exercise/assignment/fixing/settlement; refusal/correction/incident. Events contain economic IDs and exact facts, never numeric money. Private projections and drop copy preserve parent/leg/hedge/RFQ/allocation causality.

Operator actions include product/model activation, series/strike admission, lock/halt/close-only, model degradation, MMP/quote kill, expiry lease/fixing approval, settlement release, correction and emergency/wind-down actions under PX-S02 dual control and PX-S01 rules. Operators cannot type prices, payoffs or balances outside approved evidence/workflows.

Reports reconcile premiums/fees, positions, Greeks/model, margin, quotes/MMP, combos/RFQ, hedge fills, exercise/assignment, fixing, settlement, ledger and corrections. PX-S11 composes/delivers reports but does not recalculate authoritative options money or risk.

## 18. Idempotency, sequencing, concurrency, replay, and partial success

Client commands use explicit idempotency domains and payload collision refusal. Economic IDs are distinct for premium fill, position transition, exercise/assignment outcome, settlement posting and correction. Reusing a network request ID cannot duplicate money, and changing payload under an existing ID refuses.

Concurrency tests cover quote replace versus fill/MMP freeze, cancel versus combo/RFQ fill, model/risk version change during preview/acceptance, exercise versus close fill, fixing correction versus settlement, hedge trigger versus manual trade/kill, and expiry writer failover. Locks/leases/fencing and immutable watermarks choose one result; arrival order across queues never does.

Replay restores instruments, orders, quotes, RFQs, positions, model/scenario versions, frozen expiry memberships, outcomes, ledger links and corrections before enabling new risk. Partial/unknown states remain visible and reconcile; recovery never reruns historical analytics with today's surface to invent an old economic decision.

## 19. Integrity, conflicts, security, privacy, and retention

Surveillance correlates beneficial owners, accounts, makers/affiliates/house capacity, options/underlying orders, combos, RFQ, blocks, hedge flow, quote/MMP behavior, indices/fixing windows, exercise/assignment and corrections. It covers wash/self trading, marking the close/fixing, spoofing/layering, quote stuffing, stale-quote exploitation, RFQ information leakage/front-running, preferential MMP/reset/error treatment, position-limit evasion and cross-product manipulation.

Market-maker, affiliate, internal/principal and external-provider roles are disclosed and objectively governed. No role receives hidden order priority, model inputs, latency, data, fees, MMP thresholds, error-trade treatment or client RFQ information. PX-S10 owns commercial/fee/incentive constitution; absent economics remain sockets.

Scopes separate chain/data, account/risk, order, mass quote/MMP, RFQ, hedge, exercise instruction and operator settlement/correction. Credentials bind entity/account/product/environment/network and revoke through active sessions/strategies. Secrets and proprietary positions/strategies/RFQs/models are least-privilege, encrypted, redacted from diagnostics and retained/deleted under policy and legal hold.

## 20. Degraded-state and refusal truth

Named failures include underlying/index divergence; stale/gapped chain; model calibration/inversion failure; missing rate/carry/surface; crossed/locked/halted book; dense-series overload; mass-quote/cancel storm; MMP trigger/reset failure; combo/RFQ partial or unknown; risk/margin unavailable; hedge market/data/order failure; expiry/fixing job failure; settlement-asset/counterparty/custody failure; ledger/reconciliation break; correction/dispute; region/dependency loss and clock fault.

Each failure declares affected family/series/accounts, authoritative last-good watermark, allowed new-risk/quote/cancel/close/hedge/exercise/settlement actions, client status, recovery evidence and escalation. Safety order is generally: stop new quotes/complex/new risk; preserve cancel, risk-reducing close and collateral action where authoritative; finish or case-bind accepted fills and expiry obligations; retain evidence. An outage cannot make a paper or stale model look live.

The following named existing refuses remain authoritative while their conditions hold: `trade.options_settlement_law_unset`, `trade.options_fixing_unconfigured`, `trade.options_terms_incomplete`, `trade.unsettled_asset_class_listing`, and `trade.market_kind_unsupported`. PX-S08 may add typed domain refuses during implementation but cannot rename these to obscure compatibility or bypass them.

## 21. Capacity, SLO, observability, and incident behavior

PX-S13 owns target magnitudes. Capacity dimensions include underlyings/families/series/strikes, chain and surface recalculation fan-out, hot books, analytics/scenario workloads, open positions/orders/quotes, mass-quote/cancel bursts, combo/RFQ legs, MMP triggers, expiry memberships/postings, hedge cascades, private/drop-copy/report fan-out and external data/settlement quotas.

Load/fault evidence covers severe price/volatility/skew moves, zero/near-expiry calculations, dense strike grids, maker withdrawal, quote/cancel storms, correlated liquidation/hedge/expiry bursts, slow clients, replay/reconnect, model/index outage, writer failover, region/dependency loss and ledger backpressure. Expensive optional surface/what-if work sheds before authoritative quote cancel, risk, order, expiry, settlement and evidence paths.

Observability separates market-data receipt, model calculation/publication, order/quote/RFQ acceptance, match, risk/position, premium ledger, hedge, expiry stage, fixing, settlement and reconciliation. Metrics expose queue age, version/freshness, refused/degraded counts, MMP cancellation completion, residual legs/delta, job checkpoints and reconciliation breaks without leaking high-cardinality client strategy.

Status and incident communications name affected product/series/surface/action and distinguish trading, analytics, risk, expiry and settlement. “Options operational” is forbidden when only paper order entry or chain display works. Recovery follows PX-S13 fencing, replay/reconcile, customer update and post-incident evidence.

## 22. Compatibility, rollout, rollback, suspension, and wind-down

Implementation reuses existing paper listing/order gates, shared matching, PX-S03 schemas, PX-S06 risk, PX-S04 data, PX-S05 terminal, PX-S12 settlement and ledger recipes. Schema evolution must first publish complete option terms rather than the current public `null` expiry/strike/type/settlement fields. Old clients either receive compatible explicit semantics or a named capability refusal.

Rollout is staged through deterministic model tests, sandbox/paper, historical replay, shadow analytics/risk/expiry, internal non-economic drills, approved participants, bounded products/accounts and explicit live activation. Shadow prices, Greeks, positions, premiums and expiry results are labeled and cannot post. No stage bypasses the accepted empty live-set/settlement-asset freeze.

Rollback stops new risk/quotes/hedges, cancels scoped open intent, reconciles accepted economic facts, retains model/rule versions and completes/case-binds expiry/settlement. It never rewrites positions or money. Model rollback may change future analytics only; historical decisions retain their effective model.

Wind-down inventories series, orders/quotes/combos/RFQs, positions, premium/collateral, model/risk cases, hedge children, exercise/assignment/fixing/settlement, ledger/custody, reports, credentials, disputes and external obligations. It follows PX-S01/PX-S12, preserves cancel/close/settle/withdraw/evidence paths, proves zero or explicit residual claims and never invents an emergency fixing or asset.

## 23. Definition of Done

PX-S08 is implementation-complete only when evidence proves:

1. every live instrument is owner-admitted with complete bounded economics, counterparty, collateral, settlement asset and fixing; blank policy still refuses;
2. premium, fee, position, collateral, exercise/assignment payoff, settlement, release, reversal and correction reconcile exactly through approved ledger recipes;
3. chain, IV/Greeks, surface/skew/term structure and history pass provenance, freshness, sparse/invalid, correction and replay tests;
4. position builder and saved/imported risk reproduce payoff/Greek/scenario/margin/fee/execution alternatives without gaining authority;
5. native/synthetic combos pass atomicity, ratio, partial/unknown leg, hedge/repair, position, money, drop-copy and TCA tests;
6. mass quote/quote sets/MMP pass asynchronous correlation, quantity/delta/vega trigger, stale model, cancel completion, freeze/reset/kill and recovery tests;
7. options RFQ passes strategy/hedge-leg, targeted/anonymity, firmness/expiry, block/reporting, pre-allocation/break and independent MMP tests with PX-S09;
8. scenario portfolio margin is independently reproducible, enforces legal/account/asset boundaries, nonlinear risk, floors/concentration/liquidity and refuses missing model inputs;
9. expiry/exercise/assignment/fixing/settlement jobs pass fenced writer, frozen membership, replay, exactly-once outcome/posting, correction, notice and reconciliation tests;
10. automated delta hedging passes authority, model/freshness, manual-order interaction, partial/unknown/failure, revocation/kill, residual-risk and attribution tests;
11. UI/API/FIX/WebSocket/drop-copy/events/reports agree on product, model, risk, state, exact units, paper/live truth and correction;
12. integrity/conflict/security/privacy, severe-market capacity, dependency/region recovery, rollout/rollback, suspension and wind-down pass adversarial exercises;
13. all ten M11 requirements below pass integrated proof against predecessor contracts.

A completed spec, parser, paper order, policy endpoint, tracker row, generic multi-leg contract or third-party analytics widget is not a complete volatility venue.

### 23.1 Requirement proof map

| Requirement   | Contract closure                                                                                                            | Required implementation evidence                                                                     |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `PTX-M11-R01` | §§4–6 and 14 define European call/put economics, premium/collateral, exercise, settlement/fixing and disruption             | Owner-approved constitution plus exact order/position/ledger/expiry/correction conformance           |
| `PTX-M11-R02` | §§7–8 define full chain, bid/ask/mark IV, Greeks, OI/volume, skew/term, provenance and freshness                            | Feed/model/surface/history/replay, sparse/stale/invalid/correction and cross-channel proof           |
| `PTX-M11-R03` | §9 defines multi-leg position builder payoff, Greeks, scenario PnL, margin, fees and execution alternatives                 | Reproducible preview/invalidation/import/save and no-authority/no-side-effect tests                  |
| `PTX-M11-R04` | §10 defines native combo identity/atomicity and bounded synthetic legging/repair                                            | Atomic and partial/unknown/recovery fixtures across orders, positions, ledger, drop copy and TCA     |
| `PTX-M11-R05` | §11 defines quote sets, mass quote, cancel groups and quantity/delta/vega MMP freeze/reset/stale protection                 | Async per-entry, storm, trigger, fence, cancel-completion, reset/kill and recovery evidence          |
| `PTX-M11-R06` | §12 defines product-specific multi-leg/targeted/anonymity/expiry/hedge/block/allocation RFQ semantics                       | PX-S09-conformant firm/expired/partial/break/MMP/reporting and surveillance proof                    |
| `PTX-M11-R07` | §13 defines nonlinear scenario portfolio margin inputs, boundaries, shocks, floors, concentration and liquidity             | PX-S06 independent-calculator, stress/backtest/shadow, stale/refuse and liquidation proof            |
| `PTX-M11-R08` | §14 defines fenced, frozen-membership, exactly-once expiry/exercise/assignment/fixing/settlement and correction             | Crash/replay/failover/duplicate/correction/notice plus position-ledger-statement reconciliation      |
| `PTX-M11-R09` | §15 defines authorized delta-hedge target/range/instrument/triggers/caps/manual interaction/failure/termination/attribution | Ordinary order/risk/kill conformance with partial/unknown/stale/revoked and residual-risk evidence   |
| `PTX-M11-R10` | §16 defines saved/imported shock workspaces, drill-down, unresolved warnings, hedge preview and evidentiary export          | Bounded import, reproducible shock/drill/export, permission, unavailable-input and no-mutation tests |

## 24. Owner and external sockets

| Socket       | Required authority/input                                                                                                               | Refuse-closed behavior while absent                                           |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `PX-S08-O01` | Non-empty live family/series/strike set, legal entity/counterparty capacity, eligible entities/accounts/jurisdictions and disclosures  | Accepted empty live set remains; production listing/order refuses             |
| `PX-S08-O02` | Settlement asset/custody/account/finality, premium/payoff/fee recipients and approved `ledger-client` recipes                          | `socket.options-settlement-asset-law` remains open; no live premium or payoff |
| `PX-S08-O03` | Multiplier, quantity/premium/payoff convention, cap/cover/full-collateral method, precision/ticks/minimums and short eligibility       | No live position; unbounded or unprovable short obligation refuses            |
| `PX-S08-O04` | Series/strike/expiry/last-trade calendars, exercise/ATM/assignment/allocation, settlement and notice rules                             | Series remains paper/pending; expiry cannot classify or settle                |
| `PX-S08-O05` | Fixing source/window/method/clock/exclusions/fallback/payor/correction and approval                                                    | `trade.options_fixing_unconfigured`; live series cannot list or settle        |
| `PX-S08-O06` | Mark/IV/Greek/surface models, inputs/conventions, validation/tolerances, freshness/fallback and governance                             | Analytics unavailable; new model-dependent risk/quote/hedge refuses           |
| `PX-S08-O07` | Scenario shocks/offsets/boundaries/floors/concentration/liquidity/anti-procyclical controls and margin enrollment                      | Portfolio offsets unavailable; affected new risk refuses                      |
| `PX-S08-O08` | Native/synthetic combo eligibility, ratio/price/fee/risk, legging/residual/repair authority                                            | Combo disabled; independent orders remain independent                         |
| `PX-S08-O09` | Maker eligibility, mass-quote/MMP scopes, quantity/delta/vega/open-quote thresholds, freeze/reset/approval                             | Mass quote disabled; ordinary approved single-order controls remain           |
| `PX-S08-O10` | Options RFQ/block capacity, maker targeting/anonymity, hedge leg, firmness/partial, allocation/reporting/commercial policy             | Options RFQ disabled or non-firm simulation only                              |
| `PX-S08-O11` | Delta-hedge eligibility, target/range, hedge instruments/venues, triggers/cadence, protection/caps/manual priority and termination     | Automated hedge remains disabled; preview only                                |
| `PX-S08-O12` | Retention/privacy/entitlement, model/exchange IP, support, capacity/SLO, rollout/rollback and accepted residual-risk policy            | Restricted data/features unavailable; no performance or completeness claim    |
| `PX-S08-X01` | Underlying/index/fixing/rate/carry/volatility/OI/reference sources, licenses, timestamps, corrections and outage evidence              | Affected chain/model/mark/fixing unavailable or product halted                |
| `PX-S08-X02` | Market makers/RFQ counterparties/clearing/custody/settlement providers, credit/capacity, allocations, reconciliation and exit evidence | Affected quote/RFQ/product/settlement disabled                                |
| `PX-S08-X03` | Independent model/risk validation, historical stress data and reproducibility artifacts                                                | Model stays shadow; no live margin/mark/MMP/hedge dependence                  |
| `PX-S08-X04` | Applicable legal/regulatory, disclosure, record, position-limit, exercise/assignment, block-reporting and market-data requirements     | Affected entity/product/jurisdiction remains ineligible                       |

## 25. Cross-spec dependencies and contradiction register

- **PX-S01:** owns product admission, instrument/rule/emergency/fixing governance, disputes and corrections. PX-S08 supplies options-specific constitution and cannot activate outside it.
- **PX-S02:** owns legal owner, accounts, actor/delegation, approvals/revocation and operator authority. A quote bot, RFQ or hedge plan never creates separate authority.
- **PX-S03:** owns order/matching/multi-leg/mass-control/finality and execution correction. PX-S08 owns option/combo/MMP adapter semantics and payoff inputs.
- **PX-S04:** owns protocol sequence/replay, data/feed/history/certification and entitlement. PX-S08 defines option fields, units, model provenance and correction.
- **PX-S05:** owns terminal/workspace/OMS/TCA and human safety. PX-S08 supplies chain, builder, surface, risk, quote, RFQ, hedge and expiry product semantics.
- **PX-S06:** owns collateral/risk/margin/liquidation/default SoRs and model governance. PX-S08 supplies nonlinear payoff/scenario/Greek/expiry inputs without a shadow risk book.
- **PX-S07:** owns underlying linear-product/position/fixing semantics. Options exposure does not become spot, futures or FX settlement by sharing an index or symbol grammar.
- **PX-S09:** owns generic RFQ/block capacity, anonymity, allocation and reporting. PX-S08 owns the options-strategy/Greek/hedge/MMP specialization.
- **PX-S10:** owns maker constitution, fees/incentives and affiliate conflicts; PX-S08 owns technical options quote protection without inventing economics.
- **PX-S11/PX-S12:** own report delivery and money/custody/settlement reconciliation/wind-down. Options services do not become report or money books.
- **PX-S13:** owns capacity/SLO/recovery/status/incident law. A healthy paper book is not live product evidence.
- **PX-S15:** owns common deterministic strategy lifecycle. PX-S08 remains primary for the options delta-hedge product envelope; both inherit ordinary order/risk/kill authority.

Resolved contradictions and explicit gaps:

1. The accepted options/FX settlement ADR's “no IV surface” statement is scoped to completing the mechanical paper/listing/settlement thin slice: IV cannot determine payoff, invent a fixing, or unlock the live socket. M11 separately requires professional IV/Greeks/surface analytics. PX-S08 preserves the ruling by keeping analytics model-governed and non-authoritative for contractual settlement.
2. The tracker title says “cash-settled, full collateral in v1.” That is a product shape, not a computable short-option reserve. An uncapped cash-settled short call has no finite maximum payoff from that phrase alone; short opening refuses until the owner publishes bounded-liability/cover and collateral law.
3. `trade.options` is green for a paper order-entry slice while its mount declares `gap.live_options_settlement`. Paper rows use zero hold, make no ledger post and create no option position/payoff. This contract treats them as simulation evidence only.
4. The current public market adapter reports `option=true` and `paper`, but returns `null` settlement, contract size, expiry, strike and option type even though DB listing terms exist. Clients therefore cannot reconstruct the contract; PX-S08 requires an explicit compatible schema before any live claim.
5. The public policy summary's broad `optionsOrders=true` coexists with explicit `paperOptionsOrders=true` and `liveOptionsOrders=false`. The narrow fields and order-path refusal control truth; capability evolution must remove ambiguity rather than reading the broad bit as live permission.
6. The symbol parser recognizes option syntax. It does not prove admission, complete public metadata, chain/data, pricing/Greeks, risk, positions, premium, execution, expiry or settlement.
7. PX-S03 specifies generic multi-leg, mass quote and MMP envelopes, and PX-S06 specifies generic scenario margin. No options-specific adapters or end-to-end proof were found; generic contracts are dependencies, not M11 implementation.
8. The vendored terminal can send a paper option limit order. It has no professional chain/surface/builder/combo/RFQ/MMP/risk/expiry workflow and cannot be presented as one.
9. `TRADE_OPTIONS_SETTLEMENT_ASSET_LAW` is an opaque future owner stamp, never a settlement-asset parser. PX-S07 already separates FX law; PX-S08 alone binds each authorized option constitution to an owner-named asset and rail/custody path.
10. A model mark, last trade, underlying index or external venue price is not a contractual expiry fixing unless the effective PX-S01/PX-S08 constitution names it and its fallback/correction law.
