# INTAFACED Multi-Venue and On-Chain Execution Specification

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Status:** Authoritative product contract; implementation incomplete

**Authority:** `PX-S14`; bounded child of [`PRO_TRADER_EXCHANGE_DEFINITIVE_SCOPE.md`](../PRO_TRADER_EXCHANGE_DEFINITIVE_SCOPE.md)

**Primary requirements:** `PTX-M22-R01–R07`

**Predecessors:** `PX-S01` rulebook/lifecycle/integrity, `PX-S02` participant authority/security, `PX-S03` microstructure/execution, `PX-S04` connectivity/data/certification, `PX-S05` terminal/OMS/TCA, `PX-S06` collateral/risk/default, `PX-S07` products/FX, `PX-S08` options, `PX-S09` RFQ/OTC/allocation, `PX-S10` liquidity/fees/makers, `PX-S11` reporting/service, `PX-S12` custody/reconciliation/wind-down, and `PX-S13` resilience/incident command; reuses [`SPEC-SOVEREIGN-ROUTING-AND-COPY-2026-08-01.md`](SPEC-SOVEREIGN-ROUTING-AND-COPY-2026-08-01.md) only within its stated non-custodial authority boundary

**Systems of record:** PX-S02 owns actor/account/delegation authority; PX-S03 owns parent intent and execution state; PX-S04 owns source data/session/schema truth; PX-S05 owns desk and best-execution presentation; PX-S06 owns inventory, credit, counterparty and residual risk; PX-S10 owns liquidity-source/fee/conflict constitutions; PX-S12 owns custody, money finality, bridge-boundary reconciliation and wind-down; PX-S13 owns incidents/recovery. `packages/ledger-client` plus `svc-ledger` remain the only money book. This contract owns venue normalization, route eligibility/decision evidence, cross-venue child orchestration, external/on-chain execution state, and route-specific recovery.

---

## 1. Product promise, professional jobs, and boundary

Buy-side traders, brokers, execution desks, market makers, arbitrage and hedge strategies, treasury, risk, operations, compliance, surveillance, finance, clients and auditors can compare genuinely executable outcomes across internal books, external CEXs, RFQ/OTC sources and on-chain venues; release only authorized children; see where assets, credit and obligations sit; control legging and chain risk; and reconstruct why each venue was selected, excluded, degraded, filled, cancelled or repaired.

This determines primary-venue adoption because professionals require one accountable execution network, not a collage of headline quotes. They will not entrust flow to a router that hides custody and transfer cost, calls sequential legs atomic, loses the parent after a child fills, approves an arbitrary contract, treats inclusion as finality, bridges on a single observation, or silently reroutes when a venue becomes stale.

Catastrophic or dishonest outcomes include invented fills or balances; duplicate external orders after timeout; client-order ID collision; one leg filling while a failure response hides it; routing against inaccessible depth; unauthorized house preference or venue inducement; prefunding from client or fee balances; stranded inventory at an insolvent venue; allowance theft; malicious/replaced contracts; sandwich/front-running loss; nonce conflict; gas or paymaster failure; fee-on-transfer/rebasing-token mismatch; chain reorg; bridge mint/lock divergence; and a cross-plane ledger that balances while the external asset is missing.

M22 remains one contract. Adapter normalization, venue eligibility, route scoring, child execution, inventory/counterparty exposure, on-chain transaction state, best-execution evidence and recovery form one causal decision. Splitting on-chain execution from SOR would permit a quote winner that cannot lawfully or safely settle.

Non-goals:

- no venue, chain, token, pool, bridge, aggregator, wallet, custodian, counterparty, legal capacity, product, credit, prefunding, capital, contract address, signer, attestor, finality rule, gas/slippage/MEV threshold, route weight, SLO, fee, transfer, or settlement term is invented;
- no external quote or pool liquidity is represented as native executable depth, and no route plan is a fill;
- no generic DEX quote service is relabeled on-chain execution, no operator credential is relabeled client custody, and no test chain proves live deployment;
- no router, adapter, bridge or protocol service stores spendable balances or posts money outside authorized `ledger-client` recipes;
- no new matching engine, SOR, wallet system, custody book, bridge book, product SPA, tracker or SoT is created;
- permissionless network access does not bypass sanctions/region law, smart-account authority, token/contract controls, client instructions or market integrity.

## 2. Research delta and durable patterns

Current official sources add durable contract requirements:

