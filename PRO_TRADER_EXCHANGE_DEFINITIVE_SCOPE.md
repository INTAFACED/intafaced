# INTAFACED Pro Trader Exchange — Definitive Product Scope

**Status:** Canonical north-star capability scope  
**Version:** 1.25 — mega backend plan (harden grokbot landings + remainder + all non-frontend svc). Frontend stays Codex. OSS catalog unchanged.
**Research cutoff:** 2 September 2026
**Audience:** Product owner, Phantom, architecture, risk, compliance, operations, and delivery agents

---

## 0. What this document is

This is the single inventory of what INTAFACED must ultimately be able to do to credibly claim it is the world's best crypto exchange for professional traders. It defines the complete product surface, the quality bar, the missing capability universe, the boundaries between capabilities, and the way each capability becomes an implementation-ready specification.

It is deliberately **not**:

- a second implementation tracker;
- a claim that every requirement belongs in v1;
- a substitute for the money, identity, architecture, or owner-decision laws;
- a collection of UI wishes detached from exchange mechanics;
- permission to invent regulatory policy, risk magnitudes, collateral haircuts, or live limits.

The current tracker answers **whether a named feature exists**. This document answers the harder question: **is the feature deep, safe, operable, transparent, and competitive enough for a professional trading venue?** A tracker row may be green while this document still records substantial competitive-depth gaps.

### 0.1 Authority and non-duplication

Authority is resolved in this order:

1. [`INTAFACED_DEFINITIVE_BUILD.md`](INTAFACED_DEFINITIVE_BUILD.md) is constitutional product and engineering law.
2. [`docs/DIRECTION-2026-07-31.md`](docs/DIRECTION-2026-07-31.md) owns decided product boundaries and records owner-unset magnitudes.
3. This document owns the pro-exchange capability universe and its maturity evidence.
4. Existing and future `docs/SPEC-*` documents own bounded product contracts.
5. ADRs own one architectural mechanism; sockets name unresolved dependencies.
6. The tracker and GitHub issues/PRs own implementation state and delivery proof.

Where this document conflicts with a higher authority, the higher authority wins and this document must be corrected. Existing specs are linked rather than copied. New child specs must update this document's evidence map; they must not create a competing scope list.

### 0.2 Immutable platform laws

- **One money book.** No exchange, risk, custody, execution, or clearing module owns a balance. Every value movement uses `packages/ledger-client` and an explicit balanced recipe.
- **Exact money.** Decimal strings cross boundaries; scaled bigint is used in memory. Money never enters a JavaScript `number`.
- **One identity graph.** Legal person, organization, accounts, sub-accounts, delegates, sessions, and counterparties have explicit ownership and authority.
- **No second product shell.** The product extends the existing vendored exchange shell; it does not build a competing SPA.
- **Adapters at every external edge.** Custodians, banks, liquidity venues, oracle sources, travel-rule vendors, and settlement networks remain replaceable.
- **Refuse closed.** Unknown ownership, stale risk, missing limits, incomplete market state, ambiguous settlement, or unavailable compliance decisions stop the action.
- **No invented owner numbers.** Every live leverage, concentration, haircut, fee, rebate, position limit, settlement threshold, SLO, and recovery magnitude remains `OWNER-SET` until explicitly decided.
- **Internet leverage.** Agents extend in-repo `svc-*` + `ledger-client` + vendored shell. They do **not** vibe-code a matching engine, FIX parser, SBE codec, or Greeks library, and they do **not** install a second exchange or second money book. Named take/keep/never: [`docs/BACKEND-INTERNET-LEVERAGE-PEACE-2026-08-31.md`](docs/archive/BACKEND-INTERNET-LEVERAGE-PEACE-2026-08-31.md). Standing law: [`docs/INTERNET-LEVERAGE-LAW.md`](docs/INTERNET-LEVERAGE-LAW.md).

### 0.3 Named open-source (backend) — take / keep / never

Pin a **commit SHA**. Isolated install. Decimal strings on the wire. Adapter ≠ book.

| Job                              | Take                                                                                                                     | Keep in-repo                                                                                            | Never                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Match, halt, collar, IFM, MMP    | —                                                                                                                        | `svc-matching`, `execution-mm`                                                                          | OpenDAX, Hummingbot-as-venue, npm CLOB, Java `exchange-core` as SoT                  |
| Money                            | —                                                                                                                        | `ledger-client` + `svc-ledger`                                                                          | Formance, TigerBeetle, Java wallet tables, Hyperswitch, CCXT, decimal.js on the wire |
| HTTP / schema / tests            | —                                                                                                                        | Fastify 5, **Zod 3 (in-repo)**, Drizzle, postgres.js, Vitest, fast-check, OTel, `ws`, `@node-rs/argon2` | Express, Prisma, Kafka-as-bus, Zod 4 silent upgrade                                  |
| FIX session (`PTX-M05-R02/R10`)  | **QuickFIX/J** `quickfix-j/quickfixj` **3.0.2** (2026-08-04), QuickFIX 1.0 license                                       | fills → matching → ledger                                                                               | `node-quickfix`, AGPL jPOS, hand-rolled FIX                                          |
| SBE codec (`PTX-M05-R04`)        | **Real Logic SBE** `aeron-io/simple-binary-encoding` **1.39.0**, Apache-2.0                                              | our schema                                                                                              | Protobuf-as-SBE                                                                      |
| Greeks / calendars (`PTX-M11`)   | **QuantLib** C++ `lballabio/QuantLib` **1.43** (2026-07-14), modified BSD                                                | live mark/ledger clock                                                                                  | QuantLib-Python hot path; float NPV on the wire                                      |
| WebAuthn (`PTX-M17`)             | `@simplewebauthn/server` (MIT)                                                                                           | `svc-identity`                                                                                          | home-grown attestation                                                               |
| OpenAPI from Zod (`PTX-M05-R08`) | While Zod **3** is in-repo: `@asteasolutions/zod-to-openapi@7.3.4`. Do not jump to Zod 4 / generator 9.x in the same PR. | `packages/contracts`                                                                                    | A second schema language                                                             |
| FIX tags                         | FIX Trading Community official XML                                                                                       | QuickFIX DataDictionary                                                                                 | Invented tags                                                                        |
| Test DB isolation                | Testcontainers-node **or** existing per-branch Postgres                                                                  | law: no shared `intafaced_test`                                                                         | One global test DB                                                                   |
| Bus                              | —                                                                                                                        | **NATS** (doctrine)                                                                                     | Replace with Aeron/Kafka to look like CME                                            |
| Portfolio scenarios (later)      | **ORE** (Open Source Risk Engine, QuantLib-based) when PM is on                                                          | IM/MM + ledger                                                                                          | ORE as money book; vibe-coded VaR                                                    |

FIX and SBE adapters exist on `main`. **Mega backend (non-frontend):** [`docs/SPEC-BACKEND-MEGA-PLAN-2026-09-03.md`](docs/archive/SPEC-BACKEND-MEGA-PLAN-2026-09-03.md). Harden: [`docs/SPEC-PRO-EXCHANGE-HARDEN-AND-REMAINDER-2026-09-03.md`](docs/SPEC-PRO-EXCHANGE-HARDEN-AND-REMAINDER-2026-09-03.md) on PR #3777 until merged. Owner magnitudes stay `OWNER-SET`.

---

## 1. The actual product promise

The ambition is not “a long feature list.” Professional traders choose a primary venue when it combines five properties at the same time:

1. **Best execution:** deep actionable liquidity, predictable matching, low total execution cost, and evidence of queue/fill quality.
2. **Capital efficiency:** coherent collateral, margin offsets, financing, and settlement without obscuring insolvency risk.
3. **Control:** deterministic APIs, complete order semantics, risk controls, permissions, recovery, and auditability.
4. **Truth:** market data, balances, positions, fees, PnL, liquidations, incidents, and conflicts reconcile and are explained.
5. **Trust under stress:** the venue remains fair, recoverable, secure, and operational during volatility—not merely during demos.

“World's best” is earned only when all five are demonstrably strong. More instruments cannot compensate for weak custody; a fast engine cannot compensate for poor liquidity; portfolio margin cannot compensate for an unprovable default waterfall.

### 1.1 North-star scorecard

No numeric target is invented here. Each category requires an owner-approved target, a measurement method, a public or customer-visible disclosure policy, and an operational escalation path.

| Dimension           | Required evidence                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Availability        | Per-surface uptime, degraded-mode behavior, maintenance policy, RTO/RPO, and incident history                            |
| Execution           | Gateway-to-ack, gateway-to-book, cancel effectiveness, fill ratio, reject rate, and tail latency by access method        |
| Market quality      | Spread, depth, slippage, volatility resilience, price divergence, and recovery after dislocation                         |
| Data quality        | Sequence integrity, gap recovery, timestamp semantics, source provenance, correction policy, and historical completeness |
| Capital efficiency  | Margin utilization, eligible offsets, haircut transparency, borrow availability, and liquidation loss distribution       |
| Financial integrity | Ledger/order/position/custody reconciliation, segregation, reserve evidence, and unresolved-break aging                  |
| Safety              | Account takeover, key compromise, fraud loss, withdrawal protection, and control effectiveness                           |
| Service             | Institutional onboarding time, issue response, API incident communication, and account coverage                          |
| Fairness            | Deterministic rules, surveillance coverage, conflict disclosure, fee neutrality, and appealability                       |

---

## 2. Users whose unspoken requirements define the scope

The venue must work as one coherent system for these users. Designing only for a chart-and-order-ticket trader misses most of the professional exchange.

| Persona                       | What they will not repeatedly ask for, but will leave without                                                                           |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Discretionary active trader   | Fast amend/cancel, multi-monitor workspaces, reliable hotkeys, rich orders, precise PnL, mobile risk control, and excellent support     |
| Systematic trader             | Deterministic APIs, idempotency, replay, stable schemas, testnet parity, complete timestamps, bulk actions, and predictable rate limits |
| Quant researcher/algo owner   | Honest event-level backtests, SDK/studio parity, versioned deployment, approvals, runtime isolation, drift evidence, and kill controls  |
| Market maker                  | Mass quote, market-maker protection, cancel-on-disconnect, self-trade prevention, queue data, fee/rebate certainty, and portfolio risk  |
| Options volatility desk       | Full chain, IV surface, Greeks, scenario margin, combos, RFQ, position builder, settlement certainty, and delta/vega controls           |
| Basis and relative-value desk | Unified spot/perp/future/options risk, borrow and funding history, spreads, cross-instrument execution, and capital offsets             |
| Fund or asset manager         | Organizations, mandates, pre-trade limits, allocations, NAV/PnL, statements, approvals, custody choice, and audit evidence              |
| Broker, DMA, or OEMS          | Client hierarchy, tags, allocations, FIX, drop copy, give-up/settlement workflow, commissions, and delegated controls                   |
| Agency/care-order desk        | Staged instructions, claiming, multi-shift handoff, child-order control, TCA, fill confirmation, and client evidence                    |
| Agentic trader/operator       | Read/draft/live modes, structured confirmation, least privilege, provenance, injection defense, model audit, and immediate revocation   |
| Treasury or corporate         | Large-block execution, RFQ privacy, policy approvals, settlement finality, reporting, and named counterparties                          |
| Risk/compliance operator      | Real-time exposure, kill switches, surveillance, case evidence, rulebook authority, change history, and safe intervention               |
| Exchange operator             | Capacity headroom, book health, breaks, oracle divergence, liquidation queues, incident playbooks, and reversible controls              |

---

## 3. Research benchmark: adopt the strongest patterns, not entire competitors

This research uses first-party exchange/API documentation and primary regulatory sources current to the cutoff date. Competitors are evidence that users already expect a capability—not architecture to clone.

| Benchmark                    | Pattern worth matching or exceeding                                                                                                                               | Scope consequence                                                                                                            |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| OKX                          | Multiple account modes, portfolio margin, batch/amend flows, algo orders, MMP, risk-warning channels, broker/DMA APIs                                             | Account-mode migration, capital efficiency, bulk execution, proactive risk, and broker structures are core scope             |
| Deribit                      | Options-first mass quoting and MMP, combo instruments, multi-leg block RFQ, targeted makers, hedge legs, pre-allocation                                           | “Options exists” is insufficient without a complete volatility-desk and institutional block workflow                         |
| Coinbase Prime               | FIX 4.2 and FIX 5.0, deterministic sequencing, portfolio-wide drop copy, multi-connection recovery, buying-power APIs                                             | Institutional order entry must name FIX version; unsupported version refuses. Independent execution capture remains required |
| Kraken                       | FIX 4.4, atomic amend with retained queue priority, L3 with queue timestamps, off-book RFQ max-leverage cap distinct from book                                    | Queue-aware execution, amend semantics, and separate off-book credit are professional outcomes                               |
| Binance                      | Broad REST/WebSocket/FIX access, binary/SBE market data, amend-keep-priority, mature connector/testnet ecosystem                                                  | Protocol breadth, bandwidth efficiency, schema stability, and client tooling are part of the product                         |
| Hyperliquid                  | Integrated portfolio state, transparent mark/oracle, HIP-3 builder-deployed TradFi perps, idle-margin lending                                                     | Risk truth stays composable; permissionless listings and yield-on-margin are named products or explicit non-products         |
| Bybit                        | Unified account modes, hedge/one-way positions, 25-leg RFQ, batch option strategies, and dynamic delta hedging                                                    | Position semantics and automated portfolio hedging must be first-class, not implicit order behavior                          |
| Trading Technologies         | Professional DOM, synthetic spreads, hedge manager, staged/care orders, order passing, algo lifecycle, audit trail, workspace safety, and connection diagnostics  | A pro terminal is also an OMS and operational control plane, not only charts plus an order ticket                            |
| Interactive Brokers          | Basket/rebalance tools, extensive order/algo semantics, pre-trade what-if, scenario risk, and portfolio drill-down                                                | Portfolio construction, benchmark execution, and hypothetical risk belong in professional workflow                           |
| CME Globex                   | Cancel-on-disconnect, kill switch, self-match prevention, session-level controls, and deterministic audit fields                                                  | Mature exchange-session controls and explicit cancel reasons are part of the market contract                                 |
| OKX Agent Trade Kit          | Exchange-native MCP/CLI/skills, demo/read-only modes, permission-aware tools, local signing, and explicit AI-risk disclosures                                     | Agentic execution needs its own authority, confirmation, provenance, privacy, and adversarial-safety contract                |
| Institutional custody market | Third-party custody and off-exchange settlement reduce exchange prefunding and counterparty concentration                                                         | Custody choice, collateral control, settlement cycles, default procedures, and reconciliation require their own mountain     |
| ESMA MiCA Article 76         | Fair/orderly non-discretionary rules, peak capacity, erroneous-order controls, continuity, abuse detection, transparent market data/fees, five-year order records | Market integrity and exchange governance are product requirements, not a later legal wrapper                                 |
| CFTC DCM principles/reviews  | Audit trails, trade and market surveillance, position accountability, discipline, disputes, safeguards, emergency authority                                       | A serious derivatives venue needs enforceable rules, reconstruction, surveillance operations, and tested resilience          |

### 3.1 What the second audit added beyond the initial exchange review

The initial review correctly identified portfolio margin, richer APIs, deeper derivatives, a stronger risk workstation, and liquidity. It was not full scope. This pass adds these previously underweighted or missing domains:

- exchange rulebook, listing governance, member discipline, disputes, and emergency authority;
- real-time and retrospective market-abuse surveillance with full order reconstruction;
- off-exchange custody, collateral mirroring/control, settlement cycles, and counterparty default procedures;
- broker/DMA client hierarchies, pre-allocation, post-trade allocation, give-up, and independent drop copy;
- L3/queue analytics, feed entitlements, binary feeds, timestamps, and deterministic recovery;
- atomic amend-with-priority, dead-man controls, mass actions, mass quote, and multi-dimensional MMP;
- option combos, volatility surfaces, position building, scenario margin, exercise/assignment, and fixing governance;
- capacity engineering, disaster recovery, severe-market modes, erroneous-order controls, and operational drills;
- capital/treasury/default management, not only per-user liquidation logic;
- data licensing, statements, tax lots, institutional books and records, and evidentiary exports;
- service model, onboarding, connectivity certification, test environments, and change-management discipline.

### 3.2 What the final red-team pass added

The final pass deliberately searched outside the usual crypto-exchange checklist, using professional derivatives terminals, OMS platforms, prime brokerage, quantitative tooling, and the repository's own tracker. It found another set of real omissions:

- staged/care orders, dealer claiming, order passing, shift handoff, fill confirmation, and client instruction controls;
- explicit parent/child order trees, synthetic-order ownership, hedge-order repair, and disconnect policy per strategy;
- custom algo creation, backtesting, paper/shadow execution, approval, signed deployment, sharing, monitoring, rollback, and retirement;
- transaction-cost analysis against decision/arrival/VWAP/TWAP/close benchmarks, including market impact, opportunity cost, fees, funding, and markouts;
- advanced professional intent such as pegged/relative, midpoint, minimum-quantity, all-or-none, basket, rebalance, benchmark, and multi-account-per-leg workflows;
- terminal order-entry lock, live/sim separation, connection/session diagnostics, long-session performance, crash recovery, and prevention of duplicate intent after reconnect;
- position-mode law—net/one-way versus simultaneous long/short hedge mode—and safe migration between them;
- automated delta hedging and hedge-failure behavior for volatility portfolios;
- explicit mapping for the existing quant studio, backtest, SDK, strategy marketplace, copy trading, Convert, and FX capabilities;
- trade-finance/credit-line buying power and settlement-date exposure, which is distinct from ordinary margin borrowing.

These are incorporated below as additions to existing mountains and five new mountains. They are not decorative terminal features; each changes authority, risk, order state, money, or evidentiary truth.

### 3.3 What the 31 August 2026 competitive refresh added

The 24 August cutoff was still the right inventory of a **crypto CEX**. A 31 August pass against first-party docs and 2026 venue behavior found capabilities that desks now treat as table-stakes, or as explicit **non-products** that must be refused rather than implied:

- TradFi-linked perpetuals (equity, index, commodity, metal) as a **distinct underlying class** with hours, oracle, jurisdiction, and corporate-action law — not “another crypto perp” (Hyperliquid HIP-3, Kraken xStocks, Coinbase perpetual-style futures, gold/silver perps).
- Listing remains **admission-reviewed**. Permissionless/builder-deployed markets are not implied by M02.
- Yield-bearing, staked, or lending-idle collateral that keeps earning while posted, including slash/unbond/recall (2026 on-chain and unified-account practice).
- Segregated vs cross-collateral as a product axis **orthogonal** to standard vs portfolio margin (Deribit four named mechanisms).
- In-flight mitigation: an amend in flight cannot create a second live order or a duplicate fill (CME IFM).
- Mass-quote two-sided integrity and MMP margin reservation from quoted quantity (Deribit 2025–26 MMP/MQQ).
- FIX version law: 4.2, 4.4, and 5.0 as demanded; unsupported version refuses (Coinbase Prime FIX 5.0).
- Off-book / RFQ / liquidation-assignment leverage and credit caps distinct from book maker/taker (Kraken 20 August 2026 off-book max-leverage).
- Public maker-attribution / “L4” identity is not inferred from L2/L3.
- Pre-trade credit at firm/session (CME Globex credit controls) as a named risk product, not only kill-switch.

These land as new R-items on existing mountains. No M29. Magnitudes stay `OWNER-SET`. Child mapping: [`docs/SPEC-PRO-EXCHANGE-COMPETITIVE-DELTA-2026-08-31.md`](docs/archive/SPEC-PRO-EXCHANGE-COMPETITIVE-DELTA-2026-08-31.md).

---

## 4. Capability maturity language

Every mountain and requirement is classified with evidence. “Done” is forbidden without proof.

