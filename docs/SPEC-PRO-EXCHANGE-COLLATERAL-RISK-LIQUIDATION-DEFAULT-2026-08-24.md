# Spec — Pro Exchange Collateral, Risk, Liquidation, and Default (`PX-S06`)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Status:** Authoritative product contract; the isolated futures slice has implementation evidence, while cross, multi-collateral, portfolio-margin, credit, capital, and default-policy sockets remain refuse-closed

**Authority:** `PX-S06`; bounded child of [`PRO_TRADER_EXCHANGE_DEFINITIVE_SCOPE.md`](../PRO_TRADER_EXCHANGE_DEFINITIVE_SCOPE.md)

**Requirements:** `PTX-M08-R01–R09`, `PTX-M09-R01–R09`

**Hard predecessors:** [`PX-S01`](SPEC-PRO-EXCHANGE-RULEBOOK-LIFECYCLE-INTEGRITY-2026-08-23.md), [`PX-S02`](SPEC-PRO-EXCHANGE-AUTHORITY-AND-PARTICIPANT-SECURITY-2026-08-23.md), [`PX-S03`](SPEC-PRO-EXCHANGE-MICROSTRUCTURE-AND-ORDER-EXECUTION-2026-08-24.md)

**Primary systems of record:** immutable risk/rule/instrument versions; position, loan, margin-call, liquidation, and default-case records in their owning services; accepted market observations; and `ledger-client` postings for every hold, transfer, accrual, loss, recovery, and correction

This contract defines how collateral becomes buying power, how risk is measured and constrained, and how distress is resolved without inventing money or silently moving loss between legal owners. It does not activate a margin mode, collateral asset, credit line, liquidation magnitude, or loss-allocation policy.

## 1. Product promise, professional jobs, and non-goals

A professional can use the venue as a primary risk-taking venue only if they can:

- reproduce buying power, initial margin, maintenance margin, excess/deficit, and liquidation bands from versioned inputs;
- know which legal owner, account, sub-account, product, asset, and counterparty each unit of collateral supports;
- add collateral, repay, reduce, cancel, or transfer risk before forced action, with truthful deadlines and outcomes;
- distinguish valuation, warning, order-entry, withdrawal, and liquidation eligibility when data or dependencies degrade;
- see the complete causal chain from risk observation through warning, cancellation, forced execution, insurance, recovery, ADL, and correction;
- prove that platform, affiliate, market-maker, broker, and customer accounts receive the same published risk method at the same legal boundary.

The contract serves traders, market makers, brokers/DMA clients, lenders, credit and treasury operators, risk model owners, liquidation operators, surveillance, finance, support, and incident command.

Non-goals:

- no owner-set leverage, haircut, concentration, stress, buffer, grace, fee, threshold, inventory, cap, or SLO value is supplied here;
- no jurisdiction, legal entity, custodian, settlement asset, lender, bank, or recovery counterparty is selected;
- no service may keep a balance, and no second position-backed money book is created;
- aggregate portfolio visibility never creates cross-account collateral support;
- isolated futures are not silently upgraded to cross or portfolio margin;
- product-specific payoff, funding, expiry, options Greeks, custody, and route mechanics remain with `PX-S07`, `PX-S08`, `PX-S10`, `PX-S12`, and `PX-S14`.

## 2. Research delta and durable patterns

The 24 August 2026 primary-source review found no missing mountain and no reason to split M08 from M09. It sharpened these durable rules:

1. A money-moving mark needs source, observation time, construction, and a use-specific quality gate. [Hyperliquid's oracle documentation](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/oracles) distinguishes oracle and mark inputs and uses the mark for margin and liquidation; INTAFACED additionally preserves its existing independent-source, staleness, outlier, and refuse-closed gates.
2. Portfolio margin is an explicit account product, not a UI aggregation. [Hyperliquid portfolio margin](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/portfolio-margin) keeps sub-accounts distinct and demonstrates that oracle-update ordering can affect a liquidation sequence. INTAFACED therefore requires a pinned calculation snapshot and deterministic evaluation order.
3. Forced close should use ordinary market liquidity before a separately governed backstop. [Hyperliquid liquidation](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/liquidations) documents that broad pattern. It does not justify copying its thresholds, fees, or backstop design.
4. Client ownership and segregation constrain collateral reuse. [MiCA Article 70](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32023R1114) requires safeguards for client ownership and separation of client funds. Legal applicability remains an owner/legal socket, but internal account design must preserve those facts.

These sources validate professional jobs and failure modes, not implementation choices or live policy.

## 3. Existing INTAFACED authority and evidence to reuse

- Doctrine makes `ledger-client` the only value-movement authority. Decimal strings cross boundaries; scaled bigint is used in memory.
- `svc-trade/src/futures/position-service.ts` persists positions separately from margin money, requires caller idempotency, locks rows for close/adjustment, supports isolated mode only, and refuses unsupported cross mode.
- `initial-margin.ts`, `maintenance-ladder.ts`, and the futures policy gates preserve owner-set leverage and ladder values as absent rather than defaulting them into production.
- `mark-policy.ts`, mark sources, and accepted-mark storage carry price, observation time, quality, provenance, staleness, and deviation decisions. Missing price is not zero; last trade is not a liquidation basis.
- `liquidation-tick.ts` supplies stable attempt IDs, claim-before-post semantics, bounded partial-liquidation hooks, insurance sufficiency checks, and delivery-before-grace logic.
- `liquidation-planner.ts` produces exact ledger recipe inputs but holds no balance; `insurance-bound.ts` refuses a shortfall the named insurance account cannot cover.
- `adl-last-resort.ts` has no production default, requires owner policy and prior participant disclosure, emits evidence before action, and never ranks candidates itself.
- lending specs and ledger loan recipes provide bounded loan, interest, repayment, default, and correction primitives. They are not evidence of an integrated prime-credit product.
- the ledger provides atomic balanced posting, idempotency, account identity, history, freeze controls, and chain/balance/totals reconciliation.

Current evidence is narrower than this contract. The live futures path proves an isolated slice, not cross margin, portfolio offsets, multi-collateral valuation, institutional credit, legal-boundary aggregation, a complete default-management playbook, or retained model/capital stress evidence. Existing policy constants and test harnesses are not authority for live magnitudes.

## 4. Actors, legal boundaries, and trust

| Boundary                             | Authority                                                | Forbidden inference                                                            |
| ------------------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Legal owner and account/sub-account  | PX-S02 authority decision                                | Common login, organization, broker view, or beneficial-owner aggregation alone |
| Risk unit                            | Versioned mode enrollment and risk policy                | Portfolio screen grouping or shared collateral asset                           |
| Collateral ownership and encumbrance | Ledger accounts and postings                             | Position row, cache, venue balance, or projected equity                        |
| Position/loan obligation             | Owning service record linked to ledger transactions      | Ledger balance alone or market-data event                                      |
| Mark/index observation               | Accepted observation record and source policy            | Request price, last trade, client screen, or read time                         |
| Risk decision                        | Immutable calculation snapshot and model version         | Current model rerun against historical state                                   |
| Liquidation/default action           | Durable case/action state plus PX-S03 execution evidence | Warning delivery, command acknowledgement, or operator intent                  |
| Loss finality                        | Balanced ledger transaction                              | Fill, insurance estimate, ADL disclosure, or external promise                  |

Actors include legal owner, account/sub-account, authorized trader, broker/DMA principal or agent, lender, borrower, guarantor, risk engine, model owner, market-data authority, matching/execution services, liquidator, ledger, insurance-fund controller, treasury, custodian, bank, settlement network, oracle/provider, compliance, finance, and incident command. Each counterparty role is explicit; “venue” never collapses operator, legal entity, custodian, insurer, or lender.

## 5. Modes and propagation boundaries

The following are separate versioned products:

| Mode               | Permitted support                                                    | Status represented by this contract                                  |
| ------------------ | -------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `CASH`             | Settled available asset only                                         | Defined; product mechanics elsewhere                                 |
| `ISOLATED`         | Named collateral pot for one declared risk unit                      | Existing futures slice; evidence remains incomplete end to end       |
| `CROSS_ACCOUNT`    | Eligible collateral and liabilities within one legal account         | Disabled until policy, calculation, migration, and proof exist       |
| `MULTI_COLLATERAL` | Versioned set of assets valued under explicit haircuts/add-ons       | Disabled until constitution and oracle dependencies exist            |
| `PORTFOLIO_MARGIN` | Scenario-based offsets within one enrolled risk unit                 | Disabled until independently reproducible model and governance exist |
| `ORG_OFFSET`       | Consented cross-account support under an enforceable legal agreement | Disabled; never implied by aggregate visibility                      |
| `BILATERAL_CREDIT` | Named lender/borrower line and eligible uses                         | Disabled until commercial/legal terms and funding authority exist    |

Every position, order, hold, loan, collateral lot, and calculation names exactly one mode and `riskUnitId`. Missing or unsupported mode refuses risk-increasing actions. A mode never widens because a client omits a field.

### 5.1 Mode change

A `ModeChange` records request ID, old/new modes, legal owner and risk unit, expected state version, policy/model versions, inventory snapshot, preview, consent evidence, blockers, expiry, and result.

```text
DRAFT → PREVIEWED → CONSENTED → QUIESCING → MIGRATING → ACTIVE
                    ↘ REFUSED      ↘ RECOVERY_REQUIRED
                    ↘ EXPIRED      ↘ ROLLED_BACK
```

The preview enumerates collateral reclassification, buying-power change, open orders, positions, loans, withdrawals, unsettled fills, liquidation proximity, fees, and irreversible effects. Migration requires no unknown commands or settlements and fences new risk. A rollback is allowed only while the old state remains reconstructable and no new-mode risk was accepted. Otherwise recovery closes or transfers risk under an explicit plan; it never relabels balances.

## 6. Canonical objects, identifiers, precision, and clocks

The contract requires:

- `riskUnitId`, legal-owner/account/sub-account IDs, `modeEnrollmentId`, `positionId`, `orderId`, `loanId`, `collateralLotId`, `holdId`, and `ledgerTransactionId`;
- `riskPolicyVersion`, `modelVersion`, `ruleVersion`, `instrumentVersion`, `collateralConstitutionVersion`, `markPolicyVersion`, and `waterfallVersion`;
- `calculationId`, `snapshotSequence`, `inputWatermark`, `observedAt`, `calculatedAt`, `effectiveAt`, `expiresAt`, and clock source/quality;
- `marginCallId`, `liquidationCaseId`, `liquidationAttemptId`, `defaultCaseId`, `actionId`, and caller idempotency key;
- exact decimal-string quantities, prices, rates, ratios, notionals, PnL, collateral values, margins, losses, fees, and recoveries at boundaries.

Money-like values never use JavaScript `number`. Integer sequence, enum, clock, and bounded basis-point policy fields are not balances; calculations convert policy ratios into exact scaled integer arithmetic with named rounding direction. Every derived value retains source inputs and formula/model version so a statement can be independently reproduced.

## 7. Collateral constitution and valuation

A `CollateralConstitutionVersion` defines each eligible asset, accepted ownership/custody state, valuation source hierarchy, quote asset, haircut, concentration and liquidity add-ons, wrong-way rules, depeg treatment, settlement/finality requirement, withdrawal interaction, and degraded fallback. All magnitudes and asset lists are owner-approved sockets.

Rules:

1. Eligibility is product, legal entity, jurisdiction, account, and mode specific.
2. Available, held, pending, unsettled, encumbered, borrowed, disputed, and externally located assets are distinct states.
3. A venue or custodian balance is evidence to reconcile, not spendable collateral until ledger recognition and policy eligibility both succeed.
4. A missing, stale, future-dated, outlier, disputed, or insufficient-capacity valuation cannot increase buying power. The mode applies its published conservative behavior or refuses.
5. A depeg state is explicit and versioned. Stablecoin labels never imply par value.
6. Wrong-way exposure considers issuer, custodian, chain/bridge, settlement bank, borrower, and market concentration where relevant.
7. Withdrawal authorization recomputes post-withdrawal risk against a pinned snapshot and reserves the asset atomically through the ledger before external dispatch.

## 8. Calculation contract

### 8.1 Calculation snapshot

A risk calculation consumes one immutable snapshot of positions, working-order worst cases, unsettled fills, loans/liabilities, funding/interest accruals, eligible collateral, accepted marks/indices, FX conversions, concentration/liquidity inputs, and operational dependency states. Inputs carry sequences; mixed watermarks are refused or explicitly bounded and disclosed.

The output includes gross and net exposure, collateral value before/after adjustments, initial margin, maintenance margin, reserved order risk, excess/deficit, available withdrawal and buying power, stress loss, concentration, liquidity horizon, dominant drivers, refusal/degradation codes, and exact input/model references.

### 8.2 Mode-specific law

- `ISOLATED`: only the named pot supports its risk unit. No other sub-account, profit, or organization balance can be seized or counted.
- `CROSS_ACCOUNT`: offsets remain within the enrolled legal account and permitted products.
- `MULTI_COLLATERAL`: each asset is converted and adjusted under the same pinned constitution snapshot; missing a required conversion cannot improve equity.
- `PORTFOLIO_MARGIN`: scenarios, shocks, correlations/offsets, floors, minimums, concentration/liquidity charges, and anti-procyclical controls are documented and independently executable. Evaluation order is deterministic. No offset crosses a prohibited legal, custody, settlement, or model boundary.
- `ORG_OFFSET`: requires explicit agreement, authority, limits, consideration/guarantee accounting, revocation mechanics, and insolvency treatment.

No implementation may advertise a mode until conformance fixtures reproduce both ordinary and adversarial outputs independently.

### 8.3 Pre-trade/post-trade identity

The same versioned exposure and margin logic drives order preview, order acceptance, post-fill state, withdrawal power, warnings, and liquidation. Conservative pre-trade approximations are allowed only if named and never yield more buying power than the authoritative calculation. A fill that changes state between preview and acceptance is evaluated at the acceptance snapshot; stale approvals fail and rerun.

## 9. Borrowing, financing, and credit

Every loan identifies lender, borrower, legal entities, asset, principal, inventory source, committed/uncommitted status, start/maturity/recall terms, interest index and spread, accrual convention, collateral, eligible uses, utilization/caps, repayment waterfall, default events, and correction policy.

- Inventory is reserved through the ledger before credit becomes spendable.
- Interest/funding is an exact periodic accrual with observation/source/version; missing input is `UNSETTLED`, never zero.
- Auto-borrow and auto-repay require explicit scoped consent and preview. A failed repay never silently rolls into a new loan.
- Cross-currency liability reports principal asset, valuation asset, conversion source, and FX risk separately.
- Trade-finance lines distinguish buying power from withdrawal power and define settlement date, high-water or other fee basis, recall, collateral, guarantor, lender concentration, and default interaction.
- Uncommitted credit can refuse new draws; it cannot retroactively erase a funded obligation. Committed credit availability is not represented until legally and operationally fundable.

Unset lender, rate/index, cap, inventory, entity, or agreement returns a typed refusal. Existing generic lending primitives do not activate institutional credit.

## 10. Mark, index, and degradation law

Each accepted observation includes market/instrument, price, source set, source observations and weights, construction method, quality, provenance, observation time, receive time, sequence, policy version, and rejection/degradation evidence.

- No caller-supplied or display price may move money.
- Index construction defines source eligibility, independence, outage treatment, outlier method, minimum quorum, timestamp alignment, and fallback hierarchy.
- Mark construction defines basis/index/book components and prevents circular dependence on the liquidation flow it triggers.
- Valuation/warning, entry, withdrawal, and involuntary-action gates are distinct. A price acceptable for display need not authorize seizure.
- Missing is never zero. Future-dated, stale, outlier, crossed, insufficient-depth, or non-quorate observations cannot authorize liquidation.
- A degraded source cannot increase leverage, collateral value, withdrawal power, or credit. Risk-reducing orders and collateral additions remain available where their own dependencies are sound.
- Methodology and change history are public at the level needed to reproduce participant treatment without exposing exploitable secrets.

## 11. Risk state, warnings, and participant action

```text
NORMAL → WATCH → MARGIN_CALL → LIQUIDATION_ELIGIBLE → LIQUIDATING
   ↑         ↘ CURED       ↗           ↘ RECOVERY_REQUIRED
   └──────────── CURED ← PARTIALLY_LIQUIDATED
LIQUIDATING → RESOLVED / DEFAULT_SHORTFALL
```

Transitions are driven by a pinned calculation, not a screen value. `MARGIN_CALL` records reason, deficit, actions available, delivery channels/results, model/mark versions, and any owner-set deadline. A grace clock begins only after the required delivery contract succeeds. No grace magnitude is inferred.

During distress:

- cancellation, collateral addition, repayment, and unambiguously risk-reducing orders receive an operational path when new risk is halted;
- “reduce-only” is checked against current position, working siblings, pending fills, and mode boundary so concurrent orders cannot flip exposure;
- transfers expose source and destination risk after the proposed move and settle atomically or remain pending with both sides fenced;
- terminal/API show current state, data freshness, deficit, next possible action, unavailable dependencies, and whether a command is merely acknowledged or final.

## 12. Liquidation state machine and execution

```text
OPENED → SNAPSHOT_LOCKED → CONFLICTING_ORDERS_CANCELLING → EXECUTION_READY
       → PARTIAL_ORDER_WORKING → PARTIAL_SETTLEMENT_PENDING → REASSESSING
       → CLOSE_ORDER_WORKING → CLOSE_SETTLEMENT_PENDING → RESOLVED
       ↘ PAUSED_DATA / PAUSED_MARKET / RECOVERY_REQUIRED
       ↘ DEFAULT_SHORTFALL
```

One durable `liquidationCaseId` owns monotonically sequenced attempts. Before involuntary execution, the service obtains an acceptable mark, persists the decision snapshot, fences risk-increasing intent, and causally cancels conflicting orders. Cancel acknowledgement is insufficient; exposure includes fills racing the cancellation.

The versioned ladder defines warning, cancellation, partial-reduction, close, and backstop rungs. Each rung has owner-set triggers, target exposure, sizing, price/slippage protection, time/depth bounds, retry rules, venues, and escalation. Missing or incoherent policy refuses seizure and pages operators; it does not choose the harshest rung.

Every forced child uses PX-S03 semantics and records provenance, order/fill IDs, mark and execution prices, quantity, fees, PnL, slippage, actor, timestamps, and settlement transaction. After each final fill the authoritative position and ledger state are re-read before the next child. A timeout produces `OUTCOME_UNKNOWN` and reconciliation, never a duplicate close.

Partial liquidation is preferred where the configured method can restore safety without increasing expected loss. It preserves entry/PnL history and re-evaluates actual residual state. If the market is halted, data is unusable, execution capacity is unavailable, or the bound would be breached, forced execution pauses; the position is not closed at an invented mark.

## 13. Money postings, holds, and corrections

Only `ledger-client` recipes move value. The minimum semantic recipes are:

| Economic action                | Required ledger effect                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------- |
| Collateral allocate/deallocate | Atomic transfer between owner available and named risk-unit collateral/hold accounts  |
| Order exposure reserve/release | PX-S03 hold/release, bound to the risk snapshot and order                             |
| Loan draw/repay                | Principal transfer and liability evidence between named lender/borrower accounts      |
| Interest/funding               | Exact accrual/settlement between named counterparties; missing rate remains unsettled |
| Voluntary/forced fill          | Ordinary balanced trade settlement; liquidation provenance does not bypass it         |
| Realized loss/profit           | Named position collateral and contractual counterparty/profit-source accounts         |
| Insurance cover                | Insurance account debit only up to its reconciled available balance                   |
| Recovery                       | Named default estate/counterparty to entitled account with case linkage               |
| Fee                            | Named fee recipe and revenue owner; no hidden netting into price or margin            |
| Correction/reversal            | Compensating immutable posting linked to original transaction and authority           |

A service database may retain positions, obligations, calculations, and workflow state but never a spendable balance. `houseFees` or general revenue is not a default insurance or profit source. Negative treasury balances mean explicit external obligations and trigger reconciliation/escalation; they are not free liquidity.

Ledger idempotency roots derive from the immutable economic action, not attempt time. Workflow commits semantic intent before external posting, then finalizes local state after ledger acceptance. Crash recovery replays the same key, reconciles the result, and prevents a different request inheriting its sequence.

## 14. Insurance, recovery, ADL, and loss waterfall

Each product/risk unit binds an owner-approved `WaterfallVersion`. The general order is:

1. participant's eligible isolated or enrolled collateral;
2. proceeds and recoveries contractually attributable to that obligation;
3. named guarantor/default resources where an enforceable contract exists;
4. named insurance/default-fund resources up to reconciled available balance and policy caps;
5. other exchange capital only where the governing legal/policy version explicitly commits it;
6. ADL only under published eligibility, ranking, caps, prior disclosure, and before-action notice evidence;
7. socialized loss only if separately owner/legal-authorized, published before exposure, mechanically capped/allocated, and supported by statements and appeals.

Absence at any rung is explicit. The system cannot skip to an unfunded account, synthesize a receivable, or silently debit profitable participants. Insurance assets, liabilities, contributions, uses, recoveries, replenishment, and conflicts are separate ledger accounts and reports.

ADL ranking input, tie-breaking, candidate exclusions, maximum reduction, repeated-action caps, participant disclosure, and review are versioned. Current code's owner-gated disclosure-before-action primitive is not proof of a complete ADL program. Without valid policy and acknowledged disclosure, ADL refuses.

## 15. Default management

A `DefaultCase` names defaulting legal party, role, affected accounts/products/assets, trigger evidence, detection time, policy version, incident authority, frozen scopes, obligations, collateral, open risk, claims, actions, communications, recoveries, and closure basis.

| Failure                         | Minimum response contract                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Trader/borrower                 | Fence new risk, preserve reduce/repay, calculate and notify, liquidate under §12, pursue named recovery                         |
| Market maker/broker             | Separate principal/agency obligations, client orders/assets, open allocations, guarantees, and venue exposure                   |
| Custodian/sub-custodian         | Freeze unsupported availability/withdrawal, reconcile ownership, activate replacement/return plan under PX-S12                  |
| Settlement network/chain/bridge | Separate pending from final, stop affected dispatch/credit, preserve claims and replay-safe reconciliation                      |
| Oracle/index provider           | Enter explicit degraded state; refuse money-moving uses without a permitted fallback                                            |
| Bank/payment rail               | Separate client-fund ownership, receivable, settlement, and operational liquidity; no cross-rail substitution without authority |
| Venue/liquidity counterparty    | Fence route, reconcile orders/fills/collateral, apply exposure/capital limit, invoke exit/portability plan                      |
| INTAFACED entity                | Invoke PX-S12 wind-down, protect records/assets, stop new exposure, and preserve close/transfer/claim paths                     |

Defaults are not inferred from a timeout alone. Detection, declaration, cure, dispute, acceleration, close-out, valuation, set-off/netting, recovery, and case closure have distinct authorized states. Legal enforceability, insolvency treatment, and governing entity/jurisdiction remain explicit owner/legal sockets.

## 16. Risk-model and capital governance

Every risk model has an owner, purpose, scope, code/data version, assumptions, calibration window, limitations, independent reviewer, approval, effective interval, change record, and rollback target. Promotion requires:

- deterministic fixtures and independent reproduction;
- historical backtests and outcome attribution;
- stress, reverse-stress, sensitivity, liquidity, concentration, basis, oracle, and operational-failure scenarios;
- shadow runs against current production state with difference explanation;
- anti-gaming and procyclicality review;
- treatment/fairness checks across equivalent accounts;
- retained artifacts sufficient to reproduce past acceptance and liquidation decisions.

Model disagreement beyond an owner-set bound blocks promotion or enters a declared conservative mode. Rollback never recalculates historical decisions as if the old model had not existed.

Exchange capital, insurance, settlement liquidity, committed facilities, stress loss, and counterparty concentrations are reported separately by legal availability and time-to-use. Owner-set thresholds drive scoped alerts and action; this contract supplies no magnitude and treats absent values as not approved.

## 17. Concurrency, sequencing, recovery, and correction

1. Risk-increasing commands use expected state/model versions; stale approvals refuse and re-evaluate.
2. Position/margin adjustment, close, liquidation, withdrawal, and transfer contend on a declared risk-unit sequence or lock; no two may spend the same excess.
3. Fill, funding, interest, collateral, and external-settlement events are idempotent and sequenced within named domains. Gaps halt dependent finality and trigger replay.
4. A ledger success with local-finalize failure is `RECOVERY_REQUIRED`; re-drive uses the same economic key. A local success without ledger evidence is never final money.
5. Conflicting operator and automated actions resolve by durable precedence and expected version, not last wall-clock write.
6. Corrections append a causal decision, position adjustment where required, and balanced compensating ledger transaction. They never edit historical marks, fills, or statements in place.
7. Rebuild compares risk positions/obligations to ledger holds/balances and PX-S03 settled fills. Any unexplained delta freezes risk-increasing actions in the smallest safe scope.

## 18. User, API, event, terminal, and reporting contract

The API exposes mode, risk unit, policy/model/input versions, timestamp/freshness, collateral states, valuations/adjustments, exposure, IM/MM, excess/deficit, buying/withdrawal power, stress/concentration/liquidity measures, warnings, liquidation/default state, and actionable refusal codes. Pagination and replay use stable sequences.

Commands require scoped authority and idempotency and return command state separately from economic finality. Preview responses expire and identify assumptions. Bulk actions report each account/order/position outcome; partial success is never flattened to success.

Events carry event/schema version, causal and correlation IDs, legal owner/account/risk unit, source sequence, calculation/model/policy versions, observed/effective/published times, degradation, and correction link. Delivery is at least once; consumers deduplicate and repair gaps from authoritative snapshots.

The professional terminal shows:

- mode and collateral propagation boundary before order entry;
- current/freshness-labelled equity, buying power, IM/MM, excess/deficit, liquidation bands, concentration and dominant stress drivers;
- mark/index source health and whether valuation, entry, withdrawal, or liquidation is disabled;
- warning delivery, available cure actions, deadlines only when valid, forced children, fees, settlement state, insurance/default/ADL state, and corrections;
- parent-child causality and account/owner/provenance consistent with PX-S03.

Statements reproduce opening collateral/obligations, every posting/accrual/fill, valuation basis, closing state, fees, insurance/recovery/ADL effects, corrections, and outstanding claims. A current model is never substituted for the historical version.

## 19. Security, market integrity, conflicts, privacy, and retention

- Material policy/model/limit changes, manual seizures, insurance transfers, ADL activation, and default-case closure require least privilege, reason, expiry, immutable audit, and dual control where the action can affect multiple owners.
- Emergency controls can reduce or freeze scope; they cannot create balances, bypass ledger posting, authorize caller prices, or silently broaden collateral propagation.
- Surveillance correlates liquidation and risk-policy changes with affiliate/house/customer orders, oracle contributions, cancellations, fills, and operator access. Platform accounts receive no privileged mark, queue, liquidation, or default treatment.
- Model inputs, positions, credit terms, and default cases are confidential at legal-owner scope; aggregate publication uses governed thresholds and resists reconstruction.
- Retention covers calculation inputs/results, observations, policies/models, commands, notices/delivery, executions, postings, access, approvals, communications, corrections, and exports for the governing rule/legal period. Deletion requests cannot erase regulated financial evidence.

## 20. Operations, capacity, and customer-visible proof

Metrics cover mark/index age/quorum/outliers, calculation lag and queue depth, input watermark skew, order-risk latency, reconciliation deltas, margin-call delivery, liquidation stage/duration/slippage/unknown outcomes, insurance utilization, ADL refusals/actions, model shadow differences, stress/capital thresholds, and default cases.

Owner-set SLO sockets exist for freshness, calculation, warning delivery, liquidation processing, recovery, reconciliation, and reporting. Until set and evidenced, no “real-time,” capacity, or resilience claim is made.

Load/fault proof includes burst orders/fills, correlated price moves, many large portfolios, oracle/provider loss, stale/outlier storms, ledger latency/outage, matching disconnect/replay, notification failure, competing adjustments/withdrawals/liquidations, insurance exhaustion, counterparty failure, regional failover, and long-running recovery. Evidence records configuration, workload, policy/model versions, faults, invariant checks, and residual errors.

Customer-visible status names affected modes/markets/assets/functions, data time, refusal behavior, risk-reducing paths, and correction/recovery progress without exposing private portfolios or exploitable controls.

## 21. Compatibility, rollout, rollback, migration, and wind-down

New fields are additive and versioned; clients must not interpret absent as zero or healthy. Breaking semantic changes require a new API/event and policy/model version, compatibility window, replay fixtures, and migration evidence.

Rollout sequence is offline reproduction, historical/backtest, shadow calculation, operator-only comparison, participant preview, bounded enrollment, then explicit expansion. Money-moving behavior stays on the accepted implementation until shadow differences and reconciliation are resolved. Rollback restores the prior model for new decisions while retaining the version actually used for each historical decision.

Mode or model migration inventories and fences open orders, positions, loans, collateral, withdrawals, settlements, warnings, and liquidation/default cases. No migration combines owners or changes encumbrance through database relabeling.

Wind-down under PX-S12 stops new leverage/draws, preserves cancellation/repayment/collateral addition and safe close/transfer paths, continues funding/interest and statement truth, reconciles all obligations, returns eligible residual collateral through ledger-backed flows, and retains unresolved claims. Unsupported asset or counterparty return paths remain named sockets, not silent conversion.

## 22. Definition of Done

PX-S06 is implementation-complete only when evidence proves:

1. every enabled mode has explicit enrollment, propagation boundary, preview, consent, migration, and rollback;
2. collateral constitution and all owner magnitudes are approved, versioned, effective-dated, and refuse closed when absent;
3. independent fixtures reproduce collateral, buying power, IM/MM, excess/deficit, stress, and liquidation decisions exactly;
4. pre-trade, post-fill, withdrawal, statement, and liquidation calculations reconcile to the same inputs and model;
5. caller/display/last prices cannot move money; stale, outlier, future, missing, and insufficient-quorum cases pass adversarial tests;
6. concurrent order, fill, margin adjustment, transfer, withdrawal, funding, and liquidation cannot double-spend collateral or flip reduce-only exposure;
7. warnings are deliverable and actionable; no undelivered notice starts a grace clock;
8. staged liquidation cancels conflicting risk, uses bounded ordinary execution, records every child/fill/fee, and recovers deterministic unknown outcomes;
9. every economic action posts exactly once through `ledger-client`, with crash-window, reversal, correction, and reconciliation proofs;
10. insurance, exchange capital, recovery, ADL, and any social loss follow one funded, versioned, disclosed waterfall with no implicit account;
11. each counterparty/default class has detection, authority, containment, communication, valuation, recovery, and exit exercises;
12. models pass versioning, review, backtest, stress, shadow, explainability, promotion, and rollback evidence;
13. scoped dual-control and surveillance tests cover material operator actions and affiliate conflicts;
14. capacity/fault tests retain configurations and prove no invented valuation, unbalanced money, duplicate action, or unsafe restart;
15. UI/API/events/statements expose consistent state, provenance, freshness, finality, degradation, and corrections;
16. PX-S01/PX-S02/PX-S03 conformance and PX-S07/PX-S08/PX-S10/PX-S12/PX-S13/PX-S14 consumer tests pass for enabled products.

A specification or green tracker row satisfies none of these implementation proofs by itself.

### 22.1 Requirement proof map

| Requirement   | Contract closure                                                                    | Required implementation evidence                                        |
| ------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `PTX-M08-R01` | §5 separates seven modes and their propagation boundaries                           | Enrollment, isolation, and negative cross-mode conformance              |
| `PTX-M08-R02` | §5.1 defines preview, consent, quiescence, migration, recovery, and rollback        | Concurrent open-risk migration and rollback fixtures                    |
| `PTX-M08-R03` | §7 defines the versioned collateral constitution and degraded valuation             | Asset/depeg/wrong-way/concentration/oracle adversarial suite            |
| `PTX-M08-R04` | §8 defines reproducible scenario margin, offsets, floors, and deterministic order   | Independent calculator, backtest, stress, and shadow corpus             |
| `PTX-M08-R05` | §§8.1–8.3 bind pre/post-trade, withdrawal, liquidation, and statement calculations  | Cross-surface exact reconciliation fixtures                             |
| `PTX-M08-R06` | §9 defines inventory, loan, recall, repayment, and lender/default boundaries        | Ledger-backed loan lifecycle and shortage/default faults                |
| `PTX-M08-R07` | §§9 and 13 bind accrual, cross-currency liability, consent, and all-in cost         | Funding/interest gap, correction, and statement proof                   |
| `PTX-M08-R08` | §§5 and 8.2 make organization offsets separate consented legal products             | Negative isolation tests plus agreement/revocation evidence             |
| `PTX-M08-R09` | §9 defines bilateral-line economics and buying/withdrawal-power separation          | Legal/commercial authority and full line lifecycle proof                |
| `PTX-M09-R01` | §§4 and 8 define risk dimensions and correct legal/risk units                       | Boundary aggregation, concentration, and counterparty fixtures          |
| `PTX-M09-R02` | §10 defines independent observations, robust construction, and use-specific gates   | Source loss/outlier/stale/future/quorum adversarial corpus              |
| `PTX-M09-R03` | §11 defines warning delivery and actionable risk-reduction paths                    | Delivery, cure, priority, transfer, and race evidence                   |
| `PTX-M09-R04` | §12 defines staged partial, bounded execution and causal conflict cancellation      | Book, disconnect, partial-fill, and settlement recovery tests           |
| `PTX-M09-R05` | §14 defines funded waterfall, insurance, recovery, ADL, and social-loss prohibition | Exhaustion, ordering, disclosure, accounting, and correction proof      |
| `PTX-M09-R06` | §15 defines eight counterparty/default classes and case lifecycle                   | Exercises and retained evidence for each enabled dependency             |
| `PTX-M09-R07` | §16 separates capital, liquidity, facilities, stress, and concentration             | Owner thresholds, source-of-funds reconciliation, and escalation drills |
| `PTX-M09-R08` | §16 defines model version, review, backtest, shadow, explanation, and rollback      | Signed promotion pack and historical reproducibility                    |
| `PTX-M09-R09` | §19 defines scoped, expiring, observable, dual-controlled material actions          | Authorization matrix, abuse tests, and ledger-invariant proof           |

## 23. Owner and external sockets

| Socket       | Required authority/input                                                                            | Refuse-closed behavior while absent                               |
| ------------ | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `PX-S06-O01` | Enabled modes and enrollment eligibility by legal entity/product                                    | Only separately proven cash/isolated paths may operate            |
| `PX-S06-O02` | Collateral assets, custody/finality states, haircuts, add-ons, concentration/wrong-way/depeg policy | Asset provides no collateral buying power                         |
| `PX-S06-O03` | IM/MM/leverage/ladder/scenario/floor/anti-procyclical magnitudes                                    | New affected risk or seizure refuses                              |
| `PX-S06-O04` | Mark/index sources, construction, quorum, staleness/outlier and fallback policy                     | Affected money-moving decision refuses; no zero/last substitution |
| `PX-S06-O05` | Margin-call channels, delivery contract, cure actions, and grace                                    | No grace-based escalation                                         |
| `PX-S06-O06` | Liquidation sizing, bounds, venues, fees, backstop, and operator authority                          | No configured involuntary rung                                    |
| `PX-S06-O07` | Insurance/default fund ownership, contributions, caps, eligible uses, recovery and replenishment    | No debit or advertised cover                                      |
| `PX-S06-O08` | Exchange capital/buffer commitments and stress/escalation thresholds                                | No capital availability claim or automated use                    |
| `PX-S06-O09` | ADL ranking/caps/disclosure and any socialized-loss authorization                                   | ADL/social loss refuses                                           |
| `PX-S06-O10` | Lender, inventory, rates/indexes, caps, recall, term, collateral, guarantee, credit agreement       | New borrow/draw refuses                                           |
| `PX-S06-O11` | Legal entities, jurisdictions, netting/set-off/insolvency/default authority                         | Cross-owner offset and disputed default action refuse             |
| `PX-S06-X01` | Oracle/index vendors and market-data capacity                                                       | Affected source is degraded/unavailable                           |
| `PX-S06-X02` | Custodian, bank, chain/bridge, settlement and venue counterparty contracts                          | Unproven external asset/credit/settlement is ineligible           |
| `PX-S06-X03` | Notification and incident communication delivery evidence                                           | Notice is undelivered; no grace clock                             |

## 24. Cross-spec dependencies and contradiction register

- **PX-S01:** binds effective rule/instrument versions, market states, disclosures, corrections, and governance. A risk model cannot override a halted or ineligible product.
- **PX-S02:** supplies legal owner, actor, account/sub-account, grants, session and dual-control authority. Organization visibility is not collateral consent.
- **PX-S03:** owns deterministic order/cancel/amend/fill semantics. A risk approval is not engine acceptance; a liquidation child is an ordinary order with forced-action provenance.
- **PX-S07/PX-S08/PX-S10:** supply payoff, funding, expiry, option/scenario, and settlement inputs; PX-S06 owns common collateral/risk/default semantics.
- **PX-S11:** consumes calculations and postings for portfolio/institutional reporting; it may not recompute authoritative money from a view.
- **PX-S12:** owns custody, asset/ledger reconciliation, solvency, return, and wind-down. External custody evidence never becomes collateral directly.
- **PX-S13:** consumes degradation, recovery, capacity, and incident states; it cannot weaken money/risk refusal.
- **PX-S14:** owns external route/counterparty execution and collateral placement; normalized venue data never proves finality or availability.

Resolved contradictions:

1. `PositionRow` retains a historical `cross` value, while live APIs intentionally support isolated only. This contract treats cross as disabled legacy/schema vocabulary, not an enabled product.
2. Existing default mark-policy constants and test ladders are implementation evidence, not approved live magnitudes. Production activation requires the named owner versions.
3. The liquidation planner can calculate an insurance share, but arithmetic is not permission or funding. The reconciled named account bound and waterfall version govern posting.
4. Current ADL code can disclose and reduce but deliberately does not rank candidates or supply caps. PX-S06 leaves those owner sockets closed.
5. Portfolio views may aggregate sub-accounts, but no collateral, loss, or offset propagates across them without a separate enrolled product and enforceable authority.
6. Ledger finality and position workflow finality can temporarily diverge after a crash. The state is `RECOVERY_REQUIRED`; neither side is overwritten, and replay uses the original economic idempotency root.