- [Coinbase Prime systems and operations](https://docs.cdp.coinbase.com/prime/introduction/systems-operations) exposes one SOR across connected venues, aggregated books, venue filters and fee transparency; its [order lifecycle](https://docs.cdp.coinbase.com/prime/concepts/trading/trading) preserves multiple venue-attributed fills under one order and distinct pending/open/filled/cancelled/failed/expired states.
- [0x Swap API](https://docs.0x.org/docs/introduction/quickstart/swap-tokens-with-0x-swap-api) separates indicative price, allowance, firm quote and transaction submission and returns chain/block, minimum output, route fills, balance/allowance issues, gas and simulation status. Its [contract guidance](https://docs.0x.org/docs/core-concepts/contracts) makes the allowance target and execution entry point explicit and warns that approval to the wrong contract can expose tokens.
- [Ethereum transaction lifecycle](https://ethereum.org/developers/docs/transactions/) distinguishes signed submission, mempool, block inclusion, justification and finalization; [Ethereum proof-of-stake finality](https://ethereum.org/developers/docs/consensus-mechanisms/pos/) reinforces that inclusion is not irreversible finality.
- [MiFID II Article 27](https://eur-lex.europa.eu/eli/dir/2014/65/oj/eng) uses price, cost, speed, execution and settlement likelihood, size and nature as execution factors; requires venue-policy and quality evidence; and treats routing inducements as a conflict. These are durable evidence patterns only; legal applicability remains owner/counsel authority.
- [0x API overview](https://docs.0x.org/api-reference/api-overview) treats cross-chain quotes, ready-to-sign routes, in-flight status and source lists as separate surfaces. A bridge route therefore needs its own lifecycle and cannot inherit same-chain swap finality.

The delta is that a professional route is an eligibility and settlement decision, not merely a price sort. On-chain execution adds approval, signer, contract, nonce, simulation, gas, MEV, inclusion, reorg and finality states; cross-chain execution adds a second independent obligation and reconciliation boundary.

## 3. Repository evidence audit

| State       | Evidence and bounded truth                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `BUILT`     | `packages/venue-adapter` has typed venue kinds/capabilities, exact-money quote/route math, health/freshness refusal, source-aware sequenced books, three external CEX market/trade/account adapter families, complete-cost scoring, split planning, rejected-venue reasons and route reports. `svc-execution` wires plan/execute/cancel/fetch, balances/positions/rails and a durable EMS acknowledgement store.   |
| `PARTIAL`   | `svc-dex` sources internal/external/indexer books, refuses stale/future/invented prices, discloses unavailable/degraded sources and routes exact book/pool quotes with custody/settlement-cost labels. `svc-protocol` has typed chain absence, user-op/bundler/paymaster policies, smart-account/session and venue-vault primitives. Indexer reorg foundations and cross-plane bridge accounting law are reusable. |
| `SPECIFIED` | PX-S02/PX-S03/PX-S04/PX-S05/PX-S06/PX-S10/PX-S12/PX-S13 bind authority, parent/child truth, source sequencing, TCA, exposure, fees/conflicts, finality/reconciliation and outage recovery. The accepted one-book rule permits the existing bounded internal ranking preference and forbids any second structural preference.                                                                                       |
| `SOCKET`    | Live venues/credentials, per-user vault durability/HSM, eligible instruments, account mapping, settlement/custody, inventory, transfer/credit/counterparty caps, external cost/latency inputs, DEX/aggregator/contract/token/chain law, signer, gas/MEV, finality, bridge/attestation and live SLOs remain typed sockets.                                                                                          |
| `OWNER-SET` | The existing internal ranking preference is an accepted owner ruling. All venue policy, client disclosure/consent, capital, route factors/weights, risk limits, chains/contracts, settlement, finality and bridge security remain owner/legal/risk decisions.                                                                                                                                                      |
| `EXTERNAL`  | CEXs, DEXs, RFQ makers, custodians, banks, lenders, clearing/settlement systems, chains/L2s, validators/sequencers, RPC/bundler/paymaster providers, wallets/signers, aggregators, pools/contracts, bridges/attestors and data sources require authenticated evidence and exit paths.                                                                                                                              |
| `ABSENT`    | No integrated per-client external-venue vault-to-OMS path, global capital/counterparty/inventory reservation, institutional route-policy governance, robust multi-child recovery, complete best-execution archive, live on-chain transaction executor, MEV policy, token/contract admission, or production bridge/reconciler/attestation system was found.                                                         |

Two code-level contradictions were material at the audited baseline. The planner now reports `atomic: false`, although the legacy `planOmsArbAtomicLegs` / `executeOmsArbAtomicLegs` symbol names remain; execution still submits sequentially and reports partial executions, so the workflow is `LEGGED`, not venue-atomic. The general OMS executor still generates `oms-<venueId>` child IDs that are not unique across distinct parent requests, and a later-leg `submit_failed` response does not carry already completed executions even though they may be journaled. The contract below keeps required truth and recovery authoritative; implementation must correct the remaining child-ID and recovery artifacts before relying on these paths professionally.

The `venue.aggregation`, `execution.sor`, `dex.quote-router`, venue-vault and protocol tracker rows prove their stated bounded doors. They do not prove client account authority, capital, live external/chain dependencies, end-to-end finality, best execution, or M22 completion. The empty DEX venue-set ruling remains correct: shipped defaults refuse rather than manufacture a live venue.

## 4. Actors, capacity, trust boundaries, objects, IDs, and clocks

Execution capacity is explicit per route and child: `VENUE_INTERNAL`, `AGENCY_EXTERNAL`, `PRINCIPAL_EXTERNAL`, `MATCHED_PRINCIPAL`, or `SELF_CUSTODY_ONCHAIN`. Capacity names the legal entity/counterparty, beneficial owner, account/wallet, custody and settlement model, capital/credit source, disclosures and conflicts. An adapter type cannot decide capacity.

Canonical objects include `VenueDefinition`, `VenueAccount`, `InstrumentMapping`, `VenueCapabilitySet`, `VenueHealthSnapshot`, `RoutePolicy`, `RouteRequest`, `RouteDecision`, `RouteCandidate`, `RoutePlan`, `RouteParent`, `RouteChild`, `ExecutionGroup`, `ExternalOrder`, `VenueFill`, `InventoryReservation`, `CounterpartyExposure`, `TransferInstruction`, `OnchainIntent`, `ApprovalGrant`, `FirmOnchainQuote`, `ChainTransaction`, `BridgeTransfer`, `RouteRecoveryCase`, and `BestExecutionRecord`.

Stable IDs include legal/beneficial owner, client/organization/account/sub-account/portfolio, actor/session/key/grant/mandate, route request/decision/plan/parent/version, child/attempt/client-order/venue-order/execution/fill, venue/account/counterparty/instrument/mapping, inventory/hold/reservation/credit/transfer/settlement, wallet/chain/token/contract/pool/aggregator/quote/approval/permit/nonce/transaction/block/log, bridge/crossing/attestation, ledger transaction/entry, rule/risk/cost/model/schema, recovery/correction/case/incident and source snapshot.

Clocks distinguish client intent, server acceptance, market-data event/receive/decision age, route snapshot/expiry, child release/venue ack/fill/cancel, transfer initiation/value/finality, quote block/time/expiry, signing/broadcast/mempool/inclusion/safe/finalized, reorg/orphan/replacement, bridge source-final/destination-final, reconciliation, recovery and correction. Source clocks carry quality; client, provider and chain clocks never overwrite server causality.

## 5. Venue constitution, normalization, and eligibility

Every venue has a versioned `VenueDefinition`: legal operator/counterparty and capacity; products/jurisdictions/participant classes; account/custody/settlement model; source endpoints and credentials; instruments/precision; order/cancel/amend/fill semantics; identifiers; fees/rebates/taxes; balances/positions/holds; rate limits; sessions/idempotency; timestamps/sequences; error/unknown states; data/records; risk/caps; health/SLO; maintenance/incidents; reconciliation; change/deprecation; and suspension/exit.

Normalization preserves canonical fields and a venue-native evidence envelope. It never collapses:

- `PENDING`, venue-accepted, open, partially filled, filled, pending-cancel, cancelled, rejected, expired, replaced, suspended and outcome-unknown;
- base/quote/settlement asset, contract/multiplier, tick/lot/precision/rounding, fee asset, position mode and venue account type;
- event, receive, exchange, chain and settlement timestamps or sequence quality;
- venue-native order/fill IDs, status/reject code, liquidity role, fee, tax, trade bust/correction and reconciliation facts.

Unknown enum/state is preserved and fences dependent action rather than mapping to the nearest canonical success. Precision conversion proves exact representability or refuses; decimal strings cross boundaries and scaled bigint remains in memory. Venue-specific semantics are extensions, never erased fields hidden from reports.

Eligibility is the intersection of PX-S01 product/market state, PX-S02 mandate/entitlement, PX-S06 risk/counterparty, PX-S10 source/fee constitution, PX-S12 custody/settlement, live venue/account capabilities and health. Missing or stale credentials, instrument map, cost, credit, balance, settlement or status excludes the venue with a named reason.

## 6. Route policy, candidate snapshot, scoring, and decision

A versioned `RoutePolicy` defines applicable entity/client/product/order class; permitted venues/capacities; client instructions; price/cost/speed/fill/settlement/counterparty factors; factor precedence/weights where authorized; venue/child/slippage limits; internal/affiliate preference and conflict disclosure; data/cost freshness; partial/legging behavior; review; and best-execution evidence.

The accepted internal preference remains exactly the bounded existing owner ruling and appears in decision evidence. No child contract may broaden or silently default another preference. If legal/client policy forbids it for a scope, that scope uses zero or refuses under published authority. Venue fees, rebates or payments never override client instructions, conflicts, risk or best-outcome law.

Each `RouteCandidate` freezes instrument map, executable signed quantity, limit, source book/quote/version/age, account entitlement, balance/inventory/credit, fee/rebate, expected impact, transfer/gas/settlement cost, measured latency, fill and settlement likelihood, counterparty/chain risk, custody location and exclusion reason. Missing cost/latency/risk inputs do not become zero. Correlated or mutually exclusive liquidity is not double-counted.

`RouteDecision` states requested versus planned quantity; eligible, selected, rejected and unavailable candidates; factor inputs/versions; ordering and split; internal preference; expected total consideration; child release plan; residual/hedge/repair rule; snapshot and expiry. A route that cannot cover the request returns an explicit remainder unless the client authorized partial execution. An indicative comparison never becomes an executable plan.

## 7. Parent, child, reservation, and external-order lifecycle

The route parent reuses PX-S03 intent and has:

`RECEIVED → VALIDATING → RESERVING → PLANNING → APPROVAL_PENDING → RELEASE_READY → RELEASING → WORKING → TERMINAL_RECONCILING → RECONCILED`

with `REFUSED`, `PARTIAL`, `CANCEL_PENDING`, `CANCELLED`, `EXPIRED`, `OUTCOME_UNKNOWN`, `RESIDUAL_RISK`, `REPAIR_PENDING`, `CORRECTION_PENDING`, `SUSPENDED` and `WIND_DOWN`. Parent state is derived from actual children and money/risk finality; a transport error cannot turn prior fills into failure or success.

Before release, one atomic reservation covers parent total quantity/notional, venue inventory/prefunding, credit/counterparty/settlement and worst-case simultaneous children. Each child gets globally unique parent ID, child ID, stable venue-scoped client-order ID and attempt. Re-drive looks up before submit. IDs cannot be derived from venue alone, wall-clock time or loop position.

Child state is:

`CREATED → RESERVED → SUBMITTING → ACK_PENDING → ACKNOWLEDGED → WORKING → PARTIALLY_FILLED → TERMINAL`

where terminal is `FILLED`, `CANCELLED`, `REJECTED`, `EXPIRED`, `BUSTED` or `CORRECTED`; `OUTCOME_UNKNOWN`, `CANCEL_PENDING`, `REPLACE_PENDING`, `SUSPENDED` and `RECOVERY_REQUIRED` remain non-terminal. Timeout after dispatch triggers authoritative fetch/open-order/fill/drop-copy lookup with the same client ID. No retry emits a new economic child until absence is proven.

Fills update the parent and reservation monotonically and idempotently. Cancels are requests; late fills remain valid facts. A venue acknowledgement is not a fill, and a fill is not ledger/settlement finality. EMS journals, venue queries, independent drop copy where available, custody/ledger and reports reconcile before terminal truth.

## 8. Multi-child partial success, legging, hedge, and correction

An `ExecutionGroup` declares `VENUE_ATOMIC`, `ENGINE_ATOMIC`, or `LEGGED`. Only a boundary capable of enforcing all-or-none may use an atomic label. Cross-venue sequential or parallel submissions are legged even when planned together.

A legged group defines release ordering/parallelism, maximum simultaneous exposure, parent/child quantities, price and time bounds, partial consent, residual tolerance socket, cancel/replace behavior, hedge instrument/venue/account, repair authority, deadline, abandonment and terminal outcomes. Each successful child is reported immediately and never hidden by a later failure.

On partial success the orchestrator fences new release; retrieves every unknown child; cancels live residual where authorized; recomputes exposure, inventory, margin, settlement and client mandate; and enters `RESIDUAL_RISK` until an authorized wait, hedge, unwind, complete or accept-residual decision. It never labels a compensating trade a reversal of a real external fill.

Hedge/repair is a new attributed order subject to ordinary authority, price/risk/capital, venue eligibility and client/capacity rules. Platform error losses cannot be moved to another client or an unfunded house account. Busts, fee changes and venue corrections preserve original executions and use PX-S01/PX-S12 correction law.

## 9. Cross-venue inventory, prefunding, transfer, credit, and settlement

Treasury/risk views, by legal entity/beneficial owner/venue/account/asset, expose available, held, ordered, unsettled, in-transfer, borrowed/financed, encumbered and withdrawable amounts; positions; venue margin; credit used/available; settlement obligations/due dates; counterparty concentration; custody/finality and source age. An external balance is evidence, not a second INTAFACED money book.

External trading uses either pre-positioned inventory, an enforceable credit/prime agreement, or a fully defined just-in-time settlement path. The source, owner, cap, fees, recall/default and loss treatment are explicit. Bridge or transfer speed is never assumed inside an immediate route. A cross-venue arbitrage plan that requires both sides pre-positioned remains legged execution, not atomic settlement.

Every transfer has intent, source/destination legal account, asset/network, amount, fees, authority, reservation, external ID, status/finality, reconciliation and reversal/recovery. Transfer/withdraw credentials are separately privileged; trade-only venue keys must not gain withdrawal. Cross-account or universal-transfer scopes remain disabled unless a product-specific mandate and risk path exist.

Counterparty and settlement caps are checked before planning and immediately before release; concurrent routes reserve them atomically. Stale balance/position/credit or settlement break excludes the venue. External failure enters PX-S06 default and PX-S12 recovery/exit; client assets, general fees or another venue's inventory cannot plug it.

## 10. On-chain quote, wallet, approval, transaction, and token contract

On-chain capacity is either user self-custody/smart account or a named custodial/principal account under PX-S02/PX-S12. The actor sees wallet/account, chain, token/contract, spender, execution target, calldata method/value, recipient, route sources, fees/surplus recipient, gas/funding, approvals, quote block/time/expiry, minimum output/maximum input, price impact/slippage, simulation completeness and custody consequences before signing.

Lifecycle separates:

`INDICATIVE_PRICE → FIRM_QUOTE → SIMULATED → APPROVAL_REQUIRED → APPROVAL_PENDING → SIGNATURE_REQUIRED → SIGNED → BROADCAST → MEMPOOL → INCLUDED → SAFE → FINALIZED → RECONCILED`

with `REFUSED`, `QUOTE_EXPIRED`, `SIMULATION_INCOMPLETE`, `SIGNATURE_REJECTED`, `DROPPED`, `REPLACED`, `REVERTED`, `ORPHANED`, `STUCK`, `OUTCOME_UNKNOWN`, `CORRECTION_PENDING` and `WIND_DOWN`. No UI/API calls `INCLUDED` settled or final.

Approval/permit binds exact chain, token, owner, spender, amount/cap, nonce and expiry. The spender comes from an admitted/versioned contract registry and must match the intended approval model; approval to an execution contract that is not an authorized spender refuses. Unlimited/passive allowance is never default. Allowance inventory, revocation and compromised-contract kill are customer/operator visible.

Before signature/broadcast, verify chain ID, contract code/version/hash/proxy governance, token behavior, recipient, calldata decoder/policy, balance/allowance, nonce, gas/value, quote freshness/block ancestry, min-out/max-in, route/sources, simulation result, sanctions/contract controls and wallet grant. Fee-on-transfer, rebasing, callback/hook, blacklist/freeze, proxy, permit and tax behavior require explicit admission; unknown behavior refuses.

Gas sponsorship/paymaster, relayer/bundler and smart-account session keys are separate authorities and budgets. Provider failure can fall back only to a pre-disclosed user-submit path that the user can execute safely. Nonce replacement retains one intent lineage; concurrent submissions use nonce fencing and lookup, never blind retry.

## 11. MEV, slippage, simulation, and chain integrity

The `OnchainExecutionPolicy` names public/private/batch/auction route, allowed builders/relays/solvers/aggregators, trust and censorship model, slippage/price-impact authority, deadline, revert behavior, surplus treatment, gas policy, simulation provider/quorum, source exclusions and fallback. Blank policy refuses live on-chain execution.

MEV controls consider frontrun/sandwich/backrun, information leakage, solver/builder/relay conflict, quote manipulation, stale block, gas grief, revert and censorship. A private relay or batch auction is a dependency with outage and trust risk, not a guarantee. Fallback from protected to public broadcast requires prior consent/policy and a fresh quote/simulation; it is never silent.

Slippage is a hard transaction bound expressed exactly, not only an estimate or UI warning. Route-level and leg-level bounds compose safely across split sources. User/client mandates may tighten but cannot widen owner/risk maxima. Positive slippage/surplus recipient is disclosed and governed by PX-S10; it never silently accrues to the platform or integrator.

Simulation records chain/block/state, sender, nonce, calldata, value, gas, token state and provider/version. Incomplete, divergent or stale simulation refuses under policy. Simulation is not execution and cannot prove future ordering, gas, liquidity, token behavior or finality.

Chain state uses authenticated chain ID, canonical block hash/parent, transaction/receipt/log and finality evidence. Reorg removes orphaned observations, returns the transaction/route to the correct non-final state and triggers any required ledger correction. Finality policy is chain/L2/bridge specific and owner-set; a fixed confirmation count copied from another chain is not authority.

## 12. Bridge and cross-chain execution

A bridge is never an implicit SOR leg. `BridgeTransfer` identifies source/destination chains, asset representations/contracts, amount, user and platform accounts, provider/protocol, custody/capacity, quote/fees, source lock/burn/finality, attestation/proof/quorum, destination mint/release/finality, timeout/refund, replay protection, caps, emergency authority, reconciler and exit.

State is:

`QUOTED → SOURCE_RESERVED → SOURCE_SUBMITTED → SOURCE_INCLUDED → SOURCE_FINAL → ATTESTATION_PENDING → DESTINATION_SUBMITTED → DESTINATION_INCLUDED → DESTINATION_FINAL → RECONCILING → SETTLED`

or `REFUSED`, `EXPIRED`, `SOURCE_REORGED`, `ATTESTATION_FAILED`, `DESTINATION_REVERTED`, `OUTCOME_UNKNOWN`, `REFUND_PENDING`, `DIVERGED`, `HALTED`, `RECOVERY_REQUIRED`. Source and destination finality are independent.

The accepted cross-plane accounting law remains binding: the platform bridge boundary—not a user—carries in-flight exposure; keyed hold/settle/reverse postings use authorized `ledger-client` recipes; chain state, not adapter memory, decides; and the cross-plane reconciler must compare ledger obligation with on-chain lock/mint truth before any crossing is enabled. An internally balanced ledger is not bridge proof.

Absent attestor/quorum/light-client authority, finality policy, contracts, caps or reconciler keeps crossing disabled. Route optimization cannot create a bridge hop simply because a provider advertises one. Cross-chain price, time and failure risk are shown separately from same-chain swap and CEX settlement.

## 13. Best-execution reconstruction, conflicts, and reporting

Each `BestExecutionRecord` retains parent intent/mandate/client instructions, legal capacity, permitted universe, point-in-time candidate books/quotes and availability, normalized plus native fields, account/inventory/credit/counterparty/settlement constraints, complete costs, factor policy/version, internal/affiliate/inducement conflicts, selected and rejected routes, child chronology, fills/fees, on-chain/bridge evidence, residual/repair and final outcome.

The record explains why each venue was excluded or degraded: unsupported product/order, entitlement, client instruction, rule/risk/limit, missing credentials, stale/gapped data, incomplete cost/latency, insufficient balance/credit/inventory, counterparty/settlement/custody, maintenance/outage, chain/contract/approval/simulation/gas/MEV/finality, capacity or conflict. `Not evaluated` is distinct from `evaluated and lost`.

Reports compare expected and realized all-in price, fees, impact, latency, fill probability outcome, settlement/finality, slippage, opportunity/residual and route changes without forcing incomparable costs into one number. Benchmark/methodology follows PX-S05. A specific client instruction and its consequences are visible; it does not permit the platform to claim unconstrained best execution.

House/internal/affiliate routing, external remuneration/rebates, aggregator surplus and principal spread remain explicit. Surveillance correlates beneficial ownership across venues/wallets/chains and covers self/wash trades, spoofing, venue/chain manipulation, front-running, private-intent misuse, collusive routing, oracle/pool attacks and correction abuse. Applicable reporting/retention is a legal socket; complete private evidence remains available to authorized control functions.

## 14. Interfaces, degraded truth, operations, and security

Terminal, REST, FIX, WebSocket, drop copy and event surfaces reuse PX-S03/PX-S04 states and IDs. They show parent and children, venue/capacity/custody, route snapshot age, expected and actual costs, reservations/exposure, unavailable/excluded reasons, partial/unknown/cancel state, chain/approval/gas/MEV/finality/bridge state and reconciliation. Decimal values are strings; hashes/addresses are chain-qualified.

Customer truth distinguishes quote, plan, released order, venue acknowledgement, fill, external settlement, chain inclusion and finality. During degradation it states the reduced venue universe and never says “best across venues” when only one source survived. A mobile control may cancel/kill/revoke within authority but does not silently sign a new swap or bridge.

Operators can disable venue/account/product/source, fence credentials, stop new routes, cancel authorized children, declare outcome unknown, revoke contract/aggregator/bridge eligibility and initiate recovery only through PX-S02/PX-S13 authority, reason, scope, version/fencing, immutable audit and dual control where material. No operator fabricates fill, balance, finality or route score.

External API keys, wallet/session keys, HSM/MPC material, RPC/bundler/paymaster/relayer/aggregator credentials and webhook secrets are least privilege, scoped, rotated and never logged. Trade-only keys refuse withdrawal/transfer permissions. Contract addresses and proxy upgrades are admitted/versioned; DNS/RPC/provider responses cannot replace them. Privacy and licensing govern client route, external account and wallet linkage.

## 15. Outage, divergence, replay, reconciliation, and capacity

Venue/data outage, sequence gap, stale quote, rate limit, credential failure, unknown submit/cancel, position/balance divergence, settlement break, chain/RPC/sequencer/finality delay, contract pause/upgrade, gas spike, bundler/paymaster/relay/aggregator loss, reorg and bridge divergence each have typed health and scoped route effects.

On failure, stop new affected release; preserve parent/child IDs and reservations; query authoritative venue/chain/custody state; process late fills/receipts idempotently; reconcile balances, positions, orders, transfers, ledger and reports; hedge/repair only under prior authority; communicate impact through PX-S13; and require controlled validation before restore. An alternate venue, RPC, signer, contract, chain or bridge is not used unless already admitted and compatible.

Reconciliation proves parent to children, external orders/fills/fees, balances/positions/holds, inventory/credit/counterparty exposure, transfers/settlement, ledger postings, chain transactions/logs/finality, bridge supply/obligation and client/finance reports. Breaks preserve immutable source facts and create correction cases. Duplicate, missing or orphaned events cannot create a new fill or release a still-needed hold.

Capacity tests cover quote bursts, dense multi-venue books, many candidates/children, rate-limit exhaustion, cancel storms, burst/late fills, venue-region loss, EMS restart/replay, balance/position polling, chain nonce contention, mempool/gas spikes, RPC/relay disagreement, reorg, bridge backlog and reconciliation catch-up. Owner-set SLO categories cover decision and release latency, source freshness, ack/fill/cancel recovery, exposure lag, chain/finality/bridge age and reconciliation; blank targets remain visibly unset.

## 16. Migration, compatibility, suspension, and wind-down

Adapter/schema changes use translation golden tests, dual-read/shadow comparison, venue certification, canary accounts, point-in-time route replay and rollback. Instrument/account/status changes preserve native evidence. Credential or contract migration never changes the identity of an in-flight child.

Route-policy rollout shadows decisions before release, compares old/new candidate universes and costs, and canaries by legal entity/product/account. Rollback stops new decisions under the new version; in-flight children remain governed by their bound version. A venue, chain, token, contract, aggregator or bridge is suspended at the smallest safe scope with customer/operator truth.

Decommission stops new plans, resolves/cancels/recovers children, settles and reconciles external obligations, returns/transfers inventory under PX-S12 authority, revokes keys/allowances/sessions, exports route and native evidence, terminates data/commercial/custody/credit agreements and proves no stranded assets or unknown orders. A disappeared external dependency enters default/wind-down; it is not deleted from history.

## 17. Testable Definition of Done

Implementation is complete only when evidence proves:

1. every enabled venue/chain/contract/account has approved legal capacity, product/instrument mapping, credentials, custody/settlement, costs, limits, health, reconciliation and exit; blanks refuse;
2. normalization golden/property tests preserve all venue-native precision, state, fee, timestamp, ID, correction and unknown semantics without floating-point money;
3. route replay from retained candidate snapshots reproduces selection/exclusion and exposes accepted internal preference, fees, cost, latency, fill/settlement likelihood and conflicts;
4. globally unique parent/child/client IDs, reservation and lookup-before-retry prevent duplicates through timeout, restart, concurrent routes and late acknowledgements;
5. adversarial multi-child tests prove first-leg fill plus later-leg reject/timeout, partial fill, cancel race, venue correction and restart retain completed executions and reach explicit residual/repair/reconciled states;
6. cross-venue inventory, balances, credit, prefunding, transfers, settlement and counterparty caps reconcile by owner/entity/account/asset and cannot draw from client or unapproved house funds;
7. on-chain tests cover wrong chain/address/code, expired/stale quote, allowance target, unlimited approval refusal, token behavior, nonce conflict, gas/paymaster/bundler/relay loss, incomplete/divergent simulation, min-out/max-in, revert, replacement, orphan/reorg and chain-specific finality;
8. MEV/private/public fallback and surplus-recipient behavior are disclosed, authorized, bounded and reproduced; no fallback silently weakens protection;
9. bridge fault tests cover source/destination reorg, missing/duplicate attestation, replay, timeout/refund, chain/ledger divergence and service crash between every state, with platform-only in-flight exposure and halt-before-crossing reconciliation;
10. best-execution/TCA records explain every selected, excluded, unavailable and degraded venue and reconcile expected outcome to actual children, fills, costs, settlement and finality;
11. load/fault tests cover peak quote/order/cancel/fill, rate limits, venue/region loss, EMS recovery, chain/RPC/sequencer stress, nonce contention, reorg and reconciliation backlog against owner-published SLOs;
12. rollout, rollback, suspension, credential/contract migration, venue/chain/bridge exit and wind-down preserve authority, money, customer truth and immutable evidence.

## 18. Owner/external sockets and contradiction register

| Socket or conflict                         | Required authority / safe blank behavior                                                                                                                                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `socket.route-policy-and-capacity`         | Owner/legal publish entity capacity, client classes/instructions, venue universe, factors/weights, conflicts and disclosures. Blank: no live external/on-chain route for affected scope.                                              |
| `socket.venue-account-set`                 | Owner/external publish authenticated venues, credentials, products, accounts, instrument maps and commercial/custody/settlement terms. Blank/stale: venue excluded.                                                                   |
| `socket.inventory-credit-counterparty`     | Owner/risk/treasury publish inventory/prefunding, transfer, credit, concentration and settlement caps. Blank: no route consuming that external capacity.                                                                              |
| `socket.client-venue-vault`                | Security owner provides durable HSM/MPC-backed storage, client/account binding, trade-only permission proof and rotation/recovery. Blank: per-client external credential execution unavailable.                                       |
| `socket.onchain-admission`                 | Owner/legal/security publish chains, tokens, contracts/proxies, wallets/signers, aggregators, gas/MEV/slippage/simulation/finality law. Blank: live on-chain execution unavailable.                                                   |
| `socket.bridge-and-attestation`            | Owner/legal/risk/security publish bridge/provider, representations, contracts, finality, attestor/proof/quorum, caps, refund/recovery and reconciler. Blank: crossing disabled.                                                       |
| `socket.external-best-execution-law`       | Counsel/owner publish applicability, execution policy, consent, venue-quality/reporting and review. Blank: no legal best-execution claim; route evidence still retained and customer outcome truth remains mandatory.                 |
| Existing bounded internal preference       | Accepted owner ruling remains authoritative and must be disclosed in route policy/evidence. This spec neither invents nor widens it; any scope-specific prohibition resolves to zero/refusal under new authority.                     |
| `planOmsArbAtomicLegs` atomic label        | Resolved at the response boundary: the planner now reports `atomic: false`. Execution remains sequential and admits partial success, so canonical truth is `LEGGED`; legacy code/type naming cannot support an atomic customer claim. |
| General OMS child ID and partial refusal   | `oms-<venueId>` is not parent-unique, and later-leg failure may omit earlier executions from the response. Canonical contract requires globally unique lineage, durable lookup and explicit partial outcomes before professional use. |
| DEX quote tracker versus execution         | No contradiction after bounded reading: source-aware quote/routing arithmetic is real; wallet authorization, signing, broadcast, chain lifecycle and settlement are not thereby delivered.                                            |
| Bridge ledger balance versus external fact | An internally balanced ledger does not prove lock/mint or external custody. PX-S12/cross-plane reconciler truth has precedence; unreadable/divergent sides halt crossings.                                                            |

## 19. Requirement-level proof map

| Requirement   | Authoritative clauses | Implementation truth after this specification                                                                                                                             |
| ------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PTX-M22-R01` | §§4–5, 14–17          | Typed normalization and live CEX adapter families are built; complete product/account/custody/correction certification remains incomplete.                                |
| `PTX-M22-R02` | §§5–6, 9–13, 15–18    | Exact source/cost SOR and DEX quote foundations are partial; full fill/settlement/counterparty/on-chain scoring and governed policy proof remain incomplete.              |
| `PTX-M22-R03` | §§4, 6–8, 13–17       | Parent/child and EMS foundations exist; unique lineage, reservations, partial-success recovery and integrated money/settlement proof remain gaps.                         |
| `PTX-M22-R04` | §§4–9, 13–18          | Account/balance/position/rail adapters exist, but global inventory, prefunding, transfer, credit, settlement and counterparty exposure control is unimplemented.          |
| `PTX-M22-R05` | §§4–5, 9–12, 14–18    | DEX quote and protocol safety primitives are partial; authoritative wallet/approval/gas/MEV/token/reorg/finality/bridge execution semantics now close without live proof. |
| `PTX-M22-R06` | §§4–6, 8–9, 11, 13–18 | Route reports/rejections are partial; complete point-in-time best-execution reconstruction, governance and reporting remain unimplemented/legal-socketed.                 |
| `PTX-M22-R07` | §§5–8, 10–16, 18      | Refuse-closed source/adapter behavior is substantial; exhaustive duplicate/unknown/partial/reorg/divergence recovery and operational proof remain incomplete.             |

Every primary ID assigned to `PX-S14` appears exactly once in this map. This contract specifies product semantics; it does not promote implementation maturity, admit a venue/chain, or claim best-execution compliance.

## 20. Implementation gaps and precedence

Specification completeness is not product completion. Material gaps are a governed live route policy and venue universe; legal capacity; client/account vault integration; globally unique idempotency; parent reservations; multi-child recovery; inventory/credit/counterparty/settlement control; full best-execution archive; live wallet/signing/approval/simulation/broadcast lifecycle; MEV and surplus law; admitted chains/tokens/contracts; chain-specific finality; and any bridge, attestation and cross-plane reconciler.

Precedence is: doctrine and canonical SoT; accepted owner directions/ADRs; PX-S01/PX-S02 rule and authority; PX-S03 parent/child/execution truth; PX-S06 risk/capital; PX-S10 liquidity/fee/conflict; PX-S12 custody/ledger/finality; PX-S13 incident/recovery; then this route-specific contract. A venue adapter, tracker check, provider quote, chain log or balanced internal journal cannot weaken those boundaries. Conflict or unreadable external truth refuses the affected route until authoritative artifacts are amended together.