| State       | Meaning                                                                                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PROVEN`    | Every applicable §18 evidence transition is satisfied for the named scope, version, environment, and owner/external authority; no unresolved critical outcome remains |
| `BUILT`     | Material implementation exists, but not every professional-depth or operational requirement is proven                                                                 |
| `PARTIAL`   | A useful slice exists; important workflows or guarantees remain absent                                                                                                |
| `SPECIFIED` | A bounded, authoritative product contract exists; implementation proof is incomplete                                                                                  |
| `SOCKET`    | Explicit unresolved dependency prevents honest completion                                                                                                             |
| `ABSENT`    | No reliable repo evidence was found                                                                                                                                   |
| `OWNER-SET` | Scope is known, but a product/risk/legal magnitude or policy must be decided by the owner                                                                             |
| `EXTERNAL`  | Delivery depends on a licensed entity, venue, bank, custodian, oracle, or other adapter counterparty                                                                  |

Maturity applies per requirement, not per marketing feature. A market can be `BUILT` for basic orders and `ABSENT` for L3 data or kill-switch governance.

Section 13 retains these evidence-census classifications for continuity. In the post-spec progression in §18, `BUILT` means material code exists and cannot by itself advance beyond `IMPLEMENTED`; `PARTIAL` means different clauses or scopes stop at different evidenced stages and must name the residual. `SOCKET`, `OWNER-SET`, and `EXTERNAL` are readiness blockers rather than implementation stages. Future maturity updates record the highest §18 stage actually proved while preserving these honest residual labels; `SPECIFIED` and `PROVEN` are the shared endpoints.

---

## 5. The complete mountain map

These mountains are the stable decomposition. They describe enduring product domains, not delivery tickets. Detailed requirements beneath them become child specs and acceptance proofs.

### M00 — Product truth, rulebook, and decision control

**Outcome:** Everyone can determine what the venue promises, which rule applies, who can change it, and what remains undecided.

- `PTX-M00-R01` Public trading, participation, matching, cancellation, settlement, liquidation, fee, and market-data rules are versioned and non-discretionary.
- `PTX-M00-R02` Every product has eligible users/jurisdictions, counterparty model, conflicts, risk disclosures, and wind-down behavior.
- `PTX-M00-R03` Every live magnitude is linked to an owner decision and change history; blank values refuse closed.
- `PTX-M00-R04` Emergency actions—halt, cancel-only, reduce-only, price bands, delist, settlement change—have authority, evidence, notification, and review.
- `PTX-M00-R05` Customer complaints, trade disputes, error trades, appeals, and disciplinary actions have fair processes and immutable evidence.
- `PTX-M00-R06` Claims such as “best execution,” “insured,” “reserves,” “liquid,” or “institutional” require defined evidence and approval.

**Current baseline:** constitutional doctrine and direction documents are strong; a unified venue rulebook and change-control surface are not proven.  
**Maturity:** `PARTIAL`.

### M01 — Identity, organizations, accounts, sub-accounts, and delegation

**Outcome:** Individuals and institutions can divide strategies and delegate actions without money, data, jurisdiction, or authority leakage.

- `PTX-M01-R01` Legal entity, beneficial owner, trader, admin, auditor, risk manager, broker, and service account are distinct roles.
- `PTX-M01-R02` Sub-accounts isolate balances, orders, positions, margin, API keys, and reports unless a separately consented portfolio product says otherwise.
- `PTX-M01-R03` Role- and attribute-based permissions cover instrument, size, side, leverage, transfer, withdrawal, API, IP, time window, and approval threshold.
- `PTX-M01-R04` Dual control/four-eyes applies to policy changes, key changes, high-risk transfers, and institutional administration.
- `PTX-M01-R05` Session/API-key attribution survives into every order, fill, ledger posting, configuration change, and report.
- `PTX-M01-R06` Broker/DMA hierarchies support client tags, commission schedules, segregation, allocation, revocation, and client-visible evidence.
- `PTX-M01-R07` Trading desks, groups, shifts, execution traders, originators, caretakers, and risk supervisors have explicit visibility and action boundaries.
- `PTX-M01-R08` Account/order-routing profiles can default by market, product, strategy, leg, and broker but show the resolved account before commitment and never bypass ownership.

**Existing contract:** [`docs/SPEC-SUBACCOUNTS-2026-08-02.md`](docs/SPEC-SUBACCOUNTS-2026-08-02.md).  
**Current baseline:** sub-account isolation is well specified; organization, mandate, broker, and fine-grained institutional authority need deeper evidence.  
**Maturity:** `SPECIFIED` / `PARTIAL`.

### M02 — Market and instrument lifecycle

**Outcome:** Every listed market has unambiguous economics and remains suitable, orderly, and settleable through its entire lifecycle.

- `PTX-M02-R01` Instrument master defines asset, venue symbol, precision, tick/lot, contract multiplier, quote/base/settlement asset, expiry, exercise, and status.
- `PTX-M02-R02` Admission reviews legal eligibility, technical reliability, custody/deposit safety, manipulation susceptibility, oracle quality, liquidity, and issuer risk.
- `PTX-M02-R03` Status machine covers prelaunch, auction, open, post-only, cancel-only, reduce-only, halted, expired, settled, delisted, and archived.
- `PTX-M02-R04` Corporate actions, token migrations, forks, airdrops, redenominations, chain halts, reorgs, and asset recovery have deterministic policies.
- `PTX-M02-R05` Derivative specifications define index, mark, funding, expiry, fixing, settlement, disruption fallbacks, limits, and position accountability.
- `PTX-M02-R06` Delisting includes notice, order cancellation, position close/transfer, settlement, withdrawals, records, and appeals.
- `PTX-M02-R07` Underlying class is explicit: native crypto, stablecoin, tokenized security/equity, commodity/metal, FX, or index. Each class has listing, oracle, trading-hours, jurisdiction, corporate-action, and settlement law. A perpetual on an equity or metal is not admitted as “another crypto perp.”
- `PTX-M02-R08` Listing is admission-reviewed. Permissionless or builder-deployed markets are not implied. If ever offered they are a separate consented product that still passes every M02 gate.

**Maturity:** `PARTIAL`; broad market schemas exist, full lifecycle governance is not proven.

### M03 — Matching engine and market microstructure

**Outcome:** Price-time behavior is deterministic, fair, reconstructable, performant, and resilient under pathological flow.

- `PTX-M03-R01` Matching priority, trade allocation, rounding, self-trade prevention, maker/taker determination, and sequence rules are explicit and tested.
- `PTX-M03-R02` Atomic order acceptance binds auth, market state, limits, balance/margin hold, sequencing, matching, fees, events, and ledger settlement.
- `PTX-M03-R03` Native amend semantics state when queue priority is retained or lost; cancel/replace is never presented as atomic amend.
- `PTX-M03-R04` Cancel-on-disconnect/dead-man, cancel-all by scope, mass cancel, kill switch, and session fencing work during partial failure.
- `PTX-M03-R05` Auctions cover launch, reopen, volatility interruption, and closing/fixing where applicable, with published uncrossing rules.
- `PTX-M03-R06` Price collars, fat-finger checks, message throttles, circuit breakers, and severe-market controls reject disorderly flow without hidden discretion.
- `PTX-M03-R07` Engine journal plus gateway and risk timestamps reconstruct every order transition and trade causally.
- `PTX-M03-R08` Capacity tests cover peak messages, hot symbols, cancel storms, liquidation bursts, failover, and recovery with owner-set SLOs.
- `PTX-M03-R09` In-flight mitigation: while an amend or cancel is unconfirmed, the venue cannot create a second live order or a duplicate fill. Unknown in-flight state refuses further mutation until reconstructed.

**Current baseline:** matching, sequenced books, journaling, and recovery primitives exist; atomic amend priority, auctions, comprehensive mass controls, and capacity evidence require audit.  
**Maturity:** `BUILT` / `PARTIAL` / `SPECIFIED`.

### M04 — Order, execution, and algo toolkit

**Outcome:** Traders express intent precisely and can control execution without unsafe client-side emulation.

- `PTX-M04-R01` Core orders: market, limit, post-only, IOC, FOK, GTC, GTD/GTT, reduce-only, close-position, and client IDs.
- `PTX-M04-R02` Conditional orders: stop, stop-limit, take-profit, bracket/OCO, trailing, trigger source, trigger protection, and guaranteed cancellation semantics.
- `PTX-M04-R03` Bulk place/amend/cancel has per-item results, idempotency, rate accounting, and explicit atomic/non-atomic behavior.
- `PTX-M04-R04` Native strategies include TWAP, VWAP, POV, schedule, limit participation, slippage caps, pause/resume/cancel, child-fill attribution, and failure reporting.
- `PTX-M04-R05` Spread/strategy orders express multi-leg intent and atomicity where supported; legging risk is disclosed otherwise.
- `PTX-M04-R06` Order preview returns buying power/margin, fees, estimated impact, liquidation effect, and rejection reason before commitment.
- `PTX-M04-R07` Execution reports expose ack, reject, rest, amend, cancel, partial fill, fill, expire, trigger, liquidation, bust/correct, and recovery states.
- `PTX-M04-R08` Smart order routing states venues, fees, price protection, partial-fill policy, information leakage, and best-execution evidence.
- `PTX-M04-R09` Professional order attributes include pegged/relative and midpoint behavior where market structure supports them, minimum quantity, all-or-none, display quantity, and benchmark/auction instructions; unsupported intent refuses rather than being silently weakened.
- `PTX-M04-R10` Every native, venue-simulated, and platform-synthetic order is visibly identified, with its execution location, parent/child tree, persistence owner, failure domain, cancel propagation, and reconnect behavior.
- `PTX-M04-R11` Basket, portfolio rebalance, scale, accumulate/distribute, arrival-price/implementation-shortfall, and conditional cross-instrument workflows have worst-case pre-trade risk and deterministic partial-failure policy.
- `PTX-M04-R12` Multi-leg execution models quote legs, hedge legs, working risk, legging state, hedge-repair choices, account per leg, and the consequence of abandoning a parent while children remain live.

**Current baseline:** core order schema and TWAP/VWAP/POV implementations exist; production enablement and advanced lifecycle depth are uneven. Iceberg remains out under current direction unless separately re-decided.  
**Maturity:** `BUILT` / `PARTIAL` / `SPECIFIED` / `SOCKET`.

### M05 — Professional connectivity and execution APIs

**Outcome:** A professional client can integrate once, recover deterministically, and operate at scale without scraping UI state.

- `PTX-M05-R01` Public/private REST and WebSocket contracts are versioned, authenticated, idempotent where needed, and complete across products.
- `PTX-M05-R02` FIX order entry and FIX market data support session sequencing, replay, resend, heartbeats, certification, and stable dictionaries.
- `PTX-M05-R03` Independent drop-copy streams all executions across UI, REST, WebSocket, FIX, algo, liquidation, RFQ, and broker sources.
- `PTX-M05-R04` High-throughput binary/SBE-like feeds have schemas, compatibility policy, entitlements, capture tools, and reference decoders.
- `PTX-M05-R05` Rate limits expose scopes, weights, remaining capacity, reset/retry semantics, fill-ratio rules, and institutional tiers.
- `PTX-M05-R06` API keys support scopes, sub-account, product, IP/network allowlist, expiry, rotation, provenance, and emergency revocation.
- `PTX-M05-R07` Idempotency and client IDs define uniqueness domain, retention, collision, replay, and terminal-state lookup.
- `PTX-M05-R08` Changelog, deprecation window, schema diff, migration guide, status feed, and breaking-change policy are contractual.
- `PTX-M05-R09` Connectivity options include internet, approved low-latency paths/colocation where viable, redundant endpoints, and time synchronization guidance.
- `PTX-M05-R10` FIX version is explicit (4.2, 4.4, 5.0 as demanded). An unsupported version refuses. Dictionaries and certification are per version and are not implied by “FIX exists.”

**Current baseline:** REST/WebSocket and CCXT-shaped surfaces exist; FIX, drop copy, binary feeds, certification, and institutional network products were not found.  
**Maturity:** `PARTIAL` / `ABSENT`.

### M06 — Market data, reference data, and historical data

**Outcome:** Traders can price, trade, recover, research, and prove outcomes from authoritative data.

- `PTX-M06-R01` L1/L2/L3 feeds state sequence, checksum, snapshot, delta, gap, replay, correction, timestamp, and conflation rules.
- `PTX-M06-R02` Trades distinguish aggressor, auction, liquidation, block/RFQ, correction, and bust according to disclosure policy.
- `PTX-M06-R03` Reference feeds cover instruments, status, fees, tiers, limits, collateral, haircuts, rates, indices, marks, funding, open interest, and expiries.
- `PTX-M06-R04` Derivatives data includes term structure, basis, funding history, liquidations, OI, IV, Greeks, volatility surface, and settlement history.
- `PTX-M06-R05` Historical tick/order-book/trade data is downloadable with provenance, completeness metrics, corrections, and reproducible schemas.
- `PTX-M06-R06` Queue-position and fill-probability tooling is derived honestly from L3/order events where permitted, never implied from L2 alone.
- `PTX-M06-R07` Data licensing, redistribution, retention, entitlement, privacy, and commercial terms are explicit.
- `PTX-M06-R08` Internal and external consumers share canonical identifiers and timestamps; adapters cannot silently reinterpret instruments.
- `PTX-M06-R09` Implied and synthetic markets, spread BBO, auction imbalance, indicative prices, index constituents, and non-actionable reference prices are unmistakably distinguished from executable native liquidity.
- `PTX-M06-R10` Terminal consumers receive per-stream freshness, entitlement, source, sequence health, clock offset, and last-good-update metadata—not a single misleading global “connected” flag.
- `PTX-M06-R11` Public maker identity / LP attribution / “L4” is not inferred from L2 or L3. If the feed is not entitled or not produced, the door refuses rather than inventing attribution.

**Current baseline:** public book, trades, candles, ticker, funding, and normalized venue data exist; L3, full derivative analytics, data products, and correction/licensing machinery need work.  
**Maturity:** `BUILT` / `PARTIAL` / `ABSENT`.

### M07 — Professional terminal and trader experience

**Outcome:** A discretionary professional can monitor, decide, execute, and control risk faster than switching among specialist tools.

- `PTX-M07-R01` Multi-workspace, detachable/resizable panels, saved cloud layouts, multi-monitor continuity, command palette, and keyboard-first navigation.
- `PTX-M07-R02` Charting supports drawing, indicator templates, multi-chart linking, order/position overlays, alerts, compare, and replay.
- `PTX-M07-R03` DOM/ladder, depth heatmap, tape, footprint/order-flow, spread matrix, watchlists, scanners, and market statistics are synchronized.
- `PTX-M07-R04` Tickets support every native order/strategy, presets, one-click controls with safeguards, drag-amend, position sizing, and preview.
- `PTX-M07-R05` Blotters unify orders, fills, positions, strategies, transfers, funding, borrow, RFQ, and errors with powerful filters and exports.
- `PTX-M07-R06` Risk workspace exposes collateral, utilization, Greeks, scenarios, concentration, liquidation bands, ADL/default indicators, and alerts.
- `PTX-M07-R07` Mobile is a secure control plane for monitoring, alerts, cancel-all, reduce risk, approvals, and incidents—not a placeholder.
- `PTX-M07-R08` Accessibility, localization, timezone, number format, precision, error clarity, degraded-state truth, and no-stale-data signaling are first-class.
- `PTX-M07-R09` A persistent session-status surface distinguishes authentication, trading connection, private state, each market-data subscription, clock health, software/schema version, and degraded dependencies.
- `PTX-M07-R10` Workspace safety supports lock-all, lock-order-entry, live/simulation banners, configurable confirmations, protected destructive hotkeys, account/color coding, and a globally visible trading-enabled state.
- `PTX-M07-R11` Browser/desktop crash, sleep, network transition, refresh, tab duplication, and reconnect recover server truth before enabling new intent; client retries cannot duplicate orders.
- `PTX-M07-R12` The terminal remains responsive through long sessions, dense L3 books, large portfolios, burst fills, many charts, and multi-window use, with explicit render/input/memory budgets and graceful shedding.
- `PTX-M07-R13` Order and strategy trees show parent, children, hedge orders, venue, account, owner, strategy, working exposure, orphan state, and all causal messages in a persistent trader audit trail.
- `PTX-M07-R14` Funding, expiry, settlement, listing/delisting, maintenance, governance, economic-event, and exchange-announcement calendars drive configurable in-app, push, email, webhook, and sound alerts with provenance.
- `PTX-M07-R15` Presets, columns, hotkeys, layouts, alert rules, and order profiles are versioned, portable, shareable under organization permission, and recoverable from a known-good version.
- `PTX-M07-R16` A trade journal can attach rationale, tags, screenshots, strategy, and review notes without altering authoritative order/fill/PnL history; replay clearly separates historical simulation from live trading.
- `PTX-M07-R17` Scoped join/cross, reprice-by-tick, cancel, cancel-all, close, flatten, and reverse controls show affected accounts/orders/positions, preserve reduce-only intent, and require protection proportional to blast radius.

**Current baseline:** the vendored terminal contains substantial chart, depth, trade, position, hotkey, and account UI; adapter coverage and institutional workflows lag the visual shell.  
**Maturity:** `BUILT` / `PARTIAL`.

### M08 — Collateral, margin, financing, and capital efficiency

**Outcome:** Traders understand exactly what collateral supports which risk, how buying power changes, and where loss can propagate.

- `PTX-M08-R01` Modes are explicit products: cash/spot, isolated margin, cross margin, multi-collateral, and risk-based portfolio margin.
- `PTX-M08-R02` Switching modes has eligibility, consent, migration preview, open-risk constraints, rollback rules, and full audit.
- `PTX-M08-R03` Collateral eligibility, valuation, haircuts, concentration, wrong-way risk, liquidity add-ons, stablecoin depeg, and oracle fallbacks are versioned.
- `PTX-M08-R04` Portfolio margin uses documented scenarios, offsets, minimums, floors, anti-procyclicality, and independently reproducible calculations.
- `PTX-M08-R05` Pre-trade buying power and post-trade IM/MM/excess/deficit reconcile to liquidation logic and customer statements.
- `PTX-M08-R06` Borrowing defines inventory, utilization, interest index, caps, recalls, term/open loans, collateral, repayment, defaults, and lender risk.
- `PTX-M08-R07` Financing includes cross-currency liabilities, interest accrual, auto-borrow/repay with consent, funding, and transparent all-in cost.
- `PTX-M08-R08` Cross-sub-account or organization offsets are separate consented products and never emerge from aggregate reads.
- `PTX-M08-R09` Trade-finance and bilateral-credit products define committed/uncommitted lines, eligible use, tenor/settlement date, utilization, high-water or other fee basis, collateral, buying power, withdrawal power, margin interaction, recall, default, and lender concentration.
- `PTX-M08-R10` Segregation and calculation are orthogonal named products: segregated vs cross-collateral, and standard vs portfolio margin. The four combinations are explicit. Switching still follows R02.
- `PTX-M08-R11` Yield-bearing, staked, or lending-idle collateral is a separate product. Yield, slash, unbond, recall, and haircut cannot silently turn posted margin into a loan or a disappearing asset. Unsupported collateral class refuses.

**Current baseline:** isolated futures and lending primitives exist; multi-collateral and portfolio margin are material missing mountains and may conflict with current v1 isolation if treated as implicit upgrades.  
**Maturity:** `BUILT` / `PARTIAL` for the isolated slice; `SPECIFIED` / `OWNER-SET` for north-star modes.

### M09 — Real-time risk, liquidation, and default management

**Outcome:** Risk is measured continuously, interventions minimize unnecessary loss, and the default waterfall is provable.

- `PTX-M09-R01` Position, market, counterparty, collateral, concentration, liquidity, basis, volatility, and operational risks aggregate at correct legal boundaries.
- `PTX-M09-R02` Mark and index construction use independent sources, robust outlier/staleness logic, source degradation states, and public methodology.
- `PTX-M09-R03` Margin warnings, pre-liquidation controls, collateral transfer/repay options, and risk-reducing order priority are timely and actionable.
- `PTX-M09-R04` Liquidation is partial and staged where safe, uses bounded execution, cancels conflicting orders, records all prices/fees, and avoids unnecessary bankruptcy.
- `PTX-M09-R05` Insurance fund, recovery, socialized loss (if ever), and ADL have an explicit waterfall, ownership, accounting, caps, priority, and disclosures.
- `PTX-M09-R06` Default management covers trader, market maker, broker, custodian, settlement network, oracle, bank, and venue failures.
- `PTX-M09-R07` Exchange capital, liquidity buffers, stress loss, and concentration thresholds are monitored with owner-set escalation.
- `PTX-M09-R08` Risk models have versioning, backtesting, independent review, shadow runs, explainability, and rollback.
- `PTX-M09-R09` Operator controls are scoped, dual-controlled where material, time-bound, observable, and incapable of creating unbalanced money.
- `PTX-M09-R10` Pre-trade credit at firm and session (max order, max position, max loss, or equivalent owner-set dimensions) can block new risk without inventing a flatten. Unset dimensions refuse.

**Current baseline:** partial liquidation, insurance, ADL, funding, and risk checks exist in an isolated model; portfolio/counterparty/default stress depth is incomplete.  
**Maturity:** `BUILT` / `PARTIAL` / `SPECIFIED` / `OWNER-SET`.

### M10 — Spot, margin, perpetuals, and dated futures

**Outcome:** Core linear products are institutionally complete, liquid, and mutually coherent.

- `PTX-M10-R01` Spot supports custody-backed settlement, margin eligibility, fee asset, precision, min notional, and deterministic finality.
- `PTX-M10-R02` Linear and inverse perpetuals define contract multiplier, collateral, funding, mark, limits, liquidation, and ADL.
- `PTX-M10-R03` Dated futures define expiry series, basis/calendar displays, final settlement/fixing, disruption fallbacks, and roll tooling.
- `PTX-M10-R04` Cross-instrument spread and basis execution can be priced, risk-checked, executed, and attributed coherently.
- `PTX-M10-R05` Funding predicts, accrues, settles, corrects, and reports consistently across UI/API/ledger/statements.
- `PTX-M10-R06` Contract migrations and emergency settlement cannot strand orders, positions, PnL, or collateral.
- `PTX-M10-R07` Position mode is explicit: net/one-way versus simultaneous long/short hedge mode, including order-side semantics, reduce/close behavior, margin, reporting, API fields, and migration constraints with open orders/positions.

**Current baseline:** spot and isolated perpetual-style futures are broadly present; dated futures, production depth, and integrated basis workflows need proof.  
**Maturity:** `BUILT` / `PARTIAL`.

### M11 — Options and volatility trading

**Outcome:** An options professional can price, quote, hedge, margin, execute, and settle a portfolio without relying on another venue for core workflow.

- `PTX-M11-R01` European call/put contracts define style, expiry, strike, multiplier, premium, collateral, exercise, settlement asset, index/fixing, and disruption policy.
- `PTX-M11-R02` Full chain displays bid/ask, IV, delta, gamma, vega, theta, OI, volume, skew, term structure, and data freshness.
- `PTX-M11-R03` Position builder models multi-leg payoff, Greeks, scenario PnL, margin change, fees, and execution alternatives before commitment.
- `PTX-M11-R04` Native combo books and/or atomic multi-leg execution cover standard and custom strategies with defined ratio/legging behavior.
- `PTX-M11-R05` Market makers receive mass quote, quote sets, cancel groups, MMP by quantity/delta/vega, freeze/reset state, and protections against stale quotes.
- `PTX-M11-R06` Options RFQ supports multi-leg strategies, targeted makers, anonymity rules, quote expiry, hedge leg, block reporting, and allocations.
- `PTX-M11-R07` Scenario portfolio margin captures spot, vol, skew, basis, time, concentration, liquidity, and minimum floors.
- `PTX-M11-R08` Exercise/expiry/assignment/fixing jobs are idempotent, recoverable, reconciled, pre-announced, and independently reproducible.
- `PTX-M11-R09` Automated delta hedging defines target/range, hedge instrument, trigger/cadence, order type, slippage/size caps, interaction with manual orders, residual delta, failure/termination, position persistence, fees, and complete attribution.
- `PTX-M11-R10` Options risk supports saved/imported what-if portfolios, user-defined spot/vol/time/rate/skew shocks, drill-down by underlying/expiry/strategy, unresolved-position warnings, hedge preview, and export.
- `PTX-M11-R11` If one side of a required two-sided mass quote is rejected, the paired side is rejected or cancelled. A one-sided remainder is allowed only when the quote set explicitly permits it.
- `PTX-M11-R12` MMP groups and quote-set freeze apply to mass quotes. MMP may reserve margin from quoted quantity. Owner quantity/delta/vega/interval/freeze magnitudes remain unset-refuse.

**Current baseline:** the tracker names fully collateralized European options, but the settlement-asset law remains a socket and the professional volatility stack is not proven.  
**Maturity:** `PARTIAL` / `SOCKET` / `ABSENT`.

### M12 — RFQ, block, OTC, and institutional allocation

**Outcome:** Large and complex trades execute privately with firm prices, fair disclosure, controlled information leakage, and complete post-trade evidence.

- `PTX-M12-R01` RFQ distinguishes principal, matched-principal, and routed agency models, with counterparty and markup disclosure.
- `PTX-M12-R02` Quotes state instruments/legs, direction, ratios, amount, price, expiry, settlement, maker, and firmness; no undisclosed last look.
- `PTX-M12-R03` Takers may target makers, define anonymity, attach hedge legs, compare quotes, and control information exposure.
- `PTX-M12-R04` Pre-allocation and post-trade allocation support sub-accounts, funds, broker clients, average price, fees, breaks, correction, and approval.
- `PTX-M12-R05` Block thresholds, delayed/public reporting, surveillance, wash prevention, and order-book interaction follow the rulebook.
- `PTX-M12-R06` OTC settlement covers escrow/DvP, custody location, confirmation, netting where lawful, fails, disputes, and counterparty limits.
- `PTX-M12-R07` Voice/chat/manual-assisted execution enters the same audit, risk, fee, compliance, and ledger path as electronic orders.
- `PTX-M12-R08` Give-up, clearing account, average-price/bunched allocation, affirmation, confirmation, settlement instruction, and allocation-break workflows preserve client, broker, executing, and carrying-account identity.
- `PTX-M12-R09` Off-book, RFQ, and liquidation-assignment fills have pre-trade leverage and credit caps distinct from book maker/taker limits. A blank cap refuses; it does not inherit the book schedule.

**Existing contract:** [`docs/SPEC-OTC-RFQ-AND-EARN-2026-08-02.md`](docs/archive/SPEC-OTC-RFQ-AND-EARN-2026-08-02.md).  
**Current baseline:** firm-quote honesty is specified and RFQ primitives exist; maker routing, multi-leg blocks, allocation, and institutional post-trade depth remain incomplete.  
**Maturity:** `SPECIFIED` / `PARTIAL` / `SOCKET`.

### M13 — Liquidity, market makers, and market quality

**Outcome:** Markets are genuinely tradable at intended size, and liquidity incentives improve—not distort—price discovery.

- `PTX-M13-R01` Launch-liquidity plans define makers, capital, symbols, obligations, spreads, depth, uptime, inventory, and exit criteria.
- `PTX-M13-R02` External liquidity and venue aggregation are visibly sourced; executable internal depth is never overstated.
- `PTX-M13-R03` Maker programs define objective tiers, rebates, obligations, monitoring, clawbacks, suspension, conflicts, and equal-access criteria.
- `PTX-M13-R04` Internal/affiliate market making is legally reviewed, segregated, disclosed where required, surveillance-covered, and cannot see private customer intent.
- `PTX-M13-R05` Market-quality telemetry covers spread, depth, slippage, price divergence, adverse selection, maker concentration, outages, and toxic flow.
- `PTX-M13-R06` Incentives do not reward excessive cancels, wash volume, disorderly messaging, or fake depth.
- `PTX-M13-R07` Liquidity crisis playbooks cover maker withdrawal, venue loss, oracle divergence, depeg, borrow shortage, and mass liquidation.

**Current baseline:** internal seeding, venue adapters, latency grading, SOR, arbitrage, and market-making engines exist; sustainable external liquidity and conflict governance remain business-critical gaps.  
**Maturity:** `BUILT` infrastructure / `EXTERNAL` / `OWNER-SET` outcome.

### M14 — Portfolio, analytics, accounting, and reporting

**Outcome:** Every user can explain present risk and historical performance from authoritative records.

- `PTX-M14-R01` Real-time balances, equity, buying power, IM/MM, liabilities, accrued funding/interest, collateral, and holds reconcile across surfaces.
- `PTX-M14-R02` PnL distinguishes realized/unrealized, trading, funding, fees, rebates, interest, settlement, liquidation, transfer, and FX effects.
- `PTX-M14-R03` Position views aggregate by instrument, strategy, sub-account, account, organization, underlying, currency, venue, and counterparty without enabling cross-leak writes.
- `PTX-M14-R04` Performance analytics include equity curve, drawdown, returns, attribution, exposure, concentration, Greeks, basis, and benchmark comparison.
- `PTX-M14-R05` Statements, confirmations, invoices, fee reports, funding/interest reports, tax lots, cost basis, and machine-readable exports are immutable and reproducible.
- `PTX-M14-R06` Institutions receive NAV-ready data, accounting mappings, scheduled delivery, SFTP/API options, and correction/version history.
- `PTX-M14-R07` Audit and regulator exports reconstruct user, session, order, fill, fee, ledger, position, transfer, and custody state with common IDs.

**Maturity:** `PARTIAL`; operational records exist, professional analytics and evidentiary reporting are not proven end-to-end.

### M15 — Custody, deposits/withdrawals, settlement, and treasury

**Outcome:** Trading access does not require users to accept opaque custody or settlement risk, and every external/internal balance reconciles.

- `PTX-M15-R01` Custody models distinguish omnibus, segregated/dedicated, third-party, and off-exchange controlled collateral with legal ownership and insolvency treatment.
- `PTX-M15-R02` Off-exchange settlement/collateral mirroring defines control, available collateral, encumbrance, intraday calls, settlement cycle, thresholds, shortfalls, and default.
- `PTX-M15-R03` Deposits and withdrawals cover address ownership, chain finality, reorg, memo/tag, wrong-chain/asset recovery, screening, travel rule, holds, fees, batching, and acceleration.
- `PTX-M15-R04` Fiat rails define bank/PSP adapter, cutoffs, holidays, returns/recalls, name match, source of funds, reconciliation, and safeguarded funds.
- `PTX-M15-R05` Internal trade settlement, external venue settlement, RFQ/OTC settlement, and custody settlement each have explicit finality and failure states.
- `PTX-M15-R06` Treasury controls hot/warm/cold inventory, withdrawal liquidity, network fees, rebalance, counterparty exposure, key ceremonies, and segregation.
- `PTX-M15-R07` Every ledger liability reconciles to controlled assets/receivables at defined frequency; breaks age, escalate, and never auto-disappear.
- `PTX-M15-R08` Custodian, bank, chain, bridge, stablecoin, and settlement-network failure have exposure caps and exit playbooks.

**Current baseline:** custody/ledger and transfer foundations exist; institutional custody choice and off-exchange settlement are major missing north-star capabilities.  
**Maturity:** `PARTIAL` / `SPECIFIED` / `EXTERNAL` / `OWNER-SET`.

### M16 — Market integrity, surveillance, and exchange compliance

**Outcome:** The venue can prevent, detect, reconstruct, investigate, and act on abusive or disorderly activity.

- `PTX-M16-R01` Complete order-event audit trail retains identity, beneficial owner, session, device/key, client/broker tag, timestamps, decisions, and linked trades/ledger entries.
- `PTX-M16-R02` Surveillance covers spoofing/layering, wash/self trading, marking, momentum ignition, manipulation, collusion, insider/listing abuse, quote stuffing, and liquidation/oracle attacks.
- `PTX-M16-R03` Cross-account, cross-sub-account, cross-product, cross-venue, RFQ/block, transfer, and on-chain context support investigations.
- `PTX-M16-R04` Alerts enter case management with evidence preservation, triage, escalation, disposition, reporting, and false-positive/model governance.
- `PTX-M16-R05` Position limits/accountability, large-trader monitoring, concentration, beneficial ownership aggregation, and exemptions are enforced.
- `PTX-M16-R06` Trade bust/correction, error trade, suspension, restriction, discipline, appeal, and regulatory notification follow explicit authority.
- `PTX-M16-R07` Market-data transparency, fee fairness, access criteria, and latency treatment are non-discriminatory and auditable.
- `PTX-M16-R08` Record retention/export satisfies applicable order-book and transaction formats without corrupting the internal canonical record.
- `PTX-M16-R09` AML/sanctions/fraud controls cover account creation, deposits, trading behavior, transfers, counterparties, withdrawals, and case escalation without treating compliance as a trading-engine side effect.

**Current baseline:** identity/compliance and audit primitives exist; dedicated market surveillance, case workflow, rule enforcement, and regulator-grade reconstruction require a separate audit/spec.  
**Maturity:** `PARTIAL` / `ABSENT`.

### M17 — Security and participant protection

**Outcome:** Compromise of a person, device, key, employee, vendor, or subsystem is contained before it becomes an irreversible financial loss.

- `PTX-M17-R01` MFA/WebAuthn, device/session management, phishing resistance, login anomaly, and account recovery are designed as money controls.
- `PTX-M17-R02` API secrets use secure creation/display, hashing/encryption, least privilege, network restrictions, rotation, revocation, anomaly detection, and key-specific kill switches.
- `PTX-M17-R03` Withdrawals support address allowlists, cooling periods, velocity/risk controls, approvals, trusted devices, out-of-band notices, and honest delay states.
- `PTX-M17-R04` Privileged access is just-in-time, least-privileged, dual-controlled for material actions, session-recorded, and independently reviewed.
- `PTX-M17-R05` Secure SDLC, dependency/supply-chain controls, secrets, vulnerability handling, penetration testing, bounty, and incident response have accountable owners.
- `PTX-M17-R06` DDoS, bot, API abuse, credential stuffing, insider threat, social engineering, SIM-swap, and support-channel takeover are exercised.
- `PTX-M17-R07` Privacy defines collection, residency, access, minimization, retention, export, deletion constraints, and breach response.
- `PTX-M17-R08` Customer protection states what is insured, guaranteed, segregated, recoverable, or not—without ambiguous marketing.

**Maturity:** `PARTIAL`; strong primitives do not replace a complete participant-protection proof.

### M18 — Resilience, operations, and incident command

**Outcome:** The exchange fails predictably, recovers provably, and tells users the truth while it does so.

- `PTX-M18-R01` SLOs and error budgets exist per order entry, matching, market data, risk, ledger, transfer, custody, and reporting surface.
- `PTX-M18-R02` Dependency map identifies blast radius and degraded behavior for database, NATS, Redis, region, cloud, chain, oracle, venue, custodian, and bank failure.
- `PTX-M18-R03` Active/passive or multi-region recovery preserves single-writer/sequence safety, prevents split-brain money, and proves RTO/RPO.
- `PTX-M18-R04` Backups, restore, journal replay, ledger reconciliation, and data correction are regularly exercised with retained evidence.
- `PTX-M18-R05` Capacity management forecasts peak messages/orders/positions/data, rate-limit headroom, storage, and external quotas.
- `PTX-M18-R06` Incident command defines severity, authority, trader communications, status page, regulatory/customer notifications, timeline, reconciliation, and post-incident actions.
- `PTX-M18-R07` Maintenance and releases state session behavior, open-order treatment, schema compatibility, rollback, and customer notice.
- `PTX-M18-R08` Runbooks cover stale books, missing sequences, risk lag, oracle split, ledger break, stuck withdrawal, settlement fail, cancel storm, liquidation storm, and custody outage.

**Current baseline:** telemetry, reconciliation, matching journal/replay, and adapter health primitives exist; venue-wide drills and customer-facing service proofs require evidence.  
**Maturity:** `BUILT` / `PARTIAL`.

### M19 — Developer ecosystem, sandbox, and client certification

**Outcome:** Clients can build and validate production-safe integrations without learning through financial loss.

- `PTX-M19-R01` Testnet/demo matches production contracts, auth, sequencing, risk states, rate-limit behavior, instruments, and failure simulation.
- `PTX-M19-R02` SDKs/connectors for priority languages are generated or contract-tested, versioned, maintained, and explicit about decimal handling.
- `PTX-M19-R03` FIX/API certification validates sequencing, recovery, duplicate handling, disconnect, mass cancel, risk rejects, and clock behavior.
- `PTX-M19-R04` Reference apps, Postman/OpenAPI, FIX dictionaries, binary schemas, examples, and capture/replay tools are runnable.
- `PTX-M19-R05` Client telemetry lets integrators diagnose request IDs, latency timestamps, rejects, limits, disconnections, and venue incidents.
- `PTX-M19-R06` Status, changelog, release calendar, deprecation, breaking-change notification, and support escalation are machine-consumable.
- `PTX-M19-R07` Backtest/simulation datasets state survivorship, corrections, fees, funding, latency assumptions, and known limitations.

**Current baseline:** REST/WS/CCXT and repo test infrastructure exist; public SDK, certification, parity sandbox, and lifecycle program require evidence.  
**Maturity:** `PARTIAL` / `ABSENT`.

### M20 — Institutional onboarding, service, and operations

**Outcome:** A professional organization can become operational, remain supported, and pass its own risk/audit review.

- `PTX-M20-R01` KYB/UBO, mandate, jurisdiction, tax, suitability, credit/counterparty, and product eligibility form one traceable onboarding case.
- `PTX-M20-R02` Legal agreements cover trading, custody, margin, market data, APIs, RFQ/block, broker, off-exchange settlement, and dispute venue.
- `PTX-M20-R03` Due-diligence package includes corporate/legal, security, financial, custody, insurance, BCP, risk, audit, and control evidence.
- `PTX-M20-R04` Named coverage, 24/7 trading support, technical account management, incident escalation, and service reviews have measurable commitments.
- `PTX-M20-R05` Connectivity onboarding includes test credentials, certification, production cutover, limits, contacts, monitoring, and rollback.
- `PTX-M20-R06` Account changes, limits, fee tiers, settlement details, permissions, and closures use authenticated, dual-controlled workflows.
- `PTX-M20-R07` Offboarding covers orders, positions, liabilities, statements, keys, data retention, assets, unresolved cases, and legal holds.

**Maturity:** `PARTIAL` / `ABSENT`; this is as much operating-model scope as software scope.

### M21 — Fees, incentives, and commercial economics

**Outcome:** Total trading cost is transparent, predictable, competitive, and cannot incentivize abusive behavior.

- `PTX-M21-R01` Maker/taker, tier, VIP, broker, RFQ, block, liquidation, funding, borrow, withdrawal, custody, data, and service fees are versioned.
- `PTX-M21-R02` Fee preview and fill reports show basis, rate, asset, amount, tier, rebate, markup, and correction.
- `PTX-M21-R03` Tier calculation defines volume window, product eligibility, related-account aggregation, exclusions, timing, and appeals.
- `PTX-M21-R04` Maker incentives bind payment to measurable market quality and prohibit self/wash volume and disorderly cancel incentives.
- `PTX-M21-R05` Broker commissions and markups are attributable, disclosed as required, reconciled, and never hidden in an unexplained price.
- `PTX-M21-R06` Promotions have budget, source, eligibility, end, abuse controls, accounting, and truthful labels.
- `PTX-M21-R07` Venue unit economics include liquidity cost, insurance/default capital, custody, data, support, compliance, and infrastructure—not only fee revenue.

**Maturity:** `PARTIAL` / `OWNER-SET`.

### M22 — Multi-venue, on-chain, and execution network

**Outcome:** Traders can access the best available venue or liquidity source without losing custody, risk, or execution truth.

- `PTX-M22-R01` Venue adapters normalize instruments, precision, order states, fees, timestamps, rate limits, balances, and reconciliation without erasing venue-specific semantics.
- `PTX-M22-R02` SOR compares executable price, fees, latency, fill probability, size, custody/settlement, counterparty, and failure risk.
- `PTX-M22-R03` Child orders preserve parent intent, client attribution, venue, fee, slippage, partial-fill, cancel, and recovery state.
- `PTX-M22-R04` Cross-venue inventory, prefunding, transfers, credit, settlement, and counterparty caps are visible to risk and treasury.
- `PTX-M22-R05` DEX routing includes wallet/custody authority, approval risk, gas, MEV, slippage, reorg, finality, bridge, and contract risk.
- `PTX-M22-R06` Best-execution evidence is reproducible, including why a venue was excluded or a route degraded.
- `PTX-M22-R07` Venue outage or divergence cannot cause invented fills, stale balances, duplicate orders, or unsafe rerouting.

**Existing contract:** [`docs/SPEC-SOVEREIGN-ROUTING-AND-COPY-2026-08-01.md`](docs/SPEC-SOVEREIGN-ROUTING-AND-COPY-2026-08-01.md).  
**Current baseline:** adapters, grading, data lake, SOR, arbitrage, and MM infrastructure are extensive; capital/counterparty and institutional execution proof remains essential.  
**Maturity:** `BUILT` / `PARTIAL`.

### M23 — Exchange finance, reconciliation, transparency, and wind-down

**Outcome:** The venue can prove solvency-relevant facts, identify every break, fund its obligations, and close products without trapping customers.

- `PTX-M23-R01` Ledger control accounts reconcile orders, holds, positions, fees, funding, interest, liquidations, insurance, custody, chains, banks, and external venues.
- `PTX-M23-R02` Breaks have ownership, materiality, age, source, correction entry, customer impact, escalation, and closure evidence.
- `PTX-M23-R03` Client liabilities, controlled assets, receivables, encumbrances, collateral, insurance/default funds, and corporate assets are distinctly represented.
- `PTX-M23-R04` Reserve/liability attestations define scope, frequency, exclusions, privacy, auditor/cryptographic method, and limitations; no misleading proof-of-reserves claim.
- `PTX-M23-R05` Exchange capital and liquidity planning cover operational loss, market stress, custodian/bank/venue default, run behavior, and wind-down costs.
- `PTX-M23-R06` Orderly wind-down covers new-risk stop, close/transfer positions, settle derivatives, repay borrow, withdraw assets, retain records, and support disputes.
- `PTX-M23-R07` Finance closes produce reproducible revenue, fee, rebate, interest, funding, custody, treasury, tax, and entity-level records.

**Current baseline:** the one-ledger doctrine and reconciliation tooling are strong foundations; exchange-level solvency transparency, capital planning, and wind-down require explicit scope and evidence.  
**Maturity:** `BUILT` foundation / `PARTIAL` / `SPECIFIED` / `OWNER-SET`.

### M24 — Quantitative strategy lifecycle and governed automation

**Outcome:** A professional can research, test, approve, deploy, observe, and retire automated strategies without confusing historical results, simulated intent, or live money.

- `PTX-M24-R01` No-code studio and TypeScript/Python SDK share a typed strategy model for market data, signals, state, timers, orders, positions, risk blocks, parameters, and deterministic versioning.
- `PTX-M24-R02` Backtests are event-level where required and disclose data provenance, gaps, survivorship, fees, spread, slippage, latency, funding, borrow, liquidity, queue assumptions, and unsupported market mechanics.
- `PTX-M24-R03` Research enforces in-sample/out-of-sample or walk-forward separation, records every tried variant, resists selection bias, and never presents simulated PnL as live performance.
- `PTX-M24-R04` Paper and shadow modes consume production-shaped feeds/contracts while making money movement impossible; visual state and credentials cannot be confused with live.
- `PTX-M24-R05` Deployment binds immutable strategy version, owner, approvers, environment, accounts, instruments, capital, order/position/loss/message limits, schedule, secrets, and expiry.
- `PTX-M24-R06` Organization policy can require independent review and approval before live use; code/config changes invalidate approval and produce a new version.
- `PTX-M24-R07` Runtime isolates compute, network, secrets, tenant data, and failure; deterministic recovery states whether strategies and children resume, pause, cancel, or require intervention.
- `PTX-M24-R08` Live control includes launch, schedule, pause, resume, drain, cancel children, flatten within authority, kill, rollback, and undeploy, with all actions audited.
- `PTX-M24-R09` Monitoring attributes signals, decisions, rejects, parent/child orders, fills, costs, risk, drift, data health, latency, and exceptions to the exact strategy version.
- `PTX-M24-R10` Backtest-to-paper-to-live promotion has parity tests, capacity tests, historical stress replay, model/data change gates, canary capital, and automatic rollback conditions.
- `PTX-M24-R11` Shared strategies separate view, clone, edit, approve, launch, and capital permissions; revocation and creator departure cannot leave unowned live automation.
- `PTX-M24-R12` Strategy marketplace claims use verified live versus simulated records, net-of-cost performance, drawdown and risk context, version continuity, capacity, conflicts, fees, and delisting/wind-down rules.

**Existing repository surfaces:** `quant.studio`, `quant.backtest`, `quant.sdk`, `quant.marketplace`, `services/svc-quant`, and `packages/quant-honesty`.

**Current baseline:** meaningful refuse-closed studio/backtest/SDK/marketplace foundations exist, but Monte Carlo remains a named residual and a complete institutional approval/deployment/runtime proof requires audit.
**Maturity:** `BUILT` / `PARTIAL`.

### M25 — Professional OMS, desk workflow, and execution intelligence

**Outcome:** Funds, brokers, agency desks, and multi-shift teams can originate, work, hand off, evaluate, and prove client execution without losing order ownership or queue state.

- `PTX-M25-R01` Staged/care orders distinguish originator, client instruction, execution owner, account, limit, benchmark, urgency, discretion, expiry, and compliance tags from exchange-live child orders.
- `PTX-M25-R02` Claim, unclaim, assign, pass, accept, reject, and undo-pass maintain visible current ownership, original authority, shared visibility, queue continuity where possible, and immutable history.
- `PTX-M25-R03` Night-desk/shift handoff transfers monitoring and permitted management without transferring account risk, changing originator identity, or creating an interval of unowned live orders.
- `PTX-M25-R04` Parent instructions cap the aggregate quantity and price discretion of all children; split, bulk, stitch, combine, stage, hold, release, and manual-fill workflows cannot exceed or worsen the mandate without approval.
- `PTX-M25-R05` Cancel/change requests, price worsening, manual fills, fill assignment, correction, and client fill confirmation use permissions, approval states, and an irreversible evidentiary trail.
- `PTX-M25-R06` OMS views unify care, synthetic, algo, RFQ, routed, native, liquidation, and manual workflows while preserving their distinct risk and execution semantics.
- `PTX-M25-R07` TCA compares decision, arrival, interval VWAP/TWAP, midpoint, close/fixing, quoted spread, and explicit client benchmark using reproducible clocks and market data.
- `PTX-M25-R08` Cost attribution separates spread capture, market impact, delay/opportunity cost, fees/rebates, funding, borrow, FX, venue/routing, partial fill, and unexecuted residual.
- `PTX-M25-R09` Post-trade markouts and adverse-selection analysis work by order, parent, strategy, trader, client, venue, maker/taker, route, account, and market regime without implying causality from correlation.
- `PTX-M25-R10` Best-execution review can reproduce available venues/liquidity, exclusions, route decisions, rejects, amendments, market movement, conflicts, and outcome from retained point-in-time data.
- `PTX-M25-R11` Pre-trade what-if compares execution method, market impact, risk/margin, capital use, fees, and legging/hedge risk; estimates state confidence and assumptions.
- `PTX-M25-R12` Desk dashboards expose unattended orders, orphaned children, unconfirmed fills, breached instructions, failed hedges, stale ownership, allocation breaks, and client-reporting obligations.

**Current baseline:** core order/algo/RFQ/broker primitives exist, but a professional care-order OMS, shift handoff, and formal TCA layer were not found.
**Maturity:** `PARTIAL` / `ABSENT`.

### M26 — Copy, delegated, and distributed strategy execution

**Outcome:** A follower can delegate bounded trade replication while retaining custody, informed consent, independent risk limits, and immediate revocation.

- `PTX-M26-R01` Leader eligibility distinguishes verified live performance from backtest, paper, imported, or self-reported history and discloses tenure, costs, drawdown, leverage, capacity, concentration, and conflicts.
- `PTX-M26-R02` Followers choose an explicit sub-account and independent allocation, instrument, leverage, loss, drawdown, slippage, concurrency, and concentration limits; leader settings can never widen them.
- `PTX-M26-R03` Replication defines sizing, rounding, minimums, latency, price divergence, partial fill, unavailable market, insufficient funds, reduce-only, and follower/leader position drift.
- `PTX-M26-R04` A leader order is intent input, never authority over follower money. Every follower order passes ordinary ownership, compliance, market, balance, margin, and risk checks.
- `PTX-M26-R05` Start, pause, stop, detach, cancel-open, and flatten choices are explicit; revocation prevents new mirrors immediately without inventing a close action the follower did not choose.
- `PTX-M26-R06` Fees and leader compensation state basis, crystallization, high-water mark if applicable, refunds/corrections, conflicts, tax records, and ledger recipes; profit-sharing is absent unless separately authorized.
- `PTX-M26-R07` Leader edits, strategy-version changes, delisting, suspension, compromise, disappearance, capacity exhaustion, and extreme drawdown trigger defined follower protection and communication.
- `PTX-M26-R08` Anti-gaming controls cover self-trading, affiliate followers, front-running, delayed disclosure, illiquid price marking, volume farming, cherry-picking accounts, and survivorship-biased rankings.
- `PTX-M26-R09` Followers receive causal mapping from leader intent through their own order/fill/reject/divergence and can export a complete history without exposing other followers.
- `PTX-M26-R10` Signals, marketplace strategies, API delegates, and future managed execution use the same consent/revocation/risk boundary rather than inventing parallel custody or authority models.

**Existing contract:** [`docs/SPEC-SOVEREIGN-ROUTING-AND-COPY-2026-08-01.md`](docs/SPEC-SOVEREIGN-ROUTING-AND-COPY-2026-08-01.md).

**Current baseline:** plan/confirmation and bounded mirror foundations exist; complete live replication, leader integrity, drift, capacity, compensation, and abuse proof require audit.
**Maturity:** `SPECIFIED` / `PARTIAL` / `SOCKET`.

### M27 — Conversion, FX, and adjacent cross-asset execution

**Outcome:** Conversion and FX products reuse the exchange's money, pricing, risk, settlement, and disclosure laws while remaining visibly distinct from an order book.

- `PTX-M27-R01` Convert states whether price is principal quote or routed execution, source/reference price, spread/markup, fees, size, expiry, settlement asset, and refusal reason; it never masquerades as a fee-free market trade.
- `PTX-M27-R02` Quote acceptance is idempotent and firm until expiry, binds exact input/output decimal amounts, and settles through one balanced ledger recipe with correction policy.
- `PTX-M27-R03` FX instrument law defines base/terms currency, pip/tick, trade date, value/settlement date, holiday calendar, cutoffs, funding/roll, fixing, and supported fiat settlement rails.
- `PTX-M27-R04` Spot FX, crypto-fiat book, stablecoin conversion, and derivative FX exposure are separate products with explicit counterparty, custody, leverage, and settlement truth.
- `PTX-M27-R05` Position/PnL/accounting use configurable reporting currency and preserve original currency amounts, rates, sources, timestamps, and realized/unrealized translation effects.
- `PTX-M27-R06` Cross-asset SOR and RFQ compare all-in executable outcomes only when custody, credit, settlement date, fees, and finality are comparable; otherwise differences remain visible.
- `PTX-M27-R07` Bank holiday, rail outage, capital-control, failed settlement, rate-source disruption, negative/zero rate, and currency redenomination have deterministic degraded and wind-down behavior.
- `PTX-M27-R08` New adjacent products enter through M02 admission and must map every cross-cutting gate before being added; a shared screen or matching engine does not make their legal/economic models interchangeable.

**Current baseline:** tracker and trade-service surfaces exist for Convert and FX, while the forex settlement rail/asset law remains socketed.
**Maturity:** `BUILT` / `PARTIAL` / `SOCKET` / `EXTERNAL`.

### M28 — Agentic trading and AI decision support

**Outcome:** Professionals can use natural-language and autonomous agents for research and execution without allowing probabilistic model output to become unbounded money authority.

- `PTX-M28-R01` Modes are explicit and visually distinct: research-only, read-only monitoring, draft/preview, confirm-each-action, and bounded autonomous execution; mode changes require authenticated consent.
- `PTX-M28-R02` Each agent has a named owner, provider/model/version, purpose, environment, expiry, sub-account, tool allowlist, product/instrument scope, and revocable credential that never includes withdrawal unless separately justified and approved.
- `PTX-M28-R03` Deterministic exchange ownership, compliance, balance, margin, position, price, message-rate, loss, drawdown, and concentration controls remain authoritative after the model chooses an action; model text cannot override them.
- `PTX-M28-R04` High-consequence actions render canonical structured previews—side, instrument, order type, size, price/trigger, account, leverage, margin, fees, estimated impact, liquidation effect, and expiry—rather than relying on prose confirmation.
- `PTX-M28-R05` Agent tool calls use idempotency, bounded retries, terminal-state lookup, stale-data limits, sequence-aware recovery, and explicit partial-success handling; conversational repetition cannot duplicate intent.
- `PTX-M28-R06` Research outputs cite source, observation time, market/data environment, assumptions, uncertainty, and unsupported claims; generated analysis is never represented as exchange fact or professional advice.
- `PTX-M28-R07` Untrusted web, message, issuer, social, on-chain, document, and tool output is isolated from system policy and executable instructions; prompt injection and data poisoning are continuously tested.
- `PTX-M28-R08` Complete audit retains user instruction, resolved structured intent, relevant context hashes, model/provider/version, policy decision, tool input/output, confirmations, exchange IDs, fills/rejects, and later revocation without leaking secrets or unrelated private data.
- `PTX-M28-R09` Agent runtime supports demo, historical evaluation, adversarial evaluation, shadow, canary capital, live monitoring, pause, kill, credential revoke, child-order policy, and safe provider/model degradation.
- `PTX-M28-R10` Multiple agents and manual traders on one account have conflict, duplicate, netting, priority, and risk-budget rules; one agent cannot unknowingly unwind or amplify another's strategy.
- `PTX-M28-R11` Private portfolio, order, identity, and strategy data have explicit provider boundaries, retention, residency, training-use prohibition, redaction, deletion constraints, and customer export.
- `PTX-M28-R12` Agent/skill/tool marketplaces verify publisher, permissions, code/package provenance, version, claims, incidents, revocation, and conflicts; installation never implies trading authority.

**Current baseline:** the platform has an agent service and model-gateway doctrine, but exchange-native delegated agent scopes, structured confirmation, prompt-injection controls, and agent execution evidence require dedicated proof.
**Maturity:** `PARTIAL` / `ABSENT` / `OWNER-SET`.

### Tracker-to-scope reconciliation

This table is the proof that an existing green row or socket cannot disappear between the delivery tracker and the north-star scope. It is a mapping, not a duplicate status board.

| Tracker capability            | Owning north-star scope                                                                   |
| ----------------------------- | ----------------------------------------------------------------------------------------- |
| `trade.spot`                  | M02 instrument lifecycle; M03 matching; M04 orders; M10 spot; M21 fees                    |
| `trade.convert`               | M27 conversion quote, markup, settlement, and refusal law                                 |
| `trade.futures`               | M08 collateral/margin; M09 liquidation/default; M10 perpetuals and dated futures          |
| `trade.options`               | M08 portfolio margin; M11 complete volatility venue                                       |
| `trade.otc`                   | M12 RFQ/block/OTC/allocation; M15 settlement                                              |
| `trade.copy`                  | M26 delegated replication; M01 sub-account authority                                      |
| `trade.forex`                 | M27 FX instrument/settlement law; M15 fiat rails                                          |
| `trade.algo`, VWAP/POV        | M04 native execution algos; M24 governed strategy lifecycle                               |
| `trade.ccxt-api`              | M05 connectivity; M19 developer ecosystem; M22 adapter semantics                          |
| `trade.mm-bot`                | M13 liquidity/maker constitution; M24 runtime governance                                  |
| `venue.aggregation`           | M22 multi-venue execution and capital truth                                               |
| `connect.latency-grading`     | M05 timestamps/connectivity; M22 route inputs; M25 TCA                                    |
| `connect.data-lake`           | M06 history; M14 reporting; M24 backtest provenance; M25 TCA evidence                     |
| `execution.sor`               | M04 execution intent; M22 venue routing; M25 best-execution proof                         |
| `execution.arbitrage`         | M22 cross-venue execution; M24 strategy governance                                        |
| `execution.market-making`     | M13 liquidity/conflicts/MMP; M24 automated runtime                                        |
| `execution.house-tenant`      | M01 tenant authority; M13 information barriers; M16 surveillance; M23 finance segregation |
| `web.terminal`                | M07 complete professional workstation; M25 OMS/desk workflow                              |
| `ws.depth`, `ws.gateway`      | M05 realtime contracts; M06 sequence/freshness; M18 degraded recovery                     |
| Options/FX settlement sockets | M11 option settlement; M27 FX law; M15 rails/finality                                     |
| OTC maker/mid sockets         | M12 firm RFQ/routing; M06 reference-price truth; M15 settlement                           |
| Copy live-mirror socket       | M26 ordinary order/risk checks, divergence, revocation, and causal evidence               |
| `quant.studio`                | M24 typed no-code strategy authoring and mandatory risk blocks                            |
| `quant.backtest`              | M24 honest event-level/OOS research and cost assumptions                                  |
| `quant.sdk`                   | M24 sandboxed code strategy lifecycle; M19 SDK support                                    |
| `quant.marketplace`           | M24 performance/capacity claims; M26 delegated strategy authority                         |

---

## 6. Cross-cutting completeness gates

A child spec is incomplete until it answers every applicable gate below. “Not applicable” requires a reason.

1. **User and authority:** Which legal person, organization, sub-account, role, key, session, or broker may act?
2. **Lifecycle:** What are every object's creation, active, degraded, terminal, correction, archive, and wind-down states?
3. **Money:** Which holds and postings occur, in what assets, through which `ledger-client` recipe, with what reversals and reconciliation?
4. **Precision:** What is a decimal string, scaled bigint, timestamp unit, tick, lot, multiplier, and rounding direction?
5. **Risk:** What pre-trade, real-time, post-trade, concentration, default, and model risks exist?
6. **Failure:** What happens on timeout, duplicate, reorder, stale data, partial success, disconnect, replay, dependency loss, and operator error?
7. **Abuse:** How can a customer, maker, broker, insider, bot, compromised account, or counterparty exploit it?
8. **Compliance:** Which jurisdiction, eligibility, surveillance, record, disclosure, reporting, and privacy rules apply?
9. **Conflict:** Is the venue, affiliate, maker, broker, liquidator, or router a counterparty or beneficiary, and how is that controlled/disclosed?
10. **API/data:** Are schemas, sequences, timestamps, idempotency, limits, corrections, recovery, and deprecation defined?
11. **Trader UX:** Can a user preview, understand, act, recover, export, and distinguish stale/degraded state?
12. **Operator UX:** Can authorized operators observe, intervene safely, dual-approve, communicate, reconcile, and later prove what happened?
13. **External edge:** What adapter, legal agreement, limit, settlement, outage, replacement, and exit plan applies?
14. **Observability:** Which metrics, traces, logs, SLOs, alerts, dashboards, and customer-visible signals prove health?
15. **Testing:** Which unit, property, integration, replay, concurrency, fault, load, security, and end-to-end proofs are mandatory?
16. **Migration:** How are existing accounts, orders, positions, data, and clients moved or preserved without surprise?
17. **Economics:** Who pays, who earns, what capital is tied up, what loss is possible, and how is every amount accounted?
18. **Decommission:** How can the capability be halted, rolled back, delisted, closed, or replaced without losing money or records?
19. **Automation/AI:** Is intent deterministic or probabilistic; what version, data, approval, authority, limit, explanation, adversarial test, and kill path governs it?

---

## 7. Current-state audit: the honest headline

The repository is not an empty exchange. It has unusually strong breadth and a serious integrity doctrine. The correct conclusion is neither “start over” nor “we are done.”

### 7.1 Strong foundations to preserve

- Exact-money and single-ledger laws.
- Typed exchange contracts with core order types, time-in-force, reduce-only, client IDs, positions, and sub-accounts.
- Matching, order book, public/private WebSocket, REST market data, fills, positions, funding, and OHLCV foundations.
- Isolated derivative risk with partial liquidation, insurance fund, ADL, and funding mechanisms.
- TWAP/VWAP/POV code paths, venue adapters, latency grading, data lake, SOR, arbitrage, and market-making engines.
- Quant studio, event-level walk-forward backtesting, TypeScript/Python SDK, marketplace, and refuse-closed performance-claim boundaries.
- A substantial vendored trading terminal rather than an unnecessary second SPA.
- Matching journal/replay, telemetry, ledger reconciliation, and refuse-closed doctrine.
- Existing product specs for sub-account isolation, sovereign routing/copy, and OTC/RFQ honesty.

### 7.2 Highest-consequence gaps

| Priority class | Gap                                                                     | Why it determines professional adoption                                                              |
| -------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Existential    | Real sustainable liquidity and market quality                           | A complete UI/API with non-actionable depth is not an exchange professionals can use                 |
| Existential    | Venue-wide financial/custody reconciliation and default proof           | Professionals need to know where assets, liabilities, collateral, and losses sit under stress        |
| Existential    | Market integrity, rulebook, surveillance, and reconstruction            | A venue cannot be fair, licensable, or trusted without enforceable non-discretionary rules           |
| Critical       | Portfolio/multi-collateral margin                                       | Capital efficiency is a decisive venue-selection variable for multi-product desks                    |
| Critical       | FIX, drop copy, binary/L3 data, deterministic recovery                  | Institutions and high-throughput firms require infrastructure integration, not UI automation         |
| Critical       | Full options/volatility stack                                           | Listing European options is not equivalent to serving an options desk                                |
| Critical       | Off-exchange custody and settlement                                     | Large firms actively minimize prefunding and single-venue counterparty exposure                      |
| Critical       | Broker, allocation, mandate, and institutional reporting                | Funds and intermediaries operate legal/client books, not one undifferentiated account                |
| Critical       | Severe-market resilience and capacity proof                             | The moment of greatest trader need is the moment an unproven exchange fails                          |
| High           | Risk workstation and trader control plane                               | Pros need scenario understanding and rapid risk reduction, not only balances and positions           |
| High           | Dated futures, combos, advanced orders, and native execution workflow   | These unlock basis, volatility, hedging, and precise execution strategies                            |
| High           | Developer certification, testnet parity, change discipline, and service | Integration trust is built before production capital arrives                                         |
| High           | Professional OMS, strategy governance, and TCA                          | Funds and desks need controlled delegation, shift continuity, and execution-quality proof            |
| High           | Terminal operational integrity                                          | Hidden stale feeds, unsafe live/sim state, duplicate intent, or orphan orders make a terminal unsafe |

### 7.3 The most important interpretation rule

Do not convert every gap directly into a ticket. First decide the product contract and its failure boundaries. Portfolio margin, off-exchange collateral, options settlement, internal market making, and principal RFQ can create catastrophic hidden obligations if implemented as isolated features.

---

## 8. Owner decisions retained as refuse-closed sockets

These are legitimate product/risk/legal choices. Their absence does not prevent an authoritative specification from closing when the contract defines a typed safe blank; it does prevent the dependent product, policy, magnitude, or claim from activating. The code must remain refuse-closed where an unset value is required, and this document does not manufacture answers.

Each numbered family below has one accountable decision owner: the product owner. Legal, risk, security, privacy, finance, operations, data, and external-provider authorities supply mandatory approvals or evidence where the family names them, but they do not become competing product owners. Child-spec sockets are typed projections of one of these families or a named external dependency, not independent decision inventories. Until the accountable owner record and every mandatory approval/input are present, the socket stays closed.

1. Licensed entities and jurisdiction-by-product matrix.
2. Principal, matched-principal, or agency role by order-book, RFQ, OTC, liquidation, and routing workflow.
3. Account modes offered and eligibility/migration sequence.
4. Portfolio-margin methodology, scenario set, offsets, floors, governance, and independent validation.
5. Collateral eligibility, haircuts, concentration limits, stablecoin/depeg treatment, and change notice.
6. Maximum leverage, position limits/accountability, liquidation bands, penalties, insurance targets, and default waterfall.
7. Index/oracle constitution, source weights, staleness/outliers, fallbacks, and emergency settlement authority.
8. Options settlement asset, fixing, exercise, disruption, listing cadence, and market-maker obligations.
9. Maker tiers, rebates, obligations, internal/affiliate participation, information barriers, and conflict disclosures.
10. Fee tiers, volume aggregation, broker commissions, RFQ markups, data licensing, and commercial entitlements.
11. Custody models, approved custodians, off-exchange control structure, settlement thresholds/cycles, and counterparty caps.
12. Surveillance rule ownership, reporting obligations, retention, discipline, disputes, and appeals.
13. SLOs, capacity headroom, maintenance windows, RTO/RPO, severe-market modes, and customer compensation policy.
14. Institutional service tiers, support coverage, certification, connectivity products, and due-diligence disclosures.
15. Reserve/solvency transparency claims, audit/attestation model, insurance claims, and wind-down funding.
16. Native versus synthetic advanced orders, position modes, strategy disconnect defaults, and which controls preserve queue priority.
17. Quant live-deployment eligibility, required approvals, compute/network permissions, capital caps, marketplace claims, and strategy retirement policy.
18. OMS agency/discretion boundaries, care-order price discretion, manual-fill authority, client confirmation, and best-execution benchmarks.
19. Copy-leader eligibility, follower caps, compensation model, strategy capacity, ranking methodology, and automatic protection triggers.
20. Convert principal/agency role, FX products, reporting currency, settlement calendars, credit terms, supported rails, and disruption authority.
21. Agentic-trading modes, confirmation policy, model/provider eligibility, autonomous limits, data-use terms, tool marketplace, and responsibility disclosures.

Each decision belongs in `docs/DIRECTION-*` when it is an owner product decision or in an ADR when it chooses a bounded technical mechanism. Child specs link the decision; they do not restate or silently broaden it.

---

## 9. How to spec this without reinventing Phantom's system

### 9.1 The specification factory

Use one funnel:

```text
This capability map
        ↓
