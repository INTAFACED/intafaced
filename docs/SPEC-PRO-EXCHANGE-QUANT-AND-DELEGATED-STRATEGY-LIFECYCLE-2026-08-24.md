# INTAFACED Quantitative and Delegated Strategy Lifecycle Specification

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Status:** Authoritative product contract; implementation incomplete

**Authority:** `PX-S15`; bounded child of [`PRO_TRADER_EXCHANGE_DEFINITIVE_SCOPE.md`](../PRO_TRADER_EXCHANGE_DEFINITIVE_SCOPE.md)

**Primary requirements:** `PTX-M24-R01–R12`, `PTX-M26-R01–R10`

**Predecessors:** `PX-S01` rulebook/lifecycle/integrity, `PX-S02` participant authority/security, `PX-S03` microstructure/execution, `PX-S04` connectivity/data/certification, `PX-S05` terminal/OMS/TCA, `PX-S06` collateral/risk/default, `PX-S07` products/FX, `PX-S08` options, `PX-S09` RFQ/OTC/allocation, `PX-S10` liquidity/fees/makers, `PX-S11` reporting/service, `PX-S12` custody/reconciliation/wind-down, `PX-S13` resilience/incident command, and `PX-S14` multi-venue/on-chain execution; preserves the bounded product law in [`SPEC-SOVEREIGN-ROUTING-AND-COPY-2026-08-01.md`](SPEC-SOVEREIGN-ROUTING-AND-COPY-2026-08-01.md)

**Systems of record:** PX-S02 owns actor, account, sub-account, credential, mandate and revocation authority. PX-S03 owns order intent, parent/child state and execution semantics. PX-S04 owns data/session/schema truth. PX-S05 owns professional control and TCA presentation. PX-S06 owns capital, margin and risk. PX-S10 owns fees, incentives and conflicts. PX-S12 owns money finality and reconciliation. PX-S13 owns incidents/recovery. PX-S14 owns venue route truth. `packages/ledger-client` plus `svc-ledger` remain the only money book. This contract owns strategy/research/deployment identities, promotion and runtime governance, leader/follower replication semantics, and their causal evidence.

---

## 1. Product promise, professional jobs, and boundary

Quant researchers, portfolio managers, traders, developers, model reviewers, risk, compliance, operations, clients, copy leaders, followers and auditors can build or select a strategy; distinguish research, paper, shadow and live evidence; approve one immutable version; delegate only bounded order intent; control and revoke it; and reconstruct every signal, decision, follower divergence, order, fill, cost and correction without granting a model or leader independent authority over money.

This determines primary-venue adoption because professional automation is trusted only when the path from data to decision to order is reproducible and governable. A venue that offers attractive backtests or popular leaders but cannot prove version, assumptions, authority, risk, drift, recovery and stop behavior is a marketing surface, not an institutional execution platform.

Catastrophic or dishonest outcomes include look-ahead or survivorship bias; simulated results labeled live; omitted costs or failed variants; mutable approved code; secret or tenant escape; duplicate live deployment after restart; uncontrolled order storms; stale-data trading; a leader widening follower risk; paper intent reaching live money; silent copy failure or divergence; revocation that still opens positions; a stop that unexpectedly liquidates; self/affiliate volume farming; P&L-linked compensation contrary to accepted law; and any strategy, leader or agent posting value outside the ledger boundary.

M24 and M26 remain one contract because authored, marketplace, copied, signal-driven and future delegated strategies share the same immutable version, approval, account, risk, execution, observability, revocation and wind-down spine. This grouping does not collapse strategy authorship into copy-leader identity or allow marketplace publication to authorize execution.

Non-goals:

- no model, strategy, leader, agent, marketplace or signal receives custody, balance, ledger, withdrawal, transfer, credit or risk-limit authority;
- no return, drawdown, capacity, ranking, fee, rate, capital, leverage, loss limit, SLO, jurisdiction, legal capacity, strategy claim or commercial policy is invented;
- no backtest, paper run, shadow decision, listing, follower plan or leader fill is called a live execution;
- no pooled fund, platform-run discretionary strategy, returns-ranked recommendation board, P&L performance fee, second money book, second OMS, second SPA, tracker or SoT is created;
- this contract does not make Monte Carlo, institutional deployment, sovereign on-chain copy, leader integrity or a live marketplace complete merely because foundations exist.

## 2. Research delta and durable patterns

Current official sources add durable contract requirements:

