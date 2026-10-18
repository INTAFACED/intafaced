# INTAFACED Liquidity, Fees, Incentives, and Maker Constitution Specification

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Status:** Authoritative product contract; implementation incomplete

**Authority:** `PX-S10`; bounded child of [`PRO_TRADER_EXCHANGE_DEFINITIVE_SCOPE.md`](../PRO_TRADER_EXCHANGE_DEFINITIVE_SCOPE.md)

**Primary requirements:** `PTX-M13-R01–R07`, `PTX-M21-R01–R07`

**Predecessors:** `PX-S01` rulebook/lifecycle/integrity, `PX-S02` participant authority, `PX-S03` microstructure/execution, `PX-S04` connectivity/data/certification, `PX-S05` terminal/OMS/TCA, `PX-S06` collateral/risk/default, `PX-S07` linear/Convert/FX, `PX-S08` options/volatility, `PX-S09` RFQ/block/OTC/allocation, `PX-S11` reporting/service, `PX-S12` custody/reconciliation/wind-down, and `PX-S13` resilience/incident command

**Systems of record:** PX-S01 owns venue rules, conflicts, surveillance, and emergency authority; PX-S02 owns participant/account/beneficial-owner authority; PX-S03 owns orders, matches, executions, and queue truth; PX-S06 owns capital, inventory, credit, and default controls; PX-S11 owns institutional reports; PX-S12 owns money finality and reconciliation; `packages/ledger-client` plus `svc-ledger` remain the only money book. This contract owns the versioned liquidity plan, maker-program constitution, fee constitution, incentive eligibility, actionable-liquidity evidence, commercial attribution, and venue-economics evidence.

---

## 1. Product promise, professional jobs, and boundary

Market makers, takers, brokers, principals, treasury, product managers, finance, risk, compliance, surveillance, operations, client service, regulators, and auditors can determine what liquidity is executable, who supplied it, which obligations and conflicts govern it, what each trade or service costs, why an incentive was earned or denied, and whether the venue can sustain the market through stress and orderly exit.

This determines primary-venue adoption because a professional venue without reliable actionable depth is merely a screen. Participants will not concentrate flow where displayed size is synthetic, affiliate flow has hidden privilege, fees change between preview and fill, rebates reward self-trading or cancel noise, the venue cannot explain maker concentration, or a liquidity crisis is disguised as a healthy market.

Catastrophic or dishonest outcomes include unauthorized house capital or inventory; an internal maker seeing private customer intent; affiliate self-preferencing; fake or non-executable depth; fee/rebate calculations using floating point or an unstated version; negative fees creating unfunded claims; tier aggregation across unrelated beneficial owners; hidden broker markup; incentive farming through wash volume, spoofing, excessive cancels, or outages; fee revenue misrepresented as available default capital; and makers disappearing during a depeg, venue loss, borrow recall, oracle split, or liquidation wave without a controlled market response.

M13 and M21 remain grouped. Liquidity obligations, maker admission, incentives, customer fees, conflict controls, and venue economics are one constitution: changing one changes market quality and abuse incentives in the others. This contract does not choose commercial magnitudes.

Non-goals:

- no maker, capital source, symbol, spread, size, depth, uptime, inventory band, rate, tier, rebate, fee asset, aggregation rule, threshold, budget, SLO, legal entity, jurisdiction, counterparty, tax treatment, accounting policy, or launch commitment is invented;
- no internal or affiliate maker is authorized by this contract; the accepted external-only ruling remains binding until owner/legal authority publishes a replacement;
- no displayed external book is relabeled as INTAFACED executable depth, and indicative or stale liquidity is never counted as actionable;
- no fee, rebate, credit, commission, clawback, or subsidy creates a balance outside `ledger-client`, and fee revenue is not silently treated as risk capital, insurance, or inventory funding;
- no second pricing service, market-making engine, surveillance system, ledger, product SPA, tracker, or commercial roadmap is created;
- competitor economics are evidence patterns only and never become INTAFACED policy.

## 2. Research delta and durable patterns

Current official sources add durable contract requirements:

- [CME Rule 195](https://www.cmegroup.com/rulebook/CME/I/1/1.pdf) makes program scope, dates, requirements, restrictions, obligations, incentives, eligibility, monitoring, records, and termination explicit; it also bars a person performing relevant maker duties from possessing non-public customer-order knowledge in the same or related market.
- [CME market-maker program filing](https://www.cmegroup.com/market-regulation/files/15-537.pdf) ties incentives to measured two-sided spread, size and time obligations and permits status revocation when eligibility or performance fails.
- [ESMA MiCA Article 76](https://www.esma.europa.eu/publications-and-data/interactive-single-rulebook/mica/article-76-operation-trading-platform-crypto) requires objective access, fair and orderly trading, resilient capacity, transparent fees, public trade data, liquidity conditions and suspension procedures. Applicability remains a legal decision.
- [Coinbase International Exchange liquidity program](https://help.coinbase.com/en/international-exchange/trading-deposits-withdrawals/international-exchange-liquidity-program) demonstrates effective-dated schedules, explicit eligibility inputs, periodic tier evaluation, rate-limit entitlements and fill-level rebate visibility; the magnitudes are not copied.
- [CME EBS messaging-efficiency program](https://www.cmegroup.com/notices/ebs/2022/01/20220113.html) treats minimum quote life, top-of-book fill quality and excessive quoting as market-quality controls rather than rewarding message volume alone.
- [CFTC Regulation AT proposal](https://www.cftc.gov/PressRoom/PressReleases/ssLINK/2015-30533a) identifies the integrity risk of incentive payments for common-ownership self-trades and of volume that does not represent bona-fide risk transfer. It is used as an abuse pattern, not as a claim that the proposal is controlling law.

The delta is constitutional: professional liquidity programs need objective admission and measurable obligations, private-intent separation, effective-dated economic law, incentive-quality attribution, and withdrawal/termination evidence. A lower headline fee alone is not a professional-liquidity contract.

## 3. Repository evidence audit

| State       | Evidence and bounded truth                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BUILT`     | `packages/execution-mm` has exact-bigint external-venue two-sided quoting, spread/inventory skew, source-aware depth/cost checks, cross-venue hedging, owner-set bands, and admin/volatility/inventory kills. It refuses internal venues, internal mids, missing depth/costs, stale uncertainty, and unset owner magnitudes. Venue adapters preserve source and cost truth.                                      |
| `PARTIAL`   | `svc-trade` calculates spot maker/taker fees and snapshotted discounts with `ledger-client` exact money, guards dust receivables, and emits fill/affiliate evidence. Fee/revenue paths are closed-mapped to named recipes or sockets. Market-quality health, latency and spread signals exist, but not the complete program, concentration, adverse-selection, crisis, or unit-economics evidence required here. |
| `SPECIFIED` | PX-S01/PX-S03/PX-S04/PX-S06/PX-S11/PX-S12/PX-S13 already bind fair access, execution provenance, data truth, risk capital, reporting, ledger finality, capacity and incidents. Accepted D26-P0-02 keeps unpublished fee shares refuse-closed; D26-P0-09 forbids new fee/revenue recipes without an owner carve-out.                                                                                              |
| `SOCKET`    | Internal/affiliate participation, legal entity/capacity, maker agreements, products, capital/inventory, obligations, commercial schedules, tier aggregation, rebates, broker/IB shares, promotions, liquidity budgets, accounting, external venues/borrow and crisis thresholds remain owner/legal/external sockets.                                                                                             |
| `OWNER-SET` | Maker tiers, obligations, internal/affiliate participation, information barriers, conflicts, fees, volume aggregation, commissions, markups, data/service pricing, capital and all live magnitudes are explicitly owner decisions. Empty authority is not zero.                                                                                                                                                  |
| `EXTERNAL`  | External makers, venues, brokers, borrowers/lenders, custodians, banks, settlement networks, data/reference providers, insurers and regulators require authenticated contracts, health, reconciliation and exit evidence.                                                                                                                                                                                        |
| `ABSENT`    | No authoritative venue-wide fee constitution, maker admission/agreement lifecycle, internal/affiliate maker approval, launch-liquidity commitment book, incentive-quality/clawback engine, beneficial-owner tier aggregation, complete market-quality warehouse, liquidity-crisis program, or complete unit-economics model was found.                                                                           |

The tracker statement that `execution.market-making` is done is truthful only for its expressly external engine half. It does not prove internal venue making, an approved house desk, capital, live makers, program economics, sustainable launch depth, or M13/M21 completion. Likewise, current integer-bps fee-discount logic openly cannot express sub-basis-point amount-level discounts; the fee constitution must define exact amount/rounding semantics before broader schedules rely on it.

## 4. Actors, trust boundaries, objects, identifiers, and clocks

Maker capacity is `EXTERNAL_PARTICIPANT`, `INTERNAL_PRINCIPAL`, or `AFFILIATE_PRINCIPAL`. Capacity names the legal entity, beneficial ownership, account, capital/inventory source, information barrier, supervision, surveillance and disclosure regime. Shared infrastructure or a `house` account label does not collapse those boundaries.

Canonical objects include `LiquidityPlan`, `LiquidityCommitment`, `LiquiditySource`, `MakerProgram`, `MakerAgreement`, `MakerEnrollment`, `MakerObligationSet`, `MakerPerformanceWindow`, `MarketQualityObservation`, `FeeConstitution`, `FeeSchedule`, `FeeRule`, `FeeTier`, `TierAssessment`, `FeePreview`, `FeeAssessment`, `IncentiveAccrual`, `RebateSettlement`, `BrokerCommission`, `MarkupDisclosure`, `Promotion`, `ClawbackCase`, `LiquidityCrisis`, and `UnitEconomicsPeriod`.

Stable IDs include legal/beneficial owner, organization, participant, maker, account/sub-account, desk/strategy/session/key, liquidity plan/source/commitment, venue/instrument/symbol, program/agreement/enrollment/obligation/version, order/execution/fill, quality observation/window, fee constitution/schedule/rule/tier/assessment/version, broker/IB/client mandate, incentive/accrual/settlement/promotion, ledger transaction/entry/recipe, report/correction/case/incident, rule/schema/model and external contract/version.

Clocks distinguish publication, effective-from/effective-to, eligibility window, observation event/receive/publish time, order enter/ack/cancel/fill, quote-presence duration, tier window close/evaluation/activation, preview creation/expiry, fill/fee assessment, accrual/settlement/correction, program start/end/suspension, crisis onset/recovery and ledger finality. Server and venue clocks carry quality/provenance; client time never grants eligibility or changes an effective schedule.

## 5. Constitutional hierarchy and invariant set

Every live market resolves one published, versioned `LiquidityPlan`; every fee-bearing action resolves one `FeeConstitution` and `FeeSchedule`; every designated maker resolves one `MakerProgram`, agreement, enrollment and obligation version. PX-S01 publication and precedence rules govern all three. Later publication never rewrites an earlier order, fill, fee, tier window or entitlement.

Binding invariants are:

1. An order/fill binds the fee-rule and tier snapshots effective at authoritative acceptance/execution, as the product rule specifies; a later rate change is a correction, not history mutation.
2. Actionable liquidity is executable for the stated participant, size, account, credit, venue, fees, latency and time. Displayed, indicative, stale, permission-blocked or exhausted external size is labeled separately.
3. No participant earns an incentive from self/wash/common-control volume, prohibited coordination, fake depth, non-bona-fide orders, disorderly messages, a surveillance hold, or activity outside its agreement.
4. A maker never receives private customer intent beyond the same rule-authorized data available to its role. Internal/affiliate capacity has no privileged queue, risk, latency, outage, fee, liquidation or market-data path unless a published lawful rule permits and discloses it.
5. All fee/rebate/commission/promotion money crosses boundaries as decimal strings, is scaled bigint in memory, and posts through an existing authorized `ledger-client` recipe. No JavaScript `number` holds money.
6. A rebate or credit is a liability only after eligibility, funding source, cap/budget, accounting and posting authority resolve. Negative fee policy is disabled while any of those are blank.
7. Fee revenue, maker capital, inventory, insurance/default resources, client assets, broker commission and promotional budgets are distinct purposed balances and claims.
8. Missing legal entity, capital, program, agreement, fee version, fee asset, rounding, entitlement, source provenance, or external health refuses the affected action without silently substituting zero or another provider.

## 6. Liquidity-plan lifecycle and launch readiness

A `LiquidityPlan` binds legal venue/entity, market and participant scope, launch/maintenance/exit stages, target jobs, approved sources, maker capacity, committed capital/inventory owner, symbols, hours, quoting obligations, observable quality categories, risk/kill controls, external dependencies, crisis modes, reporting, review and sunset. All live magnitudes are typed owner sockets.

State is:

`DRAFT → REVIEWING → APPROVED → CERTIFYING → READY → ACTIVE → MONITORING`

with `DEGRADED`, `COMMITMENT_BREACH`, `WITHDRAWAL_PENDING`, `SUSPENDED`, `REMEDIATING`, `EXITING`, `ENDED`, `REVOKED`, `EXPIRED` and `WIND_DOWN`. `READY` requires authenticated makers/sources, approved capital, executable connectivity, instrument/risk/settlement readiness, test evidence, dashboards, support and crisis exercises; a seeded bot or copied external book is insufficient.

Each `LiquidityCommitment` binds maker, capacity, proprietary account, instruments/sessions, effective interval, two-sided/one-sided rule, spread/depth/size/uptime or response-quality measure, inventory/risk limit authority, excused conditions, incentive, evidence cadence, breach cure, suspension and exit. Obligations must be objectively measurable from canonical orders/fills/data—not attested by the beneficiary alone.

Launch review tests concentration, correlated source failure, executable size at multiple price distances, participant-specific entitlements/credit, adverse selection, hedge/borrow/settlement capacity, severe-market withdrawals, liquidation interaction and planned exit. A plan cannot count the same capital, maker identity or external depth twice under aliases.

## 7. Liquidity source and actionable-depth truth

Every visible source carries `sourceId`, legal/capacity identity, venue/account, instrument mapping, data and order channel, sequence/freshness/clock quality, entitlements, fee/credit/transfer/settlement costs, available size, executable constraints, health, last verification and fallback/exit state.

Customer surfaces distinguish:

- native internal resting depth, governed by PX-S03 queue and fill rules;
- routed external executable depth, net of entitlement, credit, latency, fees, transfer/settlement and stale-state controls;
- indicative/reference depth, never combined into an executable number;
- maker commitments, which are obligations and evidence—not guaranteed fills.

Aggregated depth preserves per-venue price/size/provenance and overlap. It cannot sum mutually exclusive routes, stale snapshots, common upstream liquidity, unavailable credit or size already reserved elsewhere. PX-S14 owns route execution; this contract owns the truth of what may be counted and how source loss changes the liquidity state.

On timeout, sequence gap, unknown cancel, rejected hedge, credit exhaustion or external partial fill, advertised availability reduces or becomes unknown until authoritative recovery. The venue never fabricates a mid, assumes zero cost, substitutes internal depth, or reports an external order as native queue liquidity.

## 8. Maker program, admission, obligations, and equal access

A `MakerProgram` publishes objective eligibility, application evidence, legal/capital/technical/risk/certification gates, products, capacity classes, dates, obligations, measurement, incentives, exclusions, conflicts, surveillance, appeal, amendment, suspension, termination and records. Comparable applicants receive comparable criteria and fee treatment; individualized lawful terms remain attributable and reviewable, not concealed favoritism.

Enrollment state is:

`APPLIED → DILIGENCE → TECHNICAL_CERTIFICATION → RISK_REVIEW → AGREEMENT_PENDING → APPROVED → ACTIVE`

or `REFUSED`, `CONDITIONED`, `SUSPENDED`, `BREACH_REVIEW`, `CURE`, `TERMINATED`, `WITHDRAWN`, `EXPIRED`. Approval does not activate until the exact account/session/strategy identities and obligation version are bound. Material beneficial-owner, control, capital, strategy, connectivity or legal changes re-enter review.

Obligation evidence includes eligible time, two-sided presence, spread, actionable size/depth, quote age, fill quality, response time where applicable, outages, excused states, cancels/modifies, self-match prevention, adverse selection and source health. Measurement excludes venue-caused downtime and named extraordinary states only under the published rule; exceptions cannot be granted retroactively to manufacture compliance.

Breach state and remedy are customer/participant truthful. Incentive accrual pauses under ambiguity or surveillance hold. Suspension cancels only the governed maker scope through PX-S03 authority, preserves completed trades, reconciles pending accruals and cannot strand required customer-risk reduction.

## 9. Internal and affiliate market-making constitution

The current internal door stays `DISABLED_OWNER_LAW`; `packages/execution-mm` remains external-only. Enabling internal or affiliate capacity requires, before any quote:

- named legal entity, permitted capacity, accounts, capital/inventory funding and loss/default treatment;
- legal/conflict review, public/client disclosures where required, and PX-S01 rule publication;
- organizational, credential, network, data and operational information barriers proving no private customer intent, pending stop/auction/RFQ/liquidation/route or surveillance case is visible;
- identical public market data, queue/matching/cancel/risk/fee/throttle/outage semantics unless a published objective participant class applies;
- dedicated supervision, surveillance, common-control/self-trade controls, strategy/version attribution, independent risk/kill authority and complete beneficial-owner reporting;
- PX-S06 capital/inventory/concentration/hedge authority, PX-S12 purposed ledger accounts and reconciliation, crisis/exit testing, and proof that customer assets or fee balances are not maker capital.

Affiliate ownership and commercial relationships remain visible to governance even if client disclosure law differs. An affiliate cannot be represented as independent diversity in concentration metrics. A service credential, generic `houseMmUserId`, owner-type label, market-data multicast advantage, or colocated deployment never grants lawful capacity.

## 10. Fee constitution, versioning, preview, and assessment

`FeeConstitution` defines legal charging entity, products/services, participant/account aggregation boundaries, tax/accounting treatment, publication/change notice, correction/dispute, records and wind-down. Each effective-dated `FeeSchedule` contains typed `FeeRule`s for maker/taker, tier/VIP, broker, RFQ/block, liquidation, funding, borrow, withdrawal, custody, data/connectivity and service charges as applicable. An absent category means unavailable or explicitly zero only when the authority says which; silence is not zero.

Every rule binds basis, rate or exact amount, positive/zero/negative direction, charge/rebate party, asset, conversion/source rule, minimum/maximum if authorized, exact rounding and residual allocation, effective interval, jurisdiction/entity/product/account eligibility, tier version, promotion interaction, ledger recipe/path and correction rule. Rates may use exact integer/scaled representations; money never uses floating point.

A `FeePreview` shows gross basis, side/capacity, schedule/rule/tier/version, rate, asset, exact estimated amount and rounding, rebate/discount/markup/commission, conversion/reference provenance, included/excluded costs, expiry and why the final amount can differ. It is non-binding unless the product constitution explicitly reserves it. A fill/report shows the authoritative inputs and actual posting IDs.

`FeeAssessment` state is:

`PENDING_INPUTS → ELIGIBLE → CALCULATED → POST_PENDING → POSTED → RECONCILING → FINAL`

or `REFUSED`, `HELD`, `DISPUTED`, `CORRECTION_PENDING`, `REVERSED`, `REPLACED`. Stable assessment and ledger idempotency keys prevent duplicate charges. Re-drive retrieves prior outcomes; partial/unknown posting never reruns arithmetic against a newer schedule. Corrections reverse/adjust through named recipes and preserve original and replacement facts.

The existing spot integer-bps discount path remains a bounded implementation. Any schedule requiring finer precision uses an approved exact amount/rate contract and existing authorized recipe; it cannot truncate to the current representation or add a new recipe without the D26-P0-09 owner carve-out.

## 11. Tier, broker, affiliate, promotion, and incentive accounting

A `TierAssessment` binds participant and beneficial-owner grouping authority, eligible products/roles, observation window and timezone, gross/adjusted volume definition, maker/taker treatment, excluded self/wash/error/bust/test/liquidation/affiliate activity, balance/open-interest inputs if authorized, source snapshots, evaluation time, resulting tier/effective interval, appeal and correction. Related-account aggregation follows PX-S02 legal ownership; neither users nor brokers may opportunistically combine or split accounts.

Broker commissions and markups bind broker/client mandate, legal charging party, gross venue execution, venue fee, broker commission/markup, asset, tax, disclosure rule, calculation version, ledger entries and reconciliation. A price-inclusive markup is separately attributable even where customer display law allows a net quote. Routing incentives cannot override PX-S03/PX-S05 best-outcome and client-mandate rules.

Affiliate/IB accrual uses immutable referral/beneficial-owner identity and the authoritative fee event; no service stores a commission balance. D26-P0-02 keeps unpublished rates and chain law refuse-closed. Self-referral, cycles, common-control abuse, post-event attribution rewrites and double-pay across broker/affiliate/promotion programs are refused.

Every `Promotion` binds budget/funding source, legal entity, eligibility, products, exact benefit, start/end, capacity, exclusions/collision priority, abuse controls, accounting, disclosure and sunset. A promotion cannot promise an unfunded rebate, relabel a trading loss as yield, use client assets, or silently continue after budget/end. Expiry stops new eligibility but does not erase valid accrued liabilities.

## 12. Market-quality evidence and anti-gaming

The canonical quality view reports by instrument, time window, participant class and source: executable spread; actionable depth/size at governed price distances; realized slippage and fill rate; price/reference divergence with provenance; quote age and uptime; time at obligation; cancel/modify/message-to-trade behavior; adverse selection and markouts; maker/beneficial-owner concentration; external/borrow/hedge health; outages; toxic-flow indicators; and liquidation/auction performance.

Metrics retain numerator, denominator, exclusions, clock/data quality, rule/model version and drill-down to orders/fills. They distinguish displayed from executable size and organic from internal/affiliate/incentivized activity. Marketing, tiering and operator surfaces use the same governed definitions; no cherry-picked window, stale snapshot, test activity or duplicated source may inflate liquidity.

Incentive eligibility runs after self-match/common-control, wash, spoof/layering, quote-stuffing, excessive-cancel, fake-depth, collusion, marking and outage-quality controls. No single threshold proves intent; surveillance preserves context and due process under PX-S01. Suspected activity enters `HELD` rather than paid or confiscated. Resolution can release, deny, reverse or claw back through authorized ledger paths, with appeal and audit evidence.

Program design must not pay merely for raw messages, gross volume or nominal displayed size. It measures bona-fide executable contribution and avoids penalizing legitimate risk-driven cancellation during governed market changes. Market quality and infrastructure health are jointly reviewed so a venue fault is not misattributed to a maker.

## 13. Liquidity crisis and degraded-state contract

A `LiquidityCrisis` may be triggered by maker withdrawal/concentration breach, external venue or data loss, spread/depth discontinuity, oracle/index divergence, depeg, borrow recall/shortage, hedge/settlement failure, mass liquidation, cyber/region failure, or correlated source impairment. Thresholds and decision authority are versioned owner sockets.

State is:

`WATCH → DECLARED → CONTAINING → STABILIZING → RECOVERY_VALIDATION → RECOVERED → REVIEWED`

or `ESCALATED`, `MARKET_RESTRICTED`, `SUSPENDED`, `ORDERLY_EXIT`. PX-S13 owns incident command and status truth; PX-S01 owns market states; PX-S06 owns risk/liquidation/default. This contract supplies maker/source/fee/incentive facts and prohibits economics from overriding safety.

Playbooks include stop counting impaired liquidity; revoke affected route/maker entitlements; cancel or reduce only authorized scopes; preserve customer risk-reduction where safe; switch reference/fallback only under published law; widen/reduce/halt only with rule authority; suspend new incentive accrual where measurement is unreliable; protect reconciliation and completed-trade finality; notify participants of observable impact; obtain replacement sources without hidden capacity change; and test depth, fills, hedges, borrow, settlement, clocks and reports before recovery.

No emergency permits fabricated depth, unauthorized house capital, retroactive fee changes, confiscatory clawback, privileged affiliate treatment, or reopening before authoritative reconciliation. Maker withdrawal follows notice/emergency terms; the venue may suspend obligations under the constitution but cannot pretend the commitment remains active.

## 14. Interfaces, reports, operator controls, and evidence

REST, FIX, WebSocket, binary feeds and terminal surfaces expose the effective fee/tier/program versions appropriate to the session; preview/assessment IDs; maker/taker/capacity classification; fee/rebate/markup amounts; source and actionable-depth status; and degraded/refusal reason. PX-S04 sequencing, snapshot/replay, entitlements, schema lifecycle and certification rules apply.

Professional UI provides current and future fee schedules, personal tier inputs/status/effective date, per-fill fee drill-down, maker obligation/performance, breach/exception state, source provenance, quality/concentration dashboards, promotion budget/status, crisis truth and downloadable reconciliation. Simulation/testnet economics are unmistakable and cannot earn live incentives or appear in live volume.

Operators may propose, approve, publish, suspend and retire constitutions/programs/schedules; approve enrollments; investigate performance; hold/release incentives; declare source impairment; and initiate corrections only through PX-S02 grants, dual control where material, reason/evidence, version fencing and immutable audit. No operator directly edits a balance, fill, volume total, tier result or quality metric.

Participant statements reconcile each assessment/accrual/commission/rebate to fills, schedule/tier versions and ledger entries. Finance reports revenue, contra-revenue, rebates, commissions, promotions, taxes, bad debt, liquidity expense and correction separately by legal entity/product; customer and house flows never net away evidentiary detail.

## 15. Concurrency, replay, reconciliation, capacity, and security

Schedule/program publication uses optimistic versions and effective-time fencing. Concurrent tier, fee, promotion and fill events bind their event-time authority once; duplicate messages use stable IDs. Late corrections create replacement assessments. An unknown external source or ledger result is reconciled before retry; `last writer wins` is forbidden.

Daily and period-close reconciliation proves orders/fills to maker classifications, quality windows, tier inputs, fee assessments, incentive accruals, broker/affiliate entitlements, ledger postings, client statements and finance. Breaks pause affected payouts and claims but do not mutate fills. Required reports can reproduce the rule and data available at the original decision time.

Capacity evidence covers peak order/quote/cancel/market-data loads, maker-wide mass actions, fee calculation on burst fills, tier-window close, quality aggregation, affiliate graphs, crisis-mode source withdrawal, ledger backpressure and report generation. Owner-set SLO categories cover freshness, decision latency, publication propagation, calculation/posting/reconciliation, dashboard lag, recovery and support; blank targets remain visibly unset.

Credentials, maker identities, agreements, strategies and external connections are least-privilege and rotatable. Private intent, client identity, fee agreements and commercial terms are purpose-limited and encrypted; reports enforce field/row entitlements. Surveillance and regulatory evidence retain complete identity despite customer anonymity. Vendor data/fee licenses, privacy/retention and deletion holds follow PX-S01/PX-S02/PX-S04.

## 16. Unit economics, external dependencies, migration, and wind-down

Each `UnitEconomicsPeriod` reconciles, by entity/product, fee and data/service revenue against maker rebates/incentives, external execution/hedge/transfer/borrow costs, custody/settlement, insurance/default resources and losses, support, compliance/surveillance, connectivity/data licensing, infrastructure, capital/liquidity cost, promotions, tax and corrections. Values are exact ledger/report facts or named external/accounting inputs with provenance. Missing inputs make the view incomplete; they are not zero-filled.

Unit economics are decision evidence, not authority to debit customers, raid purposed balances, weaken risk, hide subsidies, or claim profitability. Forecasts and scenarios are labeled separately from realized amounts. Product continuation, repricing or exit follows PX-S01 governance and does not retroactively alter customer obligations.

External contracts bind identity, service/capital scope, fees, SLAs, data rights, operational contacts, incident notice, reconciliation, audit, subcontractors, termination and portable evidence. Loss of a maker, venue, bank, custodian, borrow source, reference feed or commercial entitlement triggers its plan state and tested replacement/exit; no adapter fallback changes legal capacity silently.

Rollout uses shadow quality calculations, simulation/testnet, maker certification, schedule preview, participant notice, canaries by market/program, reconciliation and rollback. Migration maps legacy rates/tier inputs and preserves original fills/fees. Rollback stops new decisions under the new version but never rewrites posted history. Wind-down closes enrollment and new accrual, publishes schedule/program end, resolves orders/trades, finalizes or disputes entitlements, posts/reconciles obligations, exports records, revokes access, terminates external contracts and retains evidence.

## 17. Testable Definition of Done

Implementation is complete only when evidence proves:

1. each live market has an approved, effective, fully socket-resolved liquidity plan and each maker has authenticated capacity, agreement, account/strategy binding and measurable obligations;
2. native, routed-external, indicative, stale and unavailable liquidity remain distinguishable through normal, gap, reconnect, partial-fill and source-loss paths;
3. internal/affiliate capacity is either demonstrably disabled or passes legal/capital/information-barrier/fairness/surveillance/disclosure/reconciliation controls;
4. every fee category has an effective-dated exact rule, preview, assessment, posting, report, reversal/correction, dispute and replay proof using authorized `ledger-client` paths;
5. property/golden tests cover rounding, dust, positive/zero/negative rates if enabled, schedule boundary races, tier aggregation/exclusions, duplicate and late events, partial/unknown ledger outcomes and total reconciliation;
6. maker quality, concentration, adverse selection, messaging and outage metrics reproduce from canonical data, and obligation/incentive decisions drill down to source events;
7. wash/common-control, spoof/fake-depth, excessive-cancel, self-referral, promotion collision and affiliate/private-intent adversarial tests hold or deny benefits without false liquidity claims;
8. severe-market exercises cover maker withdrawal, venue/data loss, depeg/oracle split, borrow shortage, hedge/settlement failure and liquidation burst, including customer/status/report truth and controlled recovery;
9. load/fault tests cover peak quote/cancel/fill, tier close, mass maker actions, ledger backpressure, source degradation and finance/report generation against owner-published SLOs;
10. unit-economics periods reconcile complete named costs/revenues by entity/product without treating fee pots as capital or silently zero-filling external inputs;
11. rollout, rollback, suspension, termination, migration and wind-down preserve completed-trade and money finality, settle valid liabilities and export complete evidence;
12. legal, compliance, surveillance, finance, risk, operations, participant and independent-control sign-offs are linked, and all remaining owner/external sockets refuse closed.

## 18. Owner/external sockets and contradiction register

| Socket or conflict                       | Required authority / safe blank behavior                                                                                                                                                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `socket.maker-program-law`               | Owner/legal publish legal entity, products, eligibility, agreements, obligations, exceptions, suspension, appeal and disclosure. Blank: no designated-maker program or incentive.                                                           |
| `socket.internal-affiliate-making`       | Owner/legal/risk approve capacity, capital, information barriers, conflicts, surveillance and disclosures. Blank: internal/affiliate order entry remains disabled; external-only engine may remain available when independently authorized. |
| `socket.liquidity-capital-inventory`     | Owner/risk name capital source, inventory, limits, hedge/borrow/settlement and loss/default treatment. Blank: no house commitment, seeding or quoting.                                                                                      |
| `socket.fee-constitution`                | Owner/legal/finance publish categories, schedules, rates, assets, precision, rounding, tiers, aggregation, notice, disputes and correction. Blank category: unavailable/refused, not assumed zero.                                          |
| `socket.rebate-negative-fee-funding`     | Owner/finance name eligibility, funding/budget, cap, liability timing, recipe and accounting. Blank: no rebate, negative fee or credit accrual.                                                                                             |
| `socket.broker-affiliate-economics`      | Owner/legal publish mandates, attribution, rates, tree/beneficial-owner rules, disclosures and collisions. Blank: accrual/payout refuses under D26-P0-02.                                                                                   |
| `socket.promotion-law`                   | Owner/legal/finance publish budget, source, benefit, eligibility, collision, abuse, accounting and end. Blank: promotion unavailable.                                                                                                       |
| `socket.market-quality-crisis-policy`    | Owner/risk/market oversight publish metrics, thresholds, excused states, declaration/recovery and maker withdrawal rules. Blank: no claim of obligation attainment; unsafe affected market/source refuses or escalates under predecessors.  |
| `socket.external-liquidity-dependencies` | Authenticated makers/venues/data/borrow/hedge/custody/settlement contracts and health/exit proof. Blank or stale: source excluded from actionable depth and dependent route/plan refuses.                                                   |
| Existing external-only MM ruling         | No contradiction: it is authoritative current safe behavior. This north-star contract specifies prerequisites for any later internal/affiliate program without asserting it is approved or implemented.                                     |
| Tracker `execution.market-making` done   | No contradiction after bounded reading: delivery proves the external engine half only. SoT and this contract retain M13/M21 implementation gaps and owner decisions.                                                                        |
| Fee recipe closure vs broader fee law    | D26-P0-09 remains authoritative: this contract cannot authorize a new recipe. A missing money path is a socket/owner carve-out; it is not implemented inline.                                                                               |
| Integer-bps spot discount vs precision   | Current behavior is valid for its bounded schedule and exposes its rounding limit. A future finer schedule must use approved exact semantics; the constitution never pretends current integer bps can represent every commercial rate.      |

## 19. Requirement-level proof map

| Requirement   | Authoritative clauses  | Implementation truth after this specification                                                                                                       |
| ------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PTX-M13-R01` | §§5–6, 9, 13, 16–18    | External engine/seeding foundations are partial; makers, capital, obligations, live magnitudes and sustainable launch evidence remain socketed.     |
| `PTX-M13-R02` | §§4–7, 12–15, 18       | Source-aware external book/adapter foundations are built; aggregated actionable-depth and end-to-end customer evidence remain incomplete.           |
| `PTX-M13-R03` | §§5, 8, 10–12, 14–18   | Maker-program economics and participation remain owner-set; objective lifecycle, monitoring, clawback, suspension and equal-access semantics close. |
| `PTX-M13-R04` | §§4–5, 8–9, 12, 14–18  | Internal/affiliate making remains disabled by owner law; this contract closes prerequisites without granting capacity or claiming implementation.   |
| `PTX-M13-R05` | §§6–7, 12–15, 17       | Some health/latency/spread evidence exists; governed full quality, concentration, adverse-selection and toxic-flow proof remains incomplete.        |
| `PTX-M13-R06` | §§5, 8, 11–12, 14–17   | Incentive-abuse semantics are authoritative; complete detection, holds, adjudication and ledger proof remain absent.                                |
| `PTX-M13-R07` | §§6, 12–18             | Liquidity-crisis semantics are authoritative; owner thresholds, live counterparties and exercised operational proof remain absent.                  |
| `PTX-M21-R01` | §§4–5, 10–11, 14–18    | Fee/recipe foundations are partial; venue-wide schedules and commercial magnitudes remain owner-set or absent.                                      |
| `PTX-M21-R02` | §§4–5, 10, 14–17       | Bounded spot fill fees exist; authoritative venue-wide preview, attribution, correction and customer-report proof remains incomplete.               |
| `PTX-M21-R03` | §§4–5, 10–12, 14–17    | Discount snapshots exist; complete beneficial-owner aggregation, windows, exclusions, activation and appeal remain unimplemented.                   |
| `PTX-M21-R04` | §§5, 8–9, 11–13, 17–18 | Economics remain owner-set; measurable-quality, common-control, disorderly-cancel and hold/clawback semantics are authoritative.                    |
| `PTX-M21-R05` | §§4–5, 10–11, 14–18    | Affiliate fee-event/payout foundations exist with rates closed; full broker/markup disclosure and reconciliation remain owner/legal/incomplete.     |
| `PTX-M21-R06` | §§5, 10–12, 14–18      | Promotion/accounting primitives are partial; authoritative budget, truth, collision, abuse and sunset semantics close without inventing a program.  |
| `PTX-M21-R07` | §§5, 10–11, 14, 16–18  | Complete venue unit-economics implementation is absent; this contract defines the authoritative input, provenance and completeness boundary.        |

Every primary ID assigned to `PX-S10` appears exactly once in this map. This contract specifies product semantics; it does not promote implementation maturity or publish commercial policy.

## 20. Implementation gaps and precedence

Specification completeness is not product completion. The material gaps are an approved liquidity plan; contracted live makers; internal/affiliate legal capacity if ever offered; committed capital/inventory; venue-wide fee/tier law; exact finer-than-integer-bps rate support where needed; maker agreements and performance warehouse; quality/concentration/adverse-selection evidence; incentive holds/clawbacks; broker/affiliate/promotion policy; crisis exercises; and complete unit-economics close.

Precedence is: doctrine and canonical SoT; accepted owner directions/ADRs; PX-S01/PX-S02 authority and fairness; PX-S03 order/fill truth; PX-S06 risk/capital; PX-S12 ledger/finality; PX-S13 incident/recovery; then this product-specific constitution. A commercial schedule cannot weaken authority, execution, risk, money, surveillance, resilience or wind-down law. Where a future rule conflicts, the affected program/fee/source refuses until the authoritative artifacts are amended together.