Owner decision or ADR, only where genuinely needed
        ↓
One dated bounded child contract under docs/
        ↓
Shared contract/event/ledger recipe PR when cross-service
        ↓
Tracker mountain/row + GitHub issue only when implementation is ready
        ↓
Small service-scoped implementation PRs with proof
        ↓
Evidence link and maturity update here
```

This matches the existing hierarchy: doctrine says what is law; direction decides owner boundaries; specs define dangerous product semantics; ADRs choose mechanisms; sockets preserve honest unresolved dependencies; the tracker maps delivery; PRs provide proof.

### 9.2 Start speccing now—but only at the correct resolution

Yes, start now. Do **not** write endpoint-by-endpoint specifications for all 29 mountains in one pass. The correct next resolution is one bounded product contract per mountain, beginning with the mountains that constrain many others.

Every child spec uses this shape:

1. Status, owner, authority, maturity, and linked requirement IDs from this document.
2. Problem, professional personas, promise, and explicit non-goals.
3. Terms, actors, legal/account boundaries, and trust boundaries.
4. Object/state machines and invariants.
5. User, operator, API, event, and data contracts.
6. Money holds/postings/reversals/reconciliation through `ledger-client`.
7. Risk equations expressed exactly; owner magnitudes linked, never invented.
8. Failure, concurrency, replay, degraded mode, recovery, and correction.
9. Abuse, surveillance, security, compliance, jurisdiction, retention, and conflicts.
10. UX requirements including previews, error truth, stale states, mobile, and accessibility.
11. Observability, SLO categories, operational controls, and incident playbooks.
12. External adapters, commercial/legal dependencies, limits, and exit path.
13. Migration, rollout, rollback, compatibility, and decommission.
14. Definition of Done: tests, reconciliation proof, load/fault proof, operator proof, and customer evidence.
15. Dependencies, sockets, decisions, exclusions, and open risks.

### 9.3 GitHub-compatible artifact rules

- One canonical scope document: this file. Do not open a second roadmap or capability board.
- One mountain spec per durable product boundary; avoid specs named after arbitrary code tasks.
- One service per implementation PR. Cross-service work begins with shared contracts/events/ledger recipe, then service PRs.
- Use short branches created by `pnpm wt <branch>`; never work in the main checkout.
- Conventional PR title and substantive `Board-Delta:` trailer for documentation changes, per repo protocol.
- GitHub issues are useful when work takes more than a day, needs discussion, or needs an unclaimed durable record—not as a mirror of every bullet here.
- Tracker rows represent implementation mountains only after dependencies and product semantics are sufficiently known.
- A green tracker row never promotes a requirement to `PROVEN`; evidence does.

---

## 10. Provisional dependency mountains—not a delivery commitment

Full scope comes first, as requested. The following order merely prevents logically impossible sequencing; it does not choose business priority or release dates.

### Foundation ridge

M00 rulebook/decisions, M01 authority graph, M02 instrument lifecycle, M03 microstructure, M16 integrity, M17 security, M18 resilience, M23 finance/reconciliation.

### Professional core ridge

M04 execution toolkit, M05 connectivity, M06 data, M07 terminal, M08 margin/collateral, M09 risk/default, M13 liquidity, M25 OMS/TCA.

### Product-depth ridge

M10 linear products, M11 options, M12 RFQ/block/allocations, M14 analytics/reporting, M15 custody/settlement, M22 execution network, M24 quant automation, M26 copy/delegation, M27 conversion/FX, M28 agentic trading.

### Adoption ridge

M19 developer ecosystem, M20 institutional service, M21 commercial economics.

The dependency rule is simple: no advanced product ships ahead of the authority, money, risk, surveillance, resilience, settlement, and evidence needed to make it truthful.

---

## 11. Audit procedure for future completeness passes

This document is complete as a capability taxonomy, not eternally frozen. A quarterly and pre-major-spec audit should run these passes:

1. **Competitor pass:** official changelogs/API docs from major CEX, derivatives, prime, and on-chain venues.
2. **Traditional-market pass:** futures/options exchange, prime broker, OEMS, custody, clearing, and market-data patterns relevant to crypto.
3. **Regulatory pass:** rules for each intended entity/jurisdiction, including market integrity, custody, resilience, records, disclosures, and wind-down.
4. **Trader-journey pass:** discover → onboard → fund → configure → price → preview → execute → amend/cancel → manage risk → settle → reconcile → report → dispute → exit.
5. **Stress pass:** volatility, gap, oracle split, depeg, chain halt, maker withdrawal, borrow recall, liquidation storm, custodian failure, cyber incident, region loss.
6. **Adversary pass:** abusive trader, colluding accounts, compromised key, malicious broker, privileged insider, toxic counterparty, manipulated external venue.
7. **Balance-sheet pass:** every asset, liability, receivable, encumbrance, loss, fee, rebate, insurance/default resource, and legal entity.
8. **Data/evidence pass:** every decision and state can be reconstructed from common IDs and corrected without rewriting history.
9. **Operator pass:** every intervention has authority, guardrails, dual control where material, visibility, and post-action reconciliation.
10. **Exit pass:** every market, account, integration, counterparty, and product can be suspended, migrated, unwound, or retired safely.
11. **Terminal/desk pass:** every live action survives stale data, reconnect, shift handoff, parent/child failure, accidental input, dense state, and long-session operation.
12. **Quant/OMS pass:** every automated or delegated decision has a version, owner, approval, limit, benchmark, causal audit, kill path, and truthful performance context.
13. **Agentic pass:** probabilistic intent, external context, tools, credentials, confirmations, provider changes, privacy, injection, multi-agent conflict, and autonomous loss are threat-modeled separately from deterministic algos.

A newly discovered capability is added here first with a stable `PTX-Mxx-Ryy` ID, then routed through the specification factory. A changed competitor UI alone is not sufficient evidence; durable trader need and system consequence are.

---

## 12. Research register

Primary sources used in the August 2026 pass:

- [OKX API guide](https://www.okx.com/docs-v5/en/) — account modes, portfolio margin fields, batch/amend, algo trading, MMP, WebSocket risk/order state.
- [OKX portfolio margin overview](https://www.okx.com/en-us/help/portfolio-margin-mode-cross-margin-trading-risk-unit-merge) — cross-product risk offsets and eligibility.
- [OKX broker API guide](https://www.okx.com/docs-v5/broker_en/) — broker tags, DMA sub-accounts, and RFQ/algo surfaces.
- [Coinbase Prime FIX](https://docs.cdp.coinbase.com/prime/concepts/trading/fix) — FIX order flow, deterministic sequencing, recovery, portfolio-wide drop copy, and buying power.
- [Coinbase Exchange FIX drop copy](https://docs.cdp.coinbase.com/exchange/fix-api/drop-copy) — execution capture across sessions and REST sources.
- [Kraken API releases](https://docs.kraken.com/api/blog) — FIX 4.4, atomic amend with retained priority, and L3 market data.
- [Kraken FIX market-data snapshot](https://docs.kraken.com/api/docs/fix-api/mdsfr-fix) — L3 order IDs, queue entry time, and high-precision event timestamps.
- [Deribit API](https://docs.deribit.com/) — options, combo instruments, mass quote, and MMP surface.
- [CME SPAN methodology](https://www.cmegroup.com/solutions/risk-management/performance-bonds-margins/span-methodology-overview.html) — reproducible option portfolio price, volatility, time, floor, and offset scenarios.
- [CME options exercise and assignment](https://www.cmegroup.com/clearing/files/IR-284_OptionsExercise.pdf) — series-level exercise/assignment, allocation methods, and lifecycle evidence.
- [Deribit Block RFQ](https://docs.deribit.com/api-reference/block-rfq/private-create_block_rfq) — multi-leg RFQ, targeted makers, hedge leg, anonymity, broker/sub-account pre-allocation.
- [CME Rule 526 block-trade guidance](https://www.cmegroup.com/rulebook/files/cme-group-Rule-526.pdf) — product/strategy thresholds, pricing, execution-time, credit, reporting, and regular-book interaction controls.
- [FIX post-trade specification](https://www.fixtrading.org/wp-content/uploads/download-manager-files/FIX-Latest-Specification-PostTrade.pdf) — preliminary/ready-to-book allocation, average/execution price, fragmentation, and quantity reconciliation.
- [Deribit custody options](https://support.deribit.com/hc/en-us/articles/26533163120413-Custody-Options) — third-party custody and off-exchange settlement models.
- [Binance developer documentation](https://developers.binance.com/en/docs/introduction) — product APIs, FIX, SBE, and API lifecycle entry points.
- [Binance SBE FAQ](https://github.com/binance/binance-spot-api-docs/blob/master/faqs/sbe_faq.md) — schema IDs/versions, compatibility, deprecation, and retirement.
- [Coinbase Exchange WebSocket feed](https://docs.cdp.coinbase.com/exchange/websocket-feed/overview) — per-product sequencing, gap detection, redundant endpoints, and recovery responsibilities.
- [CME AutoCert FIX recovery](https://www.cmegroup.com/tools-information/webhelp/autocert-cme-stp-fix-recovery-brokertec/Content/GettingStarted.html) — executable client certification for session recovery, resend, and gap handling.
- [CFTC 24/7 trading advisory 26-16](https://www.cftc.gov/csl/26-16/download) — continuous monitoring, scalable capacity, redundancy, live cutover/back-out, third-party readiness, and around-the-clock staffing considerations.
- [SEC Regulation SCI BC/DR guidance](https://www.sec.gov/rules-regulations/staff-guidance/trading-markets-frequently-asked-questions/responses-frequently-asked-questions-concerning-regulation-sci) — functional and performance recovery testing with designated participants and coordinated industry exercises.
- [Google SRE incident management](https://sre.google/sre-book/managing-incidents/) — separated command, operations, communications, and planning roles with a durable incident record and explicit handoff.
- [CME 2026 participant DR exercise](https://www.cmegroup.com/notices/ebs/2026/07/20260713.html) — registered participant connectivity and transaction testing against DR gateways and match engines.
- [ESMA MiCA Article 76](https://www.esma.europa.eu/publications-and-data/interactive-single-rulebook/mica/article-76-operation-trading-platform-crypto) — fair/orderly rules, capacity, continuity, market abuse, transparency, fees, settlement, and records.
- [ESMA MiCA data standards](https://www.esma.europa.eu/esmas-activities/digital-finance-and-innovation/markets-crypto-assets-regulation-mica) — standardized machine-readable order-book and transaction records.
- [CFTC DCM rule-enforcement reviews](https://www.cftc.gov/IndustryOversight/TradingOrganizations/DCMs/dcmruleenf.html) — audit trail, surveillance, participant protection, discipline, disputes, and position accountability.
- [Trading Technologies Pro features](https://library.tradingtechnologies.com/trade/overview/tt-platform/description-tt-platform/tt-pro-advanced-features/) — DOM, spread/hedge/algo tooling, options, RFQ, audit, and professional workspace breadth.
- [Trading Technologies care-order management](https://library.tradingtechnologies.com/trade/co-working-with-staged-orders.html) and [order passing](https://library.tradingtechnologies.com/trade/ops-order-passing-overview.html) — staged instructions, claiming, child execution, approvals, shift handoff, and audit continuity.
- [Trading Technologies algo deployment and approval](https://library.tradingtechnologies.com/adl/adl-overview/adl-basic-concepts/description-adl-basic-concepts/algo-deployment-and-approvals/) — test/deploy/approve/undeploy lifecycle.
- [Trading Technologies session status](https://library.tradingtechnologies.com/trade/ttd-session-status.html) and [workspace locking](https://library.tradingtechnologies.com/trade/overview/workspace-windows/task-workspace-windows/locking-a-workspace/) — component health and protection against accidental live order entry.
- [Bloomberg execution management](https://professional.bloomberg.com/products/trading/execution-management-system/) and [Bloomberg BTCA](https://professional.bloomberg.com/products/trading/trade-analytics/btca/) — interoperable high-touch/electronic workflows, reproducible multi-source analytics, cost attribution, benchmark governance, and exception review.
- [FIX Trading Community data and transparency guidance](https://fixtrading.org/guidelines/data-transparency/) — standardized point-in-time venue, liquidity, capacity, method, routing, and execution evidence for TCA and best-execution reconstruction.
- [Coinbase business onboarding](https://docs.cdp.coinbase.com/api-reference/v2/business-onboarding) — verified business evidence and explicit custodial-account linking before protected institutional APIs activate.
- [Coinbase Exchange reports](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/reports/create-report) and [Coinbase Prime auditor access](https://help.coinbase.com/en/prime/audits) — asynchronous scoped report jobs, point-in-time balance statements, expiring artifacts, and least-privilege auditor/API access.
- [CME Customer Center service guidance](https://www.cmegroup.com/content/dam/cmegroup/education/files/cme-customer-center-services-guide.pdf) — separated accountability for entity diligence/contracting, entitlements, connectivity certification, global account management, and technical support.
- [SEC electronic-recordkeeping guidance](https://www.sec.gov/investment/amendments-electronic-recordkeeping-requirements-broker-dealers) — original-record recreation, complete actor/time modification trails, and production in usable electronic form; used as an evidence pattern, not an applicability finding.
- [Interactive Brokers professional order types and algos](https://portal.interactivebrokers.com/en/trading/ordertypes.php) — basket, benchmark, conditional, pegged, accumulate/distribute, and simulated-order semantics.
- [Interactive Brokers Risk Navigator](https://www.ibkrguides.com/traderworkstation/risk-navigator.htm) — portfolio drill-down, what-if, scenario analysis, and basket hedging.
- [Bybit RFQ](https://www.bybit.com/en/help-center/article/FAQ-Bybit-RFQ) — cross-product multi-leg RFQ, quote comparison, portfolio margin, and all-or-none execution.
- [Bybit dynamic delta hedge](https://www.bybit.com/en/help-center/article/Dynamic-Delta-Hedge) — automated portfolio-delta control and explicit failure/termination risks.
- [OKX position modes](https://www.okx.com/en-us/help/trading-settings-faq) — one-way versus simultaneous long/short hedge-mode semantics.
- [CME daily/final settlement](https://www.cmegroup.com/market-data/daily-settlements.html) and [mark-to-market guidance](https://www.cmegroup.com/education/courses/introduction-to-futures/mark-to-market) — governed daily settlement, variation PnL, and distinct final-settlement evidence.
- [CME FX futures calendar spreads](https://www.cmegroup.com/articles/faqs/frequently-asked-questions-cme-fx-futures-calendar-spreads.html) — simultaneous linked execution across contract maturities rather than unrelated displayed legs.
- [OKX Convert API](https://tr.okx.com/docs-v5/en/) — quote/request identity, exact input/output amounts, timestamped validity, and separate acceptance.
- [BIS 2026 FX settlement-risk survey](https://www.bis.org/publ/qtrpdf/r_qt2606c.htm) — payment-versus-payment, risk-mitigating methods, and residual gross bilateral settlement risk.
- [FX Global Code](https://www.globalfxc.org/fx-global-code/) — durable governance, execution, confirmation, risk, and settlement patterns; not a finding of applicability or adherence.
- [CME Globex session controls](https://www.cmegroup.com/globex/files/iLinkSessionIDPolicy.pdf) — cancel-on-disconnect, kill switch, and self-match prevention at exchange-session scope.
- [Coinbase Prime trade financing](https://docs.cdp.coinbase.com/prime/concepts/trading/trade-financing) — credit-line buying power, withdrawal power, utilization, fees, and delayed settlement.
- [OKX Agent Trade Kit](https://www.okx.com/docs-v5/agent_en/) — exchange-native MCP/CLI/skills, demo and read-only modes, least-privilege modules, local credential handling, and explicit non-deterministic AI risk.
- [OKX API agreement for agent trading](https://www.okx.com/en-us/help/okx-api-agreement) — autonomous-order responsibility, independent pre-trade controls, market-integrity prohibitions, and execution-only boundaries.
- [OKX AI agent marketplace agreement](https://www.okx.com/en-gb/help/okx-ai-agent-marketplace-user-agreement) — hallucination, untrusted-input/prompt-injection, provider, counterparty, and task-performance risks.
- [OKX API changelog](https://www.okx.com/docs-v5/log_en/) — 2026 group-RFQ account allocation, parent-level reporting, partial-execution, and per-account terminal-state semantics; these reinforce M12 allocation/break handling rather than creating a new mountain.
- [CME Rule 195](https://www.cmegroup.com/rulebook/CME/I/1/1.pdf) — market-maker program scope, dates, eligibility, obligations, incentives, customer-order information separation, monitoring, records, and termination.
- [Coinbase International Exchange liquidity program](https://help.coinbase.com/en/international-exchange/trading-deposits-withdrawals/international-exchange-liquidity-program) — effective-dated fee schedules, objective tier inputs, periodic assessment, entitlements, and fill-level rebate visibility.
- [CME EBS messaging-efficiency program](https://www.cmegroup.com/notices/ebs/2022/01/20220113.html) — quote-life/fill-quality measurement and excessive-message controls that distinguish actionable liquidity from raw message volume.
- [Coinbase Prime systems and operations](https://docs.cdp.coinbase.com/prime/introduction/systems-operations) — unified multi-venue books, venue filtering, fee transparency, and SOR operating boundaries.
- [0x Swap API](https://docs.0x.org/docs/introduction/quickstart/swap-tokens-with-0x-swap-api) — indicative/firm quote separation, route fills, allowance issues, gas, minimum output, simulation status, and executable transaction handoff.
- [Ethereum transaction lifecycle](https://ethereum.org/developers/docs/transactions/) — signed submission, mempool, block inclusion, justification, finalization, and the distinction between observed and irreversible chain state.
- [MiFID II Article 27](https://eur-lex.europa.eu/eli/dir/2014/65/oj/eng) — price, total cost, speed, execution/settlement likelihood, size, venue policy, conflicts, and execution-quality evidence patterns; applicability remains a legal decision.
- [QuantConnect live-trading concepts](https://www.quantconnect.com/docs/v2/writing-algorithms/live-trading/key-concepts) and [live reconciliation](https://www.quantconnect.com/docs/v2/cloud-platform/live-trading/reconciliation) — authoritative-position restart, real-time versus simulated behavior, and measured live/out-of-sample data/model/brokerage divergence.
- [EU RTS 6 / Delegated Regulation 2017/589](https://eur-lex.europa.eu/eli/reg_del/2017/589/oj/eng/pdf) — durable algorithm inventory, development/testing, conformance, capacity, monitoring, continuity and kill-function patterns; applicability remains a legal decision.
- [OKX copy-trader operations](https://www.okx.com/en-gb/help/copy-traders-how-to-manage-copied-trades), [Bybit Copy Trading FAQ](https://www.bybit.com/en/help-center/article/FAQ-Copy-Trading), and [eToro CopyTrader operation](https://www.etoro.com/en-us/copytrader/how-it-works/) — explicit pause/stop disposition, capacity and risk refusals, and follower divergence from balance, minimum-size, latency and slippage rather than an exact-replication promise.
- [NIST AI 100-2 E2025](https://csrc.nist.gov/pubs/ai/100/2/e2025/final) and [NIST Generative AI Profile](https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf) — lifecycle taxonomies and governed measurement for prompt injection, poisoning, evasion, privacy, misuse, third-party and incident risks.
- [Model Context Protocol security principles](https://modelcontextprotocol.io/specification/2025-03-26/index) and [tool specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) — explicit data/tool consent, user control, structured schemas, and treatment of tool descriptions/annotations as untrusted unless their server is trusted.

Research observations are requirements inputs, not proof of legal applicability or permission to copy protected implementation details. Applicable counsel and entity decisions remain owner-controlled.

---

## 13. Requirement-level evidence and maturity census

This is the canonical census required by the maturity law in §4. It is deliberately embedded here rather than maintained as a second tracker. A state is evidence about the whole requirement, not a claim that one named file proves every clause. `PARTIAL` means the cited implementation or contract is materially relevant but still fails at least one clause. `ABSENT` means the audit found no reliable production-shaped evidence, even if a mock, screen, tracker label, or aspirational note exists.

Ranges are inclusive: for example, `R01–R03` assigns the stated maturity and evidence to each of `R01`, `R02`, and `R03`. Every one of the 255 IDs appears exactly once below. Evidence keys point to the smallest durable repository surfaces that justify the classification.

### 13.1 Evidence key register

| Key   | Repository evidence or explicit audit boundary                                                                                                                                                                                                                                                                                 |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `E00` | [`INTAFACED_DEFINITIVE_BUILD.md`](INTAFACED_DEFINITIVE_BUILD.md), this scope, and existing direction/ADR law; no unified public venue rulebook found                                                                                                                                                                           |
| `E01` | [`docs/SPEC-SUBACCOUNTS-2026-08-02.md`](docs/SPEC-SUBACCOUNTS-2026-08-02.md), [`services/svc-identity/src`](services/svc-identity/src), [`packages/auth/src`](packages/auth/src)                                                                                                                                               |
| `E02` | [`packages/exchange-contract/src/api.ts`](packages/exchange-contract/src/api.ts), [`services/svc-trade/src/spot/instrument-enums.ts`](services/svc-trade/src/spot/instrument-enums.ts), and listing gates in `svc-market`/`svc-trade`                                                                                          |
| `E03` | [`services/svc-matching/src/engine`](services/svc-matching/src/engine), [`services/svc-matching/src/reconcile.ts`](services/svc-matching/src/reconcile.ts), and matching tests                                                                                                                                                 |
| `E04` | [`services/svc-trade/src/spot/trade-service.ts`](services/svc-trade/src/spot/trade-service.ts), [`services/svc-trade/src/algo`](services/svc-trade/src/algo), and exchange-contract schemas                                                                                                                                    |
| `E05` | [`services/svc-trade/src/public-rest.ts`](services/svc-trade/src/public-rest.ts), [`services/svc-trade/src/private-rest.ts`](services/svc-trade/src/private-rest.ts), [`services/svc-ws/src`](services/svc-ws/src), and [`services/svc-trade/src/ccxt-capability-matrix.ts`](services/svc-trade/src/ccxt-capability-matrix.ts) |
| `E06` | [`packages/market-data/src`](packages/market-data/src), [`packages/connect-data-lake/src`](packages/connect-data-lake/src), and depth/trade services in `svc-ws`                                                                                                                                                               |
| `E07` | [`vendor/upstream-exchange/05_Web_Front/src/terminal-mount-vs-tracker.ts`](vendor/upstream-exchange/05_Web_Front/src/terminal-mount-vs-tracker.ts) and the vendored terminal screens/assets; visual presence is not adapter or operational proof                                                                               |
| `E08` | [`docs/SPEC-LENDING-2026-08-02.md`](docs/archive/SPEC-LENDING-2026-08-02.md), isolated futures margin code, and ledger loan recipes; no portfolio-margin engine found                                                                                                                                                          |
| `E09` | [`services/svc-trade/src/futures`](services/svc-trade/src/futures), including mark, margin, liquidation, insurance, ADL, funding, and health gates                                                                                                                                                                             |
| `E10` | Spot/futures product services under [`services/svc-trade/src`](services/svc-trade/src); no dated-futures or hedge-mode authority found                                                                                                                                                                                         |
| `E11` | [`services/svc-trade/src/spot/options-policy.ts`](services/svc-trade/src/spot/options-policy.ts), options mount/listing files, and the explicit settlement-law socket; no complete volatility venue found                                                                                                                      |
| `E12` | [`docs/SPEC-OTC-RFQ-AND-EARN-2026-08-02.md`](docs/archive/SPEC-OTC-RFQ-AND-EARN-2026-08-02.md) and [`services/svc-trade/src/otc`](services/svc-trade/src/otc)                                                                                                                                                                  |
| `E13` | [`packages/execution-mm/src`](packages/execution-mm/src), [`services/svc-trade/src/mm`](services/svc-trade/src/mm), and venue/SOR infrastructure; sustainable external liquidity remains external/owner-set                                                                                                                    |
| `E14` | [`packages/portfolio-view/src`](packages/portfolio-view/src), execution account projections, and ledger history; no complete institutional analytics/reporting proof found                                                                                                                                                     |
| `E15` | [`packages/ledger-client/src`](packages/ledger-client/src), `svc-ledger`, bank/chain/indexer surfaces; no off-exchange custody product or complete treasury proof found                                                                                                                                                        |
| `E16` | [`services/svc-edge/src/compliance-honesty.ts`](services/svc-edge/src/compliance-honesty.ts), [`packages/config/src/compliance-queue.ts`](packages/config/src/compliance-queue.ts), and identity audit data; no dedicated market-surveillance/case system found                                                                |
| `E17` | [`packages/auth/src`](packages/auth/src), identity WebAuthn/TOTP/API-key migrations and tests; venue-wide participant-protection proof remains incomplete                                                                                                                                                                      |
| `E18` | [`packages/telemetry/src`](packages/telemetry/src), matching journal/replay, service health/metrics, and reconciliation jobs; no venue-wide drill/SLO evidence pack found                                                                                                                                                      |
| `E19` | CCXT-shaped contracts, repo tests, and quant sandbox surfaces; no public certification program, parity testnet, FIX dictionaries, or production SDK lifecycle found                                                                                                                                                            |
| `E20` | `svc-identity` and [`services/svc-support/src`](services/svc-support/src); institutional legal/due-diligence/coverage operating model is not proven                                                                                                                                                                            |
| `E21` | [`services/svc-trade/src/spot/fees.ts`](services/svc-trade/src/spot/fees.ts) and [`packages/ledger-client/src/recipes/fee-revenue-map.ts`](packages/ledger-client/src/recipes/fee-revenue-map.ts); full commercial constitution is owner-set                                                                                   |
| `E22` | [`docs/SPEC-SOVEREIGN-ROUTING-AND-COPY-2026-08-01.md`](docs/SPEC-SOVEREIGN-ROUTING-AND-COPY-2026-08-01.md), [`packages/venue-adapter/src`](packages/venue-adapter/src), and [`services/svc-execution/src`](services/svc-execution/src)                                                                                         |
| `E23` | Single-ledger recipes, spot engine/ledger reconciliation, ledger conformance, and audit documents; solvency, capital, and wind-down evidence remains incomplete                                                                                                                                                                |
| `E24` | [`services/svc-quant/src`](services/svc-quant/src), [`packages/quant-honesty/src`](packages/quant-honesty/src), and quant terminal surfaces; Monte Carlo and institutional live-governance proof remain residual                                                                                                               |
| `E25` | Core OMS/EMS files in [`services/svc-execution/src`](services/svc-execution/src); no care-order ownership, shift handoff, allocations, or formal TCA layer found                                                                                                                                                               |
| `E26` | Routing/copy spec, [`services/svc-trade/src/copy`](services/svc-trade/src/copy), and copy-intelligence services; live mirror/capacity/abuse proof remains incomplete                                                                                                                                                           |
| `E27` | [`services/svc-trade/src/convert/quote.ts`](services/svc-trade/src/convert/quote.ts) and [`services/svc-trade/src/spot/forex-settlement.ts`](services/svc-trade/src/spot/forex-settlement.ts); FX rail/asset law remains socketed/external                                                                                     |
| `E28` | [`services/svc-agents/src`](services/svc-agents/src), including guardrails/audits/kill switches; no complete exchange-native agent authority and adversarial-evaluation proof found                                                                                                                                            |
| `C01` | [`docs/SPEC-PRO-EXCHANGE-RULEBOOK-LIFECYCLE-INTEGRITY-2026-08-23.md`](docs/archive/SPEC-PRO-EXCHANGE-RULEBOOK-LIFECYCLE-INTEGRITY-2026-08-23.md); authoritative M00/M02/M16 contract, not implementation proof                                                                                                                 |
| `C02` | [`docs/SPEC-PRO-EXCHANGE-AUTHORITY-AND-PARTICIPANT-SECURITY-2026-08-23.md`](docs/archive/SPEC-PRO-EXCHANGE-AUTHORITY-AND-PARTICIPANT-SECURITY-2026-08-23.md); authoritative M01/M17 contract, not implementation proof                                                                                                         |
| `C03` | [`docs/SPEC-PRO-EXCHANGE-MICROSTRUCTURE-AND-ORDER-EXECUTION-2026-08-24.md`](docs/archive/SPEC-PRO-EXCHANGE-MICROSTRUCTURE-AND-ORDER-EXECUTION-2026-08-24.md); authoritative M03/M04 contract, not implementation proof                                                                                                         |
| `C04` | [`docs/SPEC-PRO-EXCHANGE-CONNECTIVITY-DATA-AND-CERTIFICATION-2026-08-24.md`](docs/archive/SPEC-PRO-EXCHANGE-CONNECTIVITY-DATA-AND-CERTIFICATION-2026-08-24.md); authoritative M05/M06/M19 contract, not implementation proof                                                                                                   |
| `C05` | [`docs/SPEC-PRO-EXCHANGE-TERMINAL-OMS-AND-TCA-2026-08-24.md`](docs/archive/SPEC-PRO-EXCHANGE-TERMINAL-OMS-AND-TCA-2026-08-24.md); authoritative M07/M25 contract, not implementation proof                                                                                                                                     |
| `C06` | [`docs/SPEC-PRO-EXCHANGE-COLLATERAL-RISK-LIQUIDATION-DEFAULT-2026-08-24.md`](docs/archive/SPEC-PRO-EXCHANGE-COLLATERAL-RISK-LIQUIDATION-DEFAULT-2026-08-24.md); authoritative M08/M09 contract, not implementation proof                                                                                                       |
| `C07` | [`docs/SPEC-PRO-EXCHANGE-LINEAR-PRODUCTS-CONVERT-AND-FX-2026-08-24.md`](docs/archive/SPEC-PRO-EXCHANGE-LINEAR-PRODUCTS-CONVERT-AND-FX-2026-08-24.md); authoritative M10/M27 contract, not implementation proof                                                                                                                 |
| `C08` | [`docs/SPEC-PRO-EXCHANGE-OPTIONS-AND-VOLATILITY-2026-08-24.md`](docs/archive/SPEC-PRO-EXCHANGE-OPTIONS-AND-VOLATILITY-2026-08-24.md); authoritative M11 contract, not implementation proof                                                                                                                                     |
| `C09` | [`docs/SPEC-PRO-EXCHANGE-RFQ-BLOCK-OTC-AND-ALLOCATION-2026-08-24.md`](docs/archive/SPEC-PRO-EXCHANGE-RFQ-BLOCK-OTC-AND-ALLOCATION-2026-08-24.md); authoritative M12 contract, not implementation proof                                                                                                                         |
| `C10` | [`docs/SPEC-PRO-EXCHANGE-LIQUIDITY-FEES-AND-MAKER-CONSTITUTION-2026-08-24.md`](docs/archive/SPEC-PRO-EXCHANGE-LIQUIDITY-FEES-AND-MAKER-CONSTITUTION-2026-08-24.md); authoritative M13/M21 contract, not implementation proof                                                                                                   |
| `C11` | [`docs/SPEC-PRO-EXCHANGE-PORTFOLIO-INSTITUTIONAL-REPORTING-AND-SERVICE-2026-08-24.md`](docs/archive/SPEC-PRO-EXCHANGE-PORTFOLIO-INSTITUTIONAL-REPORTING-AND-SERVICE-2026-08-24.md); authoritative M14/M20 contract, not implementation proof                                                                                   |
| `C12` | [`docs/SPEC-PRO-EXCHANGE-CUSTODY-RECONCILIATION-AND-WIND-DOWN-2026-08-24.md`](docs/archive/SPEC-PRO-EXCHANGE-CUSTODY-RECONCILIATION-AND-WIND-DOWN-2026-08-24.md); authoritative M15/M23 contract, not implementation proof                                                                                                     |
| `C13` | [`docs/SPEC-PRO-EXCHANGE-RESILIENCE-AND-INCIDENT-COMMAND-2026-08-24.md`](docs/archive/SPEC-PRO-EXCHANGE-RESILIENCE-AND-INCIDENT-COMMAND-2026-08-24.md); authoritative M18 contract, not implementation proof                                                                                                                   |
| `C14` | [`docs/SPEC-PRO-EXCHANGE-MULTI-VENUE-AND-ONCHAIN-EXECUTION-2026-08-24.md`](docs/archive/SPEC-PRO-EXCHANGE-MULTI-VENUE-AND-ONCHAIN-EXECUTION-2026-08-24.md); authoritative M22 contract, not implementation proof                                                                                                               |
| `C15` | [`docs/SPEC-PRO-EXCHANGE-QUANT-AND-DELEGATED-STRATEGY-LIFECYCLE-2026-08-24.md`](docs/archive/SPEC-PRO-EXCHANGE-QUANT-AND-DELEGATED-STRATEGY-LIFECYCLE-2026-08-24.md); authoritative M24/M26 contract, not implementation proof                                                                                                 |
| `C16` | [`docs/SPEC-PRO-EXCHANGE-AGENTIC-TRADING-AUTHORITY-AND-SAFETY-2026-08-24.md`](docs/archive/SPEC-PRO-EXCHANGE-AGENTIC-TRADING-AUTHORITY-AND-SAFETY-2026-08-24.md); authoritative M28 contract, not implementation proof                                                                                                         |
| `N`   | No reliable repository implementation or bounded contract found in the targeted code, spec, tracker/socket, and Graphify audit                                                                                                                                                                                                 |

### 13.2 Census by requirement

| Requirement IDs   | Maturity    | Evidence / unresolved boundary                                                                                                                                                |
| ----------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PTX-M00-R01–R06` | `SPECIFIED` | `C01`; rule, decision, emergency, dispute, and claims semantics are authoritative; implementation and owner/legal proof remain incomplete                                     |
| `PTX-M01-R01`     | `SPECIFIED` | `C02`; institutional legal/persona semantics are authoritative; legal selections and implementation proof remain incomplete                                                   |
| `PTX-M01-R02`     | `BUILT`     | `E01`, `C02`; sub-account isolation has contract, code, ledger recipes, and tests, but still requires integrated proof before `PROVEN`                                        |
| `PTX-M01-R03–R05` | `SPECIFIED` | `C02`; ABAC, four-eyes, and causal attribution semantics are authoritative; full implementation proof remains incomplete                                                      |
| `PTX-M01-R06–R08` | `SPECIFIED` | `C02`; broker/DMA, desk/shift, and resolved-routing authority contracts exist; implementation and legal/commercial authority remain absent                                    |
| `PTX-M02-R01`     | `BUILT`     | `E02`, `C01`; typed instruments/listing gates exist and lifecycle semantics are contracted, not fully proven                                                                  |
| `PTX-M02-R02–R06` | `SPECIFIED` | `C01`; admission, state, corporate-action, derivative-fallback, and delisting semantics are authoritative; implementation proof remains incomplete                            |
| `PTX-M03-R01–R02` | `BUILT`     | `E03`; engine/order/ledger primitives and tests exist, but production capacity proof is separate                                                                              |
| `PTX-M03-R03`     | `SPECIFIED` | `C03`; native atomic-amend queue-priority contract now exists; implementation remains absent                                                                                  |
| `PTX-M03-R04`     | `PARTIAL`   | `E03`; cancel/recovery primitives do not prove all scoped mass controls during partition                                                                                      |
| `PTX-M03-R05`     | `SPECIFIED` | `C03`; deterministic auction-family contract now exists; implementation remains absent                                                                                        |
| `PTX-M03-R06–R08` | `PARTIAL`   | `E03`, `E18`; controls/journal exist, owner SLO and stress evidence do not                                                                                                    |
| `PTX-M04-R01`     | `BUILT`     | `E04`; broad core schema exists, with product-specific gaps preventing `PROVEN`                                                                                               |
| `PTX-M04-R02–R04` | `PARTIAL`   | `E04`; conditional/bulk/algo slices exist without the entire failure and lifecycle contract                                                                                   |
| `PTX-M04-R05`     | `SPECIFIED` | `C03`; multi-leg atomicity/legging contract now exists; native atomic implementation remains absent                                                                           |
| `PTX-M04-R06–R08` | `PARTIAL`   | `E04`, `E22`; preview/report/SOR foundations exist without complete cost and best-execution proof                                                                             |
| `PTX-M04-R09–R12` | `SPECIFIED` | `C03`; advanced attributes, provenance, baskets, and leg-repair now have a bounded contract; implementation proof remains absent                                              |
| `PTX-M05-R01`     | `PARTIAL`   | `E05`, `C04`; REST/WS breadth is real and semantics are contracted, but implementation is incomplete across products                                                          |
| `PTX-M05-R02–R04` | `SPECIFIED` | `C04`; FIX, independent drop-copy, and binary-feed semantics are authoritative; implementation remains absent                                                                 |
| `PTX-M05-R05–R07` | `PARTIAL`   | `E01`, `E05`, `C04`; bounded limits, keys, and client IDs exist under a complete institutional contract, without full proof                                                   |
| `PTX-M05-R08–R09` | `SPECIFIED` | `C04`; change-lifecycle and network-product semantics are authoritative; owner/commercial values and implementation remain absent                                             |
| `PTX-M06-R01–R05` | `PARTIAL`   | `E05`, `E06`, `E09`, `C04`; authoritative feed/history contracts now bind real partial data surfaces, not full implementation proof                                           |
| `PTX-M06-R06–R07` | `SPECIFIED` | `C04`; honest queue analytics and licensing/entitlement semantics are authoritative; implementation and authority remain absent                                               |
| `PTX-M06-R08`     | `BUILT`     | `E02`, `E06`, `E22`, `C04`; canonical normalization and its no-reinterpretation contract exist, but integrated proof is still required                                        |
| `PTX-M06-R09–R10` | `PARTIAL`   | `E06`, `E07`, `C04`; source/health distinctions and complete terminal-truth semantics exist without full implementation                                                       |
| `PTX-M07-R01–R06` | `PARTIAL`   | `E07`, `E04`, `E14`, `C05`; substantial workstation fragments are bound by the authoritative professional contract, but adapter/workflow proof remains incomplete             |
| `PTX-M07-R07`     | `SPECIFIED` | `C05`; secure mobile risk-control semantics are authoritative; no implementation proof was found                                                                              |
| `PTX-M07-R08–R10` | `PARTIAL`   | `E07`, `C05`; localization/safety/status fragments exist under a complete operational contract without integrated proof                                                       |
| `PTX-M07-R11–R17` | `SPECIFIED` | `C05`; recovery, capacity, causal tree, calendar, profile, journal/replay and blast-radius semantics are authoritative; implementation proof remains absent                   |
| `PTX-M08-R01`     | `PARTIAL`   | `E08`, `E09`; isolated mode exists, required cross/multi-collateral/portfolio modes do not                                                                                    |
| `PTX-M08-R02–R04` | `SPECIFIED` | `C06`; migration, collateral constitution, and reproducible portfolio-model contracts exist; implementation and owner policy remain absent                                    |
| `PTX-M08-R05–R07` | `PARTIAL`   | `E08`, `E09`; preview, borrow, interest, and funding slices exist without end-to-end reconciliation                                                                           |
| `PTX-M08-R08–R09` | `SPECIFIED` | `C06`; cross-account offset and institutional-credit boundaries are explicit disabled products; implementation and commercial/legal authority remain absent                   |
| `PTX-M09-R01–R03` | `PARTIAL`   | `E09`; isolated risk/mark/warning pieces exist, not full legal-boundary aggregation and methodology                                                                           |
| `PTX-M09-R04–R05` | `BUILT`     | `E09`; partial liquidation, insurance, and ADL foundations exist, still short of `PROVEN` default evidence                                                                    |
| `PTX-M09-R06–R08` | `SPECIFIED` | `C06`; multi-counterparty default, exchange-capital stress, and governed model lifecycle contracts exist; operational proof remains absent                                    |
| `PTX-M09-R09`     | `PARTIAL`   | `E09`, `E17`; refuse-closed operator gates exist without full dual-control proof                                                                                              |
| `PTX-M10-R01–R02` | `BUILT`     | `E09`, `E10`, `C07`; spot and isolated perpetual foundations exist under authoritative product semantics, without integrated proof                                            |
| `PTX-M10-R03–R04` | `SPECIFIED` | `C07`; dated futures and coherent basis/spread execution semantics are authoritative; implementation and owner inputs remain absent                                           |
| `PTX-M10-R05`     | `BUILT`     | `E09`, `C07`; funding foundations and authoritative prediction/accrual/settlement/correction semantics exist; integrated proof remains                                        |
| `PTX-M10-R06–R07` | `SPECIFIED` | `C07`; contract migration/emergency settlement and hedge-mode semantics are authoritative; implementation and owner policy remain absent                                      |
| `PTX-M11-R01`     | `SOCKET`    | `E11`, `C08`; semantics are authoritative; the empty live set/settlement asset and open fixing law keep production closed                                                     |
| `PTX-M11-R02–R10` | `SPECIFIED` | `C08`; professional volatility semantics are authoritative; implementation remains absent                                                                                     |
| `PTX-M12-R01–R03` | `PARTIAL`   | `E12`, `C09`; firm single-principal quote/settlement foundations have complete RFQ/capacity semantics without integrated proof                                                |
| `PTX-M12-R04–R05` | `SPECIFIED` | `C09`; allocation and block-rule/reporting semantics are authoritative; implementation and owner/legal policy remain absent                                                   |
| `PTX-M12-R06–R07` | `PARTIAL`   | `E12`, `E15`, `C09`; settlement/audit primitives have authoritative institutional/manual semantics without full workflow proof                                                |
| `PTX-M12-R08`     | `SPECIFIED` | `C09`; give-up, carrying-account, average-price/bunched, confirmation and break semantics are authoritative; implementation remains absent                                    |
| `PTX-M13-R01`     | `PARTIAL`   | `E13`, `C10`; external engine/seeding foundations exist with authoritative launch-plan semantics, but makers, capital, commitments, and live evidence remain absent           |
| `PTX-M13-R02`     | `BUILT`     | `E13`, `E22`, `C10`; source-aware adapter/book foundations exist and are bounded by actionable-depth provenance semantics                                                     |
| `PTX-M13-R03–R04` | `OWNER-SET` | `E13`, `C10`; program and internal/affiliate prerequisites are authoritative, while participation, capital, economics, and conflicts still require owner/legal decisions      |
| `PTX-M13-R05`     | `PARTIAL`   | `E13`, `C10`; health/latency/spread signals and complete quality semantics exist without integrated concentration/adverse-selection/quality proof                             |
| `PTX-M13-R06–R07` | `SPECIFIED` | `C10`; incentive-abuse and liquidity-crisis semantics are authoritative; implementation, thresholds, counterparties, and exercised proof remain absent                        |
| `PTX-M14-R01–R03` | `PARTIAL`   | `E14`, `E23`, `C11`; exact portfolio/order/risk/ledger projections exist under authoritative reconciliation and attribution semantics without integrated proof                |
| `PTX-M14-R04–R07` | `SPECIFIED` | `C11`; performance, evidentiary reporting, NAV delivery and audit/regulator reconstruction semantics are authoritative; implementation remains absent                         |
| `PTX-M15-R01–R02` | `SPECIFIED` | `C12`; custody models and off-exchange collateral boundaries now have a refuse-closed contract; implementation and legal/counterparty proof remain absent                     |
| `PTX-M15-R03`     | `PARTIAL`   | `E15`; transfer/chain foundations exist without full recovery/travel-rule proof                                                                                               |
| `PTX-M15-R04`     | `PARTIAL`   | `E15`, `E27`; bank/fiat adapter fragments exist; rails remain external/socketed                                                                                               |
| `PTX-M15-R05`     | `PARTIAL`   | `E12`, `E15`, `E22`; settlement paths exist without unified finality contract                                                                                                 |
| `PTX-M15-R06`     | `SPECIFIED` | `C12`; treasury inventory, liquidity, key-control, and rebalance contract exists; implementation and owner policy remain absent                                               |
| `PTX-M15-R07`     | `BUILT`     | `E15`, `E23`; one-ledger reconciliation foundations are material, not solvency proof                                                                                          |
| `PTX-M15-R08`     | `SPECIFIED` | `C12`; external-failure caps and exit-playbook contract exists; live caps, counterparties, and exercises remain owner/external                                                |
| `PTX-M16-R01`     | `PARTIAL`   | `E03`, `E16`, `E23`, `C01`; audit IDs/events and an authoritative reconstruction contract exist without regulator-grade completeness proof                                    |
| `PTX-M16-R02–R08` | `SPECIFIED` | `C01`; surveillance, case, accountability, discipline, fairness, and export semantics are authoritative; implementation remains absent                                        |
| `PTX-M16-R09`     | `PARTIAL`   | `E16`, `C01`; compliance gates and lifecycle semantics exist, but complete case proof does not                                                                                |
| `PTX-M17-R01–R03` | `PARTIAL`   | `E01`, `E17`, `C02`; strong controls and authoritative money-control semantics exist without full lifecycle proof                                                             |
| `PTX-M17-R04–R08` | `PARTIAL`   | `E17`, `E18`, `C02`; security doctrine and contract exist; venue-wide exercises, privacy, and claims evidence remain incomplete                                               |
| `PTX-M18-R01–R03` | `SPECIFIED` | `C13`; SLO/error-budget, dependency, writer-fencing and multi-region recovery semantics are authoritative; owner targets and implementation proof remain absent               |
| `PTX-M18-R04`     | `BUILT`     | `E03`, `E18`, `E23`, `C13`; journal/replay/reconcile foundations plus the complete recovery contract exist; venue-wide proof remains incomplete                               |
| `PTX-M18-R05–R08` | `PARTIAL`   | `E18`, `C13`; metrics, health, controls and runbook fragments now have authoritative capacity/incident/maintenance semantics without venue-wide proof                         |
| `PTX-M19-R01–R06` | `SPECIFIED` | `C04`; parity sandbox, SDK, certification, runnable tooling, diagnostics, and lifecycle semantics are authoritative; implementation remains absent                            |
| `PTX-M19-R07`     | `PARTIAL`   | `E06`, `E24`, `C04`; backtest provenance controls and complete dataset semantics exist with implementation residuals                                                          |
| `PTX-M20-R01`     | `PARTIAL`   | `E01`, `E20`, `C11`; individual KYC/document controls exist under a complete institutional-case contract; KYB/UBO/credit integration remains absent                           |
| `PTX-M20-R02–R03` | `SPECIFIED` | `C11`; agreement and diligence-package semantics are authoritative; legal/external inputs and implementation remain absent                                                    |
| `PTX-M20-R04`     | `PARTIAL`   | `E20`, `C11`; support tickets, audit, grounded escalation and no-SLA honesty exist under the service-plan contract; named coverage/commitments remain absent                  |
| `PTX-M20-R05`     | `SPECIFIED` | `C04`, `C11`; client-specific implementation/cutover/rollback semantics bind the certification contract; operating proof remains absent                                       |
| `PTX-M20-R06–R07` | `SPECIFIED` | `C11`; controlled institutional change and complete offboarding semantics are authoritative; implementation remains absent                                                    |
| `PTX-M21-R01–R03` | `PARTIAL`   | `E21`, `C10`; spot/recipe foundations now have authoritative version, preview, assessment, tier, correction, and reporting semantics without venue-wide implementation        |
| `PTX-M21-R04–R05` | `OWNER-SET` | `E13`, `E21`, `C10`; quality/conflict/disclosure semantics are authoritative, while maker/broker/affiliate economics and capacity require explicit decisions                  |
| `PTX-M21-R06`     | `PARTIAL`   | `E21`, `C10`; promotion/accounting primitives have authoritative budget, truth, abuse, collision, correction, and sunset semantics without complete implementation            |
| `PTX-M21-R07`     | `SPECIFIED` | `C10`; complete unit-economics input, provenance, reconciliation, and incomplete-state semantics are authoritative; implementation/accounting inputs remain absent            |
| `PTX-M22-R01`     | `BUILT`     | `E22`, `C14`; typed normalization and live CEX adapter families are substantial under authoritative no-semantic-erasure and eligibility contracts                             |
| `PTX-M22-R02–R03` | `PARTIAL`   | `E22`, `C14`; exact SOR, parent/child, adapter and EMS foundations have complete route/partial/recovery semantics without integrated institutional proof                      |
| `PTX-M22-R04–R06` | `SPECIFIED` | `C14`; inventory/credit/counterparty, on-chain/bridge, and best-execution semantics are authoritative; live policy, dependencies and end-to-end implementation remain absent  |
| `PTX-M22-R07`     | `PARTIAL`   | `E22`, `C14`; refuse-closed adapter/source behavior has authoritative outage/divergence/replay/reconciliation semantics without exhaustive operational proof                  |
| `PTX-M23-R01–R02` | `BUILT`     | `E23`; reconciliation/correction foundations are substantive                                                                                                                  |
| `PTX-M23-R03`     | `PARTIAL`   | `E15`, `E23`; purposed accounts exist without full entity/balance-sheet representation                                                                                        |
| `PTX-M23-R04–R06` | `SPECIFIED` | `C12`; attestation, capital/liquidity, and orderly wind-down contracts exist; external, owner, and operational proof remain absent                                            |
| `PTX-M23-R07`     | `PARTIAL`   | `E21`, `E23`; revenue recipes exist without complete finance-close proof                                                                                                      |
| `PTX-M24-R01–R02` | `BUILT`     | `E24`, `C15`; typed studio/sandbox and fill-based backtest honesty foundations sit under authoritative model, data, simulation, and unsupported-mechanics semantics           |
| `PTX-M24-R03–R04` | `PARTIAL`   | `E24`, `C15`; walk-forward/honesty/sandbox controls have authoritative experiment and environment-separation semantics without production parity proof                        |
| `PTX-M24-R05–R10` | `PARTIAL`   | `E24`, `C15`; sandbox/runtime/tracing fragments sit under complete institutional deployment, approval, recovery, control, monitoring, and promotion contracts                 |
| `PTX-M24-R11–R12` | `PARTIAL`   | `E24`, `E26`, `C15`; listing/honesty foundations have authoritative sharing, claims, capacity, ownership, delisting, and wind-down semantics without full implementation      |
| `PTX-M25-R01–R05` | `SPECIFIED` | `C05`; care ownership, handoff, mandate, allocation, manual-fill and correction semantics are authoritative; implementation remains absent                                    |
| `PTX-M25-R06`     | `PARTIAL`   | `E25`, `C05`; bounded OMS/SOR/EMS transport exists under unified-but-distinct workflow semantics; care/manual depth remains absent                                            |
| `PTX-M25-R07–R11` | `SPECIFIED` | `C05`; TCA, cost, markout, best-execution reconstruction and pre-trade what-if semantics are authoritative; implementation remains absent                                     |
| `PTX-M25-R12`     | `PARTIAL`   | `E25`, `C05`; OMS state exists under a complete exception contract, but no professional dashboard proof exists                                                                |
| `PTX-M26-R01–R02` | `PARTIAL`   | `E26`, `C15`; leader-directory/follower-envelope foundations have authoritative eligibility and independent-limit semantics without complete proof                            |
| `PTX-M26-R03–R05` | `PARTIAL`   | `E26`, `C15`; idempotent mirror/revocation foundations sit under complete sizing, divergence, disposition, race, and causal semantics without sovereign/live proof            |
| `PTX-M26-R06`     | `PARTIAL`   | `E26`, `C15`; accepted protocol-fee-share and ledger path are real, P&L fees remain banned, and period-key/correction/tax/subscription proof remains incomplete               |
| `PTX-M26-R07–R10` | `SPECIFIED` | `C15`; leader-change protection, anti-gaming, private causal export, and common delegation boundaries are authoritative; triggers/policy and implementation remain incomplete |
| `PTX-M27-R01–R02` | `PARTIAL`   | `E27`, `E23`, `C07`; Convert quote/execute foundations now have authoritative capacity/disclosure/firmness/correction semantics without integrated proof                      |
| `PTX-M27-R03–R04` | `SOCKET`    | `E27`, `C07`; product-separation and FX lifecycle semantics are authoritative, while legal capacity and settlement asset/rail law remain unresolved and external              |
| `PTX-M27-R05–R08` | `SPECIFIED` | `C07`; reporting-currency, comparable routing, disruption, and adjacent-product admission semantics are authoritative; implementation remains absent                          |
| `PTX-M28-R01–R03` | `PARTIAL`   | `E28`, `C16`; modes/guardrails and money-deny foundations have authoritative grant/consent/deterministic-control semantics without exchange-native trading proof              |
| `PTX-M28-R04–R05` | `PARTIAL`   | `E28`, `E04`, `C16`; draft/audit/completion-idempotency fragments sit under complete preview, confirmation, tool replay, partial and unknown-state contracts                  |
| `PTX-M28-R06`     | `PARTIAL`   | `E28`, `C16`; grounded refusal foundations have authoritative context/source/citation/uncertainty/advice semantics without complete implementation                            |
| `PTX-M28-R07`     | `SPECIFIED` | `C16`; untrusted-zone isolation and continuous prompt-injection/data-poisoning adversarial-evaluation semantics are authoritative; implementation remains absent              |
| `PTX-M28-R08–R09` | `PARTIAL`   | `E28`, `C16`; hash-chained audit, provider health, readiness and kill foundations have complete causal-evidence and promotion/degradation contracts without full proof        |
| `PTX-M28-R10–R12` | `SPECIFIED` | `C16`; multi-agent/manual coordination, endpoint-specific provider privacy and tool-marketplace admission/revocation semantics are authoritative; implementation is absent    |

