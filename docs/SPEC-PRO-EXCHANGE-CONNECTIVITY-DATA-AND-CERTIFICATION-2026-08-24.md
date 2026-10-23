# INTAFACED Professional Connectivity, Data, and Certification Specification

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Status:** Authoritative product contract; implementation incomplete  
**Authority:** `PX-S04`; bounded child of [`PRO_TRADER_EXCHANGE_DEFINITIVE_SCOPE.md`](../PRO_TRADER_EXCHANGE_DEFINITIVE_SCOPE.md)  
**Primary requirements:** `PTX-M05-R01–R09`, `PTX-M06-R01–R10`, `PTX-M19-R01–R07`  
**Predecessors:** `PX-S01` rule/change lifecycle, `PX-S02` participant authority, `PX-S03` order/execution lifecycle  
**Systems of record:** product/rule authority from `PX-S01`; account/key authority from `PX-S02`; order/fill authority from `PX-S03`; ledger finality only through `packages/ledger-client`; this contract owns external protocol, market-data, historical-data, sandbox, SDK, and certification semantics

---

## 1. Product promise, professional jobs, and boundary

A systematic trader, market maker, broker/OEMS, data engineer, quant researcher, or integration-support team can integrate once, determine exactly what each channel knows, recover deterministically after loss, and prove what it sent and received. This capability determines primary-venue adoption because a venue that cannot be integrated, monitored, replayed, and upgraded safely cannot be trusted with continuous professional flow.

The catastrophic failures are duplicate economic intent after retry, an apparently live but gapped book, missing fills on a private or drop-copy channel, schema drift that changes meaning without refusal, leaked or over-broad credentials, test success that does not predict production behavior, and historical data that silently rewrites the past.

M05, M06, and M19 remain one contract. Transport semantics, data semantics, and client certification share the same schemas, clocks, recovery rules, compatibility lifecycle, and proof corpus. Splitting them would allow a protocol to be certified against data or failure behavior different from production.

Non-goals:

- this contract does not define matching, order, fill, risk, liquidation, RFQ, or settlement economics;
- it does not authorize a low-latency/colocation product, licensed redistribution, live instrument, fee, rate-limit magnitude, retention period, SLO, or support commitment;
- it does not make a public feed an authority for balances, positions, orders, or money;
- it does not create an alternative ledger, OMS, terminal, surveillance store, or product SPA;
- it does not promise that sandbox instruments, liquidity, latency, or counterparties equal production outcomes.

## 2. Research delta and durable patterns

Current official sources materially add these durable requirements:

