# INTAFACED Professional Terminal, OMS, Desk Workflow, and TCA Specification

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Status:** Authoritative product contract; implementation incomplete

**Authority:** `PX-S05`; bounded child of [`PRO_TRADER_EXCHANGE_DEFINITIVE_SCOPE.md`](../PRO_TRADER_EXCHANGE_DEFINITIVE_SCOPE.md)

**Primary requirements:** `PTX-M07-R01–R17`, `PTX-M25-R01–R12`

**Predecessors:** `PX-S01` rules and market states, `PX-S02` account/actor authority, `PX-S03` order and execution lifecycle, `PX-S04` connectivity/data/recovery, `PX-S06` risk and liquidation, `PX-S13` resilience and incident truth

**Systems of record:** the terminal and OMS are control/read-model surfaces, not independent economic authorities; orders and executions remain in their PX-S03 SoRs, risk in PX-S06 SoRs, and all value movement in `packages/ledger-client` plus `svc-ledger`; this contract owns professional workspace, desk-ownership, care-order, execution-analysis, and human-control semantics

---

## 1. Product promise, professional jobs, and boundary

Discretionary and systematic traders, market makers, execution traders, portfolio managers, agency/broker desks, risk officers, operations, compliance/best-execution reviewers, and mobile approvers can see authoritative state, express permitted intent safely, manage complex execution across people and sessions, and reconstruct why an outcome occurred. This determines primary-venue adoption because professional flow will not remain on a venue whose screen can be stale, duplicate intent after reconnect, orphan a live child, lose the responsible desk, or offer TCA that cannot reproduce its inputs.

Catastrophic or dishonest outcomes include a destructive hotkey hitting the wrong account; live and simulation being confused; a browser restart replaying an order; dense books or burst fills silently dropping state; a care order exceeding its mandate; a shift creating unowned live risk; a manual fill rewriting history; a dashboard declaring an order cancelled from transport acknowledgement alone; or analytics inventing causality, liquidity, benchmarks, costs, or best execution.

M07 and M25 remain grouped. The terminal is the human authority and evidence surface for OMS ownership, high-touch execution, exceptions, and TCA. Splitting them would permit attractive controls without desk authority, or a care/TCA model that cannot be operated and inspected safely.

Non-goals:

- no second product SPA, matching/order book, position book, risk engine, ledger, market-data authority, or execution router is created;
- this contract does not claim the bounded `svc-execution` OMS/SOR/EMS slice is a complete professional OEMS;
- no account, venue, client, legal entity, benchmark, fee, capital, mandate, confirmation, retention, performance, mobile, SLO, or approval policy is invented;
- a TCA result is measurement and governance evidence, not a promise of best execution, profitability, causality, or regulatory compliance;
- mobile is not full desktop parity and never bypasses ordinary authentication, account, risk, order, ledger, revocation, or kill controls.

## 2. Research delta and durable patterns

Current official sources materially add these durable requirements:

- [Trading Technologies order passing](https://library.tradingtechnologies.com/trade/ops-order-passing-overview.html) separates originator from caretaker, keeps account risk with the submitted order, retains queue continuity, preserves shared visibility, and uses explicit pending/accept/reject states. INTAFACED adopts those invariants, not TT's implementation.
- [Trading Technologies staged-order workflow](https://library.tradingtechnologies.com/trade/co-uploading-and-staging-orders.html) and [order-entry/manual-fill guidance](https://library.tradingtechnologies.com/trade/ot-submitting-an-order.html) reinforce preview, authorization, held versus staged versus exchange-live truth, claimable care orders, and append/offset treatment rather than history mutation.
- [Trading Technologies workspace model](https://library.tradingtechnologies.com/trade/overview/workspace-windows/description-workspace-windows/workspace-windows-overview.html) reinforces multiple saved windows, movable widgets, and intentional workspace recovery; layout persistence is operational state and must not imply trading-state persistence.
- [Bloomberg execution management](https://professional.bloomberg.com/products/trading/execution-management-system/) reinforces interoperable pre-trade, OMS, execution, and post-trade workflows across electronic and voice/manual handling, with auditability rather than one execution style.
- [Bloomberg BTCA](https://professional.bloomberg.com/products/trading/trade-analytics/btca/) reinforces consistent cross-source analytics, asset-appropriate benchmarks, cost attribution, exception review, and a decision-to-post-trade evidence loop.
- [FIX Trading Community data and transparency guidance](https://fixtrading.org/guidelines/data-transparency/) reinforces standardized venue, capacity, liquidity, method, and point-in-time execution data so routing and best-execution review can be reconstructed interoperably.

These are professional workflow patterns, not legal-applicability findings, protected implementation details, or authorization to invent commercial policy.

## 3. Repository evidence audit

| State       | Evidence and bounded truth                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `BUILT`     | `svc-execution` has route planning over the existing SOR, execute/cancel/fetch procedures, venue/account adapters, balances/positions/open-order reads, and an EMS acknowledgement journal. `svc-edge` publishes an admin-scoped OMS consumer-door description.                                                                                                                                                                                                                                                                |
| `PARTIAL`   | The vendored terminal contains a real exchange workspace, live depth adapter, chart/order/depth/trade/position assets, localization and exact-wire guards. OMS snapshot polls now record measured books and typed holes into the capture lake, with persistence refusing when owner TSDB inputs are blank. Portfolio, risk and terminal fragments exist, but no integrated professional workspace, complete order toolkit, point-in-time TCA corpus, reconnect proof, performance envelope, or mobile control plane is proven. |
| `SPECIFIED` | PX-S01/PX-S02/PX-S03/PX-S04/PX-S06/PX-S13 bind rules, authority, lifecycle, data recovery, risk and incident truth consumed here.                                                                                                                                                                                                                                                                                                                                                                                              |
| `SOCKET`    | Legal/client roles, mandate/discretion rules, confirmations, benchmark/fixing definitions, approval matrices, layout/profile policy, mobile policy, TCA methodology, retention and performance/SLO magnitudes require owner or legal authority.                                                                                                                                                                                                                                                                                |
| `EXTERNAL`  | Venue feeds/order sessions, consolidated/reference/economic data, third-party OEMS/OMS, client allocations, notification/push, benchmark licenses, app distribution and device-attestation evidence remain provider-dependent.                                                                                                                                                                                                                                                                                                 |
| `ABSENT`    | No care/staged-order ownership service, claim/pass/shift workflow, client mandate/allocation/manual-fill system, formal TCA/markout/best-ex reconstruction engine, secure mobile risk-control plane, or production-shaped terminal capacity/recovery proof was found.                                                                                                                                                                                                                                                          |

The `execution.sor` tracker row is truthful only for its named bounded slice. At assurance baseline `1a17a85ab03cf549243d0b62565eeec4ecd84b11`, the `svc-execution` README statement that the service was not an OMS/SOR/EMS was stale relative to code, tests, tracker evidence, and history; repository history now records the separate service-scoped correction. Conversely, the delivered slice does not contain parent/care ownership, allocations, formal TCA, or the complete north-star terminal.

## 4. Canonical objects, identifiers, versions, and clocks

Canonical objects include `Workspace`, `Window`, `Widget`, `LinkGroup`, `LayoutVersion`, `OrderProfile`, `AlertRule`, `SessionHealth`, `ControlLock`, `DeskOrder`, `CareOrder`, `Mandate`, `OwnershipTransfer`, `ParentExecution`, `ChildExecution`, `ManualFill`, `Allocation`, `Correction`, `CausalTree`, `TcaRun`, `BenchmarkObservation`, `CostAttribution`, `Markout`, `BestExecutionReview`, `WhatIfRun`, `ExceptionCase`, `JournalEntry`, and `MobileCommand`.

Stable IDs include organization/legal owner, account/sub-account, actor/session/device, workspace/layout/profile/version, instrument/product/venue/market-data stream, order/client-order/parent/child/list/strategy/algo/RFQ/quote/execution/fill/allocation/mandate, ownership transfer, approval, benchmark/data capture, TCA run/methodology/version, exception/correction, command/idempotency, and incident. IDs reference predecessor SoRs; a view identifier never replaces an economic identifier.

Timestamps distinguish decision, instruction receipt, staged, claimed, released, order accepted, venue sent/acknowledged, match/execution, market-data event/receive/capture, benchmark observation, allocation, correction, notification, and review times. Each records source, timezone rendering, synchronization/uncertainty, and correction status. Display time never becomes sequencing authority.

Layouts, profiles, widgets, analytics methodologies, benchmark definitions, schemas, rules and renderers are versioned independently. Historical reconstruction binds the exact versions effective at each event; recalculation is labeled and never overwrites the originally delivered result.

## 5. Trust, account, client, and authority boundaries

Every terminal action resolves the PX-S02 principal, organization/legal owner, account/sub-account, role/grant, session/device, environment, origin surface, network policy, and current revocation/kill state server-side. Hidden, disabled, colored, or locked UI is not authorization. Deep links, browser tools, replayed messages, plugins, imported layouts and mobile commands face the same checks.

Client/broker/agency behavior is enabled only when entity, capacity, account ownership, mandate, disclosure, consent, conflict and reporting policy are owner/legal-approved. `originator`, `client`, `executionOwner`, `caretaker`, `approver`, and `accountRiskOwner` remain distinct. Passing monitoring or execution control never transfers account risk, money, legal ownership, original authority, or audit attribution.

Each live surface shows environment, legal owner, organization, account/sub-account, product, currency/settlement context, permission scope and trading-enabled state. Account colors are secondary cues; text/icons and confirmations carry meaning accessibly. Cross-account views aggregate read-only unless an explicitly scoped action enumerates every target and is independently authorized.

## 6. Workspace, windows, layouts, and portability

A workspace contains versioned windows/widgets with stable instance IDs, geometry, monitor affinity, tabs, filters, columns, link groups, symbol/account context, profiles, alerts and hotkey bindings. Users can create, clone, rename, detach, resize, tile, dock, move, save, publish, recover, compare and restore known-good versions subject to organization permissions.

Multi-monitor recovery handles missing/reordered displays, DPI/zoom changes and window bounds without hiding critical controls off-screen. A recovered layout is visibly draft until all authoritative subscriptions and account contexts resolve. Duplicate tabs/windows identify shared session/account subscriptions and cannot independently replay pending intent.

Shared templates never carry secrets, private data, unapproved account IDs, active confirmations, pending orders, unlock state or delegated authority. Import validates schema/version, provenance, permissions, plugin/widget allowlists and hotkey conflicts. Incompatible or corrupt state quarantines the affected artifact and offers a known-good version; it does not reset silently.

Keyboard and command-palette navigation are complete and accessible. Focus is visible, modal traps are prevented, and commands display resolved scope before execution. Layout sync conflicts preserve both versions or use an explicit merge; last-writer-wins cannot silently discard a safety control.

## 7. Market, chart, order-flow, and calendar surfaces

Charts provide durable drawings, indicator templates, multi-chart link groups, compare, replay, alerts, order/fill/position/benchmark overlays and visible adjustment/provenance. DOM/ladder, L1/L2/L3 depth, heatmap, tape, footprint/order flow, spread matrix, watchlists, scanners and market statistics share canonical instrument, venue, sequence, precision and clock semantics from PX-S04.

Every surface displays source/venue, snapshot/delta state, sequence/gap, checksum where supported, event/receive age, last-good time, correction and entitlement. `LIVE`, `STALE`, `GAPPED`, `RECOVERING`, `DELAYED`, `HISTORICAL`, `SIMULATED`, `UNENTITLED`, and `UNAVAILABLE` are visually and machine distinct. A chart or cached book cannot remain trade-colored after its authoritative feed is stale.

Cross-widget linking propagates explicit context events, not executable intent. A symbol/account change never submits, amends, cancels or rebinds a pending ticket. Mixed venues, currencies, contract multipliers, price types and adjusted histories remain labeled.

One calendar covers funding, expiry/exercise/settlement, listing/delisting, maintenance, governance, economic events and exchange announcements with source, version, effective time, affected products/accounts and correction. In-app, push, email, webhook and sound delivery are configurable and evidenced; an undelivered notice is not acknowledgement.

## 8. Tickets and complete execution workflows

The terminal exposes every PX-S03 native order and strategy only through the canonical schemas and capability matrix. Tickets cover supported market/limit/stop/trigger, time-in-force, post/reduce-only, iceberg/reserve, pegged/discretionary, bracket/OCO/OTO, TWAP/VWAP/participation/implementation-shortfall, spread/multi-leg, basket/list, RFQ/block and routed workflows without flattening their distinct state machines.

Each preview resolves account, product/rule version, side, exact decimal price/quantity/notional, position effect, estimated fees/funding/borrow/FX, risk/margin/capital effect, route/venue capability, liquidity assumptions, child/hedge plan, expiry and required approvals. Estimates are labeled with source/time/confidence and cannot be reused after material state or rule change.

Presets and order profiles are permission-scoped and versioned. One-click and drag-amend actions require owner-approved protection by risk/blast radius. An amendment preserves causal order identity and exposes cancel-replace/queue-priority consequences; it never appears successful before authoritative acknowledgement.

Join/cross/reprice-by-tick, cancel, cancel-all, close, flatten and reverse commands first resolve affected accounts, positions, orders, children, hedges, venues and reduce-only consequence. Bulk results are per-target `ACCEPTED`, `REJECTED`, `UNKNOWN`, `PARTIAL`, or final; transport acceptance is not exchange finality. Unsupported combinations refuse with structured reasons.

## 9. Blotters, risk workspace, and causal trees

Blotters unify but distinguish native, routed, synthetic, algo, RFQ, care, liquidation, manual and correction records. Views cover orders, fills, positions, strategies, transfers, funding, borrow, allocations and errors with server-backed pagination, stable sorting, filters, exports, provenance, exact precision and access-controlled columns.

Risk views consume PX-S06 truth: collateral, utilization, valuation/model version, Greeks, scenarios, concentration, limits, liquidation bands, warnings, insurance/default/ADL states and freshness. They neither recalculate authoritative margin locally nor convert unknown into zero. Money crosses boundaries as decimal strings and is represented internally by exact types; the terminal never posts, settles, reverses or corrects value.

Each parent/strategy tree shows mandate, originator, current owner/caretaker, account, venue/route, children, hedges, working exposure, fills, rejects, amendments, cancel state, unknown outcomes, orphans and every causal message. Aggregate quantities reconcile exactly to children, fills, residual and corrections. Missing nodes or gaps create an exception; the UI does not synthesize a plausible tree.

## 10. Session health, stale state, reconnect, and recovery

The persistent status surface independently reports authentication/session expiry, trading/order connection, private order/fill/position/risk sequence, every market-data subscription, clock quality, software/schema/rule version, storage/sync, external venue/dependency and incident state.

On crash, sleep, refresh, duplicate tab, network/interface change, endpoint migration or reconnect, a client enters `RECOVERY_LOCKED`. It authenticates anew as required, negotiates versions, fetches authoritative snapshots, resumes/replays sequences, reconciles pending commands by idempotency key/client order ID, resolves `UNKNOWN` outcomes, and only then enters `TRADING_READY`. Visual market data may recover separately; trading remains locked until private/account/risk truth is reconciled.

Retries reuse the original economic idempotency root and never manufacture new intent. In-flight tickets are drafts unless server acknowledgement proves acceptance. Conflicting tabs coordinate client-side for usability but correctness remains server-side; either may cancel only with current authority. Logout/revocation/kill invalidates all windows and mobile sessions at the authority boundary.

Stale, gapped or recovering fields retain last-good value only with state/age/provenance. If displaying it could authorize unsafe action, the action refuses. Recovery history and corrections remain inspectable after readiness returns.

## 11. Safety controls and destructive operations

Locks distinguish `VIEW_ONLY`, `ORDER_ENTRY_LOCKED`, `RISK_INCREASE_LOCKED`, and scoped operational/incident states. Live versus simulation/testnet uses persistent non-color labels, different environment identifiers, credential domains and confirmation language. Simulation can never route to live endpoints or use live money authority.

Hotkeys declare scope, focus requirements, repeat behavior, debounce/idempotency, confirmation tier and conflict resolution. Destructive keys are disabled by default until explicitly permitted, cannot fire while typing or from an untrusted embedded component, and show the resolved action/account/product. Held keys, key repeat and OS/layout changes cannot emit repeated economic intent.

Kill, cancel-all, close, flatten and reverse use named PX-S02/PX-S03/PX-S06 authority and show blast radius before action except a narrowly defined emergency path. `flatten` is not a promise of immediate fill; it reports child orders, residual, rejects, slippage/market state and final position. `reverse` is flatten plus separately authorized new risk and cannot bypass a risk-increase lock.

## 12. Care, staged, held, and mandate state machines

A `CareOrder` is a client/desk instruction and is never exchange-live merely because it exists. Minimum fields include originator, client/legal owner, account, instrument, side, aggregate quantity, limit/benchmark, urgency, discretion, expiry, execution objectives/restrictions, compliance/conflict tags, instructions, current owner and version.

State machines are explicit:

- care lifecycle: `DRAFT → STAGED → AVAILABLE → CLAIMED → WORKING → COMPLETED | CANCELLED | EXPIRED | REJECTED`, with `SUSPENDED`, `CORRECTION_REQUIRED` and `UNKNOWN` side states;
- held child: `CREATED → HELD → RELEASE_REQUESTED → LIVE`, or `CANCELLED/REJECTED/EXPIRED`; held is not staged and not live;
- ownership: `UNASSIGNED → CLAIM_PENDING → OWNED`; pass uses `OWNED → PASS_PENDING → OWNED_BY_CARETAKER`, with accept, reject, undo and timeout transitions preserving the prior responsible owner until acceptance;
- mandate changes: `PROPOSED → APPROVAL_REQUIRED → APPROVED → EFFECTIVE`, or `REJECTED/EXPIRED`; no retroactive approval.

Every transition checks optimistic version/concurrency, actor/grant, mandate, account/risk/rule state and idempotency. Claim, unclaim, assign, pass, accept, reject and undo-pass retain original authority, current responsibility, shared visibility, live-order continuity and immutable history. There is no interval in which a live order lacks a responsible owner.

## 13. Shift handoff and desk collaboration

A handoff package enumerates desks/groups, outgoing/incoming actors, effective window, accounts, care parents, live children/hedges, unknown outcomes, instructions, exceptions, client/reporting obligations, incident/degraded state and evidence watermark. Both sides see differences between package creation and acceptance.

Handoff requires authorized offer and acceptance; until acceptance the outgoing owner remains responsible. Rejection, timeout or revocation leaves ownership unchanged and alerts supervision. Emergency reassignment uses named break-glass authority and retrospective review, never an unaudited database edit.

The handoff transfers permitted monitoring/management only. It does not change account, originator, economic owner, mandate, queue position, risk ownership or money. Orders/fills arriving during transfer are sequenced into both views and acknowledged against the final accepted watermark.

Comments, tags and instructions are append-only/versioned and access controlled. Chat text cannot widen mandate or act as approval; structured authority must be resolved by the owning service.

## 14. Parent, child, bulk, manual-fill, allocation, and correction law

The parent mandate caps total released plus held plus filled quantity, price/benchmark discretion, instruments/venues, time window, risk and client restrictions. Split, bulk, stitch, combine, stage, hold, release, algo, RFQ, routed and manual workflows reserve quantity atomically and cannot double-count concurrent children.

Cancel/change requests and price worsening use explicit request, approval, applied/rejected/unknown and client-notification states. A client instruction version cannot be silently replaced. Partial success yields target-level results and a residual action; bulk success is never inferred from one acknowledgement.

A `ManualFill` identifies external source/counterparty, account, instrument, side, exact price/quantity/fees, trade/fill time, settlement context, evidence, actor, approval and idempotency root. It cannot create ledger value or rewrite an execution. Once recorded it is immutable; error correction appends a reversal/offset and corrected record through the owning order/position/ledger authorities. External confirmation and reconciliation are required before it becomes authoritative position or money truth.

Allocations preserve parent/fill lineage, exact quantities, prices/cost methodology, account eligibility, rounding residual, booking/settlement status, approvals, client confirmation and corrections. Allocation breaks remain exceptions and cannot be hidden by aggregate totals. No cross-client transfer or average-price policy exists until owner/legal authority supplies it.

## 15. TCA inputs, benchmarks, and reproducibility

Each `TcaRun` binds order/parent/mandate/version, decision and arrival times, execution interval, account/client permissions, instrument/reference versions, venue and route universe, available and excluded liquidity, market-data capture/checksums/gaps/corrections, FX/fee/funding/borrow inputs, benchmark definitions, methodology/software version and data entitlements.

Supported benchmark classes include decision price, arrival price, interval VWAP/TWAP, midpoint, close/fixing, quoted spread and explicit client benchmark. Availability is product/data dependent. Each declares source, venue/universe, calculation window, weighting, side/sign convention, currency/units, clock quality, adjustment/correction and confidence. A missing or unlicensed input yields `UNAVAILABLE` or bounded partial analysis, never a fabricated benchmark.

Original results are retained. Corrected data or methodology creates a new linked run showing the delta and reason. Reproduction can resolve the exact input digests and calculation steps without needing today's mutable configuration.

## 16. Cost attribution, markouts, and pre-trade what-if

Cost attribution separately reports quoted/effective spread, price improvement or spread capture, explicit fees/rebates, market impact, delay/timing, opportunity cost/unexecuted residual, funding, borrow, FX conversion, venue/routing and hedge/legging effects where the data and methodology support them. Components state overlap/non-additivity; no unexplained residual is forced into a named cause.

Markouts use declared horizons and reference prices with source, clock, sign, correction and confidence. They slice by order/parent, strategy/algo, trader/desk/client, venue/counterparty, maker/taker, route, account, instrument and market regime only where privacy and sample-size policy permit. Association is not causation; small/selected samples and survivorship are disclosed.

Pre-trade what-if compares only eligible execution methods and estimates market impact, risk/margin/capital use, fees/rebates, funding/borrow/FX and legging/hedge risk. Inputs, model version, scenario, age, confidence and unsupported dimensions are explicit. It creates no order and grants no authority; choosing a scenario still passes ordinary preview, mandate, rule, risk and approval checks.

## 17. Best-execution reconstruction and exception oversight

A review reconstructs the point-in-time mandate, authorized venues/counterparties, accessible liquidity, entitlements, exclusions with reasons, route/algo decisions, quotes/books, rejects, throttles, amendments, partial fills, market movement, conflicts/affiliate status, costs and final residual. It distinguishes venue availability from hypothetical global liquidity and retains missing/gapped data honestly.

Best-execution policy, applicability, review thresholds, approvers, client disclosure and report format are owner/legal sockets. The system supplies evidence and exceptions; it cannot infer that cheapest price alone is best, or assert compliance from one metric.

Exception dashboards cover unattended care/live orders, orphaned children/hedges, unknown or unconfirmed fills, mandate/limit breaches, failed hedges, stale ownership/handoff, allocation breaks, missing benchmark/data, TCA outliers, conflicts and overdue client/reporting obligations. Each has severity/socket, owner, state, evidence, action, escalation, correction and closure. Suppression/threshold changes are versioned and reviewed.

## 18. Journal, replay, export, and reporting

The trader journal attaches rationale, strategy, tags, notes, links and screenshots to immutable order/fill/TCA references. Edits create versions with actor/time/reason. User notes cannot alter authoritative PnL, order, fill, allocation, ledger or surveillance history and are subject to privacy/retention/legal-hold policy.

Replay uses captured historical data and the effective rules/layout/analytics versions, displays `HISTORICAL SIMULATION`, disables live command routing and separates simulated annotations/results. It does not claim fills from viewed book data unless the simulation methodology supports and labels that assumption.

Exports and statements preserve exact decimal strings, IDs, timestamps/source clocks, versions, status/finality, provenance, entitlements, correction links and generation parameters. Large export jobs are asynchronous, access-controlled, checksummed and expiry-bound. CSV/spreadsheet output prevents formula injection; screenshots are supporting evidence, never the sole record.

## 19. Secure mobile risk-control plane

Mobile supports authenticated monitoring, alerts, incident/status, approval, scoped cancel-all and risk reduction only when the same server-side authority and data freshness as desktop are available. New complex risk, bulk import, layout administration, manual fills and policy changes are non-goals unless separately specified and proven.

Device binding/attestation policy, phishing-resistant authentication where approved, secure local storage, screen/privacy controls, notification redaction, jailbreak/root posture, remote revocation and session limits are sockets under PX-S02. A push notification is not authorization or delivery proof; deep links reauthenticate and resolve current server truth.

Every command shows environment, account, product, scope, last-good state and expected blast radius. Offline actions are drafts only and cannot queue live money/order intent. Loss of private/risk sequence locks commands; emergency cancellation still requires authoritative target and returns per-order finality/unknown truth.

## 20. Capacity, degraded behavior, observability, and incidents

PX-S13 owns SLO/capacity magnitudes. Terminal evidence must cover long sessions, dense L3/hot symbols, large portfolios, many charts/widgets/windows/monitors, burst fills, order/cancel storms, reconnect/replay waves, large trees/blotters/exports and slow devices/networks. Budgets distinguish input latency, authoritative event-to-render delay, frame/render work, memory/CPU/network/storage and recovery time.

Graceful shedding drops animation, off-screen rendering, optional indicators and historical depth before current private state, safety controls or causal evidence. Sampling/aggregation is labeled and never changes execution truth. A slow widget cannot block cancel or corrupt the shared event stream; bounded queues expose loss/gap and trigger recovery.

Observability correlates client session/build/schema, workspace/widget, stream/sequence, command/idempotency, server order/fill and incident without logging secrets or unnecessary private content. Client crash/performance reports include consent and redaction policy. Status truth follows PX-S13 and never claims recovery before private/order/risk reconciliation.

## 21. Security, integrity, surveillance, privacy, and retention

Untrusted market text, imported files/layouts, links, screenshots, plugins and external content are isolated and escaped. Content cannot invoke command APIs or read secrets/account data. CSP/supply-chain/artifact signing, dependency policy, secrets handling and extension permissions require security evidence.

All order, ownership, manual-fill, allocation, approval, hotkey, bulk and correction actions are surveillance/audit inputs with actor, account, device/session, causal IDs and effective rule/version. Affiliate/house/client roles remain visible to conflict and surveillance controls. Productivity shortcuts cannot bypass self-match, market-integrity, credit/risk or sanctions/compliance gates.

Privacy uses least-visible account/client scope, column/export redaction, screen-share mode, tenant isolation, purpose limitation, retention and legal hold. TCA cohorts/peer comparisons require authorization and minimum-disclosure policy; no client or venue confidential data is repurposed silently.

## 22. Migration, compatibility, rollout, rollback, and wind-down

Adopt the existing product shell, terminal assets, PX-S03 order contracts and `svc-execution` slice incrementally. Introduce read-only authoritative projections and session truth first; then guarded execution parity; then care/ownership; then allocations/manual evidence; then TCA and mobile controls. Shadow calculations cannot place orders or publish client conclusions.

Schema/layout/profile changes use expand/migrate/contract compatibility and rollback tests. A client downgrade refuses unsupported live controls rather than dropping fields. Rollback restores software for new actions but never rewrites accepted orders, fills, ownership transfers, allocations, corrections or TCA history.

Feature rollout is scoped by environment, organization/account, product, surface and permission with observable kill/disable. Suspension preserves cancels/reduce-only and evidence where authoritative. Decommission exports portable layouts/profiles, orders/fills/ownership/allocations/TCA/journals under retention policy, revokes credentials/sessions, reconciles all live parents/children/exceptions and preserves wind-down access; it never strands live risk behind a retired UI.

## 23. Definition of Done

PX-S05 is implementation-complete only when evidence proves:

1. all 29 requirements below pass desktop/browser and applicable mobile conformance against authoritative SoRs;
2. every PX-S03 order/algo workflow has capability-driven preview, submission, amendment, cancellation, causal display, recovery and refusal truth;
3. crash/sleep/network/refresh/duplicate-tab/reconnect tests recover server truth and never duplicate economic intent;
4. saved/multi-monitor/shared layouts, profiles, hotkeys and alerts pass version, permission, corruption, conflict, rollback and accessibility tests;
5. stale/gapped/corrected data and session/dependency states are visible and gate unsafe actions;
6. long-session, dense-book, large-portfolio, burst-fill, multi-window and recovery loads remain within approved budgets with safe shedding;
7. care/held/staged/claim/pass/shift/mandate/bulk/manual-fill/allocation/correction state machines pass concurrency, permission, failure and reconciliation tests;
8. parent/child/hedge quantities, exposure and causal evidence reconcile with order, risk, execution and ledger SoRs;
9. TCA benchmarks, costs, markouts, what-if and best-ex reviews reproduce exact versions/data or refuse unavailable inputs, with no causal/compliance overclaim;
10. exception ownership, escalation, closure, client/reporting obligations and corrections are proven;
11. secure mobile monitoring/approval/cancel/reduce commands pass device, revocation, stale/offline, blast-radius and incident tests;
12. security, privacy, surveillance, retention, migration, rollback, suspension and wind-down pass adversarial review.

A completed spec, attractive screen, tracker row, transport route or isolated unit test is not a professional terminal/OEMS/TCA product.

### 23.1 Requirement proof map

| Requirement   | Contract closure                                                                                       | Required implementation evidence                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `PTX-M07-R01` | §6 defines multi-workspace/window/layout/linking, multi-monitor, command and keyboard semantics        | Layout/version/permission/conflict/recovery/accessibility tests across display topologies    |
| `PTX-M07-R02` | §7 defines charts, drawings/templates, linking, overlays, alerts, compare and honest replay            | Golden/interaction/data-provenance tests across live, stale, corrected and historical states |
| `PTX-M07-R03` | §7 defines synchronized DOM/L1–L3, heatmap, tape, footprint, matrix, scanners and statistics           | Sequence/checksum/correction/cross-widget load and data-parity evidence                      |
| `PTX-M07-R04` | §8 defines every PX-S03 ticket/strategy, presets, one-click, drag-amend, sizing and preview            | Capability matrix and end-to-end order/strategy preview/action/refusal tests                 |
| `PTX-M07-R05` | §9 defines unified, distinct, exact and exportable professional blotters                               | Cross-SoR pagination/filter/export/provenance/access-control reconciliation                  |
| `PTX-M07-R06` | §9 defines authoritative collateral/risk/Greek/scenario/liquidation/default surfaces                   | PX-S06 conformance, freshness/refusal and exact-precision evidence                           |
| `PTX-M07-R07` | §19 defines secure mobile monitoring, alerts, approvals, cancel-all, risk reduction and incidents      | Device/auth/revocation/stale/offline/blast-radius mobile tests                               |
| `PTX-M07-R08` | §§6–11 define accessibility, localization, precision, error and degraded/no-stale truth                | Accessibility/localization/time/number/error-state conformance                               |
| `PTX-M07-R09` | §10 defines persistent per-channel session, clock, schema/version and dependency status                | Fault/reconnect matrix showing independent state and honest recovery                         |
| `PTX-M07-R10` | §11 defines locks, live/sim truth, protected hotkeys, account cues and trading-enabled state           | Permission/focus/key-repeat/environment/lock/kill adversarial tests                          |
| `PTX-M07-R11` | §10 defines recovery lock, snapshot/replay/reconciliation and idempotent pending-command resolution    | Crash/sleep/network/refresh/duplicate-tab tests proving no duplicate intent                  |
| `PTX-M07-R12` | §20 defines terminal capacity dimensions, budgets, observability and safety-ordered shedding           | Long-session/dense-L3/portfolio/burst-fill/chart/multi-monitor load packs                    |
| `PTX-M07-R13` | §9 defines causal parent/child/hedge/route/account/owner/exposure/orphan/message trees                 | Cross-SoR causal reconciliation and missing/gap/orphan tests                                 |
| `PTX-M07-R14` | §7 defines authoritative calendars and multichannel alerts with provenance/delivery                    | Source/version/correction/scope/delivery and unavailable-state evidence                      |
| `PTX-M07-R15` | §6 defines versioned portable permission-shared recoverable profiles and configurations                | Export/import/share/migration/corruption/known-good recovery tests                           |
| `PTX-M07-R16` | §18 defines append/versioned journal and hard live-versus-historical replay separation                 | History immutability, privacy/retention and simulation-route isolation tests                 |
| `PTX-M07-R17` | §§8, 11 define scoped join/cross/reprice/cancel/close/flatten/reverse and blast-radius protection      | Per-target partial/unknown outcomes, reduce-only and destructive-action tests                |
| `PTX-M25-R01` | §12 defines care-order fields and distinct staged/held/exchange-live states                            | Schema/state/UI evidence preserving client instruction and execution ownership               |
| `PTX-M25-R02` | §12 defines claim/unclaim/assign/pass/accept/reject/undo ownership and immutable history               | Concurrent transfer, timeout, reject, fill-during-pass and authorization tests               |
| `PTX-M25-R03` | §13 defines accepted shift handoff with continuous responsibility and unchanged account risk           | Shift/incident/revocation handoff exercises proving no unowned interval                      |
| `PTX-M25-R04` | §14 defines parent caps, atomic reservations and split/bulk/stitch/stage/hold/release/manual law       | Concurrency/property tests proving no quantity/price/mandate exceedance                      |
| `PTX-M25-R05` | §14 defines governed changes, worsening, manual fills, allocations, corrections and confirmations      | Permission/approval/evidence/reversal/reconciliation/client-delivery tests                   |
| `PTX-M25-R06` | §§9, 12–14 define unified-but-distinct care/synthetic/algo/RFQ/routed/native/liquidation/manual views  | Cross-workflow state/capability/causal reconciliation                                        |
| `PTX-M25-R07` | §15 defines reproducible decision/arrival/VWAP/TWAP/mid/close/fixing/client benchmarks                 | Input digest, clock, correction and independent recomputation evidence                       |
| `PTX-M25-R08` | §16 defines separate spread/impact/delay/opportunity/fee/funding/borrow/FX/route/residual costs        | Exact calculation fixtures with overlap/residual and unavailable-input tests                 |
| `PTX-M25-R09` | §16 defines multi-dimensional markouts/adverse-selection with non-causality and sample caveats         | Horizon/reference/sign/correction/cohort/privacy reproducibility tests                       |
| `PTX-M25-R10` | §17 defines point-in-time venue/liquidity/exclusion/route/reject/amend/conflict reconstruction         | Full retained-data replay, gap disclosure and reviewed exception evidence                    |
| `PTX-M25-R11` | §16 defines pre-trade execution/impact/risk/capital/fee/legging what-if with assumptions/confidence    | Versioned model scenarios, unsupported/refusal cases and no-order-side-effect proof          |
| `PTX-M25-R12` | §17 defines actionable unattended/orphan/unconfirmed/breach/hedge/ownership/allocation/reporting cases | Detection, ownership, escalation, correction and closure evidence                            |

## 24. Owner and external sockets

| Socket       | Required authority/input                                                                                              | Refuse-closed behavior while absent                                              |
| ------------ | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `PX-S05-O01` | Legal entity/client/broker/agency roles, account-risk ownership, mandates and disclosure                              | Client/care/agency workflow disabled; ordinary account trading only              |
| `PX-S05-O02` | Desk groups, claim/pass/handoff eligibility, responsibility, supervision and break-glass approval                     | No pass/handoff; existing authorized owner remains responsible                   |
| `PX-S05-O03` | Care-order discretion, price/quantity worsening, manual-fill, allocation, confirmation and correction policy          | Action refuses or remains unconfirmed/correction-required                        |
| `PX-S05-O04` | UI locks, confirmation tiers, hotkey enablement and kill/flatten/reverse blast-radius policy                          | Destructive shortcuts disabled; explicit narrow action only                      |
| `PX-S05-O05` | Layout/profile/plugin sharing, retention, portability, accessibility and localization support policy                  | Personal known-good configuration only; unsupported locale/format labeled        |
| `PX-S05-O06` | Approved benchmarks/fixings, TCA methodologies, signs/windows, thresholds, cohort/privacy and best-execution policy   | Raw facts available; no benchmark, attribution, outlier or compliance conclusion |
| `PX-S05-O07` | Terminal/mobile SLOs, capacity/render/input/memory budgets, supported devices/displays and alert delivery commitments | Observations only; no performance/mobile/delivery claim                          |
| `PX-S05-O08` | Mobile features, device/auth/attestation/root posture, notification redaction and distribution policy                 | Mobile remains unavailable or read-only; no offline live command                 |
| `PX-S05-X01` | Venue/OEMS/OMS/client order, allocation and manual-trade integration plus counterparty evidence                       | Affected workflow unavailable; no synthetic acknowledgement or fill              |
| `PX-S05-X02` | Licensed point-in-time market/reference/economic/benchmark/FX data and correction history                             | Dependent TCA/calendar/what-if result unavailable or explicitly partial          |
| `PX-S05-X03` | Push/email/webhook/SMS, device platform and app distribution/security evidence                                        | Delivery remains unknown; desktop/server state is authoritative                  |
| `PX-S05-X04` | Client best-execution/reporting format, acknowledgement and external record/retention obligations                     | No applicability or delivery claim; exception remains open                       |

## 25. Cross-spec dependencies and contradiction register

- **PX-S01:** owns market/instrument/rule/emergency state, surveillance and corrections. A terminal control never invents a market state or hides an effective rule version.
- **PX-S02:** owns principal, account, delegation, approval, session, security/privacy and revocation. Workspace visibility and desk ownership are not economic authority.
- **PX-S03:** owns native order/algo schemas, lifecycle, matching, executions, cancels/kills, causal journal and correction. OMS views and hotkeys consume rather than redefine them.
- **PX-S04:** owns protocol/feed sequence, recovery, entitlement, version/change, market-data provenance and capture. Rendered data cannot promote an unhealthy stream.
- **PX-S06:** owns risk, margin, positions, liquidation/default and safe reduction. Preview/TCA estimates never authorize or settle risk.
- **PX-S12:** owns ledger/custody/reconciliation/wind-down. Terminal, allocations and manual fills cannot create a second money or position book; value corrections are balanced postings through ledger authority.
- **PX-S13:** owns capacity/SLO magnitudes, recovery, dependency truth, status and incident command. Client readiness cannot outrun authoritative reconciliation.
- **PX-S07–PX-S10/PX-S14–PX-S16:** supply product, options, RFQ/allocation, liquidity/fees, venue, quant/delegation and agent-specific semantics while inheriting this human control/evidence boundary.

Resolved contradictions and explicit gaps:

1. At assurance baseline `1a17a85ab03cf549243d0b62565eeec4ecd84b11`, the stale `svc-execution` README denied OMS/SOR/EMS scope, while current `oms-plan`, execute/cancel/fetch procedures, adapters, EMS store/tests, the `execution.sor` tracker row and edge consumer door proved a bounded delivered slice. PX-S03 and this contract use the stronger evidence; repository history records the separately delivered service correction.
2. That correction does not promote the north-star OEMS. The delivered slice explicitly does not invent parent/child orders and no care ownership, shift, mandate/allocation/manual-fill system or formal TCA implementation was found.
3. The later OMS capture-lake runtime records observed snapshots and explicit holes and refuses TSDB persistence when owner configuration is absent. That is useful provenance infrastructure, not a historical completeness, benchmark, TCA or best-execution implementation claim.
4. The `web.terminal` tracker row proves the vendored desk, live depth and wire guard named by the row. Its own mount lists residual gaps, and it does not prove the M07 professional workspace/recovery/capacity/mobile contract.
5. `svc-execution` acknowledgement records and projections are not authoritative fills, positions or money. Unknown/missing state remains unknown and reconciles with the owning SoR.
6. A passed order preserves original account risk and originator. Caretaker responsibility is operational authority only; it cannot widen the mandate or move value.
7. Manual fills and allocations are evidentiary workflows, not permission to manufacture trades or balances. Their effect requires external confirmation and existing order/position/ledger correction law.
8. TCA and best-execution review can explain measured association under declared methods; they cannot infer causality, legal compliance or hypothetical venue availability from incomplete data.