### 13.3 Census conclusions

- No requirement qualifies as `PROVEN`. That is an honest proof threshold, not a claim that the existing product lacks substance.
- The strongest built foundations are sub-account isolation, matching/order primitives, isolated futures risk, funding/liquidation, canonical identifiers, source-aware routing, reconciliation, and quant authoring/backtest foundations.
- The most consequential absence clusters remain rulebook/surveillance, portfolio margin, institutional connectivity, professional terminal recovery/controls, volatility/options depth, custody/off-exchange settlement, care-order OMS/TCA, certification, and venue-wide resilience proof.
- A tracker green row, UI mount, or implementation file may justify `PARTIAL` or `BUILT`; it never independently justifies `PROVEN`.
- The census is updated only when a linked contract or proof changes. Delivery status remains in the existing tracker; this section must not become a parallel work board.

### 13.4 Tracker, socket, spec, and owner-decision reconciliation

The final reconciliation found no tracker capability outside M00–M28, but it did find several places where a green delivery row is intentionally narrower than the professional requirement. These distinctions are binding:

| Existing repository claim               | Canonical interpretation in this scope                                                                                                                                                               |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trade.options` done                    | Paper order entry is delivered; live listing remains refuse-closed by the accepted empty settlement law. M11 is not professionally complete.                                                         |
| `trade.forex` done                      | Shared-engine/refusal behavior is delivered; live fiat settlement rails and FX product law remain socketed under M27/M15.                                                                            |
| `trade.otc` done                        | Principal RFQ/settlement slice is delivered; maker routing, multi-leg allocation, give-up, and post-trade breaks remain M12 gaps.                                                                    |
| `trade.copy` and its auto-mirror socket | Follow/kill/grant/place primitives exist; this does not prove leader integrity, drift, capacity, compensation, anti-gaming, or full causal evidence in M26.                                          |
| `trade.algo` and VWAP/POV done          | Current TWAP/VWAP/POV slices are real; the full advanced order/algo lifecycle in M04 and governed promotion/runtime in M24 remain broader.                                                           |
| `execution.sor` done                    | Core OMS/SOR planning/execution is delivered; it is not the care-order, shift-handoff, allocation, and TCA product defined by M25.                                                                   |
| `web.terminal` done                     | The vendored desk and depth wiring are delivered; M07 additionally requires recovery, stale-state truth, safety, capacity, mobile control, audit trees, calendars, and institutional workflows.      |
| `quant.*` rows done                     | Studio/backtest/sandbox/marketplace foundations are delivered; Monte Carlo is explicitly residual and M24 still requires institutional approval, deployment, recovery, parity, and retirement proof. |

The existing bounded specs remain authoritative for their stated slices: sub-accounts (`E01`), lending (`E08`), OTC/RFQ (`E12`), and routing/copy (`E22`/`E26`). They are inputs to future mountain specs, not documents to rewrite. The accepted owner rulings on external-only house execution, empty options/FX live settlement law, and refuse-closed copy jurisdictions remain valid. They settle safe current behavior, not the north-star magnitudes, licensed entities, product eligibility, or commercial/risk policies listed in §8. Consequently, none of the 21 §8 decisions may be inferred from a tracker checkmark or narrow ADR.

At assurance baseline `1a17a85ab03cf549243d0b62565eeec4ecd84b11`, the `svc-execution` README predated its OMS/SOR/EMS implementation and was not authoritative evidence. Current code, tests, tracker history, and `E25` prove the bounded core described above; they do not prove the north-star M25 desk OMS/TCA product. The baseline artifact required a separate service-scoped correction; repository history, rather than this specification, records that correction's delivery state.

---

## 14. Definition of “scope complete”

The full-scope phase is complete when:

1. Every professional persona and end-to-end lifecycle maps to at least one mountain.
2. Every exchange money flow, balance-sheet exposure, external counterparty, failure mode, and operator intervention maps to a requirement.
3. Every current tracker exchange, trade, terminal, execution, venue, and quant capability maps to this document, including sockets and competitive-depth gaps.
4. Every requirement has a maturity state and evidence or an explicit absence.
5. Every dangerous owner choice appears in the owner-decision register rather than being silently assumed.
6. Existing specs are linked and contradictions are surfaced; nothing is re-specced merely because it was hard to find.
7. Research covers CEX, derivatives/options, prime/institutional, on-chain, custody/settlement, professional terminal/OMS, quant and agentic automation, and regulatory market infrastructure.
8. The specification factory can turn any mountain into a bounded contract without creating a second roadmap.

This version satisfies the capability-taxonomy portion of that bar after three progressively adversarial passes: crypto competitors, regulated market infrastructure/custody, and professional terminal/OMS/quant/prime workflows. No finite document can honestly prove that markets, regulation, or technology will never produce a new requirement. The defensible statement is: **as of the research cutoff, no material professional-exchange domain or existing exchange/quant tracker product remains knowingly unmapped.** The recurring audit in §11 is the control that keeps this true.

The requirement census in §13 closes the evidence-assignment portion of the scope phase. The 16 bounded mountain specifications in §15 close the product-semantics portion without converting unresolved owner decisions into invented product behavior. Implementation maturity remains separately and honestly classified in §13.

---

## 15. Dependency-complete child-spec program

This program covers all 29 mountains exactly once as a primary responsibility. It is a specification dependency graph, not a delivery board or promise that every product launches. All authoritative child filenames are resolved below; the canonical status remains here.

| Spec     | Bounded contract                                                                                                                                                              | Primary requirements | Hard predecessors / gates                                                                            |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------- |
| `PX-S01` | [`SPEC-PRO-EXCHANGE-RULEBOOK-LIFECYCLE-INTEGRITY-2026-08-23.md`](docs/archive/SPEC-PRO-EXCHANGE-RULEBOOK-LIFECYCLE-INTEGRITY-2026-08-23.md)                                   | M00, M02, M16        | Entity/jurisdiction and venue-role decisions may remain named sockets; no magnitude invention        |
| `PX-S02` | [`SPEC-PRO-EXCHANGE-AUTHORITY-AND-PARTICIPANT-SECURITY-2026-08-23.md`](docs/archive/SPEC-PRO-EXCHANGE-AUTHORITY-AND-PARTICIPANT-SECURITY-2026-08-23.md)                       | M01, M17             | Reuse sub-account spec; legal roles and privileged-action authority must be explicit                 |
| `PX-S03` | [`SPEC-PRO-EXCHANGE-MICROSTRUCTURE-AND-ORDER-EXECUTION-2026-08-24.md`](docs/archive/SPEC-PRO-EXCHANGE-MICROSTRUCTURE-AND-ORDER-EXECUTION-2026-08-24.md)                       | M03, M04             | `PX-S01` market states/rules and `PX-S02` actor/session attribution                                  |
| `PX-S04` | [`SPEC-PRO-EXCHANGE-CONNECTIVITY-DATA-AND-CERTIFICATION-2026-08-24.md`](docs/archive/SPEC-PRO-EXCHANGE-CONNECTIVITY-DATA-AND-CERTIFICATION-2026-08-24.md)                     | M05, M06, M19        | `PX-S01` rule/change policy; `PX-S03` canonical order states and sequence law                        |
| `PX-S05` | [`SPEC-PRO-EXCHANGE-TERMINAL-OMS-AND-TCA-2026-08-24.md`](docs/archive/SPEC-PRO-EXCHANGE-TERMINAL-OMS-AND-TCA-2026-08-24.md)                                                   | M07, M25             | `PX-S02` authority, `PX-S03` lifecycle, `PX-S04` data/recovery contracts                             |
| `PX-S06` | [`SPEC-PRO-EXCHANGE-COLLATERAL-RISK-LIQUIDATION-DEFAULT-2026-08-24.md`](docs/archive/SPEC-PRO-EXCHANGE-COLLATERAL-RISK-LIQUIDATION-DEFAULT-2026-08-24.md)                     | M08, M09             | Owner risk methodology/magnitudes remain sockets; isolated mode remains distinct                     |
| `PX-S07` | [`SPEC-PRO-EXCHANGE-LINEAR-PRODUCTS-CONVERT-AND-FX-2026-08-24.md`](docs/archive/SPEC-PRO-EXCHANGE-LINEAR-PRODUCTS-CONVERT-AND-FX-2026-08-24.md)                               | M10, M27             | `PX-S01`, `PX-S03`, `PX-S06`; preserve options/FX settlement sockets                                 |
| `PX-S08` | [`SPEC-PRO-EXCHANGE-OPTIONS-AND-VOLATILITY-2026-08-24.md`](docs/archive/SPEC-PRO-EXCHANGE-OPTIONS-AND-VOLATILITY-2026-08-24.md)                                               | M11                  | `PX-S01`, `PX-S03`, `PX-S06`; live settlement asset/fixing decision required before live DoR         |
| `PX-S09` | [`SPEC-PRO-EXCHANGE-RFQ-BLOCK-OTC-AND-ALLOCATION-2026-08-24.md`](docs/archive/SPEC-PRO-EXCHANGE-RFQ-BLOCK-OTC-AND-ALLOCATION-2026-08-24.md)                                   | M12                  | Reuse OTC/RFQ spec; `PX-S01`, `PX-S02`, `PX-S03`; principal/agency and allocation law                |
| `PX-S10` | [`SPEC-PRO-EXCHANGE-LIQUIDITY-FEES-AND-MAKER-CONSTITUTION-2026-08-24.md`](docs/archive/SPEC-PRO-EXCHANGE-LIQUIDITY-FEES-AND-MAKER-CONSTITUTION-2026-08-24.md)                 | M13, M21             | `PX-S01` fairness/surveillance; maker participation and economics owner decisions                    |
| `PX-S11` | [`SPEC-PRO-EXCHANGE-PORTFOLIO-INSTITUTIONAL-REPORTING-AND-SERVICE-2026-08-24.md`](docs/archive/SPEC-PRO-EXCHANGE-PORTFOLIO-INSTITUTIONAL-REPORTING-AND-SERVICE-2026-08-24.md) | M14, M20             | `PX-S02`, `PX-S06`; common IDs, accounting policy, service/legal operating model                     |
| `PX-S12` | [`SPEC-PRO-EXCHANGE-CUSTODY-RECONCILIATION-AND-WIND-DOWN-2026-08-24.md`](docs/archive/SPEC-PRO-EXCHANGE-CUSTODY-RECONCILIATION-AND-WIND-DOWN-2026-08-24.md)                   | M15, M23             | One-ledger law; entity/custodian/bank/rail sockets; no second money book                             |
| `PX-S13` | [`SPEC-PRO-EXCHANGE-RESILIENCE-AND-INCIDENT-COMMAND-2026-08-24.md`](docs/archive/SPEC-PRO-EXCHANGE-RESILIENCE-AND-INCIDENT-COMMAND-2026-08-24.md)                             | M18                  | State/recovery inputs from `PX-S03`, `PX-S04`, `PX-S06`, and `PX-S12`; owner-set SLOs may stay blank |
| `PX-S14` | [`SPEC-PRO-EXCHANGE-MULTI-VENUE-AND-ONCHAIN-EXECUTION-2026-08-24.md`](docs/archive/SPEC-PRO-EXCHANGE-MULTI-VENUE-AND-ONCHAIN-EXECUTION-2026-08-24.md)                         | M22                  | Reuse routing/copy spec; `PX-S02`, `PX-S03`, `PX-S06`, `PX-S12`; counterparty/capital truth          |
| `PX-S15` | [`SPEC-PRO-EXCHANGE-QUANT-AND-DELEGATED-STRATEGY-LIFECYCLE-2026-08-24.md`](docs/archive/SPEC-PRO-EXCHANGE-QUANT-AND-DELEGATED-STRATEGY-LIFECYCLE-2026-08-24.md)               | M24, M26             | `PX-S02`, `PX-S03`, `PX-S06`; reuse quant/copy foundations and keep money authority ordinary         |
| `PX-S16` | [`SPEC-PRO-EXCHANGE-AGENTIC-TRADING-AUTHORITY-AND-SAFETY-2026-08-24.md`](docs/archive/SPEC-PRO-EXCHANGE-AGENTIC-TRADING-AUTHORITY-AND-SAFETY-2026-08-24.md)                   | M28                  | `PX-S02`, `PX-S03`, `PX-S15`; deterministic controls dominate probabilistic output                   |

### 15.1 Specification order

1. **Constitution ridge:** `PX-S01`, then `PX-S02`.
2. **Deterministic trading spine:** `PX-S03`, `PX-S06`, and `PX-S12`; these may proceed in parallel once shared rule/authority terms are stable.
3. **Professional access and proof:** `PX-S04`, `PX-S13`, then `PX-S05` and `PX-S11`.
4. **Product and liquidity depth:** `PX-S07`, `PX-S08`, `PX-S09`, `PX-S10`, and `PX-S14` after their named foundations.
5. **Governed automation:** `PX-S15`, then `PX-S16`.

This order does not prioritize UI over liquidity or vice versa. It prevents execution, margin, custody, data, and delegation specs from silently defining incompatible authority or money models.

### 15.2 Definition of Ready for a child spec

A child spec may move from outline to authoritative contract only when all of the following are true:

1. Its complete PTX requirement set and all cross-cutting gates are linked.
2. Existing code, tests, specs, tracker rows, sockets, and accepted owner rulings are inventoried; contradictions are stated, not overwritten.
3. Actors, legal/account boundaries, counterparty role, trust boundaries, and authoritative system of record are named.
4. Every value-bearing path uses decimal strings on the wire, scaled bigint in memory, and balanced `ledger-client` recipes; no parallel balance store is implied.
5. State machines cover normal, refusal, partial success, correction, expiry, suspension, recovery, migration, and wind-down.
6. Common identifiers and timestamps support causal reconstruction across UI/API, risk, execution, events, ledger, and reports.
7. Owner-set magnitudes/policies and external dependencies are represented as typed sockets with safe blank behavior.
8. Abuse, surveillance, security, privacy, jurisdiction, record retention, operator authority, and conflicts are addressed at the product boundary.
9. Compatibility, rollout, rollback, degraded mode, load/fault evidence, reconciliation, and customer/operator evidence are testable.
10. Non-goals prevent the spec from creating a second SPA, second money book, hidden principal role, synthetic liquidity claim, or silently weakened order intent.

### 15.3 Definition of Done for the specification phase

The specification program is complete only when all 16 child contracts meet §15.2, every PTX ID links to exactly one primary child contract, cross-contract terms and states pass a contradiction audit, and remaining unknowns are explicit sockets or owner decisions. Only then should implementation mountains be added to the existing tracker and decomposed into service-scoped PRs.

Version 1.19 meets this definition. The initial proof and contradiction result is retained in §16; the independent assurance certification and post-spec evidence transitions are in §§17–18. This is specification completeness, not implementation completion or launch authority.

---

## 16. Final all-spec audit and implementation handoff

### 16.1 Completeness proof

The 24 August 2026 audit evaluated this canonical scope and every authoritative contract from `PX-S01` through `PX-S16` against §15.2 and the shared specification quality bar. It verified:

- 16 real child files linked from the evidence register and §15, with no filename placeholder;
- 255 unique requirement definitions, 255 unique census assignments, and 255 unique requirement-level child proof entries, with no missing or duplicate PTX ID;
- all 29 mountains assigned to exactly one primary child contract;
- resolved local links across this document and all 16 child contracts;
- explicit authority, systems of record, object and state ownership, timestamps, correction, degraded/refusal, recovery, rollout, decommissioning, wind-down, proof, and implementation-gap treatment in every applicable contract; and
- no second product shell, money book, ledger, tracker, or canonical scope artifact.

The audit used range expansion when counting PTX IDs, so a compact row such as `R01–R03` counts as three assignments rather than one prose occurrence. Maturity remains evidence-based: an authoritative `SPECIFIED` contract closes product semantics, while `BUILT`, `PARTIAL`, `SOCKET`, `OWNER-SET`, `EXTERNAL`, and `ABSENT` continue to describe implementation or dependency truth. No requirement is promoted to `PROVEN` by this specification result.

### 16.2 Cross-contract precedence and invariants

The audit found the following shared law internally consistent and binding:

1. **Authority:** PX-S02 grants are intersection-only, account/sub-account scoped, attributable, revocable, and never expanded by a terminal, broker, strategy, copy leader, model, tool, operator, venue adapter, or report. PX-S01 still owns product/rule eligibility and intervention authority.
2. **Money and finality:** `packages/ledger-client` plus `svc-ledger` remain the only internal money book. Decimal strings cross boundaries, exact scaled integers are used in memory, and no service or projection owns a balance. Matching, routing, external acknowledgement, chain inclusion, model output, or UI state never substitutes for the applicable ledger and external finality evidence.
3. **Orders and external effects:** PX-S03 owns Fiat-plane order/match/fill semantics. Command acceptance is distinct from application; cancel is a request until the matching sequence proves it; a timeout after possible dispatch is unknown and reconciled before retry. Cross-venue and synthetic groups are legged unless one named boundary proves all-or-none.
4. **Evidence and clocks:** canonical IDs preserve legal owner, account, authority, rule/instrument/model/schema version, parent/child/hedge lineage, economic idempotency root, source sequence, and event/receive/effective/final timestamps. Derived data retains provenance, age, limitations, and correction lineage.
5. **Corrections:** original orders, fills, observations, postings, statements, approvals, and decisions remain immutable. Bust, reversal, allocation repair, report replacement, and economic correction append causal evidence and use balanced recipes where value changes.
6. **Failure and wind-down:** stale, partial, divergent, unknown, suspended, and recovery-required states are customer/operator visible and do not collapse into success. Wind-down stops new risk, preserves authorized risk reduction and evidence access where safe, resolves or explicitly records residual claims, and never invents a conversion, counterparty, asset, deadline, or loss allocation.

If a product-specific contract conflicts with these invariants, the higher authority in §0.1 and the owning predecessor contract win; the affected capability refuses until the canonical artifacts are amended together.

### 16.3 Resolved contradiction register

| Evidence conflict                                                                                                                                                                                       | Authoritative resolution                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| At the audited baseline, `services/svc-execution/README.md` said the service was not an SOR/OMS/EMS, while later code, tests, tracker history, and the SoT showed bounded delivery.                     | PX-S03 and §13.4 record the exact truth: core OMS/SOR planning, execution, cancellation, fetch, venue observation/adaptation, execution reporting, and an EMS acknowledgement journal exist; the professional care-order/desk/allocation/drop-copy/TCA product remains incomplete. That baseline artifact required a separate service-scoped correction and cannot override stronger evidence. |
| At the audited baseline, `planOmsArbAtomicLegs` labeled a plan atomic although its executor submits sequentially and can partially succeed; a general OMS child ID is derived only from venue identity. | The planner now reports `atomic: false` while retaining legacy symbol names. PX-S14 classifies the route `LEGGED`, requires actual completed children in every failure result, and requires globally unique parent-bound child/client IDs. Child-ID and recovery correction remain implementation work.                                                                                        |
| Existing `svc-trade` copy flow is a Fiat-plane service envelope, while the accepted sovereign copy contract requires Protocol-plane follower authority and non-custodial enforcement.                   | PX-S15 preserves both truths: current code is a bounded partial foundation and cannot claim sovereign/non-custodial enforcement until a Protocol-plane adapter proves it. Settled fill fees, not illustrative notional-derived fee estimates, are authoritative; period statistics remain pair-lifetime until a period key exists.                                                             |
| At the audited baseline, `services/svc-trade/README.md` said D26-P0-15 published a copy-jurisdiction allowlist, while the later accepted ADR and PX-S15 kept every region closed pending counsel.       | The later accepted refusal law prevails: no served jurisdiction exists until counsel supplies the list. That baseline artifact required its own service-scoped documentation correction; it cannot activate follow creation or weaken the typed blank.                                                                                                                                         |
| Existing agent guardrails accept caller-provided approval and tool-name checks, while completion request IDs and hash-chain logs can look stronger than their economic guarantees.                      | PX-S16 requires bound consent/confirmation, authorization of typed tool arguments plus an input digest, product/economic idempotency and lookup, and causal intent-to-order-to-ledger evidence. Provider health or hot-swap is not evaluated release approval. Existing agents remain non-money product assistants; any trading agent is a separately granted PX-S15-bound capacity.           |
| PX-S07 said order acceptance “atomically binds” authority, rule, risk/hold, and matching sequence, which could imply a cross-service transaction.                                                       | PX-S07 now states that an accepted order is valid only when those inputs are bound at PX-S03's defined linearization point. PX-S03's durable saga, explicit pending/unknown states, and ledger finality remain authoritative.                                                                                                                                                                  |

These resolutions close the specification contradictions. They do not close the named implementation gaps.

### 16.4 Remaining decisions and external dependencies

The 21 owner decision families in §8 remain open unless an accepted direction or ADR says otherwise. Each child contract maps its relevant subset to a typed socket with a safe blank: affected activation, value movement, exposure, entitlement, claim, automation, external route, or destructive action refuses or stays explicitly paper/read-only/degraded. A missing magnitude is never replaced by zero, a competitor value, an example, or a tracker label.

External dependencies remain explicit in four classes:

- **legal and regulatory:** licensed entities, jurisdictions, product/counterparty capacities, rule/reporting/record obligations, agreements, client mandates, advice and data-use law;
- **market and financial:** makers, venues, prime/credit counterparties, custodians, banks, PSPs, rails, chains, bridges, oracles, liquidity/borrow/hedge inventory, settlement and exit arrangements;
- **technology and data:** authenticated adapters, production market/reference data, FIX/binary dictionaries, time sources, HSM/MPC and credential custody, model/provider endpoints, notification/status delivery, capacity and portability proof; and
- **independent assurance:** model validation, security/adversarial testing, certification, audit/attestation, resilience exercises, legal review, and production-shaped operating evidence.

An external dependency is admitted only through its owning adapter/constitution, health and evidence contract, failure behavior, and exit path. Absence or stale evidence excludes the source or refuses the dependent action; it never becomes hidden platform capacity.

### 16.5 Recommended implementation sequence

Implementation should now use the existing tracker rather than extending this specification program:

1. resolve only the owner decisions needed for the first bounded launch slices; establish shared authority, identifier, event, exact-money, correction, and typed-socket contracts;
2. harden the deterministic spine in PX-S01/PX-S02/PX-S03/PX-S06/PX-S12/PX-S13, including durable writers/outcomes, recovery, reconciliation, severe-market capacity, and the known OMS/SOR/atomicity gaps;
3. deliver professional access and proof through PX-S04/PX-S05/PX-S11: protocol certification, data/drop-copy completeness, terminal recovery/safety, OMS desk workflow, TCA, institutional reports, and service operations;
4. activate product and liquidity slices from PX-S07/PX-S08/PX-S09/PX-S10/PX-S14 only after their legal, risk, settlement, counterparty, liquidity, and failure sockets are non-empty and tested; and
5. promote PX-S15 deterministic strategies/copy before PX-S16 agentic trading, keeping both inside ordinary account, risk, order, ledger, audit, revocation, and kill boundaries.

Each implementation unit remains service-scoped and must update §13 only when evidence actually changes. Specification completeness authorizes implementation planning; it does not authorize a live product, invented policy, or maturity promotion.

---

## 17. Independent specification-assurance certification

### 17.1 Baseline, cutoff, and bounded verdict

The independent assurance baseline is `1a17a85ab03cf549243d0b62565eeec4ecd84b11` (`docs(pro-exchange): close final specification audit (#3186)`), audited on 24 August 2026 after confirming that no active pull request touched this scope or the 16 canonical child contracts. Version 1.19 applies the material corrections found during that audit.

At this baseline and research cutoff, the professional-exchange scope is complete enough to implement: the independent persona, journey, economic, authority, failure, adversary, institutional-diligence, and competitor-pattern derivations found no material product job outside the existing 29 mountains and 255 requirements. No new PTX ID was therefore manufactured. The contracts are mutually consistent and testable after the corrections recorded here, and dangerous unknowns remain closed sockets.

This is a **specification certification only**. It does not certify that a capability is implemented, integrated, reconciled, secure, operable, legally available, externally ready, customer-proven, or `PROVEN`. Section 13 remains the implementation-maturity truth, and §18 defines the evidence needed to advance it.

### 17.2 Audits performed and results

| Audit                                | Independent result at the baseline                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mechanical integrity                 | Passed: exactly 16 resolved child files; 29 unique mountains with one primary child each; 255 unique definitions, 255 unique census assignments, and 255 unique child proof entries; `C01`–`C16` match the contracts; no missing local link, accidental template-date or unfinished-work marker, duplicate PTX ID, or `PROVEN` requirement claim. State-machine uses of `DRAFT` and deliberate example placeholders are not unresolved drafting markers.                                                        |
| Full-scope gap hunt                  | Re-derived through professional personas, complete journeys, instrument/order/money/authority lifecycles, operator intervention, stress, adversary, counterparties, correction, migration/exit, economics, diligence, and customer claims. No additional durable requirement survived the materiality and non-duplication tests.                                                                                                                                                                                |
| Current research and competition     | Rechecked official venue, derivatives/options, prime/custody, OEMS/EMS, FIX/data/certification, margin/default, surveillance, settlement/wind-down, quant/copy, and agent/tool sources. PX-S01 and PX-S02 now have focused dated primary-source registers; competitor mechanisms, numbers, legal terms, and claims were not copied.                                                                                                                                                                             |
| Cross-contract semantics             | Passed after removing stale SoT-version pins and retaining the ownership/precedence map in §17.3. Consumers may specialize views or product state but cannot redefine authority, money, order, risk, route, report, incident, or wind-down truth.                                                                                                                                                                                                                                                               |
| Money and balance sheet              | Passed the economic-path trace in §17.4. Every value path resolves owner/account/asset/exact amount, purpose hold/reservation, ledger-recipe boundary, economic idempotency, finality, partial/unknown handling, correction, reconciliation, report/dispute, and wind-down treatment. No service owns a balance.                                                                                                                                                                                                |
| Authority and information leakage    | The chain `legal owner → organization → account → sub-account → mandate → grant → session/key → instruction → execution → ledger/report` remains intersection-only for direct, broker/DMA, care, maker, affiliate, strategy, copy, agent, operator, support, control-function, and external-counterparty capacities. Aggregate-read-to-write, sibling funding, inherited withdrawal, stale revoke, caretaker, leader/model, affiliate, and private-intent leakage cases refuse or remain separately authorized. |
| State, race, and distributed failure | Duplicate, reorder, stale snapshot, gaps, restart, region loss, split brain, partial store/bus/ledger failure, cancel/fill, amend/cancel, mark/risk, transfer/liquidation, correction/settlement, revoke/child, strategy/agent retry, venue ambiguity, reorg, dependency outage, clock skew, and schema mismatch retain one owner, stable idempotency, lookup/replay/reconciliation, and explicit unknown/customer truth.                                                                                       |
| Stress, adversary, and abuse         | Severe-market capacity and abuse clauses cover hot symbols/L3, cancel and fill storms, liquidation cascades, maker withdrawal, oracle/depeg/chain/borrow/expiry/external divergence, provider failure/DDoS, credential/insider abuse, manipulation/collusion/quote stuffing, RFQ/copy/backtest abuse, injection/poisoning, malicious tools, and multi-agent feedback. Numeric envelopes remain owner-set.                                                                                                       |
| Professional journeys                | The full `discover → diligence → onboard → fund → configure → connect → price → preview → submit → acknowledge → recover → amend/cancel → manage risk → settle → reconcile → report → dispute → offboard/wind down` journey was traced for discretionary, maker, options, quant, broker/care, multi-venue, treasury/custody, risk, compliance/surveillance, auditor, copy, and agent operators. No required truth depends on UI scraping, an undocumented manual value, or a hidden reconciliation step.        |
| Implementation reality               | Graphify plus focused code/test/history/README inspection upheld the bounded `BUILT`/`PARTIAL` classifications and their explicit residuals. It confirmed baseline `svc-execution` and `svc-trade` README overclaims, a false atomic planner flag, and one obsolete `svc-execution` source-shape pin; current repository history corrects those artifacts without promoting or erasing the underlying bounded implementation evidence.                                                                          |
| Testability and evidence             | Every child Definition of Done names observable objects/outcomes and one or more deterministic, property/model/fuzz, concurrency/replay, ledger, integration/E2E, fault/chaos, capacity, security/abuse, surveillance, shadow/canary, external-certification, drill, or customer-evidence methods. Adjectives such as secure, real-time, resilient, institutional, liquid, or best execution are bounded by a measurement/evidence category and owner target socket.                                            |
| Owner, legal, and external sockets   | The 21 canonical owner families remain the only owner-decision summary. Child sockets name affected requirements and safe blanks; external dependencies name evidence and exit behavior. No example or competitor value becomes a default, and an unopened socket blocks only its dependent activation, magnitude, claim, or destructive action.                                                                                                                                                                |

### 17.3 Canonical semantic ownership and precedence

| Canonical concept                                                                                                                                                             | Sole authoritative owner | Consumer/specialization boundary                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Legal person, organization, account/sub-account, broker/client mandate, credential, session, key, grant, approval, and revocation                                             | PX-S02                   | Every other contract consumes the resolved leaf authority; UI, broker, operator, strategy, leader, agent, and adapter context cannot widen it.                                                            |
| Rule version, instrument version, market/product state, emergency authority, dispute, discipline, and market-integrity case                                                   | PX-S01                   | Product contracts add economics and evidence under the bound rule version; they cannot create an undocumented halt, listing, correction, or legal capacity.                                               |
| Order instruction/command, canonical preview, order state, execution group, parent/child lineage, fill, cancel, bust, and execution correction                                | PX-S03                   | PX-S09 RFQ/allocation, PX-S14 routes/external orders, PX-S15 automation, and PX-S16 tools specialize causes and external states but preserve PX-S03 identity and final outcome law.                       |
| Protocol/session/schema, source sequence, market-data observation, capture edition, recovery, compatibility, and client certification                                         | PX-S04                   | Product calculations retain provenance and freshness; transport or normalization never creates order, risk, balance, or finality truth.                                                                   |
| Position, collateral snapshot, risk snapshot, mark/index use, credit, liquidation, insurance/default resource, and ADL evaluation                                             | PX-S06                   | PX-S07/PX-S08 own product economics; PX-S10 owns fees/incentives; PX-S12 owns resulting value finality. A display/model/router cannot become a risk SoR.                                                  |
| Hold/reservation posting, ledger transaction/entry, custody location, transfer/settlement finality, external reconciliation, finance close, asset return, and wind-down state | PX-S12                   | PX-S03/PX-S06/PX-S09/PX-S14 request purpose-scoped holds or obligations; only ledger recipes move internal value and only named external evidence proves controlled assets/finality.                      |
| Liquidity plan, fee/rebate/promotion/broker economics, maker obligations, conflicts, and commercial attribution                                                               | PX-S10                   | Execution and reports consume effective versions and actual collected amounts; no service reconstructs a fee pot or unfunded rebate.                                                                      |
| Statement, confirmation, report, portfolio presentation, diligence pack, service case, and offboarding evidence                                                               | PX-S11                   | Reports compose immutable source facts and corrections; they never become a ledger, risk, order, custody, or legal-decision SoR.                                                                          |
| Professional workspace, desk/care ownership, human control, and TCA presentation                                                                                              | PX-S05                   | Terminal/OMS views and workflow remain control/read models over PX-S02/PX-S03/PX-S04/PX-S06/PX-S11/PX-S12 truth.                                                                                          |
| External venue eligibility/decision, external order, route child, on-chain transaction, bridge lifecycle, and route recovery                                                  | PX-S14                   | PX-S03 owns canonical parent/execution truth, PX-S06 exposure, and PX-S12 custody/finality. A quote, acknowledgement, inclusion, or balanced internal journal is not settlement.                          |
| Strategy deployment, research/paper/shadow/live promotion, copy delegation, replication/divergence, and compensation attribution                                              | PX-S15                   | Signals and leaders propose bounded intent only; PX-S02/PX-S03/PX-S06/PX-S10/PX-S12 remain authoritative for action and money.                                                                            |
| Agent grant/mode, context/model/tool call, structured intent/confirmation evidence, provider release, adversarial evaluation, and tool admission                              | PX-S16                   | Probabilistic output is untrusted proposal input to deterministic PX-S15 and ordinary account/risk/order/ledger controls.                                                                                 |
| Incident command, dependency/capacity state, writer fencing, recovery evidence, maintenance, exercise, and status truth                                                       | PX-S13                   | Domain owners retain their state and reconciliation. PX-S13 coordinates and proves recovery; it cannot edit balances, orders, positions, rules, or external facts. PX-S12 alone owns financial wind-down. |

Identifiers, versioning, event/source/effective/finality clocks, idempotency, sequencing, partial success, retries/replay, correction, suspension, recovery, migration, decommission, and wind-down follow the owner in this table. Cross-domain events carry owner IDs/versions and causal watermarks; they do not invent a global transaction or allow a consumer's queue arrival time to choose economic truth.

### 17.4 Economic-path assurance result

Every row below passed one common proof: legal/beneficial owner and leaf account; asset and exact amount; purpose hold/reservation; balanced `ledger-client` recipe boundary; stable economic idempotency root; application and finality state; partial/unknown recovery; append-only reversal/correction; independent reconciliation source; statement/report treatment; dispute; and wind-down disposition. A product-specific contract may add economics, but PX-S12 owns value finality and PX-S11 owns participant evidence.

| Economic paths traced                                                                                                                                      | Owning contracts and result                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deposits, withdrawals, custody assets/encumbrances, bank/chain/rail transfer, external settlement, finance close, and asset return                         | PX-S12, with PX-S02 authority and PX-S11 reporting. Unknown rail/custodian/finality remains pending or recovery-required; it never credits an invented asset or closes a claim.                          |
| Trade holds/releases, fills, fees, maker rebates, broker commissions/markups, promotions, busts, refunds, and compensation                                 | PX-S03/PX-S10/PX-S12. Schedules and actual collected amounts are versioned; absent funding means no rebate/promotion/accrual, and corrections are compensating postings.                                 |
| Funding, borrow/interest/recall, collateral/margin, liquidation fees/penalties, insurance/default resources, ADL/social loss if authorized, and recoveries | PX-S06/PX-S07/PX-S10/PX-S12. Owner-set methodology and capital/loss-allocation sockets block use and claims while blank; no implicit fund or cross-owner loss transfer exists.                           |
| RFQ/OTC/block premium or spread, allocation/give-up, credit, escrow/DvP, receivable, and settlement repair                                                 | PX-S09/PX-S12, with PX-S06 credit/default and PX-S10 economics. Partial legs and rejected give-ups remain explicit obligations; allocation never changes beneficial ownership without authority.         |
| External-venue prefunding/inventory/credit/receivables, on-chain gas/approval/swap, bridge in-flight exposure, and route repair                            | PX-S14/PX-S12, with PX-S06 counterparty/exposure. External balances are reconciliation evidence, not a second book; platform bridge exposure and unknown children remain reserved until proved.          |
| Convert/FX consideration and spread, linear funding/settlement, options premium/exercise/assignment/expiry settlement, hedges, and corrections             | PX-S07/PX-S08/PX-S12. Product constitution supplies exact assets/formula; absent fixing, settlement asset, calendar, rail, or risk law keeps the product unavailable.                                    |
| Strategy/copy subscription or permitted compensation and agent/tool/provider costs                                                                         | PX-S10/PX-S15/PX-S16/PX-S12. Leaders/models/tools hold no money authority; copy compensation derives only from the actual settled fee under accepted law, and absent commercial/legal authority refuses. |

### 17.5 Residual limits and revalidation triggers

The certification leaves the §8 owner decisions and every child `O*`, `X*`, or `socket.*` dependency in its recorded state. It does not select an entity, jurisdiction, product, counterparty, settlement asset, provider, sanctions rule, fee, limit, tolerance, SLO, capital amount, or legal interpretation. It also does not prove production data quality, liquidity, capacity, custody, solvency, security, operations, customer adoption, or regulatory acceptance.

Revalidation is mandatory when any PTX definition, owner assignment, child contract, precedence rule, maturity claim, system of record, money recipe, authority boundary, external provider/counterparty, owner/legal socket, supported product/jurisdiction, schema/protocol, material competitor pattern, incident finding, test failure, or governing primary source changes. Revalidation reruns all mechanical checks and the affected semantic, economic, authority, failure, journey, research, and evidence transitions; it never relies on this date as a permanent waiver.

---

## 18. Post-spec implementation assurance and hardening framework

Maturity is asserted per requirement and named product/entity/account/environment/version scope. It is not inherited from a service, tracker row, deployment, screenshot, or adjacent requirement. Evidence is immutable or reproducibly referenced, identifies the tested versions and owner, records failures and residuals, and expires or reopens when a §17.5 trigger changes its assumptions.

### 18.1 Evidence transitions

| Stage                                          | Minimum evidence required to enter                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. `SPECIFIED`                                 | Canonical PTX definition, exactly one child proof owner, complete contract/state/failure/abuse/DoD clauses, precedence, and typed owner/external sockets with safe blanks.                                                                                                                                                                      |
| 2. `CONTRACT_READY` — contract/interface ready | Versioned commands/APIs/events/schemas, canonical IDs/clocks/idempotency, compatibility/deprecation, authority and exact-money types, ledger recipe contracts where value changes, refusal/partial/unknown/correction semantics, fixtures, and producer/consumer ownership review.                                                              |
| 3. `IMPLEMENTED`                               | Service-scoped code, migrations/config/feature gate, authoritative writer and lookup/recovery path, telemetry/audit hooks, no mock or invented fallback on the claimed path, and source-to-contract traceability. Implementation alone is not verification.                                                                                     |
| 4. `LOCALLY_VERIFIED`                          | Deterministic unit/contract tests plus applicable invariant/property, model-based state-machine, fuzz, precision/rounding, migration, static/type, replay/idempotency, and negative/refusal tests on the exact implementation version.                                                                                                          |
| 5. `INTEGRATED`                                | Cross-service contract and end-to-end scenarios prove identity/authority, rule/data, order/risk, event, ledger/report, version compatibility, partial success, correction, and rollback across every claimed producer/consumer.                                                                                                                 |
| 6. `RECONCILED`                                | Ledger balance/hash/zero-sum and purpose-hold proofs; order/fill/position/risk/custody/statement agreement at named watermarks; external venue/chain/bank/custodian confirmations where applicable; finance-close treatment; and every difference resolved or case-bound.                                                                       |
| 7. `FAULT_TESTED`                              | Concurrency/race, duplicate/reorder/gap, restart/replay, unknown dispatch, dependency/store/bus/ledger partial failure, writer fencing/split brain, region loss, clock/schema mismatch, recovery, correction, and chaos evidence with safe customer/operator truth.                                                                             |
| 8. `CAPACITY_TESTED`                           | Production-shaped burst/soak and severe-market workloads across shared bottlenecks, hot symbols/L3, order/cancel/fill/liquidation/reconnect fan-out, backlog recovery and dependency quotas, measured against owner-approved envelopes/SLO categories with safe shedding and retained raw results.                                              |
| 9. `SECURITY_ABUSE_TESTED`                     | Threat model, least privilege and secrets proof, dependency/supply-chain review, fuzz/adversarial tests, credential/insider/tenant/privacy attacks, market-abuse and surveillance validation, red-team findings, remediation or explicit accepted residual, and regression evidence.                                                            |
| 10. `OPERATIONALLY_EXERCISED`                  | Versioned runbooks, monitoring/alerts/status/support, controlled release/rollback, incident command/handoff, backup/restore/DR, dependency and wind-down exercises, participant communications, reconciliation/finance close, findings and re-test in a production-shaped environment.                                                          |
| 11. `EXTERNALLY_CERTIFIED` — where required    | Applicable FIX/API/binary/drop-copy client conformance, sandbox/testnet certification, custodian/bank/venue/provider test evidence, independent security/model/audit/legal/regulatory certification, and current contracts/contacts/exit proof. `NOT_APPLICABLE` requires named authority and rationale.                                        |
| 12. `CUSTOMER_EVIDENCED`                       | Paper/shadow/testnet then owner-bounded canary evidence; customer-visible state, costs, refusals, incidents, reports/exports and reconciliation; client acknowledgement/support outcomes; claim methodology and limitations. No marketing claim outruns the evidence scope.                                                                     |
| 13. `PROVEN`                                   | Every applicable prior stage is current for the same scope/version/environment; owner and external readiness is open and evidenced; no unresolved critical money, authority, state, security, reconciliation, capacity, operational, certification, or customer-truth gap remains; and an independent reviewer signs the bounded evidence pack. |

Stages are monotonic only while their evidence remains current. A defect, incident, dependency change, expired certification, incompatible schema, owner-policy change, or scope expansion demotes the affected claim to the last still-supported stage. A stage may be `NOT_APPLICABLE` only with the owning contract, accountable authority, reason, and proof that omission cannot affect the claimed product.

### 18.2 Build and assurance sequencing

1. **Contract/event/ledger first:** establish shared exact-money types, IDs, schemas, events, recipe and reversal boundaries, state ownership, compatibility fixtures, and refusal semantics before service consumers. A contract package is not implementation.
2. **Service-scoped delivery:** each service implementation is a focused PR; shared package/schema work is its own bounded unit. A PR records the PTX/child clauses advanced and evidence produced but does not create a second implementation tracker.
3. **Local hardening:** run deterministic, property/model/fuzz, precision, negative, concurrency and replay tests before integration; preserve seeds and failure artifacts.
4. **Integrated financial proof:** exercise the whole authority-to-order-to-ledger-to-report path, balanced postings, external reconciliation, corrections and finance close before any money maturity claim.
5. **Failure and capacity proof:** inject dependency, store, bus, ledger, region, clock and external ambiguity; then run production-shaped burst/soak/severe-market loads with safety-ordered shedding and recovery.
6. **Security, abuse, and surveillance proof:** test credentials, privilege, privacy, tenant/supply-chain/provider attacks and product-specific manipulation; validate alert/case reconstruction and false-positive/false-negative limitations.
7. **Progressive environment proof:** use deterministic simulation, paper, shadow, testnet/sandbox, canary and controlled production evidence in that order where applicable. Simulation or canary scope never silently generalizes.
8. **External and operational readiness:** complete FIX/API client and provider certification, DR/incident/wind-down exercises, runbooks, staffing/contact/contract readiness, customer evidence and independent review before `PROVEN`.

The existing tracker remains the delivery map. It may link an evidence pack and its current stage, but §13 changes only when the evidence threshold above is actually met. Neither this framework nor an evidence pack is a parallel roadmap, balance book, or product source of truth.