- [Binance developer documentation](https://developers.binance.com/en/docs/introduction), [depth-stream guidance](https://github.com/binance/binance-spot-api-docs/blob/master/web-socket-streams.md), and [SBE FAQ](https://github.com/binance/binance-spot-api-docs/blob/master/faqs/sbe_faq.md) reinforce a single discoverable REST/WebSocket/FIX/binary surface, subscribe-before-snapshot recovery, and explicit schema ID/version, additive/breaking classification, retirement state, and decoder compatibility.
- [Coinbase Exchange WebSocket guidance](https://docs.cdp.coinbase.com/exchange/websocket-feed/overview) and [channel definitions](https://docs.cdp.coinbase.com/exchange/websocket-feed/channels) show that TCP alone does not prove completeness; clients need per-product sequences, heartbeats, gap behavior, and a documented recovery source.
- [Coinbase Prime FIX](https://docs.cdp.coinbase.com/prime/concepts/trading/fix), [administrative messages](https://docs.cdp.coinbase.com/prime/fix-api/admin-messages), and [Exchange drop copy](https://docs.cdp.coinbase.com/exchange/fix-api/drop-copy) reinforce persistent session state, resend/gap-fill, REST reconciliation, and an independently authenticated execution stream spanning non-FIX sources.
- [Kraken FIX L3](https://docs.kraken.com/api/docs/fix-api/mdsfr-fix) reinforces order-level identifiers plus distinct event and queue-entry times; L3 is a different entitlement and privacy product, not deeper L2 by implication.
- [CME AutoCert](https://www.cmegroup.com/tools-information/webhelp/autocert-cme-stp-fix-recovery-brokertec/Content/GettingStarted.html) and [MDP schema/recovery change guidance](https://www.cmegroup.com/notices/electronic-trading/2024/12/20241230.html) reinforce executable recovery certification and staged schema migration with parallel recovery artifacts.
- [OKX API documentation](https://www.okx.com/docs-v5/en/) and [changelog](https://www.okx.com/docs-v5/log_en/) reinforce rate-limit dimensions shared across protocols, explicit sequence linkage, named demo omissions, and machine-readable change/deprecation truth.

These are pattern inputs, not copied mechanisms, legal conclusions, or permission to choose INTAFACED policy magnitudes.

## 3. Repository evidence audit

| State       | Evidence and bounded truth                                                                                                                                                                                                                                                                     |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BUILT`     | Canonical market identifiers and decimal-string normalization exist; `packages/market-data` refuses out-of-order deltas; `SequencedBookTracker` withholds desynchronized venue books; data-lake capture and configurable retention primitives exist.                                           |
| `PARTIAL`   | `svc-trade` exposes CCXT-shaped public/private REST and capability truth; `svc-ws` exposes top-N L2 snapshot/delta, trades, and authenticated private order/fill/position channels with bounded backpressure and reconnect hydration. API-key scopes and retry-safe client IDs exist unevenly. |
| `SPECIFIED` | PX-S01 owns changes/rules; PX-S02 owns keys, grants, revocation, and attribution; PX-S03 owns canonical order/fill IDs, states, idempotency, and execution recovery.                                                                                                                           |
| `SOCKET`    | Protocol versions, limits, key policies, feed catalog, checksums, correction/retention policy, sandbox parity, certification cases, SDK languages, support/SLOs, network products, and commercial entitlements require owner values.                                                           |
| `EXTERNAL`  | Network/cross-connect providers, time sources, FIX/OEMS vendors, data licensors, and client environments require contracts and evidence.                                                                                                                                                       |
| `ABSENT`    | No production institutional FIX gateway, FIX market data, independent drop copy, binary/SBE-like public feed, complete L3 product, parity sandbox, public certification program, stable dictionaries/schema registry, or supported SDK lifecycle was found.                                    |

The current JSON depth path is sequenced but not checksummed, durable-replayable, or full-depth. Its poller and top-N snapshot repair are valid bounded implementation evidence, not proof of M05/M06 completion. The private WebSocket is a participant convenience stream, not independent drop copy: it shares source dependencies, does not yet prove all execution origins, and lacks a certified replay completeness contract.

## 4. Actors, accounts, and trust boundaries

- A **participant organization** owns legal accounts and may administer integrations only through PX-S02 grants.
- A **session principal** is the authenticated key, user, service, or FIX session; it never replaces the legal owner/account/sub-account on a command.
- A **market-data consumer** receives only its entitled products, levels, fields, venues, and uses. Public access is an explicit entitlement class, not an absence of policy.
- A **drop-copy consumer** is read-only and independently credentialed; possession cannot place, cancel, transfer, or move value.
- A **certification identity** is isolated from production authority and records organization, software/version, protocol/session profile, environment, and evidence.
- Operators may suspend or reduce scope under PX-S01/PX-S02 authority. They cannot fabricate sequence continuity, rewrite captures, impersonate participants, or widen entitlements silently.

Every private request and event carries legal owner, account, sub-account where applicable, actor, principal/key/session, authority/grant, source protocol, client ID/idempotency root, correlation/causation IDs, and server request/event ID. Broker and client fields remain distinct. One organization's connection, replay cursor, or rate bucket cannot reveal or block another except through a disclosed shared capacity class.

## 5. Canonical identifiers, values, clocks, and versions

All protocols map to canonical IDs rather than inventing protocol-local identity: `instrumentId`, `marketId`, `accountId`, `subAccountId`, `orderId`, `clientOrderId`, `parentOrderId`, `executionId`, `tradeId`, `sessionId`, `requestId`, `eventId`, `captureId`, and `correctionId`. Venue symbols and FIX tags are aliases with explicit mapping versions.

Prices, quantities, notionals, fees, rates, Greeks, and other exact decimal values cross boundaries as decimal strings and use scaled bigint or an approved exact-decimal representation in memory. JSON/FIX/binary adapters reject unsafe numeric coercion. Integer sequences and timestamps may use integer encodings only within published ranges; epoch units are named.

Each message or response identifies, where applicable:

- protocol/API version and schema name, ID, and version;
- source system and source sequence/domain;
- event/effective, venue-received, engine-accepted, generated, observed, published, and corrected times as distinct fields;
- clock source/quality and offset uncertainty when material;
- rule, instrument, fee, risk, and entitlement versions consumed rather than embedding unversioned copies;
- replay/live indicator, correction chain, and freshness/degradation state.

No consumer may infer ordering across different declared sequence domains from wall-clock time. Timestamp correction appends a correction; it never mutates an accepted historical record invisibly.

## 6. Common protocol contract

REST, public/private WebSocket, FIX, drop copy, binary feeds, capture files, and SDKs are projections of common versioned domain contracts. For every operation/channel the catalog publishes authentication, authorization, request/response or message schema, ordering domain, delivery guarantee, idempotency, pagination/replay cursor, rate dimension, error taxonomy, availability, and authoritative recovery source.

Common invariants:

1. Unknown required versions, enums, message types, or semantics refuse; additive optional fields may be ignored only where the compatibility policy says so.
2. Transport acknowledgement is separate from command acceptance, engine state, execution, ledger posting, and settlement finality.
3. At-least-once delivery is deduplicated by stable IDs; a reconnect never turns redelivery into a second economic action.
4. Pagination/cursors are stable against concurrent writes and declare snapshot or live semantics. Missing/expired cursors return typed recovery instructions.
5. Bulk calls return one outcome per item plus batch correlation; partial success is never flattened.
6. Errors distinguish authentication, authorization, entitlement, validation, conflict, duplicate, rate/capacity, stale state, unavailable dependency, unknown outcome, and unsupported capability, with retryability and request ID.
7. A health response or open socket does not imply that every channel is live. Each stream exposes its own source, last-good update, sequence health, entitlement, and degradation.

## 7. Authentication, entitlements, keys, and networks

PX-S02 owns identity, scopes, grants, compromise, rotation, and revocation. This contract requires each protocol to enforce them consistently.

API keys and FIX/session credentials bind organization, legal account, permitted sub-accounts, product/market scope, read/trade capability, environment, protocol, network/IP allowlist where approved, issue/expiry/rotation state, creator/approver provenance, and last-use evidence. Secret material is shown only at issuance, never logged, included in URLs, captures, examples, or support bundles. Rotation permits an auditable overlap only under owner policy; emergency revocation propagates to new requests and active private sessions within an owner-set bound and reports incomplete propagation.

Market-data entitlements bind level, product, fields, latency class, use, redistribution, environment, and effective interval. Loss or expiry produces an explicit entitlement state, closes or redacts the affected stream, and never substitutes delayed/partial data as live full data.

Internet access is the baseline product. Redundant endpoints, approved low-latency networks, cloud proximity, private circuits, or colocation are separate owner/commercial/external sockets with topology, failover, maintenance, capacity, time-sync, security, fair-access, and exit terms. No proximity or latency claim is made from deployment location alone.

## 8. Client IDs, idempotency, sequencing, and concurrency

Every risk-increasing or money-affecting command requires a client-generated idempotency key or protocol-equivalent. The contract publishes its uniqueness domain, accepted format, retention socket, payload-collision behavior, terminal lookup, and behavior after expiry. Same key plus same canonical payload returns the original outcome; same key plus different payload refuses. A timeout is `UNKNOWN`, never permission to resubmit under a new key before lookup/reconciliation.

`clientOrderId` has an explicit organization/account/session uniqueness domain and lifecycle. It never replaces the immutable venue `orderId`. Amend/cancel identifies both the target and new command; parent/child and hedge orders retain causal roots from PX-S03. Reused IDs outside the supported retention horizon return a typed ambiguity/refusal where prior outcome cannot be proven.

Sequence domains are named and monotonic within their contract, reset only through a versioned session/epoch transition. Consumers detect gaps, duplicates, overlap, stale frames, and epoch changes. Recovery is subscribe/buffer/snapshot/replay in the documented order; no component synthesizes venue continuity for an unsequenced source.

## 9. REST and WebSocket surfaces

REST provides authoritative snapshots, command submission/lookup, reconciliation queries, reference data, historical pagination, current limits, entitlements, and capability discovery. Signed requests bind method, canonical path/query/body hash, timestamp/nonce, credential, and environment. Clock-skew refusal reports server time without weakening replay protection.

Public WebSocket provides only published market/reference channels. Private WebSocket provides participant-scoped order, execution, position, balance/risk, RFQ, transfer, and notification projections as their owning specs enable them. Subscription acknowledgements enumerate accepted/refused channels and effective entitlements. Heartbeat/liveness, server drain/restart, token expiry, reauthentication, reconnect backoff, subscription restoration, and per-channel recovery are explicit.

Backpressure is bounded. A slow consumer is warned, degraded, resnapshotted where safe, or disconnected; messages are never silently queued without bound. If a lossy channel drops data, the next message proves a gap and names recovery. Compression/batching/conflation never changes economic meaning and is declared per channel.

## 10. FIX order entry, market data, and session recovery

FIX is a first-class projection of PX-S03, not a semantically weaker alternate exchange. Published dictionaries identify FIX version, service pack/extensions, message/tag constraints, supported order capabilities, venue reject codes, and canonical-field mappings. Unsupported intent refuses; it is never weakened to a simpler order silently.

Each order-entry, market-data, and drop-copy session has a separately authorized identity and sequence state:

`DISCONNECTED → LOGON_PENDING → ACTIVE → LOGOUT_PENDING → DISCONNECTED`

Any gap/recovery condition adds `RECOVERY_REQUIRED`; an administrative suspension adds `SUSPENDED`. Logon negotiates versions, heartbeat, sequence/reset policy, sender/target identity, environment, and permissions. Reset is never accepted merely because a peer requested it; it follows the certified owner policy and preserves reconciliation evidence.

Inbound and outbound sequence numbers, persisted message journals, heartbeats/test requests, poss-dup/poss-resend, sequence reset/gap-fill, resend range, session schedule, duplicate business-message handling, and logout cause are specified and tested. Administrative gap fill cannot conceal a business message that must be recovered. After reconnect the client reconciles open orders and terminal outcomes from an authoritative query before creating replacement intent.

FIX market data states subscription, snapshot/full-refresh, incremental refresh, security definition/status, trading session, sequence, fragmentation, conflation, gap/recovery, and unsubscribe behavior. It shares canonical instrument and market-data semantics with §§12–14.

## 11. Independent drop copy

Drop copy is an independent read-only execution evidence plane. It covers every execution and execution correction from UI, REST, private WebSocket, FIX, native/synthetic algo children, liquidation, RFQ/block, broker/DMA, operator-authorized correction, and future approved sources. It includes account/sub-account, actor/source protocol, parent/child/hedge causality, order and execution IDs, venue/location, liquidity role when authoritative, price/quantity/fee decimal strings, rule/fee versions, event/receive/publish times, settlement linkage, and bust/correct chain.

The stream has independent credentials, session state, sequencing, persistence, replay, completeness watermarks, and reconciliation queries. Failure of an order-entry session must not suppress its drop copy; common upstream failure is declared rather than hidden. Consumers can prove a closed interval complete or obtain the exact missing range. Corrections append and link; they do not replace the original execution.

Drop copy is not ledger finality, a balance feed, or an execution command surface. PX-S12 reconciliation compares its execution evidence with orders, ledger postings, custody/settlement, and statements.

## 12. Market-data products and semantics

The catalog distinguishes:

- L1 BBO and last/indicative state;
- L2 market-by-price at a declared depth/window;
- L3 market-by-order where policy, privacy, and licensing permit it;
- trades, auctions/imbalances, liquidations, block/RFQ disclosures, indices/marks, funding/OI, reference/security status, and derivative/volatility analytics;
- native executable, implied executable, synthetic/non-executable, delayed, indicative, modelled, and corrected data.

Each feed declares source, venue/market, level, depth, price aggregation, priority visibility, sequence domain, snapshot/delta model, checksum algorithm/version and coverage, batching/conflation, timestamps, heartbeat, freshness policy, correction policy, and recovery endpoint. A checksum mismatch, gap, crossed/impossible state, invalid decimal, unknown instrument mapping, stale source, or clock anomaly makes the affected view `UNSERVABLE` until repaired. Last-good data may be displayed only with age and non-actionable degradation; routers/risk use it only under their own explicit safe policy.

L3 order identifiers are feed identifiers with disclosed stability and privacy, not participant identity. Queue-position and fill-probability products state venue model, data level, assumptions, exclusions, uncertainty, and version. L2 cannot be presented as observed queue position, and model estimates cannot be presented as venue truth.

## 13. Reference, trade, derivatives, and correction data

Reference data provides canonical instruments, aliases, increments, status/session, rule version, supported order capabilities, fee/tier schedule references, limits, collateral/haircuts, indices/constituents, marks, funding, OI, expiries, settlement method/status, and effective intervals as supplied by owning specs. Unknown owner values remain null/unavailable and cannot be defaulted.

Trade records distinguish continuous/auction, aggressor when authoritative, liquidation, block/RFQ disclosure class, execution venue, correction, and bust. A missing aggressor is `unknown`, never inferred from price. Aggregates and candles identify source trades, interval convention, late-trade/correction behavior, completeness, and empty intervals; no-trade is not a zero-price trade.

Derivative data adds term structure, basis, funding history, liquidation history, OI, IV/Greeks/surface, exercise/assignment, fixing, and settlement history only as their product specs authorize. Computed values carry model/input/version/freshness and cannot impersonate exchange-native observations.

Corrections are append-only with original ID, correcting ID, reason class, authority, effective/published times, affected products/ranges, and replacement/reversal linkage. Live feeds and historical files converge on the same correction state while retaining both versions.

## 14. Historical data, capture, replay, and provenance

Download and replay products partition by dataset, instrument, date/sequence interval, schema, and correction edition. A manifest records source, capture location/version, first/last sequence and event time, message/record counts, gaps, duplicates, clock quality, checksum/digest, transformations, entitlement/license, known incidents, corrections, and generation time.

Raw capture, normalized canonical data, aggregates, and simulated/backtest datasets remain distinct. Normalization records adapter and instrument-mapping versions. Reprocessing produces a new edition with lineage; it never overwrites an edition already cited by a client or audit.

Replay preserves original order, timing metadata, gaps, duplicates, corrections, and schema version, with optional explicitly modelled timing. It cannot silently clean the data. Capture/replay tools validate checksum and sequence, redact secrets/private identifiers according to policy, and can reproduce certification failures.

Backtest/simulation datasets disclose survivorship, listings/delistings, corporate/product changes, fee/funding assumptions, book depth, latency/queue model, liquidation/block/RFQ inclusion, corrections, gaps, and known limitations. Results identify exact dataset edition and simulator version.

## 15. Rate limits and capacity truth

Rate policy is versioned and discoverable by credential, organization/account, endpoint/message, protocol/session, IP/network, market-data channel, and any shared bucket. Responses/messages expose applicable bucket, weight/cost, remaining capacity where safe, reset/retry semantics, and request ID. REST and WebSocket/FIX limits that share a resource say so.

Institutional tiers, fill-ratio or order-to-trade controls, burst/steady windows, connection/subscription ceilings, mass-cancel exemptions, and severe-market changes are owner-set. Equivalent participants receive rule-governed treatment; affiliate/house traffic cannot receive hidden priority or bypass. Missing policy refuses the affected privileged tier and makes no capacity claim.

Throttling distinguishes delayed, refused, disconnected, and administratively suspended outcomes. Risk-reducing cancellation and PX-S03 kill paths receive a separately governed capacity class but never bypass authentication or market-state law. Metrics cover requests/messages/bytes, rejects, queue delay, lag, slow consumers, gaps/resyncs, session recovery, entitlement checks, and headroom by dependency.

## 16. Versioning, schema compatibility, and change lifecycle

The contract registry publishes current, preview, deprecated, and retired API/FIX/binary/event schemas plus semantic diffs. Changes are classified as additive-compatible, behaviorally material, or breaking. Field addition is compatible only where unknown-field behavior is documented; enum addition, nullability, precision, units, ordering, default, identifier, or state-transition changes may be breaking even if syntax parses.

Every change has proposal/decision authority under PX-S01, affected protocols/products, test fixtures, sandbox availability, notice and deprecation sockets, migration guide, rollback/parallel-run plan, telemetry, and removal criteria. Machine-consumable changelog/status feeds carry stable change IDs and effective intervals. Retired versions refuse explicitly; servers never reinterpret an old version as new.

Binary schemas include schema ID/version, template/message IDs, encodings, null/sentinel rules, decimal representation, bounds, extension rules, compatibility matrix, reference decoder, golden payloads, capture header, and retirement state. FIX dictionaries and JSON/OpenAPI/event schemas are released from the same canonical change record.

## 17. Sandbox, simulation, and certification

Sandbox/testnet is an isolated environment with separate credentials, accounts, URLs, data, and unmistakable visual/wire markers. It publishes a parity matrix for contracts, auth, sequencing, idempotency, error codes, rate-limit logic, risk states, market states, instrument features, versions, and known omissions. Production data or credentials never cross by accident. Synthetic liquidity and fills are labelled and cannot become commercial or performance claims.

Failure controls support deterministic disconnect, sequence gap/duplicate/out-of-order, stale snapshot, checksum mismatch, burst traffic, slow consumer, session reset/resend, duplicate command, timeout/unknown outcome, partial bulk success, risk reject, halt/auction, mass cancel, dependency outage, clock skew, schema preview/retirement, correction/bust, and recovery. Each run records seed/scenario/version and expected invariant.

Certification state is:

`NOT_STARTED → IN_PROGRESS → PASSED → ACTIVE → EXPIRED | REVOKED`

Failure returns `IN_PROGRESS` with failed cases; no partial protocol approval is implied. Certification binds organization, software/version, protocol/session profile, environment, approved capabilities, evidence, approver, effective interval, and required recertification triggers. Material schema/session/recovery behavior, security incident, or client version change triggers scoped review under owner policy.

FIX/API certification proves logon/logout, heartbeats, sequence/resend/gap-fill, duplicate and idempotency collision, reconnect/open-order reconciliation, order lifecycle/rejects, mass cancel/kill, private/drop-copy completeness, market-data snapshot/gap/checksum/replay, rate behavior, clock handling, degraded states, and safe recovery. Passing proves only the tested profile, not production capacity or financial suitability.

## 18. SDKs, reference tooling, diagnostics, and support

Priority languages and support levels are owner-set. Each supported SDK/connector is generated from or contract-tested against canonical schemas, pins compatible protocol versions, preserves decimal strings/exact values, exposes raw IDs/timestamps/errors, implements safe retry and recovery without hiding state, and publishes version/support/security policy. A convenience wrapper cannot silently round, retry non-idempotent intent, resubscribe without recovery, or convert unknown to empty/zero.

Runnable assets include OpenAPI/Postman where applicable, FIX dictionaries/session samples, binary schemas/reference decoders, WebSocket book builders, drop-copy reconciler, capture/replay verifier, sandbox scenarios, and golden messages. Secrets are placeholders and examples refuse production endpoints unless deliberately configured.

Client diagnostics expose request/correlation ID, protocol/session and sequence state, client-send/gateway-receive/engine/publish times where available, clock offset, rate bucket, entitlement decision ID, reject taxonomy, disconnect cause, source/dependency health, schema/version, and status-incident linkage. Export bundles are scoped, redacted, signed/digested, and consented.

Support escalation and status/release calendars are machine-consumable and identify affected environment, protocol, region/endpoint, product/channel, start/update/recovery time, participant action, and correction/reconciliation status. Commitments and response times remain owner sockets.

## 19. Security, privacy, licensing, integrity, and conflicts

- Authentication is replay-resistant; TLS/network requirements, credential algorithms, nonce/clock windows, and rotation are versioned security policy.
- Public/private/drop-copy/FIX/certification planes are isolated by credential and least privilege. Read access never implies trade or money authority.
- Logs, metrics, captures, test fixtures, and support bundles redact secrets and minimize participant/order-level data. Access and export are audited.
- L3, drop copy, client diagnostics, and historical datasets obey entitlement, licensing, redistribution, retention, deletion-hold, jurisdiction, and privacy decisions. Absent terms mean no redistribution/export grant.
- Surveillance can correlate key/session, order traffic, cancels, fills, data consumption, gaps, throttles, operator changes, and affiliate/house activity without giving surveillance a trading credential.
- Internal/affiliate clients use declared tiers and feeds; hidden latency, rate, data, recovery, or certification advantage is prohibited. Testing channels never leak future participant orders or rule changes.
- Abuse controls cover credential stuffing, signing replay, subscription churn, slow-consumer/resource exhaustion, malformed binary/FIX, identifier probing, data scraping/redistribution, and testnet-to-production confusion.

## 20. Degraded states, recovery, operations, and incident truth

Each surface reports `LIVE`, `DEGRADED`, `RECOVERY_REQUIRED`, `SUSPENDED`, or `UNAVAILABLE` at the smallest honest scope. Reasons include source/sequence/checksum, freshness, clock, entitlement, capacity, schema, dependency, maintenance, and operator action. `LIVE` requires the channel's declared evidence, not merely TCP connectivity.

On restart or failover, private/FIX/drop-copy state restores persisted session and replay metadata, reconciles authoritative snapshots, and declares any unprovable interval. Public data consumers resnapshot/replay according to feed contract. Open commands with unknown outcomes are looked up; they are not recreated. Historical capture closes incomplete partitions with a manifest rather than presenting them as complete.

Observability and owner-set SLO categories cover availability, latency percentiles by protocol stage, message/request capacity, sequence gaps/resync time, checksum failures, replay lag/completeness, drop-copy delay, rate-limit headroom, auth/entitlement propagation, schema adoption, sandbox parity, certification success, SDK conformance, historical publication/correction, and support/status timeliness.

Fault/load proof covers dense books, burst trades/fills, mass quote/cancel, liquidation and auction bursts, slow consumers, reconnect storms, regional/endpoint and dependency loss, packet loss/reordering, clock fault, credential revocation, schema rollout/rollback, capture storage failure, and long sessions. PX-S13 owns venue-wide resilience/incident command; this contract supplies per-protocol behavior and evidence.

## 21. Migration, rollout, rollback, suspension, and wind-down

Rollout progresses through offline fixtures, sandbox, certification, shadow/dual decode, opt-in preview, bounded production, and explicit expansion. A new protocol never becomes authoritative before it reconciles with owning order/data systems. Parallel versions use distinct identifiers and telemetry; downgrade is permitted only where meaning remains representable.

Rollback restores the prior supported version for new traffic while retaining the schema/version actually used by historical requests and messages. Unknown outcomes, sequence intervals, capture partitions, and corrections are reconciled before declaring recovery. Suspension states the affected session/channel/version, open-order behavior, cancellation/reconciliation path, and customer action.

Decommission inventories active credentials, sessions, clients, open orders, replay dependencies, entitlements, captures, datasets, certificates, and support obligations. It provides export/reconciliation and a refuse-closed cutoff, revokes credentials, preserves required records, and does not delete schemas or decoders needed to interpret retained evidence. External network/data-provider exit has a tested fallback or declares the product unavailable; it never silently substitutes a different source.

## 22. Definition of Done

PX-S04 is implementation-complete only when evidence proves:

1. all enabled REST/WebSocket operations are versioned, contract-complete, and reconcile across products;
2. keys, sessions, scopes, account/sub-account bounds, networks, rotation, expiry, and revocation pass adversarial tests;
3. idempotency/client-ID collision, timeout, retry, lookup, and retention behavior cannot duplicate economic intent;
4. FIX order entry and market data pass persistent sequencing, resend/gap-fill, duplicate, recovery, and dictionary conformance;
5. independent drop copy covers every enabled execution origin and proves complete intervals plus corrections;
6. binary feeds pass schema/version/decoder/golden-payload and compatible migration tests;
7. every enabled L1/L2/L3/trade/reference/derivative feed proves snapshot/delta, gap, checksum, replay, timestamp, freshness, and correction semantics;
8. queue/fill estimates and synthetic/indicative/modelled data cannot be mistaken for observed executable truth;
9. historical manifests prove provenance, completeness, lineage, corrections, reproducibility, entitlement, and digest;
10. rate/capacity behavior is discoverable, fair, observable, and safe during bursts and cancel/liquidation storms;
11. sandbox parity and every named failure scenario are automated and unmistakably isolated from production;
12. certification evidence binds the exact organization, client version, session profile, capabilities, and effective state;
13. supported SDKs/tools preserve decimals, IDs, errors, recovery, and version compatibility under contract tests;
14. changelog/status/deprecation/release/support artifacts are machine-consumable and exercise rollback/removal;
15. privacy, licensing, redistribution, retention, surveillance, redaction, and affiliate-conflict controls pass proof;
16. restart, reconnect, region/dependency loss, schema change, and capture failure produce honest scoped degradation and deterministic recovery;
17. PX-S01/PX-S02/PX-S03/PX-S12/PX-S13 consumer conformance passes for every enabled capability.

A completed specification, SDK example, or green tracker row is not implementation proof.

### 22.1 Requirement proof map

| Requirement   | Contract closure                                                                            | Required implementation evidence                                               |
| ------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `PTX-M05-R01` | §§6–9 define common versioned REST/public-private WebSocket semantics                       | Cross-product schema, auth, idempotency, recovery, and conformance suite       |
| `PTX-M05-R02` | §10 defines FIX order/market-data sessions, dictionaries, sequence and recovery             | Certified persistent session, resend/gap-fill, duplicate, and reconcile corpus |
| `PTX-M05-R03` | §11 defines independent all-source drop copy and correction completeness                    | Source matrix, interval watermark, replay, and reconciliation evidence         |
| `PTX-M05-R04` | §§12 and 16 define binary feed schemas, entitlements, capture, compatibility and decoders   | Golden payload, multi-version decoder, load, capture, and migration proof      |
| `PTX-M05-R05` | §15 defines dimensioned limits, weights, headroom, retry, tiers and fair capacity           | Cross-protocol enforcement, disclosure, storm, and affiliate-equivalence tests |
| `PTX-M05-R06` | §7 binds keys to scope/account/product/network/lifecycle/provenance                         | Issue, least-privilege, rotation, expiry, compromise, and revocation evidence  |
| `PTX-M05-R07` | §8 defines uniqueness, retention, collision, replay and terminal lookup                     | Crash/timeout/concurrent duplicate and expired-key ambiguity fixtures          |
| `PTX-M05-R08` | §16 defines registry, semantic diff, notice, migration and retirement                       | Machine-readable lifecycle and staged breaking-change exercise                 |
| `PTX-M05-R09` | §7 defines internet/redundant/low-latency network products and time guidance                | Approved topology, fair-access, failover, capacity, timing, and exit proof     |
| `PTX-M06-R01` | §12 defines L1/L2/L3 sequence/checksum/snapshot/delta/gap/replay/correction/time/conflation | Per-feed book reconstruction, fault injection, checksum and recovery corpus    |
| `PTX-M06-R02` | §13 defines trade provenance, aggressor, auction/liquidation/block, correction and bust     | Source/correction coverage and non-inference tests                             |
| `PTX-M06-R03` | §13 defines complete effective-dated reference-data projections                             | Owning-spec parity, null/refusal, change, and historical reconstruction proof  |
| `PTX-M06-R04` | §13 defines derivative term, risk, volatility, liquidation and settlement data              | Product-spec truth, model provenance, correction, and completeness evidence    |
| `PTX-M06-R05` | §14 defines downloadable historical manifests, lineage and reproducible editions            | Gap/duplicate/correction/digest audit plus independent replay                  |
| `PTX-M06-R06` | §12 forbids L2 queue claims and versions L3-derived estimates                               | Data-level entitlement, uncertainty, calibration, and adverse-book tests       |
| `PTX-M06-R07` | §§7, 14 and 19 define use, redistribution, retention, privacy and commercial sockets        | Entitlement enforcement, licensed export, expiry, and deletion-hold evidence   |
| `PTX-M06-R08` | §5 mandates canonical IDs/timestamps and versioned alias mapping                            | Adapter/consumer cross-venue identity and no-reinterpretation fixtures         |
| `PTX-M06-R09` | §§12–13 label executable, implied, synthetic, indicative and reference prices               | Cross-surface labeling and negative routing/risk-consumption tests             |
| `PTX-M06-R10` | §§6 and 20 define per-stream source/freshness/entitlement/sequence/clock truth              | Independent channel-failure, stale, revocation and reconnect UI/API proof      |
| `PTX-M19-R01` | §17 defines isolated parity matrix and deterministic failure simulation                     | Production-schema parity audit and complete scenario corpus                    |
| `PTX-M19-R02` | §18 defines generated/contract-tested SDK lifecycle and decimal safety                      | Supported-version matrix, language conformance, security and retirement proof  |
| `PTX-M19-R03` | §17 defines scoped FIX/API certification and recertification                                | Executed sequence/recovery/duplicate/disconnect/kill/risk/clock evidence       |
| `PTX-M19-R04` | §§14, 16 and 18 define runnable schemas, examples, decoders and capture/replay              | Clean-environment execution and golden-fixture validation                      |
| `PTX-M19-R05` | §18 defines request, timing, reject, limit, disconnect and incident diagnostics             | Redacted cross-system trace and support-bundle exercises                       |
| `PTX-M19-R06` | §§16, 18 and 20 define machine-consumable status/change/release/support lifecycle           | Notification, incident, migration, escalation and removal drills               |
| `PTX-M19-R07` | §14 defines reproducible backtest datasets and limitation disclosures                       | Edition-pinned reproduction, survivorship/correction/fee/funding/latency audit |

## 23. Owner and external sockets

| Socket       | Required authority/input                                                                        | Refuse-closed behavior while absent                                  |
| ------------ | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `PX-S04-O01` | Supported protocol/API versions, operations, channels, and product coverage                     | Unpublished capability is unsupported                                |
| `PX-S04-O02` | FIX versions, dictionaries, sessions, schedules, reset/resend and certification policy          | No production FIX session                                            |
| `PX-S04-O03` | Drop-copy audience, scope, retention, replay and correction commitments                         | No production completeness claim                                     |
| `PX-S04-O04` | Binary schema/encoding, feed catalog, migration and retirement policy                           | No production binary feed                                            |
| `PX-S04-O05` | Rate, connection, subscription, message, fill-ratio and institutional tier policy               | No privileged tier; conservative published baseline only if approved |
| `PX-S04-O06` | Key expiry/rotation/revocation, network allowlist and idempotency retention policy              | Affected privileged credential/ambiguous retry refuses               |
| `PX-S04-O07` | Feed levels/depth, checksum, replay, freshness, correction and conflation policy                | Affected feed is unavailable or explicitly degraded                  |
| `PX-S04-O08` | Data licensing, redistribution, privacy, retention and commercial terms                         | No redistribution/export grant                                       |
| `PX-S04-O09` | Network/colocation products, fair access, capacity, time-sync and maintenance terms             | Internet access only; no latency claim                               |
| `PX-S04-O10` | Sandbox parity, instruments/data, scenario catalog and separation policy                        | No production-readiness claim from sandbox                           |
| `PX-S04-O11` | Supported SDK languages, lifecycle, certification validity/triggers and support/SLO commitments | Community/experimental assets are labelled unsupported               |
| `PX-S04-X01` | Network, cross-connect, DNS/TLS, time-source and regional endpoint providers                    | Affected path unavailable; no silent topology substitution           |
| `PX-S04-X02` | Market/reference data licensors and redistribution permissions                                  | Unlicensed dataset/channel unavailable                               |
| `PX-S04-X03` | OEMS/FIX clients and certification environments                                                 | No client/profile certification claim                                |
| `PX-S04-X04` | Status/notification/support delivery providers                                                  | Delivery is unknown/failed and shown as such                         |

## 24. Cross-spec dependencies and contradiction register

- **PX-S01:** owns rules, market/instrument states, public change authority, emergency suspension, corrections, records, and dispute evidence. A protocol version cannot bypass its effective state.
- **PX-S02:** owns organization/account/sub-account, actor, grants, credentials, revocation, dual control, and privacy authority. A connection is not a new principal or legal owner.
- **PX-S03:** owns order/fill state, idempotent economic intent, execution provenance, recovery, cancel/kill semantics, and SOR/OMS foundations. Protocol adapters cannot weaken or redefine those semantics.
- **PX-S05:** consumes these streams, freshness, diagnostics, and replay in the terminal/OMS/TCA; it must not infer global health from one socket.
- **PX-S06/PX-S07/PX-S08/PX-S09/PX-S10:** own risk and product economics projected through data/reference channels. PX-S04 carries versioned truth but chooses no leverage, fee, payoff, settlement, or liquidity policy.
- **PX-S11/PX-S12:** own reporting, ledger/custody reconciliation, statement finality, and wind-down. Drop copy is execution evidence, never a second money book.
- **PX-S13:** owns venue-wide capacity, recovery and incident command; PX-S04 supplies protocol-specific states, fault cases, SLO categories, and customer-visible diagnostics.
- **PX-S14:** owns external venue/on-chain execution and adapters. Normalization preserves source identity and cannot invent sequence, finality, or entitlement.
- **PX-S15/PX-S16:** automated and agentic callers use the same credentials, limits, idempotency, order/risk/ledger authority, revocation, audit, and kill paths as manual clients.

Resolved contradictions and explicit gaps:

1. Existing `svc-ws` documentation calls its depth stream “live” while readiness may remain green with trade/private buses detached. This contract resolves the product meaning: liveness is per stream; connection/process health alone is never full-channel health.
2. Existing top-N snapshot/delta sequencing is real and safe within its bounded design, but it has no checksum, durable client replay, L3, full correction, or contractual version lifecycle. It remains `PARTIAL`, not a complete professional feed.
3. Existing private WebSocket order/fill/position fan-out is not independent drop copy and may honestly lack a source or hydration. It cannot satisfy `PTX-M05-R03` until all-source persistence, replay, interval completeness, and correction proofs exist.
4. CCXT-shaped REST capability discovery is useful compatibility evidence, not a complete versioned institutional API, SDK lifecycle, or certification program.
5. Data-lake capture and retention code proves internal primitives, not a licensed downloadable historical product or immutable edition/completeness contract.
6. Current auth scopes and retry-safe IDs are uneven slices. This contract requires consistent protocol/account/product/network boundaries without claiming they are already implemented.
7. No FIX, binary feed, parity sandbox, or public certification implementation was found. Their contracts are authoritative here; implementation evidence remains absent until those products are built and proven.