- [QuantConnect live-trading concepts](https://www.quantconnect.com/docs/v2/writing-algorithms/live-trading/key-concepts) distinguishes real-time delivery and brokerage holdings/open orders from paper startup, requires state reconstruction after restart, and stops where portfolio mechanics cannot be modeled safely.
- [QuantConnect live reconciliation](https://www.quantconnect.com/docs/v2/cloud-platform/live-trading/reconciliation) compares live and out-of-sample simulation and names data, model and brokerage causes of divergence. Its [reality-model documentation](https://www.quantconnect.com/docs/v2/writing-algorithms/reality-modeling/trade-fills/key-concepts) separates fill, spread and slippage models, including partial and stale-fill behavior.
- [EU RTS 6 / Delegated Regulation 2017/589](https://eur-lex.europa.eu/eli/reg_del/2017/589/oj/eng/pdf) supplies durable governance patterns for algorithm inventory, controlled development/testing, conformance, monitoring, capacity, business continuity and kill functionality. Legal applicability remains a counsel socket.
- [OKX copy-trader operations](https://www.okx.com/en-gb/help/copy-traders-how-to-manage-copied-trades) distinguishes parameter changes for future positions, stop-copy, manual close, leader-permission loss and insufficient-funds failures. [OKX copy FAQs](https://www.okx.com/en-gb/help/copy-traders-faqs) additionally expose risk-control and lead-capacity refusals.
- [Bybit Copy Trading FAQ](https://www.bybit.com/en/help-center/article/FAQ-Copy-Trading) names follower divergence from slippage, minimum size, insufficient balance and failed copies rather than implying exact replication.
- [eToro CopyTrader operation](https://www.etoro.com/en-us/copytrader/how-it-works/) distinguishes pause-new-intent from stop-and-sell versus stop-and-keep. The durable lesson is explicit post-stop disposition, not adoption of its commercial or legal model.

The delta is that research/live parity must be measured rather than promised, restart begins from authoritative live positions and orders rather than an empty model, and copy status requires an explicit divergence and disposition lifecycle. Competitor rankings, profit shares, leverage and jurisdiction choices are not imported.

## 3. Repository evidence audit and contradictions

| State       | Evidence and bounded truth                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BUILT`     | `svc-quant` has a restricted JS/TS/Python interpreter with no host/network/file escape, exact-money paper book, mandatory studio risk block, typed routes, fill-based walk-forward windows and hard refusal when the data lake, OOS verdict, variant count, fee, slippage or latency provenance is absent. `packages/quant-honesty` forbids render of incomplete backtests, returns-ranked strategy comparisons and unequal live/simulation labels.                               |
| `PARTIAL`   | The studio compiles a narrow block model and uses an in-memory random-ID store; the backtest reads only fill rows and calculates fill count/notional, not a complete event engine or performance model. `svc-trade/copy` has durable follow envelopes, service session-key rotation/revocation, fill-id idempotency, cap serialization, live/paper refusal, mirror planning/optional spot placement and ledger-backed fee-share settlement. Strategy subscription listings exist. |
| `SPECIFIED` | The sovereign copy spec forbids custody/pooling, platform discretion, P&L fees and returns-ranked recommendations and requires follower-owned scoped authority. PX-S02/PX-S03/PX-S06/PX-S10/PX-S12 already bind delegation, execution, risk, fees and money. Accepted D26-P0-02 owns fee-share magnitudes and source; D26-P0-15 keeps every jurisdiction refuse-closed until counsel supplies the served list.                                                                    |
| `SOCKET`    | Data licensing/provenance, complete market models, live products/accounts, approval roles, runtime compute/network/secrets, deployment capital/risk/SLOs, marketplace/legal claims, leader eligibility/capacity/protection and counsel-supplied copy jurisdictions remain sockets. Blank live authority refuses.                                                                                                                                                                  |
| `OWNER-SET` | D26-P0-02's protocol-fee-share law is accepted and must be referenced, not recomputed or generalized. P&L-linked fees, pooling, discretionary management and returns-ranked boards remain out. All live deployment eligibility, commercial listing/subscription terms, leader criteria, protection thresholds and legal capacities remain owner/legal/risk decisions.                                                                                                             |
| `EXTERNAL`  | Market/reference data, venue/broker feeds and execution, research datasets, cloud/runtime providers, SDK dependencies, strategy authors, clients, leaders, tax/counsel/regulators and any Protocol-plane chain/bundler/signer dependency require authenticated evidence and exit paths.                                                                                                                                                                                           |
| `ABSENT`    | No durable typed version registry, experiment lineage, complete event simulator, production-shaped paper/shadow bus, independent approval workflow, live deployment registry/orchestrator, deterministic restart state, per-version monitoring/parity promotion, institutional sharing/retirement, complete leader eligibility/capacity/anti-gaming, follower drift reconciliation, stop-disposition workflow, or production sovereign smart-account copy path was found.         |

Three contradictions are material:

1. The sovereign copy contract requires Protocol-plane execution through a follower-owned smart account with scope and revocation enforced on-chain. The current `svc-trade` routes use `publicJurisdictionProcedure('trade', 'fiat')`, a service-side envelope and a hashed service session key. Comments that call current enforcement on-chain overstate the code. The Fiat service path is a useful bounded implementation, but it is not proof of the sovereign Protocol path and cannot inherit its non-custodial claims.
2. The older fee-share prose illustrates notional × fee rate × share, while current code correctly derives the share only from the settled follower fill's actually collected fee and uses ledger recipes. The code and PX-S10/PX-S12 money truth prevail: never reconstruct or over-claim a house fee from notional.
3. Copy “period” statistics are currently pair-lifetime because the durable key has no period dimension. Accepted caps/decay remain owner law, but reporting or settlement must not call those counters period-scoped until a versioned period key and migration exist.

Tracker completion proves only those bounded doors. It does not prove institutional M24/M26 lifecycle, live legal availability or professional operational readiness.

## 4. Common authority model, objects, IDs, versions, and clocks

Every strategy acts in a named capacity: `RESEARCHER`, `STRATEGY_OWNER`, `REVIEWER`, `DEPLOYER`, `RUNTIME_OPERATOR`, `LEADER`, `FOLLOWER`, `CLIENT_DELEGATE`, or `CONTROL_FUNCTION`. Roles are scoped by legal entity, organization, account/sub-account, product, environment and action. The same actor may hold several roles, but independent review cannot be self-approved where policy requires separation.

Canonical objects include `StrategyDefinition`, `StrategyVersion`, `ParameterSet`, `DataManifest`, `Experiment`, `Variant`, `BacktestRun`, `PaperRun`, `ShadowRun`, `ReviewCase`, `Approval`, `DeploymentManifest`, `Deployment`, `RuntimeInstance`, `StrategyDecision`, `PromotionCase`, `SharedStrategyGrant`, `MarketplaceListing`, `LeaderProfile`, `LeaderVersion`, `FollowerPlan`, `ReplicationIntent`, `FollowerOrderLink`, `DivergenceCase`, `CompensationAttribution`, `DelegationGrant`, `ControlAction`, and `StrategyRetirementCase`.

Stable IDs cover strategy/version/content hash, owner/organization, experiment/variant/run/dataset/schema/model/assumption, review/approval/policy, deployment/environment/runtime/epoch, account/sub-account/mandate/grant/key, signal/decision/risk-evaluation/parent/child/order/fill, leader/profile/version, follower/plan/replication/divergence, fee/ledger transaction, control/correction/case/incident and source evidence.

`StrategyVersion` is immutable content-addressed source/graph, dependency lock, typed schema, parameter defaults, risk declarations and compatibility requirements. Any code, graph, dependency, data feature, model, parameter, permission, account universe or risk-bound change creates a new version or manifest and invalidates approvals according to policy; mutable display metadata never alters evidence.

Clocks distinguish source event, venue event, platform receive, strategy event-time, decision, risk check, order release, venue acknowledgement/fill, experiment start/end, dataset availability/publication, review/approval, deployment schedule/start/heartbeat/stop, leader observation, follower decision/order/fill, revocation acknowledgement, reconciliation, correction and retention. Research event-time never sees a fact before its recorded availability time.

## 5. Typed authoring, data, experiments, and backtests

No-code and TS/Python SDKs compile to the same versioned `StrategyDefinition`: inputs/subscriptions, signals, state, timers/calendars, parameters, portfolio targets or order intents, positions, risk blocks, lifecycle callbacks, diagnostics and declared capabilities. One surface cannot express an unreviewed money or network verb unavailable to the other. Compilation produces typed diagnostics, deterministic intermediate representation and content/dependency hashes; unsupported nodes refuse rather than degrade silently.

Each `DataManifest` records source/owner/licence, instrument identity and mapping, event and availability clocks, time zone/calendar, schema/version, price adjustment, corporate actions, delistings, symbol changes, roll/expiry, universe membership history, gaps/outliers/corrections, quality, capture time and reproducible snapshot. Missing history is not forward-filled without an explicit model. Survivorship, look-ahead and selection boundaries are testable properties, not disclaimer text.

An `Experiment` freezes strategy/data/model versions, parameter search space, random seeds, compute image and every attempted `Variant`, including failed, stopped and discarded runs. Train/in-sample, validation, out-of-sample and walk-forward windows do not overlap improperly. Post-OOS changes invalidate the verdict or create a new holdout. Search count, objective choice and researcher decisions remain visible to resist selection bias.

An event-level `BacktestRun` consumes the same normalized market/order event contracts where mechanics matter and declares:

- order types, sessions, halts, auctions, sequencing, queue/priority, latency, throttles, rejects, cancels, partial fills, busts and corrections modeled or unsupported;
- spread, depth, impact/slippage, fees/rebates/taxes, funding, borrow availability/rate/recall, margin/liquidation, FX and settlement assumptions with source/version;
- initial assets/positions, cash, corporate actions, expiry/exercise/assignment and venue/product constraints;
- capacity assumptions and the point at which modeled size invalidates the result.

Unsupported material mechanics yield `NOT_MODELLED` and prevent promotion for dependent strategies. Outputs retain gross and net results, drawdown/exposure/turnover, execution costs, rejected/unfilled intent, sensitivity and confidence limitations. Simulation never uses a production balance or emits a ledger post.

## 6. Paper, shadow, live truth, and promotion

Environments are `BACKTEST`, `PAPER`, `SHADOW`, `LIVE_CANARY` and `LIVE`. Every screen, API, credential, event, alert and export carries the environment with equal visual weight. IDs are namespaced; paper/shadow credentials cannot authenticate to live order entry; live credentials are unavailable inside simulation.

Paper consumes production-shaped data and OMS/risk contracts but routes into an isolated deterministic simulator with structurally impossible `ledger-client` and external order-write access. Shadow consumes live production-shaped inputs and executes the complete decision/risk path without order release or money movement. It records the counterfactual plan and compares it with market outcomes without calling either a fill.

Promotion is a state machine:

`DRAFT → COMPILED → RESEARCHING → REVIEW_PENDING → APPROVED_FOR_PAPER → PAPER → SHADOW → LIVE_REVIEW → LIVE_CANARY → LIVE`

with `REJECTED`, `CHANGES_REQUIRED`, `EXPIRED`, `SUSPENDED`, `ROLLED_BACK`, `RETIRED` and `EVIDENCE_INVALIDATED`. Stages may be skipped only by an explicit owner policy that records the exception and cannot bypass PX-S02/PX-S06 authority.

Promotion evidence includes deterministic replay, IS/OOS/walk-forward integrity, data/model provenance, simulation limitations, paper/shadow parity, capacity and severe-market replay, venue/product certification, operational runbook, recovery and kill tests, security review, conflicts, approvals and owner-set live canary. Live versus OOS reconciliation continuously measures data, timing, fill, cost, reject, state and risk divergence. Breach pauses/rolls back under published rules; absent thresholds block automated promotion rather than inventing them.

## 7. Deployment manifest, review, and authorization

A `DeploymentManifest` immutably binds strategy/version, owner, responsible desk, reviewers/approvers, environment, legal entity, account/sub-account, instruments/venues, capacity, capital allocation, order/position/exposure/loss/drawdown/message/rate limits, schedule/time zone, data/model dependencies, secrets/network/compute permissions, restart/disconnect policy, control authority, expiry and policy/rule versions.

Deployment state is:

`PROPOSED → VALIDATING → REVIEW_PENDING → APPROVED → SCHEDULED → STARTING → RECONCILING_START → RUNNING`

then `PAUSING`, `PAUSED`, `DRAINING`, `STOPPING`, `STOPPED`, `ROLLED_BACK`, `EXPIRED`, `SUSPENDED`, `RECOVERY_REQUIRED`, `RETIRING`, or `RETIRED`. Approval is not launch; launch rechecks current entitlement, market/rule/risk state, balance/margin, credentials, dependencies, version hash and expiry.

Policy defines independent reviewer requirements, dual control for high-blast actions, incompatible role combinations, approval duration and emergency authority. Review captures diffs from prior version, tests, limitations, model/data risk, conflicts and explicit decision. Any invalidating change or expired evidence returns to review. No reviewer can approve a wider account or capital envelope than their own authority.

Capital is a hold/risk allocation in the account's ordinary systems, not a strategy balance. A deployment cannot transfer, withdraw or post value. Every emitted intent goes through PX-S02 ownership, PX-S01 market state, PX-S03 order validation, PX-S06 risk/margin, PX-S14 venue eligibility and ordinary ledger settlement.

## 8. Runtime isolation, recovery, control, and observability

Each `RuntimeInstance` is isolated by tenant, strategy version, deployment and epoch. It receives only declared data, clock, state and intent APIs; has bounded CPU/memory/storage/message rate; denies network/filesystem/process/secret access by default; mounts individual secrets by reference; redacts output; and cannot introspect another tenant, deployment or account. Dependency/image provenance, vulnerability policy and egress destinations are versioned.

Runtime checkpoints carry strategy/version/deployment, epoch, processed source sequence/watermark, deterministic state, timers, outstanding signal/decision/order lineage and checksum. Restart first loads authoritative account positions, balances, open orders and fills; reconciles them with the checkpoint; and applies the bound policy: `RESUME`, `PAUSE`, `CANCEL_CHILDREN`, or `INTERVENTION_REQUIRED`. It never assumes an empty portfolio, replays an already-released intent, or flattens without authority.

Controls are launch, schedule, pause-new-intent, resume-after-reconcile, drain, cancel authorized children, flatten authorized positions, kill, rollback version and undeploy. Scope always shows strategy/deployment/account/product and blast radius. Pause does not imply cancel; cancel does not imply flatten; flatten is a new reduce-risk order subject to ordinary authority and market truth. Kill fences new intent first, revokes runtime credentials/grants, then performs only the separately chosen child/position disposition.

Monitoring attributes exact version and deployment to input sequence/age, signal, decision, risk result/reject, parent/child, venue route, order/fill/cancel, fee/cost, position/PnL, limit headroom, model/data drift, latency, queue backlog, heartbeat, exception/restart and operator action. Metrics and logs never reconstruct money or erase corrections. Alerts state environment and customer impact.

## 9. Sharing, marketplace, claims, and retirement

`SharedStrategyGrant` independently scopes view, execute-research, clone, edit, review, approve, list, deploy and allocate-capital permissions. A clone gets new ownership and lineage. Revocation stops future access/use but preserves evidence and does not mutate already approved versions. Creator departure, organization transfer or entitlement loss places unowned live deployments into `PAUSED`/`RECOVERY_REQUIRED` until a qualified owner accepts; it never leaves orphan automation.

A `MarketplaceListing` identifies publisher/legal capacity, strategy/version lineage, executable environments, supported products/accounts, required data/dependencies, subscription terms, conflicts, capacity and claim methodology. Listing and subscription authorize discovery/access only. Followers still create their own delegation and account/risk plan.

Any performance surface distinguishes verified live, shadow, paper, backtest, imported and self-reported records; gives source period/tenure, gross/net-of-disclosed-cost basis, drawdown, exposure/leverage, liquidity/capacity, variant/version changes, missing history, conflicts and limitations. Live and simulation labels have equal weight. No registration-order directory becomes a recommendation, no return/PnL/win-rate ranking or “top trader” exists, and no projection is inferred from past performance.

Listing state is `DRAFT → REVIEW → LISTED → SUSPENDED → DELISTED → RETIRED`, with version changes requiring review and visible continuity/break. Delisting stops new subscriptions/delegations; existing runs/follows apply a declared pause/detach/wind-down path and communication. Records survive retirement under retention/dispute law.

## 10. Leader eligibility, follower plan, and independent limits

A `LeaderProfile` is eligible only under an owner/legal/risk policy and records identity/beneficial ownership, account and legal capacity, strategy/manual/API source, verified-live tenure and complete observation window, costs, drawdown, leverage/exposure, concentration, turnover, capacity, conflicts/affiliate links, incidents/suspensions and version continuity. Backtest, paper, imported and self-reported history remain separately labeled and cannot satisfy a live criterion.

Eligibility is continuously re-evaluated. Unknown provenance, incomplete loss periods, hidden accounts, unresolved beneficial ownership, unavailable capacity, prohibited region/product, stale metrics or control suspension prevents new followers. Removal never rewrites past status. Search/filter may use factual fields under policy; returns-ranked or personalized recommendation boards remain forbidden.

Each follower creates a `FollowerPlan` on an explicit follower-owned account or sub-account, with permitted leaders/versions, instruments/products, sizing method, allocation/capital budget, max per-order/aggregate exposure, leverage/margin, loss/drawdown, slippage/price divergence, concurrency, concentration, daily/message/rate limits, schedule, expiry and post-stop disposition. Values are decimal strings at boundaries and exact scaled integers internally.

Leader or platform defaults are recommendations only and cannot widen follower, account, owner, compliance or risk limits. A plan amendment is versioned, re-authorized and affects only new replication intents unless the follower explicitly authorizes a separate action on existing orders/positions. Funds remain in the follower account; no follower pool, omnibus strategy balance or leader claim exists.

## 11. Replication intent, order lineage, divergence, and recovery

A leader event is an authenticated observation, not an order authorization. `ReplicationIntent` freezes leader/profile/version/event ID, event and receive clocks, source environment, instrument/side/order semantics, original size/price, follower plan/version, sizing inputs, rounded result, market/risk snapshots, expiry and idempotency key.

Sizing may be fixed, proportional to authorized leader equity/exposure, target-allocation or another owner-approved deterministic method. It declares denominator source/age, min/step/tick rounding, remainder, maximum, reduce-only behavior and what happens when leader state is unavailable. It never infers an undocumented multiplier or increases size to meet venue minimum.

Every intent independently passes account ownership/entitlement, jurisdiction/compliance, market/product state, available balance, margin/collateral, follower and account risk, instrument/venue eligibility, price/slippage and concurrency checks. Only then does PX-S03 create a follower-owned parent/order with unique client ID. The leader cannot cancel, amend, withdraw, transfer, increase leverage or weaken controls in the follower account.

Replication state is:

`OBSERVED → DEDUPLICATED → ELIGIBILITY_CHECKED → SIZED → RISK_CHECKED → ORDER_RELEASED → WORKING → RECONCILING → ALIGNED`

or `REFUSED`, `BELOW_MINIMUM`, `INSUFFICIENT_FUNDS`, `LIMIT_BREACH`, `MARKET_UNAVAILABLE`, `STALE`, `PRICE_DIVERGED`, `PARTIAL`, `REJECTED`, `OUTCOME_UNKNOWN`, `DRIFTED`, `DETACHED`, `CORRECTION_PENDING`. Silent drop is never a state.

`DivergenceCase` compares leader intent/position with follower plan, order, fill and position: quantity/rounding, price/slippage, latency, partial/unfilled, missed/duplicate, fee/funding, leverage/margin, reduce-only, manual follower action and leader correction. It states whether no action, notify, stop-new, resync-new-intent, cancel or follower-approved repair is permitted. A repair is a new ordinary order, never retrospective fiction.

Redelivery returns the same lineage and cannot consume exposure or place twice. Timeout after dispatch uses order/fill lookup before retry. Leader bust/correction preserves the original follower fact; it does not auto-reverse unless the follower plan separately authorized a bounded repair. Dense fan-out, slow followers and capacity exhaustion degrade per follower without delaying or leaking other followers.

## 12. Start, pause, revoke, stop, detach, cancel, and flatten

Follower relationship state is:

`PROPOSED → CONSENTED → ACTIVE ↔ PAUSED → STOPPING → DETACHED`

with `EXPIRED`, `SUSPENDED`, `LEADER_UNAVAILABLE`, `CAPACITY_EXHAUSTED`, `RECOVERY_REQUIRED` and `WIND_DOWN`. Consent records leader/version scope, follower plan, account, risks, fees, conflicts, environment, expiry and disclosures.

- `PAUSE_NEW`: prevents new mirrors; existing orders/positions continue under their current authority.
- `REVOKE`/`STOP_NEW`: immediately fences new intent and revokes execution grants; it does not invent a close.
- `DETACH_KEEP`: stops copying and leaves existing orders/positions under the follower's ordinary control.
- `DETACH_CANCEL`: additionally requests cancellation of authorized open copied orders; fills and cancel-pending states remain truthful.
- `DETACH_FLATTEN`: after explicit preview/confirmation, cancels where authorized and submits new reduce-risk orders for the selected copied positions within account/risk/market authority.

Acknowledgement occurs only after the new-intent fence is durable and races are reconciled. Late leader events and fills are processed as facts. The UI/API must not use one ambiguous “stop” verb. If services are unavailable, a sovereign Protocol grant remains directly revocable by the follower when that path exists; the current Fiat service path must not claim this property.

Leader version change, delisting, suspension, compromise, disappearance, capacity exhaustion, extreme drawdown or control breach follows a versioned protection policy: stop new intent at minimum, preserve causal evidence, notify affected followers, show disposition choices, and apply automatic cancel/flatten only where the follower pre-authorized that exact action. Blank thresholds default to stop-new/review, not liquidation.

## 13. Compensation, conflicts, anti-gaming, and ledger truth

The accepted v1 compensation shape remains a share of the actually collected protocol trading fee, funded from the authorized house-fee path, never a markup to the follower and never a share of follower P&L. D26-P0-02 owns its magnitudes and caps; this child neither changes nor duplicates them. Flat subscription uses the existing marketplace/ledger authority only when terms, refund/correction, tax and legal capacity are published.

Each `CompensationAttribution` binds follower fill, leader/follower relationship and versions, fee event/asset/amount, applicable policy/rate/cap period, conflict/affiliate checks, gross/capped amount, ledger recipe keys, posting state, correction/refund and tax/reporting evidence. The settled fill fee is authoritative; notional × bps cannot manufacture the pot. All movement uses `ledger-client`; services hold no balance.

Unpublished or inapplicable law refuses accrual/payout. D26-P0-15 keeps follow creation closed in all regions pending a counsel-supplied list. P&L percentage, high-water mark, hurdle, success fee and equivalent outcome-linked compensation remain absent unless a later separately authorized legal/product contract explicitly supersedes that ban; this specification does not.

Anti-gaming links beneficial owners, accounts, devices/credentials and affiliate relationships within privacy authority and detects self-follow/self-trade, circular/affiliate volume, wash/churn, front-running or delayed signal release, illiquid marking, artificial closes, cherry-picked accounts/windows, deleted losing history, survivorship/version reset, capacity misstatement and duplicate compensation. Controls separate suspected evidence from adjudication, stop new exposure/payout safely, preserve appeal/correction and never fabricate PnL.

Platform, publisher, leader, broker, data-provider, routing, subscription and fee-share conflicts are disclosed with methodology and mitigation. No marketplace promotion, affiliate payment or fee-share changes follower risk checks or route priority.

## 14. Interfaces, causal evidence, degraded truth, and privacy

Terminal and mobile surfaces show environment, strategy/leader version, account/sub-account, authority, limits/headroom, input/data health, deployment/follow state, working children, position/exposure, costs, drift/divergence, alerts and last reconciled time. Destructive controls show scope and blast radius. Mobile is a secure risk-control surface for pause/revoke/cancel/flatten preview, not an unreviewed strategy-authoring or secret-recovery path.

REST/WebSocket/FIX/event interfaces reuse PX-S03/PX-S04 order/data contracts and add immutable version/deployment/follow/replication IDs. Sequence, replay, idempotency, schema version, corrections and entitlements apply identically. A client can subscribe to their own strategy/follower lineage and receive explicit partial/refused/diverged events; a disconnect never grants default resume.

The causal export is:

`data event → strategy/leader event → signal/decision → approval/plan/risk checks → route/parent/child → order/fill/cancel → position/fee/ledger → divergence/correction/control`.

It preserves rejected and missing branches, timestamps, source versions and operator actions. A follower sees only their own plan, orders, fills, fees and divergence plus leader facts authorized for disclosure; no other follower identity, allocation, order or PnL leaks. Strategy source, client data and leader IP follow view/export licences and retention/legal holds.

Customer-visible degraded states include stale/missing data, simulator limitation, shadow-only, approval expired, runtime unhealthy, live/order path disabled, leader suspended, capacity exhausted, follow geo closed, missed/partial mirror, outcome unknown and reconciliation pending. The system never substitutes a last-known value, historical claim or leader order for current execution truth.

## 15. Risk, security, capacity, incidents, and operations

Pre-trade and intraday risk apply per strategy/deployment/follower and aggregate with all manual, algo, copied and agentic activity in the account. Concurrent strategies reserve shared order, position, exposure, margin, loss, message and venue budgets atomically. One strategy cannot hide risk under versions, sub-accounts, followers or retries; one control action cannot unknowingly unwind another strategy's position without ownership/netting policy.

Security covers source/dependency integrity, signed build/image, secret isolation/rotation, least-privilege egress, tenant escape, malicious strategy code, deserialization, resource exhaustion, data poisoning, model artifact tampering, leader credential compromise, webhook/replay, session theft and export leakage. High-risk changes and emergency access are audited and time-bounded.

Capacity evidence covers historical replay throughput, burst market data, strategy fan-out, timer storms, many variants, dense orders, rejects/fills/cancels, leader-to-follower fan-out, slow or disconnected followers, simultaneous stops, runtime restart, region/dependency loss and reconciliation catch-up. Limits reject or shed non-money research work before compromising live risk/control. Owner-set SLO categories include input age, decision/order latency, control acknowledgement, heartbeat/recovery, copy delay/divergence age and reconciliation; blank targets remain visibly unset.

Incidents reuse PX-S13: fence new strategy/copy intent at the smallest safe scope, preserve authority and evidence, reconcile orders/positions/money, communicate environment and affected versions/followers, and restore by controlled canary. A model/data/leader incident can invalidate evidence and approvals. Status cannot claim live strategy/copy health from a healthy web process alone.

## 16. Migration, compatibility, suspension, and wind-down

Strategy schema, SDK, runtime, simulator, data and model changes use versioned compatibility, fixtures/golden replays, shadow dual-run and explicit migration. Existing deployments stay bound to their original version until reviewed; rollback restores an approved artifact, not mutable “latest.” State migrations prove checksum, idempotency and recovery from every boundary.

Copy migration preserves follow/plan/leader/fill IDs, grants, exposure and fee claims. Before any Fiat-to-Protocol migration, reconcile account ownership, open orders/positions, cap semantics and revocation; do not run both authorities against one follower simultaneously. The current service key cannot be relabeled an on-chain grant.

Suspension stops new research claims/listings/deployments/follows or intents at the smallest safe scope and preserves explicit disposition choices. Decommission resolves live orders and unknowns, transfers control of retained positions to the account owner, revokes credentials/grants, settles/reconciles fees through ledger authority, exports evidence, satisfies retention/deletion law and proves no orphan runtime, follow or compensation claim remains.

## 17. Testable Definition of Done

Implementation is complete only when evidence proves:

1. no-code and TS/Python compile to one deterministic typed model/version and cannot access undeclared money, network, secret or execution verbs;
2. dataset and experiment manifests reproduce every input, availability clock, variant and assumption and adversarially prevent look-ahead, survivorship and hidden-selection claims;
3. event replay models or names unsupported queue, partial, stale, cancel, fee, spread, slippage, latency, funding, borrow, margin, correction and capacity mechanics; incomplete evidence refuses promotion;
4. paper/shadow credentials and type boundaries make live order/ledger movement impossible, while schemas, decisions and reconciliation remain production-shaped;
5. approval/deployment tests prove immutable version/manifests, independent review, invalidation on change, expiry and launch-time authority/risk recheck;
6. sandbox and production runtime tests cover tenant/secret/network escape, resource exhaustion, restart at every checkpoint, source replay, existing positions/open orders and duplicate-intent prevention;
7. controls prove pause, drain, cancel, flatten, kill, rollback and undeploy have distinct audited blast radii and behave through races, late fills, stale UI and service loss;
8. monitoring and promotion reproduce signal-to-fill/cost/risk lineage, live/OOS divergence, severe-market capacity, canary and rollback against exact versions;
9. sharing/marketplace tests enforce permissions, ownership transfer, label live versus simulation equally, preserve losing/version history and refuse ranking/projection/conflict omissions;
10. leader eligibility and follower-plan tests prove source/tenure/cost/drawdown/capacity/conflict truth and that leader/platform inputs cannot widen follower or account limits;
11. replication tests cover rounding/minimum, latency/slippage, partial/unavailable/insufficient/reduce-only, duplicate/timeout/restart/correction and causal divergence without silent drops;
12. pause/revoke/detach/cancel/flatten tests prove immediate new-intent fencing, explicit disposition, late-event truth and no invented close;
13. compensation tests use the actual settled fee, accepted owner law and idempotent ledger recipes; cover cap concurrency, period migration, correction/refund, affiliate/self/churn abuse and prohibit P&L-linked fees;
14. counsel-jurisdiction blank refuses every follow, and Protocol-plane claims require on-chain scope/revocation evidence rather than service comments;
15. load/fault/security tests cover strategy and follower fan-out, order storms, dependency/region loss, compromise, simultaneous kill, recovery and customer/status truth;
16. migration, suspension, delisting, creator/leader disappearance and wind-down leave no orphan authority, order, position, fee claim, data or evidence.

## 18. Owner/external sockets and contradiction register

| Socket or conflict                       | Required authority / safe blank behavior                                                                                                                                                                                                                    |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `socket.live-strategy-eligibility`       | Owner/legal/risk publish products, entities, accounts, review roles, promotion evidence, capital/risk envelopes, compute/network/secrets and SLOs. Blank: no live deployment.                                                                               |
| `socket.data-model-and-capacity-law`     | Owner/data/risk publish admitted datasets, licences, model assumptions, unsupported mechanics and promotion/capacity thresholds. Blank/incomplete: dependent result cannot promote or make a professional claim.                                            |
| `socket.marketplace-and-claims`          | Owner/legal publish publisher capacity, allowed claims, review, subscription terms, conflicts, capacity, retention and delisting. Blank: private research only; no listing or recommendation.                                                               |
| `socket.copy-jurisdictions`              | D26-P0-15/counsel supplies served jurisdictions. Current authoritative blank is closed everywhere; no engineer-authored or stale example array may open it.                                                                                                 |
| `socket.leader-policy-and-protection`    | Owner/legal/risk publish eligibility, capacity, concentration, drawdown/control triggers, communications and legal capacity. Blank: no new followers; factual private history may remain without eligibility claim.                                         |
| Accepted D26-P0-02 fee-share             | Owner-set protocol-fee-share magnitudes/source remain binding by reference. Host blank still refuses. This contract does not change them, authorize P&L fees or invent subscriptions.                                                                       |
| Sovereign Protocol versus current Fiat   | Contract target is follower-owned on-chain scope/revocation; current `svc-trade` implementation is a Fiat service envelope/key. They are distinct capacities. No non-custodial/on-chain claim until the Protocol path proves enforcement and direct revoke. |
| Fee pot formula                          | Current settled `fill.fee_amount` plus ledger recipes supersede illustrative notional-derived prose. Never reconstruct a collected fee or post from an unfunded/second book.                                                                                |
| Pair-lifetime versus period counters     | Current durable copy statistics have no period key. They must be labeled lifetime until a versioned period authority/migration exists; accepted cap/decay semantics cannot be represented as period-complete meanwhile.                                     |
| Tracker/README versus product completion | Built quant/copy doors prove their exact functions only. They cannot promote typed versioning, deployment, live parity, leader integrity, copy capacity or end-to-end sovereign execution.                                                                  |
| Agentic delegation boundary              | PX-S16 may add probabilistic proposal/supervision semantics but cannot widen the strategy/follower account, risk, order, ledger, revocation or kill authority defined here.                                                                                 |

## 19. Requirement-level proof map

| Requirement   | Authoritative clauses | Implementation truth after this specification                                                                                                                                             |
| ------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PTX-M24-R01` | §§4–5, 7–8, 14–17     | Narrow studio and JS/TS/Python sandbox foundations exist; shared professional typed model, deterministic registry and SDK parity remain incomplete.                                       |
| `PTX-M24-R02` | §§2–6, 14–17          | Fill-window and honesty gates are built foundations; complete event mechanics, dataset lineage, returns and capacity models remain incomplete.                                            |
| `PTX-M24-R03` | §§2, 4–6, 9, 14, 17   | Walk-forward/OOS and variant-count refusal exist; immutable experiment lineage and exhaustive selection-bias proof remain incomplete.                                                     |
| `PTX-M24-R04` | §§4, 6, 8, 14–17      | Exact-money isolated paper execution is partial; production-shaped paper/shadow buses, credential separation and integrated parity evidence remain absent.                                |
| `PTX-M24-R05` | §§4, 6–8, 14–18       | Deployment manifest semantics are authoritative; no complete durable institutional deployment registry/orchestrator exists.                                                               |
| `PTX-M24-R06` | §§4, 6–9, 16–18       | Review, approval, version invalidation and separation semantics are authoritative; organizational workflow is not implemented.                                                            |
| `PTX-M24-R07` | §§4, 7–8, 14–18       | Restricted interpreter proves a bounded sandbox; production isolation, checkpoints, authoritative restart and recovery remain incomplete.                                                 |
| `PTX-M24-R08` | §§7–8, 12, 14–18      | Control state and blast-radius semantics are authoritative; integrated live launch/pause/drain/cancel/flatten/rollback/undeploy evidence is absent.                                       |
| `PTX-M24-R09` | §§4, 8, 11, 14–17     | Typed tracing/order foundations are partial; exact signal-to-cost/risk/drift/version observability is not complete.                                                                       |
| `PTX-M24-R10` | §§2, 5–8, 15–18       | Promotion/parity/capacity/canary/rollback semantics are authoritative; end-to-end gates and evidence are unimplemented.                                                                   |
| `PTX-M24-R11` | §§4, 7, 9, 14, 16–18  | Sharing/ownership/revocation semantics are authoritative; complete permissions and orphan-safe transfer are unimplemented.                                                                |
| `PTX-M24-R12` | §§2, 4, 6, 9, 13–18   | Subscription listing and honesty refusal foundations are partial; verified claims, capacity, continuity, conflict and wind-down governance are incomplete.                                |
| `PTX-M26-R01` | §§2–4, 9–10, 13–18    | Copy-intelligence factual/refusal foundations exist; complete leader eligibility, capacity, beneficial-owner and history proof remains incomplete.                                        |
| `PTX-M26-R02` | §§4, 7, 10–12, 15–18  | Current follow envelopes have market/notional/exposure/expiry caps; explicit sub-account plus full leverage/loss/slippage/concentration limits remain incomplete.                         |
| `PTX-M26-R03` | §§4, 10–12, 14–18     | Exact idempotent fill mirror planning is partial; sizing methods, minimum/rounding, price/latency, partial and position-drift reconciliation are incomplete.                              |
| `PTX-M26-R04` | §§1, 4, 7, 10–15, 18  | Ordinary follower principal/order checks exist on the bounded path; authoritative leader-as-input-only semantics now close without complete sovereign/live proof.                         |
| `PTX-M26-R05` | §§4, 8, 10–12, 14–18  | Unfollow and service-key kill exist; distinct pause/stop/detach/cancel/flatten disposition and direct sovereign revoke are incomplete.                                                    |
| `PTX-M26-R06` | §§3–4, 9, 13–18       | Accepted fee-share and ledger implementation are substantial; period-key truth, full correction/tax/reporting and any subscription terms remain incomplete, while P&L fees remain banned. |
| `PTX-M26-R07` | §§9–12, 14–18         | Protection/change/delist/capacity/disappearance semantics are authoritative; triggers and end-to-end automation remain owner-set/unimplemented.                                           |
| `PTX-M26-R08` | §§9–10, 13–18         | Self-follow, returns-ranking and churn/cap foundations exist; comprehensive beneficial-owner, manipulation and survivorship controls remain incomplete.                                   |
| `PTX-M26-R09` | §§4, 11–18            | Fill/follow IDs and audited stats are partial; complete private leader-intent-to-follower-outcome export and divergence evidence are incomplete.                                          |
| `PTX-M26-R10` | §§1, 4, 7–16, 18      | One delegation model across signals, marketplace, API, copy and future managed execution is authoritative; adapters remain incomplete and cannot create parallel authority.               |

Every primary ID assigned to `PX-S15` appears exactly once in this map. This contract specifies product semantics; it does not promote implementation maturity, authorize a live strategy/leader, open a jurisdiction, or complete copy/quant products.

## 20. Implementation gaps and precedence

Specification completeness is not product completion. Material gaps are a durable typed strategy/version/experiment registry; full data lineage and event simulator; paper/shadow parity; institutional review/deployment/runtime/recovery/control; exact monitoring and promotion; sharing/marketplace claims; leader eligibility/capacity/protection; complete follower limits and divergence; explicit stop disposition; period-key compensation; comprehensive anti-gaming/export; counsel jurisdictions; and the sovereign Protocol-plane path.

Precedence is: doctrine and canonical SoT; accepted owner directions/ADRs including D26-P0-02 and D26-P0-15; PX-S01/PX-S02 rule and authority; PX-S03 execution; PX-S06 risk; PX-S10 fees/conflicts; PX-S12 ledger/finality; PX-S13 incident/recovery; PX-S14 route/external truth; then this lifecycle contract. PX-S16 may specialize agentic behavior but cannot weaken it. A tracker row, comment, backtest label, listing, leader signal, runtime output, service key or model decision never supersedes account authority, ordinary risk/order checks or ledger truth.
