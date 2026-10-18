# INTAFACED Linear Products, Position Modes, Convert, and FX Specification

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Status:** Authoritative product contract; implementation incomplete

**Authority:** `PX-S07`; bounded child of [`PRO_TRADER_EXCHANGE_DEFINITIVE_SCOPE.md`](../PRO_TRADER_EXCHANGE_DEFINITIVE_SCOPE.md)

**Primary requirements:** `PTX-M10-R01–R07`, `PTX-M27-R01–R08`

**Predecessors:** `PX-S01` rule/instrument lifecycle, `PX-S02` account authority, `PX-S03` matching/orders, `PX-S04` connectivity/data, `PX-S05` terminal/OMS/TCA, `PX-S06` collateral/risk/liquidation/default, `PX-S11` portfolio/reporting, `PX-S12` custody/settlement/wind-down, `PX-S13` resilience

**Systems of record:** PX-S01 instrument/rule packages, PX-S03 order/execution SoRs, PX-S06 position/risk SoRs, and PX-S12 ledger/custody/settlement SoRs remain authoritative; `packages/ledger-client` plus `svc-ledger` remain the only money book; this contract owns coherent linear-product economics, position-mode semantics, Convert quote/acceptance, FX product separation, and their lifecycle/disruption contracts

---

## 1. Product promise, professional jobs, and boundary

Spot, basis, directional, hedging, treasury, arbitrage, market-making, execution and finance users can trade custody-backed spot, margin-eligible spot, perpetuals, dated futures, Convert and authorized FX products without translating inconsistent quantities, settlement, position sides, funding, expiry, PnL or risk across surfaces. They can roll or spread exposures, know exactly which counterparty and rail they face, and exit safely through migration or disruption.

This determines primary-venue adoption because the linear complex is the venue's core risk-transfer and collateral engine. Professionals will not center activity where a “futures” symbol is only parser syntax, hedge mode changes close the wrong side, funding cannot be reproduced, Convert hides a house spread, or fiat exposure is presented as settled crypto.

Catastrophic or dishonest outcomes include spot settlement posting twice; inverse contract amounts being treated as linear; a calendar spread exceeding leg risk; final settlement using an invented fixing; contract migration stranding orders/collateral; net and hedge modes interpreting `buy/sell/reduce-only` differently across API/UI; an expired Convert quote executing at a new price under the old ID; one FX currency paying while the other fails; or a stablecoin conversion being marketed as spot FX.

M10 and M27 remain grouped. Spot/perpetual/future/Convert/FX share instruments, exact money, collateral, orders, valuations, settlement and reporting, but must remain visibly distinct products. Splitting them would permit shared-engine implementation to erase economic and legal differences.

Non-goals:

- no live product, jurisdiction, legal entity, counterparty, settlement asset/rail, leverage, limit, fee, spread, markup, funding bound, expiry series, fixing, holiday calendar, cutoff, credit, liquidity or capital policy is invented;
- no second matching engine, SOR, position book, risk engine, custody system or money book is created;
- this contract does not enable production FX while `socket.forex-settlement` is open, nor infer true fiat from a same-named stablecoin;
- parser support, a paper listing, tracker completion, shared UI or a common matching engine is not product completeness.

## 2. Research delta and durable patterns

Current official sources materially add these durable requirements:

- [OKX API position-mode guidance](https://www.okx.com/docs-v5/trick_en/) makes account/sub-account mode explicit, returns it through configuration, distinguishes net from simultaneous long/short positions, and permits switching only with no positions or pending orders. INTAFACED adopts the safety invariant, not OKX's account taxonomy.
- [OKX API position fields](https://www.okx.com/docs-v5/en/) reinforces explicit instrument/margin/position side, contract quantity, linear versus inverse entry-price denomination, settlement currency and side-specific leverage. A generic signed size is insufficient across modes.
- [CME daily/final settlement](https://www.cmegroup.com/market-data/daily-settlements.html) and [mark-to-market guidance](https://www.cmegroup.com/education/courses/introduction-to-futures/mark-to-market) reinforce official settlement prices as governed facts driving daily PnL/margin and distinct final-settlement evidence.
- [CME FX futures calendar-spread guidance](https://www.cmegroup.com/articles/faqs/frequently-asked-questions-cme-fx-futures-calendar-spreads.html) reinforces a calendar spread as simultaneous linked execution across maturities, not two unrelated orders merely shown together.
- [OKX Convert quote API](https://tr.okx.com/docs-v5/en/) reinforces quote ID, client request ID, source/terms currencies, exact request and result amounts, quote time and validity before a separate acceptance call.
- The [2026 BIS FX settlement-risk survey](https://www.bis.org/publ/qtrpdf/r_qt2606c.htm) distinguishes payment-versus-payment from methods that only mitigate risk and from gross bilateral settlement. A matched trade is not two-sided payment finality.
- The [FX Global Code](https://www.globalfxc.org/fx-global-code/) reinforces explicit governance, execution, information-sharing, risk, confirmation and settlement practice. It supplies patterns, not legal applicability or a claim of adherence.

These inputs sharpen durable state, risk and evidence requirements; they do not authorize contracts, settlement networks, calendars, prices, or policy magnitudes.

## 3. Repository evidence audit

| State       | Evidence and bounded truth                                                                                                                                                                                                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `BUILT`     | Spot order/hold/match/fill/fee/ledger foundations and isolated perpetual position, mark, margin, partial-liquidation, insurance, ADL and funding foundations exist with substantive tests. Funding uses frozen period membership, exact amounts, stable economic idempotency and balanced ledger recipes.                                        |
| `PARTIAL`   | `trade.convert` walks visible depth with exact bigint math, applies an integer-bps house spread, exposes decimal-string amounts/expiry and executes through the spot path. Symbol parsing understands inverse perpetual and dated-future notation. Execution/venue adapters expose funding/borrow/market reads. These are narrower than M10/M27. |
| `SPECIFIED` | PX-S01/PX-S03/PX-S06/PX-S11/PX-S12 bind instruments, order/fill, risk, reporting, ledger/custody/settlement, correction and wind-down semantics.                                                                                                                                                                                                 |
| `SOCKET`    | Linear/inverse product set, expiry/listing cadence, multiplier/settlement/fixing, position-mode eligibility/migration, Convert capacity/spread/counterparty, FX products/currencies/rails/calendars/credit and disruption authority require owner/legal decisions.                                                                               |
| `EXTERNAL`  | Index/fixing/rate/FX/reference data, bank/payment systems, custodians, settlement networks, liquidity venues, holidays/capital controls and counterparties require provider evidence.                                                                                                                                                            |
| `ABSENT`    | No dated-futures lifecycle/expiry/settlement/roll product, native calendar/basis spread execution, contract migration/emergency-settlement system, hedge-mode position authority, reporting-currency translation engine, cross-asset comparable-outcome router, or live FX settlement path was found.                                            |

The `trade.futures` tracker row is product-complete only for its bounded isolated perpetual slice. Its mount names no residual inside that tracker contract, but M10 additionally requires inverse economics, dated futures, spreads, migrations and position modes. The symbol parser tests establish identifier syntax only.

The `trade.forex` tracker row and `socket.forex-settlement` agree: modelling and non-active/paper listings may exist, while production active listing and order/Convert placement refuse until owner-published settlement-asset law and real fiat rails exist. That is the correct current behavior, not a gap to bypass.

## 4. Canonical product constitutions, objects, identifiers, and clocks

Every enabled product has an immutable `ProductConstitutionVersion` linked to PX-S01 and containing legal service entity/capacity, eligible users/jurisdictions/accounts, asset/instrument IDs, product kind, contract formula/multiplier, quote/base/settlement/collateral currencies, precision/ticks/minimums, trading/settlement calendars, order/risk/fee/funding/fixing rules, counterparty/custody/credit model, finality, corrections, disruptions, migration and wind-down.

Canonical objects include `SpotMarket`, `MarginEligibility`, `PerpetualContract`, `FutureSeries`, `SettlementProcedure`, `FundingPeriod`, `PositionModeVersion`, `SpreadInstrument`, `RollInstruction`, `ContractMigration`, `EmergencySettlement`, `ConvertPair`, `ConvertQuote`, `ConvertTrade`, `FxInstrument`, `FxTrade`, `FxSettlementInstruction`, `FxPaymentLeg`, `ReportingCurrencyValuation`, and `DisruptionCase`.

Stable IDs include legal owner/account/sub-account, product/constitution/instrument/series/underlying, order/client-order/parent/leg/execution/fill/position, funding period/leg, settlement/fixing/price/index, spread/roll, migration/case/correction, Convert request/quote/trade, FX trade/value-date/payment/rail/counterparty, ledger transaction/entry, custody/transfer/reconciliation, rule/model/schema and incident.

Timestamps distinguish trade/order, mark/index observation, funding observation/cutoff/accrual/settlement, last trading, expiry, fixing window/value/publication/correction, final settlement, migration notice/effective, Convert request/quote/expiry/acceptance/execution/settlement, FX trade/value/settlement/cutoff and payment-leg finality. Source timezone/calendar and clock quality are explicit.

## 5. Common linear-product invariants

- Instrument kind and economics are server-resolved from the effective constitution, never inferred solely from symbol text.
- An accepted order is valid only when PX-S02 authority, PX-S01 market/rule state, exact quantity/price, PX-S06 risk/hold and the PX-S03 sequence are bound at PX-S03's defined linearization point. This is the PX-S03 durable saga with explicit pending/unknown states, not a transaction spanning services. A UI or adapter cannot reinterpret side, multiplier or settlement.
- Linear and inverse formulas declare the quantity unit, contract value, price denomination, PnL/margin/funding currency and rounding at every step. Shared schemas preserve these distinctions.
- Every money hold/post/settlement/reversal/correction uses an existing or approved balanced `ledger-client` recipe with one economic idempotency root. Decimal strings cross boundaries; exact scaled integers are used in memory; money never enters `number`.
- Position, order, risk, ledger, funding, settlement and reporting totals reconcile at common watermarks. Unknown, stale, disputed, unsettled or unpriced is not zero.
- Product state changes preserve cancel, reduce, repay, collateral addition, settlement, asset return, evidence and dispute paths where authoritative; risk-increasing paths stop at the smallest affected scope.

## 6. Custody-backed spot and margin eligibility

Spot product state is `PENDING → PREOPEN → ACTIVE → HALTED → CLOSE_ONLY → SETTLEMENT_ONLY → DELISTED`, with PX-S01 auctions/suspensions and correction states. Each accepted fill binds exact base/quote amounts, fee asset/rate/version, legal owner, custody locations, ledger holds, execution and settlement idempotency.

Settlement defines when base and quote ledger claims become final, when an external venue/custody leg is only receivable/payable, and how failed or corrected fills reconcile. Internal matching does not create external assets. Fees cannot consume more than the authorized asset/hold; an unavailable fee asset/rule refuses or follows an explicitly approved fallback.

Margin eligibility is a versioned overlay, not an intrinsic property of spot. It states eligible borrowers/accounts/jurisdictions, borrowable asset/source, collateral and risk mode, interest, recall/default, trading/withdrawal power, short-sale/locate semantics where applicable, fee/settlement and wind-down. PX-S06 owns magnitudes and risk; PX-S12 owns custody/settlement. A spot symbol remains cash-only when the overlay is absent.

Precision, tick/step, minimum quantity/notional and rounding apply consistently at preview, acceptance, match, fee, settlement, statement and correction. A rule update cannot invalidate an already accepted economic fact; it governs later commands under PX-S01 effective-time law.

## 7. Perpetual contract constitution

Each perpetual declares `LINEAR` or `INVERSE`; underlying/index/mark; contract unit and multiplier; quote, settlement, collateral and PnL currencies; price/quantity conventions; margin eligibility/mode; funding formula/cap/floor sockets; fee; position limits; liquidation/insurance/ADL; trading state; and disruption/wind-down.

Linear example formulas and inverse formulas are supplied only by the approved constitution and independently verified with dimensional tests. No generic conversion based on symbol suffix is allowed. API/FIX/WebSocket/terminal/reporting expose contract value and units so a client never guesses whether `size` means contracts, base or quote.

Position lifecycle is `OPENING → OPEN → REDUCING → CLOSED`, with `LIQUIDATING`, `ADL_PENDING`, `SETTLEMENT_PENDING`, `MIGRATION_PENDING`, `CORRECTION_REQUIRED` and `UNKNOWN`. Margin/risk/PnL states follow PX-S06; orders/fills follow PX-S03. Re-leverage cannot make an accepted closing order risk-increasing silently.

## 8. Dated futures series, expiry, and final settlement

A `FutureSeries` adds listing, first/last trade, expiry, daily settlement, delivery/final-settlement, fixing and archive schedules; tenor/series code; roll relationship; final settlement type; price limits; disruption fallbacks; and notice/version history. Series creation follows M02 admission and cannot be activated from parseable syntax alone.

Series state is:

`PROPOSED → ADMITTED → PREOPEN → ACTIVE → CLOSE_ONLY → LAST_TRADING_ENDED → FIXING → SETTLEMENT_PENDING → SETTLED → ARCHIVED`

Exceptional states are `HALTED`, `FIXING_DELAYED`, `DISPUTED`, `EMERGENCY_SETTLEMENT_PENDING`, `CORRECTION_REQUIRED` and `WIND_DOWN`. Allowed order/cancel/position actions are explicit per state. Expiry jobs are idempotent, fenced to one writer, replayable and reconcile every open order, position, margin hold, settlement posting and statement.

Daily settlement is distinct from final settlement and trade execution. Each settlement/fixing observation records governed source set, window, calculation, exclusions, clock, publication, approval, version and correction. Missing/invalid sources enter the constitution's approved fallback or halt/delay; no last trade, mark or external price is silently substituted.

Cash or physical delivery is not enabled without explicit asset/custody/rail/finality and legal authority. Final settlement produces exact position PnL and balanced postings through ledger authority, releases only proven residual collateral, and preserves original/corrected settlement evidence.

## 9. Basis, calendar spreads, and roll workflows

A spread is a versioned multi-leg instrument or linked parent order with leg instruments/series, signed ratios, quantity unit, price convention, tick, eligible accounts, margin/risk treatment, execution policy, residual/repair policy, fees and attribution. It is not two independent tickets grouped visually.

Pre-trade preview calculates leg prices/quantities, basis/carry, funding/borrow, fees, margin/capital, liquidity, hedge/legging risk, calendars/value dates and worst permitted residual. PX-S03 owns native atomic versus governed synthetic execution. Partial/unknown leg outcomes stop additional exposure and enter explicit hedge/repair; no auto-hedge exceeds the parent mandate.

Roll instructions link expiring and successor series, target position, timing, price/basis constraint, residual, close/open side under the active position mode, tax/accounting caveats and approvals. Roll is not automatic unless owner-authorized and client-consented. It cannot extend an expired contract or manufacture liquidity.

Attribution separates each leg, spread/basis result, funding/carry, fees, slippage, hedge/repair and residual exposure, and links to PX-S05 TCA. Cross-series positions and margin offsets remain PX-S06 policy sockets.

## 10. Funding lifecycle and reconciliation

Funding state is:

`SCHEDULED → OBSERVING → RATE_PROPOSED → RATE_FINAL → MEMBERSHIP_FROZEN → POSTING → POSITION_APPLYING → RECONCILING → SETTLED`, with `NO_TRANSFER`, `REFUSED_UNPUBLISHED_BOUND`, `PARTIAL`, `CORRECTION_REQUIRED` and `FAILED`.

The rate record identifies product/period, source inputs, observation and cap/floor rules, calculation/version, sign convention, publication and next funding time. Prediction is explicitly non-final. Missing owner-published bounds/source makes a non-zero charge refuse; it does not imply zero funding.

Membership, side, size, notional and margin currency freeze at the constitution's boundary. Existing code's frozen membership and `(period,payer,payee)` ledger keys are binding foundations: replay cannot renumber economic work or double post. Position application and ledger postings reconcile before `SETTLED`; either half without the other is a break.

Corrections never edit the original rate or ledger entries. An authorized corrected rate creates compensating funding recipes, position/PnL/report corrections, notifications and reconciliation. UI/API/private stream/statements expose predicted/final/corrected rate, period, exact amount, asset, payer/receiver, status and source version consistently.

## 11. Contract migration and emergency settlement

A `ContractMigration` is required for rename, multiplier/currency/index/risk change, series replacement, engine/schema transition or counterparty/custody move that cannot occur as an ordinary prospective rule version. It inventories open orders/strategies, positions, collateral/holds, funding, liquidations, insurance/ADL, reports, client integrations and external obligations.

State is `PROPOSED → IMPACT_ASSESSED → NOTICE → CLIENT_READY → QUIESCING → SNAPSHOT → MIGRATING → RECONCILING → ACTIVE_NEW | ROLLED_BACK | RESIDUAL_CASES`. Economic changes generally require a new instrument and explicit client close/transfer/consent; identifiers are never repointed to different economics silently.

Quiesce stops new risk, preserves governed cancellation/reduction, resolves in-flight/unknown orders, freezes a causal watermark and proves exact old/new quantities, cost, PnL, collateral and ledger claims. Rollback cannot undo accepted trades or postings; it stops new migration work and reconciles facts already moved.

Emergency settlement uses PX-S01 emergency authority and an existing constitution fallback. It requires trigger/scope, evidence, independent approval, published method/source/time, open-order treatment, exact position/PnL/collateral postings, appeals/corrections and client notices. If no authorized fallback exists, the product remains halted/close-or-settlement pending; operators cannot invent a price or asset.

## 12. Position-mode constitution and migration

Each account/sub-account has an effective `PositionModeVersion`: `NET` or `LONG_SHORT`. Product eligibility is explicit. API, FIX, WebSocket, terminal, reports and risk always return the mode and `positionSide`; omission is accepted only where the active schema unambiguously defines it.

In `NET`, buys and sells increase, reduce, close or reverse one signed position according to current exposure and reduce-only rules. In `LONG_SHORT`, `side` and `positionSide` are separate: orders explicitly open/reduce/close the long or short book; an omitted/ambiguous side refuses. Both books remain under the same account risk/ledger authority and are not separate money books.

Reduce-only and close never increase the targeted side after racing fills. Close-all enumerates side, instrument and account. Liquidation, ADL, funding, margin, PnL, fees, reporting, TCA, copy/quant/agent actions and manual/bulk orders preserve the same mode semantics. Self-match and market-integrity rules still apply between opposing orders on one owner.

Mode state is `CURRENT → CHANGE_REQUESTED → PRECHECK → READY → APPLIED → VERIFIED`, or `REFUSED`, `EXPIRED`, `ROLLBACK_REQUIRED`. Baseline safe migration requires no open orders/strategies/RFQs, no non-zero positions, no pending funding/liquidation/settlement/corrections and reconciled risk/ledger state. Any alternative position conversion requires separately approved product law and explicit client preview/consent; absent law refuses.

Mode changes are authenticated, idempotent, version-checked and audited. Concurrent order acceptance and mode change serialize at the account/product authority. Stale clients receive the current mode and must refresh before trading.

## 13. Convert product constitution

Each `ConvertPairVersion` declares product kind, principal versus agency/routed capacity, legal counterparty, source/reference market, eligible input/output assets/accounts, custody/settlement, minimum/maximum sockets, price construction, spread/markup and fee disclosure, quote validity, liquidity/capacity, partial-fill policy, correction, suspension and wind-down.

The current book-walk plus house spread is a `PRINCIPAL_BOOK_REFERENCED` candidate only if owner/legal authority approves that capacity and spread publication. Until then it remains a bounded implementation foundation, not permission to market a principal product. A routed Convert must expose route/venue and cannot reuse house-principal language.

Quote state is `REQUESTED → PRICING → FIRM | REFUSED | EXPIRED`; acceptance is `ACCEPT_REQUESTED → VALIDATING → ACCEPTED → EXECUTING → SETTLING → SETTLED`, with `REJECTED`, `UNKNOWN`, `PARTIAL` only if the constitution permits it, and `CORRECTION_REQUIRED`.

A firm quote binds quote/request/client IDs, product/account, actor, input/output assets, exact input/output amounts, side, price and convention, source/reference observation, spread/markup, fees, expiry, settlement asset/path, counterparty/capacity and rule version. Acceptance uses one idempotency root and either executes those economics before expiry or refuses; it never reprices invisibly.

Every settlement uses a balanced ledger recipe referencing the quote/trade. The current IOC order path must prove how book partials, slippage and cancellation correspond to the firm output amount. If exact firm delivery cannot be guaranteed, the product must be labeled an estimated routed execution with explicit partial/residual semantics instead.

## 14. FX instrument and product separation

An `FxInstrumentVersion` defines base and terms currency, pair direction, pip/tick, quantity/notional convention, trade date, value/settlement date, spot/forward/swap tenor, holiday/business-day convention, cutoffs, fixing, funding/roll, counterparty/capacity, credit, custody/safeguarding, settlement rails/finality, fees/markup and disruption.

The following remain separate products and states:

- spot FX exchanging two fiat currency claims for a value date;
- a crypto-fiat order book, whose crypto and fiat custody/finality differ;
- stablecoin or crypto Convert, whose token issuer/chain/custody risk is not fiat-bank money;
- FX futures/perpetual/options exposure, whose derivative settlement does not deliver underlying spot FX automatically;
- accounting translation into a reporting currency, which is a valuation and never a trade.

Each screen/API/report names the product, legal counterparty/capacity, currencies/assets, custody, leverage/credit, value date and settlement state. A shared pair label such as `EUR/USD` or shared matching code does not make products fungible.

Production activation requires the current `socket.forex-settlement` to be resolved for the exact entity/product/currency/rail combination. Blank settlement asset or unavailable rail yields a typed disabled/refusal state; paper models remain visibly non-settling.

## 15. FX confirmation, payment, settlement, and funding/roll

After execution, an `FxTrade` records confirmation/affirmation state, counterparties/capacity, currencies and exact amounts, rate/source, trade/value dates, accounts/rails, netting/PvP method, cutoffs, fees, credit and settlement instructions. Instruction changes use authenticated dual control and immutable version history.

Settlement state is:

`TRADE_CONFIRMED → INSTRUCTIONS_VALIDATED → FUNDING_REQUIRED → READY → PAYMENT_LEGS_SUBMITTED → SETTLING → SETTLED`

Exceptional states are `UNMATCHED`, `INSTRUCTION_BREAK`, `INSUFFICIENT_FUNDS`, `CUTOFF_MISSED`, `ONE_LEG_FINAL`, `COUNTERPARTY_FAILED`, `RAIL_FAILED`, `CANCEL_PENDING`, `RETURNED`, `CORRECTION_REQUIRED` and `WIND_DOWN`.

Payment-versus-payment is claimed only when the named external mechanism proves conditional final transfer of both currencies. Bilateral gross, on-us, pre-settlement netting and timing controls remain correctly labeled with residual principal/liquidity/replacement-cost risk. A trade match, debit instruction or one final leg is not settlement completion.

Funding/roll identifies value-date change, tom/next or other approved mechanism, rate/points, calendars/cutoffs, cashflows, credit and postings. No automatic rollover exists without product/client authority. Failed settlement creates explicit receivable/payable and exposure under PX-S12; it never becomes an off-ledger service balance.

## 16. Reporting currency, PnL, and accounting

Original asset/currency quantities and ledger entries remain immutable. A `ReportingCurrencyValuation` records account/reporting currency, source pair/path, direct/inverse convention, rate, observation/fixing time, source/version, market state, triangulation, rounding, realized/unrealized classification and correction.

Portfolio and PnL distinguish trade economics from FX translation: original realized/unrealized trading PnL, funding/fees/interest, cash settlement and later translation effects. Changing reporting currency changes presentation/derived analytics only; it cannot post money, change collateral or rewrite cost basis.

Missing, stale, disrupted, negative/zero or inconsistent rates follow owner-approved methodology or remain unvalued/partial. Triangulation exposes every leg and time. PX-S11 owns accounting/report output; PX-S07 owns the FX-product and rate semantics supplied to it.

## 17. Cross-asset SOR/RFQ comparability

PX-S03/PX-S05/PX-S14 own execution routing and TCA. PX-S07 supplies a comparable-outcome envelope containing exact delivered asset/currency, quantity, executable price, spread/markup/fee, funding/borrow, collateral/capital, counterparty/credit, custody location, trade/value/settlement dates, rail/finality, FX conversion and failure/exit terms.

Routes are ranked together only when every material dimension can be normalized under approved sources and timing. Otherwise the router returns separate labeled outcomes or refuses automatic comparison. Indicative prices, different value dates, unsecured credit, delayed withdrawal, off-exchange custody and non-PvP settlement cannot be made comparable by price conversion alone.

Parent/child IDs, exclusions, quotes, route decisions, rejects, partials, hedges, fees and settlement outcomes feed PX-S05 best-ex reconstruction. A cheaper displayed price cannot erase principal, liquidity, custody or settlement risk.

## 18. Disruption, correction, suspension, and wind-down

Named scenarios include market/index/fixing outage; funding source failure; exchange halt; contract/index/multiplier error; expiry-job failure; bank holiday or surprise holiday; cutoff miss; rail/custodian/counterparty outage/default; capital control; sanctions/jurisdiction change; stablecoin depeg/redemption halt; negative/zero/redenominated currency; split payment; liquidity disappearance; and migration failure.

Each `DisruptionCase` declares detection, affected entity/accounts/products/series/currencies, authoritative state, new-risk/cancel/reduce/settlement actions, fallback authority, exposure, communications, correction, recovery, alternate route and exit. External changes never silently map to a new asset, rail, series, fixing or counterparty.

Corrections append rule/fixing/rate/trade/position/funding/settlement/report records and balanced compensating postings. No historical order, fill, funding leg or payment finality is edited. Disputed outcomes remain case-bound with client-visible evidence and appeal under PX-S01.

Wind-down stops new risk/quotes, expires or cancels open intent, closes/transfers/settles positions under authorized methods, completes or returns payment legs, repays borrow, releases proven collateral, reconciles ledger/external claims, delivers reports and preserves disputes/records. No forced conversion, fallback price or residual forfeiture exists without owner/legal authority.

## 19. UI, API, FIX, WebSocket, events, operators, and reports

All surfaces expose constitution/instrument/series version, product kind, linear/inverse, amount units, settlement/collateral currencies, position/margin mode, state, clocks, precision, capability, source/freshness and refusal/degradation. UI and SDK labels never infer a live product from a parseable symbol.

Orders and positions include `positionSide` when required; ambiguous commands refuse. Private streams sequence orders, fills, positions, margin, funding, settlement, mode and corrections. FIX dictionaries and REST/WebSocket schemas follow PX-S04 version/recovery law. Reconnect restores authoritative mode/position/settlement before enabling intent.

Events cover product/series state, settlement/fixing/funding versions, mode change, migration, Convert quote/trade/expiry, FX confirmation/payment/finality, correction and disruption with causal IDs and no numeric money. Drop copy and reports distinguish match, internal ledger settlement and external finality.

Operator surfaces use PX-S02 authority and dual control for activation, fixing/final settlement, emergency settlement, migration, position-mode exceptions, Convert/FX policy, instruction changes and corrections. Operators never type balances, invent rates/assets or mark a payment final without SoR evidence.

## 20. Idempotency, concurrency, replay, partial success, and recovery

Every command carries actor/account/product version, client/request/idempotency ID and optimistic state version. Order/funding/settlement/Convert/mode/migration concurrency serializes at the domain authority. Retries reuse the original economic root; an expired quote or changed mode cannot be replayed as new intent.

Batch/spread/roll/migration/settlement commands return per-target/leg state. `UNKNOWN` remains distinct from rejection and success. Recovery queries authoritative order, position, ledger and external payment/finality SoRs before retrying. A transport timeout never creates a second payment or trade.

Journals/replay retain effective constitutions, mode, marks/fixings/rates, frozen memberships, commands, executions, postings and corrections. Recovery reproduces exact economics or raises a break; it does not reprice historical work from current market state.

## 21. Market integrity, security, privacy, retention, and conflicts

Surveillance correlates accounts/beneficial owners, spot/derivative/Convert/FX orders, funding/fixing windows, calendar spreads, rolls, liquidations, affiliate/house activity, cancellations and settlement failures. Controls address manipulation of marks/fixings, wash/self trading, abusive roll/spread activity, front-running of Convert/FX flow, stale-quote exploitation and preferential disruption treatment.

Principal/agency capacity, house spread/markup, affiliate routing, last-look or rejection rights if any, use of client information and conflicts require explicit disclosure/policy. No hidden house profit is relabeled a fee-free rate. Support/operator access does not grant execution or price discretion.

Settlement instructions, bank/custody details, positions, counterparties and client strategy are least-privilege, encrypted, audited and purpose-bound. Retention/legal hold/privacy/residency are owner/legal sockets. Public feeds and reports protect counterparty/client identity while preserving required market/audit evidence.

## 22. Capacity, SLO, observability, and incident behavior

PX-S13 owns magnitudes. Capacity dimensions include instruments/series, hot symbols, open orders/positions, funding membership/legs, expiry/fixing/settlement bursts, spread/roll parents/legs, Convert quote/acceptance bursts, FX payments/value-date cutoffs, private/report fan-out, external quotas and reconciliation backlog.

Tests cover severe markets, funding/expiry/cutoff coincidence, cancel/liquidation storms, dense calendars, many position sides, quote expiry races, repeated accept, one-leg payment failure, rail/index outage, reconnect/replay and migration. Safety shedding stops new risk/quotes before cancel/reduce/settle/repay/evidence where authoritative.

Observability separates order acknowledgement, match, position/risk update, ledger settlement, external confirmation and payment finality. Metrics label product/series/mode/rail state without high-cardinality private IDs. Status never says “settled,” “funded,” “rolled” or “migrated” before reconciliation.

## 23. Migration, compatibility, rollout, rollback, and decommissioning

Implementation reuses existing spot/futures/Convert code, exchange contracts, ledger recipes, risk, settlement adapters and terminal. Add constitution/schema compatibility before product activation. Dated futures, hedge mode and FX remain dark/paper until every named owner/external socket and integrated proof closes.

Rollout scopes environment/entity/account/product/series/mode and preserves old client compatibility or refuses unsupported semantics. Shadow pricing/funding/settlement is labeled and cannot post. Rollback stops new work, reconciles accepted economic facts and retains version history; it never rewrites positions or money.

Decommissioning inventories instruments/series, orders/strategies, positions/sides, funding, collateral, settlements/payments, Convert/FX quotes, reports, credentials, disputes and external obligations. It follows §18 and PX-S12 wind-down, proving zero or explicit residual claims and continued evidence access.

## 24. Definition of Done

PX-S07 is implementation-complete only when evidence proves:

1. spot and margin-eligible spot pass exact acceptance, hold, match, fee, custody, settlement, reversal and correction conformance;
2. every linear/inverse perpetual formula and amount unit agrees across UI/API/FIX/WebSocket, risk, ledger and reports;
3. dated series pass listing-to-archive, daily/final settlement, fixing/fallback, expiry-job replay and correction tests;
4. basis/calendar spread and roll workflows pass atomic/synthetic, risk, partial-leg, hedge/repair, attribution and migration tests;
5. funding prediction/finalization, frozen membership, ledger/position application, replay, reporting and correction reconcile exactly;
6. contract migrations and emergency settlements preserve/case-bind every order, position, PnL, collateral, posting and client obligation;
7. net and long/short modes pass all order-side/reduce/close/risk/funding/liquidation/reporting semantics and refuse unsafe migrations;
8. Convert discloses approved capacity/source/spread/markup/fee, binds firm exact quotes through idempotent acceptance and balanced settlement, or labels estimated routed execution honestly;
9. each FX product binds currency law, trade/value dates, calendars/cutoffs, counterparty, credit, custody, rail and finality without conflating stablecoins/derivatives/translation;
10. FX confirmation/payment proves both legs, PvP or residual risk, failed/returned/unknown states, receivables/payables and corrections;
11. reporting-currency PnL preserves originals and reproducible rate/source/timestamp/translation effects;
12. cross-asset routing compares only genuinely comparable executable/settleable outcomes and retains exclusions/evidence;
13. every disruption, correction, suspension, recovery and wind-down scenario refuses dangerous missing policy and preserves safe exits;
14. security/privacy/surveillance/conflicts, capacity/SLO, compatibility, rollout/rollback and external-provider failure pass adversarial review;
15. all 15 requirements below pass integrated proof against the predecessor contracts.

A completed spec, parser test, paper listing, green tracker row or isolated unit suite is not a complete linear/FX venue.

### 24.1 Requirement proof map

| Requirement   | Contract closure                                                                                                   | Required implementation evidence                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `PTX-M10-R01` | §§5–6 define custody-backed spot, margin eligibility, fees/precision/minimums and deterministic settlement         | End-to-end order/hold/fill/fee/ledger/custody/finality/correction conformance                 |
| `PTX-M10-R02` | §§5 and 7 define linear/inverse multiplier/collateral/funding/mark/limit/liquidation/ADL constitution              | Dimensional formula, schema, risk, ledger, UI/API/report and severe-market evidence           |
| `PTX-M10-R03` | §8 defines expiry series, daily/final settlement/fixing, disruption and archive lifecycle                          | Series calendar, fixing/fallback, expiry replay/reconcile/correction and client-notice tests  |
| `PTX-M10-R04` | §9 defines spread/basis preview, linked execution, risk, hedge/repair, roll and attribution                        | Native/synthetic partial/unknown leg, margin, migration and TCA evidence                      |
| `PTX-M10-R05` | §10 defines predicted/final funding, frozen membership, exact postings, correction and cross-surface reporting     | Period boundary, crash/replay, ledger/position reconciliation, statement and correction proof |
| `PTX-M10-R06` | §11 defines contract migration and emergency settlement with quiesce, watermark, reconciliation and residual cases | Production-shaped rename/economic-change/failure/rollback/emergency exercises                 |
| `PTX-M10-R07` | §12 defines net/long-short side semantics, close/reduce/risk/reporting and safe mode migration                     | Cross-surface mode matrix, concurrency, liquidation/funding and open-intent migration refusal |
| `PTX-M27-R01` | §13 defines Convert capacity/source/reference/spread/markup/fee/size/expiry/settlement/refusal truth               | Owner-authorized constitution, quote presentation and no-fee-free/hidden-principal tests      |
| `PTX-M27-R02` | §13 defines firm exact quote binding, expiry, idempotent acceptance, settlement and correction                     | Concurrent/retry/expiry/partial/unknown/crash plus balanced-ledger reconciliation             |
| `PTX-M27-R03` | §§14–15 define FX currencies, pip/tick, dates, calendars/cutoffs, roll/fixing and fiat rails                       | Approved instrument/holiday/value-date/rail/finality and disruption conformance               |
| `PTX-M27-R04` | §14 separates spot FX, crypto-fiat, stablecoin Convert, derivatives and reporting translation                      | Product/counterparty/custody/leverage/settlement labeling and cross-product isolation         |
| `PTX-M27-R05` | §16 defines configurable reporting currency with original amounts/rates/sources/times/translation PnL              | Reproducible direct/inverse/triangulated/stale/corrected valuation and accounting evidence    |
| `PTX-M27-R06` | §17 defines comparable all-in SOR/RFQ outcomes and visible non-comparability                                       | Route fixtures spanning fees, credit, custody, value date, rails, finality and exclusions     |
| `PTX-M27-R07` | §18 defines holiday/rail/capital-control/settlement/rate/redenomination degraded and wind-down behavior            | External-failure, one-leg-final, cutoff, correction, alternate-route and exit exercises       |
| `PTX-M27-R08` | §§4, 14 and 23 bind adjacent products to M02 admission and every cross-cutting gate                                | Admission dossier/gate census, product isolation, staged rollout and decommissioning proof    |

## 25. Owner and external sockets

| Socket       | Required authority/input                                                                                                  | Refuse-closed behavior while absent                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `PX-S07-O01` | Enabled spot/margin/perpetual/future product set, legal entity/capacity, eligible accounts/jurisdictions and disclosures  | Product remains pending/paper/disabled; no new risk                           |
| `PX-S07-O02` | Linear/inverse multiplier, quantity/price/PnL/settlement/collateral formula, precision and minimums                       | Instrument cannot activate or accept orders                                   |
| `PX-S07-O03` | Expiry series/cadence, daily/final settlement/fixing sources/windows, calendars, fallbacks, delivery and roll policy      | Dated series stays unlisted or halted before fixing/settlement                |
| `PX-S07-O04` | Spread/roll native versus synthetic policy, legging/repair authority, offsets and residual limits                         | Linked execution refuses; independent orders remain distinct                  |
| `PX-S07-O05` | Funding source/formula/interval/cap/floor/membership/correction and publication policy                                    | Prediction unavailable; non-zero funding refuses and no charge posts          |
| `PX-S07-O06` | Contract migration/emergency-settlement triggers, authority, method, notice, consent, fallback and residual treatment     | Product halts/close-only; no instrument remap or invented settlement          |
| `PX-S07-O07` | Position-mode availability, eligibility, side rules, migration, approvals and client defaults                             | Current mode remains; hedge mode unavailable                                  |
| `PX-S07-O08` | Convert principal/agency/routed capacity, counterparty, pair eligibility, source, spread/markup/fee, size and firm policy | Convert disabled or labeled non-firm/estimated only; no hidden house capacity |
| `PX-S07-O09` | FX legal capacity/products/currencies, trade/value-date, calendars/cutoffs, credit, fees/markup, funding/roll and fixing  | Production FX listing/trading refuses                                         |
| `PX-S07-O10` | FX settlement assets/accounts/rails, safeguarding/custody, PvP/netting, finality, limits and instruction-change policy    | `socket.forex-settlement` remains open; no production settlement              |
| `PX-S07-O11` | Reporting currency, approved FX sources/path/triangulation, accounting/tax translation and correction policy              | Original currency facts only; derived translated values remain unavailable    |
| `PX-S07-X01` | Index/mark/fixing/funding/FX/reference price sources, licenses, timestamps, corrections and outage evidence               | Affected mark/rate/fixing/quote unavailable or product halted                 |
| `PX-S07-X02` | Bank/payment/PvP/settlement networks, custodians, currencies, calendars, cutoffs, finality, return and portability        | Affected FX/payment leg cannot start or remains explicitly failed/unknown     |
| `PX-S07-X03` | External venues/liquidity/counterparties, credit/custody/settlement comparability and exit evidence                       | Route excluded or shown separately; no synthetic all-in comparison            |
| `PX-S07-X04` | Currency authority/redenomination, capital-control/sanctions, holiday and legal disruption evidence                       | Affected currency/product stops new risk and remains case-bound               |

## 26. Cross-spec dependencies and contradiction register

- **PX-S01:** owns admission, market/instrument/rule/emergency states, fixing governance, disputes and corrections. PX-S07 supplies product-specific economics but cannot activate or settle outside those versions.
- **PX-S02:** owns legal owner, account/sub-account, actor, delegation, approval and revocation. Position mode, Convert and FX never create separate authority.
- **PX-S03:** owns matching/order/algo/multi-leg execution, final order/fill state and execution correction. PX-S07 defines product semantics and linked spread/roll inputs.
- **PX-S04:** owns API/FIX/WebSocket/feed sequence, recovery, entitlement and compatibility. Product fields must be consistent across those protocols.
- **PX-S05:** owns terminal/OMS/TCA and best-ex evidence. It displays/analyses the constitutions, mode, spreads, Convert and FX facts here.
- **PX-S06:** owns margin/collateral/marks/risk/liquidation/default/ADL and risk-model magnitudes. PX-S07 supplies contract formulas and settlement/funding inputs without duplicating risk.
- **PX-S11:** owns portfolio/accounting/report delivery. PX-S07 supplies original product/PnL/rate/settlement semantics and cannot become a report book.
- **PX-S12:** owns ledger/custody/external settlement reconciliation and wind-down. Every spot/Convert/FX/futures money fact and external payment remains under that authority.
- **PX-S13:** owns SLO/capacity/recovery/status/incident law. Product completion never follows from local health or unit tests.
- **PX-S14:** owns multi-venue/on-chain SOR/counterparty/capital/DEX execution. PX-S07 defines the comparable economic envelope and FX/settlement truth it consumes.

Resolved contradictions and explicit gaps:

1. `trade.futures` is delivered for the isolated perpetual slice. Its tracker/mount “no gaps” statement is bounded to that slice; it does not prove inverse economics, dated futures, spread/roll execution, contract migration or hedge mode.
2. The symbol parser accepts inverse-perpetual and dated-future notation. Parsing an ID is not admission, listing, matching, margin, expiry, settlement or reporting implementation.
3. Funding code has strong exact-money, frozen-membership, stable-idempotency and ledger-reconciliation foundations. Owner rate/source/interval bounds and integrated customer reporting remain prerequisites; no default is inferred from code examples or tracker prose.
4. The current futures position service is a net/one-way isolated model. The SoT's hedge-mode requirement remains unimplemented; this contract does not reinterpret existing `long/short` position rows as simultaneous-side authority.
5. Convert's current house-spread/book-walk/IOC path is real, but the tracker description does not settle principal capacity, disclosure, firm output/partial semantics or correction. Those remain owner/legal and implementation gaps.
6. `trade.forex` is correctly refuse-closed despite its green tracker row: public status, listing and place gates name `socket.forex-settlement`; paper/non-active models cannot be advertised as production fiat trading.
7. `TRADE_OPTIONS_SETTLEMENT_ASSET_LAW` is referenced by the current combined options/FX socket wiring. PX-S07 does not infer that one asset law is appropriate for both products; PX-S08 owns options settlement and PX-S07 owns each FX product/currency/rail constitution.
8. A same-engine fiat pair, tokenized currency or stablecoin is not automatically spot FX. Product/counterparty/custody/value-date/payment finality must be explicit.
9. Internal ledger settlement is not external FX payment finality, and a route price is not comparable until credit, custody, value date, fees and settlement risks are normalized or shown separately.
