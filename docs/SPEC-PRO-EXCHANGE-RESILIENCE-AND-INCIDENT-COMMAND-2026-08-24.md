# INTAFACED Resilience, Capacity, Recovery, and Incident Command Specification

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Status:** Authoritative product contract; implementation incomplete

**Authority:** `PX-S13`; bounded child of [`PRO_TRADER_EXCHANGE_DEFINITIVE_SCOPE.md`](../PRO_TRADER_EXCHANGE_DEFINITIVE_SCOPE.md)

**Primary requirements:** `PTX-M18-R01–R08`

**Predecessors:** `PX-S01` rule/emergency authority, `PX-S02` operator authority and security, `PX-S03` order/matching recovery, `PX-S04` protocol/data recovery, `PX-S06` risk/liquidation/default, `PX-S12` custody/reconciliation/wind-down

**Systems of record:** each domain retains its existing SoR; `packages/ledger-client` plus `svc-ledger` remain the only money book; this contract owns service criticality, dependency/blast-radius, continuity, capacity, recovery-proof, maintenance, and incident-command semantics

---

## 1. Product promise, professional jobs, and boundary

Exchange operators, incident commanders, on-call engineering, risk/treasury/custody operations, surveillance/compliance, brokers, professional traders, and auditors can know what is impaired, contain it without widening harm, preserve risk-reducing exits, recover each authoritative state exactly once, and prove the result. This determines primary-venue adoption because severe markets are when professional users most need an exchange; a venue whose capacity or truth disappears with volatility is not a dependable venue.

The catastrophic failures are two regions or processes accepting conflicting writes, duplicate money or execution after replay, overload cascading from one dependency into the venue, cancel or liquidation storms starving safe exits, a restore that loses or invents state, a green status masking an unusable surface, and uncoordinated responders changing production without one command record.

M18 remains one contract. SLOs, dependency behavior, single-writer recovery, backup/restore, capacity, maintenance, runbooks, and incident command use one critical-service map and one retained evidence model. Splitting them would allow availability claims without recovery proof or incident declarations without authoritative state reconciliation.

Non-goals:

- this contract supplies no live SLO, error budget, RTO, RPO, capacity, staffing, maintenance, notification, retention, or compensation magnitude;
- it does not select regions, clouds, databases, counterparties, status vendors, or legal notification regimes;
- it does not create a global “halt all” that traps cancellation, repayment, collateral addition, withdrawal reversal, or other safe release paths;
- it does not move, reconstruct, or correct value outside `packages/ledger-client` and the existing ledger authority;
- it does not claim active/active, multi-region, production backup, public status, or venue-wide exercises already exist.

## 2. Research delta and durable patterns

Current official sources materially add these durable requirements:

- The [CFTC 24/7 trading advisory 26-16](https://www.cftc.gov/csl/26-16/download) emphasizes continuous monitoring, scalable capacity under varying and off-peak load, elimination of single points of failure, redundant/parallel production paths, live cutover/back-out, third-party readiness, and staffing across operations, risk, compliance, and surveillance. It is an advisory, not a legal applicability decision for INTAFACED.
- [SEC Regulation SCI guidance](https://www.sec.gov/rules-regulations/staff-guidance/trading-markets-frequently-asked-questions/responses-frequently-asked-questions-concerning-regulation-sci) reinforces functional and performance testing of BC/DR plans with designated participants and coordinated industry testing; an internal infrastructure switch alone is not continuity proof.
- [CFTC system-safeguards rules](https://www.cftc.gov/LawRegulation/FederalRegister/finalrules/2016-22174.html) reinforce objective controls, capacity, cyber, incident-response, and BC/DR testing with documented findings, risk analysis, remediation or explicit acceptance, and independent review where applicable.
- [Google SRE incident management](https://sre.google/sre-book/managing-incidents/) reinforces separate incident-command, operations, communications, and planning roles, one live state record, explicit handoff, controlled production changes, and retained post-incident evidence.
- [Google SRE cascading-failure guidance](https://sre.google/sre-book/addressing-cascading-failures/) reinforces load shedding before saturation, retry and queue bounds, and proving that failover does not overload surviving capacity.
- [CME 2026 participant DR exercise](https://www.cmegroup.com/notices/ebs/2026/07/20260713.html) reinforces registered participant testing against DR gateways and match engines using executable scripts; recovery is an end-to-end market-access exercise, not merely a database restore.

These are resilience patterns, not copied mechanisms, invented thresholds, or legal conclusions.

## 3. Repository evidence audit

| State       | Evidence and bounded truth                                                                                                                                                                                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BUILT`     | Matching has a deterministic append journal, replay, corrupt-middle refusal, truncated-tail recovery, and reconcile reports. Ledger has serialized posting, hash-chain/balance/zero-sum reconciliation, durable freeze, and operator status. Kill controls preserve named release paths.                                    |
| `PARTIAL`   | Edge and matching metrics, health/readiness probes, service telemetry, WebSocket backpressure, dependency-specific honesty, spot route chaos tests, futures concurrency/liquidation fixtures, and service runbooks exist. One throwaway ledger-schema dump/restore drill ran with important proof and production/PITR gaps. |
| `SPECIFIED` | PX-S01 owns emergency/rule states; PX-S03/PX-S04/PX-S06/PX-S12 define deterministic recovery and degraded behavior for orders, feeds, risk, ledger/custody, corrections, and wind-down.                                                                                                                                     |
| `SOCKET`    | Service-tier SLOs/error budgets, RTO/RPO, capacity envelopes, regions/topology, backup/retention, incident severity/notice, staffing, maintenance windows, and external commitments require owner values.                                                                                                                   |
| `EXTERNAL`  | Cloud/network, DNS/TLS, databases, NATS/Redis, chain/oracle/venue/custodian/bank, notification/status, security response, and participant DR testing require provider and client evidence.                                                                                                                                  |
| `ABSENT`    | No proven multi-region topology, shared multi-replica kill state, writer fencing/fencing tokens, cross-region money/order failover, production PITR/off-host backup, unified public status service, venue-wide error budgets, severe-market capacity pack, or full incident/DR exercise corpus was found.                   |

The composition topology is a single-host development baseline, not production resilience. `svc-edge` explicitly reports that its file-backed kill state is not shared across replicas. The money backup drill restored a throwaway ledger schema, but did not freeze before capture, run the full hash recomputation against the restored database, exercise cutover, configure WAL/PITR or off-host retention, or prove restoration of the matching/trade/domain stores as one recovery point.

The existing money incident runbook predated that drill and said D26-P3-09 was open. Its containment and authority guidance remains useful, but its restore-status prose was stale and is corrected alongside this contract. PX-S13 resolves the product truth without rewriting history: one bounded local drill is `PARTIAL`; production backup/recovery remains unproven.

## 4. Service catalog, owners, and criticality

One versioned critical-service catalog maps every customer and operator surface to its authoritative writers, read models, data stores, event subjects, caches, queues, external dependencies, credentials, network/DNS paths, regions, clocks, dashboards, alerts, kill/freeze controls, runbooks, recovery order, and accountable on-call/owner roles.

Criticality is expressed by business consequence rather than deployment name:

1. money integrity and custody/settlement;
2. matching/order entry/cancel and execution evidence;
3. pre-trade/intraday/liquidation/default risk;
4. authoritative market/reference/private data;
5. identity/authority/compliance/surveillance;
6. transfer, chain, bank, custodian, and counterparty connectivity;
7. reporting, support, status, and non-critical analytics.

Criticality does not imply that every service must stay available. It defines which invariants must survive, which safe functions remain, which states refuse, and which recovery dependencies precede another. An unavailable non-authoritative projection cannot block the authoritative writer unless its absence is itself a required risk/compliance gate.

## 5. Canonical resilience objects, IDs, clocks, and evidence

Canonical objects include `ServiceSurface`, `DependencyEdge`, `CapacityEnvelope`, `SloVersion`, `RecoveryPlan`, `RecoveryPoint`, `WriterEpoch`, `FailoverDecision`, `Incident`, `ImpactScope`, `ChangeAction`, `ReconciliationCase`, `MaintenanceEvent`, `Notification`, `Exercise`, and `EvidencePack`.

Stable IDs include service/surface, dependency, deployment/region/instance, writer epoch/fencing token, data-store/journal/partition, incident, action, change, runbook/version, recovery point/run, reconciliation, correction, notification/delivery, exercise/scenario, and evidence artifact. IDs correlate with PX-S01/PX-S02/PX-S03/PX-S04/PX-S06/PX-S12 objects rather than replacing them.

Timestamps distinguish detected, first-impact, declared, acknowledged, action-requested, action-applied, customer-published, last-updated, contained, recovered, reconciled, corrected, and closed times. Source and clock quality are recorded. RTO/RPO observations use the actual interval and recovery point; no target is inferred after an event.

Evidence is append-only and identifies configuration, topology, software/schema/rule/model versions, workload, faults, actors/authority, observations, commands, outputs, invariant checks, deviations, and artifact digests. A screenshot or green check without the tested version and workload is not capacity or recovery proof.

## 6. SLO and error-budget constitution

Each participant-visible surface has an owner-approved SLO version with service-level indicators, population, success/failure criteria, exclusions, measurement point, aggregation window, target socket, error-budget policy, maintenance treatment, dependency attribution, and customer claim language. At minimum, separate surfaces cover:

- order entry/acknowledgement, cancel/mass-cancel/kill, matching and execution reports;
- public/private market data and authoritative recovery;
- pre-trade risk, positions, collateral, liquidation/default actions, and warnings;
- ledger posting/history/reconciliation;
- deposits, withdrawals, custody/settlement and chain/bank rails;
- identity/key/revocation, compliance/surveillance and operator control;
- statements, reporting, drop copy, historical data and support/status.

Availability never combines a healthy read path with a failed write path or averages a critical money/order failure away with high-volume health checks. Latency uses participant-observed and stage-specific distributions, not averages alone. Correctness, freshness, sequence integrity, unknown outcomes, and reconciliation are independent indicators.

Excluded traffic and planned maintenance remain visible and rule-governed. An exhausted error budget triggers owner-set release, capacity, or feature constraints; absent targets mean no external SLO claim, not unlimited tolerance. Service credits/compensation belong to PX-S10/PX-S11 and require commercial authority.

## 7. Dependency map and degraded-mode contract

Every dependency edge declares necessity, timeout, retry/idempotency, circuit/open behavior, cache/last-good use, backlog bound, data-freshness contract, fallback, blast radius, safe surface, reconciliation, and recovery order. The minimum failure set includes:

| Dependency                              | Required explicit behavior                                                                                                                           |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL/domain store                 | Writer/read separation, pool/timeout exhaustion, transaction unknown, failover epoch, restore/reconcile; never reconstruct money from another schema |
| NATS/event bus                          | Publisher/consumer durability, redelivery/dedupe, sequence/gap, backlog, poison message, unavailable private/public projections, snapshot recovery   |
| Redis/cache/limit store                 | Cache loss/miss, stale data, shared control/rate-state consequence, fallback refusal, no authority migration into cache                              |
| Region/cloud/network/DNS/TLS            | Endpoint isolation, partial reachability, route withdrawal, failover authority, surviving capacity, split-brain fence, client reconnect              |
| Chain/oracle/venue                      | source finality/freshness, fork/reorg/outlier/gap, route/risk/transfer refusal, external reconciliation and exit                                     |
| Custodian/bank/settlement               | balance/finality/availability, queued or stopped instructions, cutoff/calendar, claims and reconciliation                                            |
| Identity/compliance/notification/status | credential/revocation, screening/surveillance, notice delivery and independent status availability                                                   |

Failure is scoped: `HEALTHY`, `DEGRADED`, `RECOVERY_REQUIRED`, `SUSPENDED`, or `UNAVAILABLE`, with reason, affected functions/owners/products, last-good time, safe actions, authoritative source, recovery progress, and incident linkage. “Connected” or HTTP 200 alone cannot promote a dependent surface to healthy.

Retries are bounded, jittered, budgeted, and idempotent. A fallback cannot turn stale, partial, unsequenced, unauthenticated, caller-supplied, or synthetic data into authoritative truth.

## 8. Single-writer, sequencing, and split-brain prevention

Every money, order, position/risk, instrument/rule, transfer/settlement, custody, and correction domain names its authoritative writer and linearization point. Failover uses a monotonically ordered `WriterEpoch` or equivalent fencing token issued by a quorum/authority independent of the candidate writer. A former writer cannot commit after its lease/epoch is superseded, even if it retains network access or local time appears valid.

Required state machine:

`FOLLOWER → CANDIDATE → FENCED → RECOVERING → RECONCILING → WRITER`

Loss of quorum/lease/authority moves `WRITER → FENCED`; it never self-promotes from wall-clock timeout. `RECOVERING` replays to a proved point, `RECONCILING` compares every dependent SoR, and only an authorized decision with successful invariant proof enters `WRITER`. Ambiguous dual-writer evidence freezes affected risk-increasing and money-moving actions while preserving proven safe release paths.

Event, journal, database, and client sequences name domains and epochs. Cross-domain recovery uses causal watermarks, not a fabricated global sequence. Replay preserves original economic idempotency roots, rule/model/schema versions, and event time. A failover or restore cannot renumber orders, executions, ledger postings, corrections, or client IDs into new economic intent.

Active/passive is the safe baseline until multi-writer correctness is independently proven. “Multi-region” does not mean active/active, and read replicas do not become writers by configuration drift.

## 9. Severe-market capacity constitution

Each surface has an owner-approved `CapacityEnvelope` covering sustained and burst requests/messages/bytes, instruments/hot symbols, accounts/sub-accounts, open orders/positions, book depth, executions, ledger postings, risk calculations, liquidation/default cases, WebSocket sessions/subscriptions/slow consumers, event backlog/redelivery, database connections/locks/storage/IO, capture/history growth, and external quotas.

Forecast inputs include normal peak, product/adoption growth, listing/event calendars, derivatives expiry/funding/settlement, severe price moves, maker withdrawal, and correlated dependency degradation. Headroom is measured at every shared bottleneck. A nominal front-door rate is not capacity if matching, risk, ledger, bus, database, or external dependencies saturate earlier.

Capacity evidence records workload distribution and exact versions and proves:

- hot-symbol concentration and dense L2/L3 books;
- new order, amend, mass quote, single/bulk cancel and cancel-on-disconnect storms;
- burst fills, private/drop-copy fan-out, reconciliation and historical capture;
- simultaneous margin recalculation, warnings, partial liquidations, insurance/default and ADL evaluation without inventing policy;
- reconnect/resubscribe/replay storms after dependency or region recovery;
- chain/oracle/venue/custodian degradation and external quota exhaustion;
- long-running production-shaped load plus maintenance/backup/failover overlap.

Load shedding is ordered by safety and authority: reject optional analytics and expensive non-critical reads before authoritative order/risk/money work; constrain new risk before cancellation/reduce-only/collateral-addition/repayment/reversal; preserve surveillance/audit and incident control. Queues, retry concurrency, circuit breakers, and per-tenant fairness are bounded so one participant or recovery wave cannot starve the venue. There is no blanket priority that bypasses account/risk/rule/ledger checks.

## 10. Cancel-storm and liquidation-burst law

Cancel and risk-reduction traffic must remain separately observable and capacity-reserved under new-risk throttling. A cancel is accepted only against authoritative order state, deduplicates by its original command identity, and reports `UNKNOWN` when outcome cannot be proved. Mass cancel/kill shows scope and per-order outcome. It cannot claim safety merely because an edge route accepted the request.

During a cancel storm:

1. stop or throttle new risk at the smallest safe scope;
2. preserve authenticated cancel, reduce-only and other governed release paths;
3. apply fairness and bounded queues without reordering within engine law;
4. expose queue/ack/engine/cancel-finality lag separately;
5. reconcile unknown and partial outcomes after recovery;
6. investigate abusive message patterns under PX-S01 surveillance without disadvantaging legitimate exits secretly.

During a liquidation burst, PX-S06 owns eligibility, sizing, mark, priority, execution, insurance/default, and ADL. PX-S13 requires bounded scan/work queues, stable risk-unit concurrency, cancel-conflict ordering, ordinary PX-S03 child-order semantics, ledger idempotency, stale/oracle refusal, source/venue capacity, participant-visible progress, and deterministic restart. Load shedding cannot skip a risk rung, use a caller/display/last price, debit an implicit fund, or silently change owner-set policy.

## 11. Backups, recovery points, restore, and data correction

The backup constitution inventories every authoritative and required reconstruction store: ledger journal/entries/tip/snapshots/migrations; matching journal; trade/order/fill/position/strategy stores; identity/authority/audit; rule/instrument/model/schema versions; custody/transfer/settlement; event streams; surveillance/cases; statements/reports; and capture/history manifests. Projection/cache stores are labelled rebuildable only with a proved source and procedure.

Owner sockets select encryption, residency, off-host/region isolation, frequency, retention, immutability, access, key recovery, legal hold, PITR, and deletion. Backup success requires restorable, authenticated artifacts and catalog evidence; upload completion is not proof.

Restore is coordinated, not store-by-store improvisation:

1. declare and fence writers; preserve a forensic copy and incident evidence;
2. select an authorized recovery point with explicit per-store watermarks and maximum known loss;
3. restore into isolated targets and validate schema/migrations, digests/hash chains, sequence/tip, balances/zero-sum, referential and ownership invariants;
4. replay journals/events idempotently to the selected causal boundary;
5. compare matching orders/executions, risk/positions, ledger holds/postings, transfers/custody, statements and external confirmations;
6. classify every mismatch as repairable projection, `RECOVERY_REQUIRED`, dispute/claim, or unrecoverable loss—never silently patch authority;
7. perform shadow reads and end-to-end participant workflows before cutover;
8. issue a new writer epoch, cut over under incident authority, monitor, and retain rollback target;
9. append corrections/compensating ledger entries under owning specs and notify affected parties;
10. close only after independent reconciliation and evidence review.

The existing local ledger drill is reusable evidence for a subset of steps 3 and 5. It is not production, PITR, cross-store, freeze-consistent, full hash-recompute, or cutover proof.

## 12. Recovery plans and executable exercises

Each critical surface has a versioned recovery plan with prerequisites, authority, dependency order, writer fencing, data-loss decision, commands/tools, verification, abort/rollback, communications, vendor/client coordination, and evidence retention. Instructions use discoverable IDs/configuration and do not embed secrets.

Exercise types include component fault, zone/region loss, database/event/cache outage, DNS/TLS/network partition, writer isolation/split-brain attempt, backup corruption, point-in-time restore, schema rollback, credential revocation, chain/oracle/venue/custodian/bank failure, cyber/insider compromise, facility/people loss, and full participant DR access.

Exercises prove function and performance at production-shaped volume. Designated clients/OEMS connect, authenticate, recover sessions/data, submit/cancel test intent, receive executions/drop copy, reconcile, and observe status/communications. External providers participate where they are critical. An exercise records untested components and deviations; a partial test cannot be labelled full DR.

RTO/RPO evidence measures detection, decision, fence, restore/replay, reconcile, cutover, client recovery, and final correction separately. Targets remain blank until owner approved; missed targets are findings, not revised history.

## 13. Incident declaration, severity, and authority

Incidents have owner-set severity classes and objective declaration triggers based on safety, money/order/data correctness, customer scope, duration, regulatory/privacy/security impact, capacity, dependency, and uncertainty. Unknown book, dual-writer suspicion, missing executions, ledger break, or uncontrolled privileged access can be severe before broad availability loss.

PX-S02 supplies named, scoped, expiring authority. Incident roles are distinct:

- **Incident commander:** owns severity, priorities, role assignment, decision cadence, escalation, and closure recommendation.
- **Operations lead:** is the only role coordinating production mutations; delegates bounded actions and records results.
- **Communications lead:** owns internal, participant, public-status, support, counterparty, and authorized regulatory/customer notices.
- **Planning/evidence lead:** maintains state/timeline, hypotheses, dependencies, handoffs, recovery/rollback plan, reconciliation and evidence.
- **Domain leads:** money/custody, matching/trade, risk/liquidation, data/connectivity, security/compliance/surveillance, and external counterparties act only in their authority.

One durable incident record captures impact, current states, commander/roles, decision and command log, hypotheses, changes, evidence links, customer messages, next update, handoffs, and unresolved risks. Handovers require explicit acceptance. Freelance production changes are prohibited. Break-glass is scoped, time-limited, audited, independently reviewed, and cannot bypass ledger/risk or invent owner values.

## 14. Containment and safe participant paths

Containment follows authoritative controls already owned by other specs: market/product state under PX-S01, credentials/revocation under PX-S02, cancel/mass controls under PX-S03, feed suspension under PX-S04, risk/liquidation under PX-S06, and ledger/custody freeze/wind-down under PX-S12.

Precedence is safety-specific rather than a single switch:

1. fence untrusted writers and compromised credentials;
2. freeze unverifiable money posting while retaining reads/evidence;
3. stop new risk/commitments at the affected scope;
4. preserve proven cancel, reduce-only, collateral-addition, repayment, claim, reversal, and safe withdrawal/return paths where their dependencies remain authoritative;
5. disable or label stale/non-authoritative data and projections;
6. shed optional work and isolate abusive or failing tenants/dependencies;
7. preserve journals, logs, captures, communications, and forensic artifacts.

If a safe exit itself would use unverified money, risk, order, identity, or settlement state, it refuses with a named recovery state; “always allow cancels” does not authorize fabricated cancellation finality. Operators cannot repair a ledger by editing balances or repair an order book by deleting discrepancies from a report.

## 15. Status truth and communications

Customer-visible status is independently reachable from the impaired product path and machine-consumable. Component names map to real surfaces rather than internal service labels alone. Each incident/maintenance item includes stable ID, environment, region/endpoint, protocol/channel, market/product/asset/function scope, state, first-impact/detected/published/update/recovery times, known symptoms, safe actions, data/finality caveats, next-update commitment when authorized, and correction/reconciliation status.

States distinguish investigating, identified, contained, recovering, monitoring, reconciled, corrected, and resolved. “Resolved” requires participant function plus authoritative reconciliation; mitigation alone is not closure. Historical incidents and updates are retained and not rewritten.

Private notices identify affected organization/account/object without leaking another participant. Regulatory, legal, counterparty, insurer, law-enforcement, and breach notices occur only under applicable owner/legal decisions, with delivery evidence and deadlines as sockets. If delivery is unknown it remains `UNDELIVERED/UNKNOWN` and no notice-dependent clock is fabricated.

Status never exposes exploitable control detail, secrets, private portfolios, sanctions content, or unverified root cause. It does not claim funds safe, orders cancelled, positions correct, or data complete until the owning SoR proves it.

## 16. Maintenance, releases, and change safety

Every maintenance/release has change ID, owner/approvers, affected services/dependencies/protocol/schema/rule/model, environment/scope, risk classification, capacity and compatibility evidence, scheduled window socket, participant notice, session/open-order/position/transfer treatment, data-feed behavior, drain/quiesce plan, backup/recovery point, rollback criteria, observation window, and incident escalation.

24/7 operation means maintenance is a product state, not “no maintenance.” Rolling changes prove mixed-version compatibility, writer fencing, schema expand/migrate/contract order, event replay, client reconnect, and capacity with one unit unavailable. Parallel environments prevent double booking/posting through epochs and idempotency. A deployment rollback cannot roll back irreversible economic facts; it restores code for new actions and reconciles facts already accepted under the deployed version.

Emergency change authority is narrow and logged. Multiple simultaneous high-risk changes are prohibited unless incident command records their dependency and rollback ordering. A failed maintenance becomes an incident before its window ends if customer or integrity criteria require it.

## 17. Runbook constitution

Each runbook states detection, prerequisites, authority, exact affected scope, containment, safe participant paths, evidence preservation, commands/tools, expected outputs, refusal/abort conditions, escalation, recovery/reconciliation, customer status, rollback, and post-action proof. Runbooks are versioned and exercise-linked; a stale assertion is recorded and corrected rather than trusted over current evidence.

Required scenarios include stale/crossed/gapped market data; missing private/drop-copy sequence; risk or liquidation lag; oracle/index split; matching journal corruption/replay mismatch; ledger chain/balance/zero-sum break; database/event/cache exhaustion; stuck deposit/withdrawal/transfer; chain reorg/halt; settlement/custody/bank/venue failure; credential/security/privacy incident; cancel/reconnect storm; liquidation/default burst; region/cloud/DNS/network partition; split-brain suspicion; backup/restore failure; and status/notification outage.

The existing money incident and kill-switch runbooks are inputs, not substitutes for this complete scenario set. Their controls must stay aligned with current mounted routes and shared-state limitations.

## 18. Reconciliation, correction, and incident closure

Recovery completion requires independent checks across:

- writer epoch and absence of post-fence writes;
- matching journal/book, trade order/fill/position stores and client/drop-copy evidence;
- ledger hash chain, account replay, per-asset zero, holds and economic idempotency roots;
- risk inputs/models/positions/liquidations/default cases;
- transfer/custody/chain/bank/venue confirmations and settlement finality;
- instrument/rule/fee/schema versions, market-data capture and historical manifests;
- identity, access, operator actions, surveillance/cases, statements and notifications.

Differences are not automatically repaired. Each has owning authority, evidence, participant impact, accounting, correction method, approval, execution, verification, and notification. Money corrects through balanced compensating ledger transactions; orders/executions/data append bust/correct or recovery records; historical facts remain reconstructable.

Closure requires containment lifted or a continuing named degradation, SLO/error-budget impact calculated, all unknown economic outcomes resolved or case-bound, customer/status updates complete, notification obligations decided, evidence preserved, and an independent reviewer accepting reconciliation. Root cause may remain under investigation after service recovery, but “resolved” status cannot outrun outcome truth.

## 19. Post-incident review and control improvement

The review reconstructs detection through closure, customer/economic/market/integrity impact, contributing technical/organizational/external causes, control performance, decision quality, capacity and recovery observations, communication/delivery, data loss/corrections, and where assumptions differed from evidence. It distinguishes root cause from trigger and avoids replacing proof with blame.

Every finding has risk classification, accountable owner, due/effective state, verification method, and explicit accept/mitigate/transfer decision under authority. Recurrence tests are added to the appropriate service/spec proof corpus. Significant changes feed PX-S01 rule/change governance and PX-S04 compatibility/certification. A review document is not completion until improvements or accepted residuals are evidenced.

## 20. Security, privacy, surveillance, and external providers

- Incident tooling and telemetry use least privilege, strong authentication, immutable audit, secret redaction, and independent availability. Production credentials never enter status/chat/tickets/capture bundles.
- Security incidents preserve forensic integrity and coordinate containment with money/order safety. Credential or code compromise can require fencing and rebuild from trusted artifacts, not merely process restart.
- Monitoring labels avoid high-cardinality participant/secret data; authorized drill-down preserves account/legal-owner privacy. Retention/legal hold and breach notice remain jurisdiction/entity sockets.
- Surveillance remains active through severe markets and correlates affiliate/house/customer orders, cancels, liquidations, operator changes, feed anomalies, and capacity controls. Incident priority cannot become hidden execution advantage.
- Providers have service/dependency maps, contacts, capacity/continuity/security commitments, status interfaces, notification, data return/portability, reconciliation, exercise participation, and exit plans. Outsourcing does not outsource INTAFACED accountability.

## 21. Capacity, SLO, recovery, and incident evidence pack

The authoritative evidence pack includes current service/dependency catalog; approved SLO/error-budget and capacity versions; dashboards/alerts and raw measurement provenance; load/fault/soak results; backup inventory and restore records; writer-fence/failover/replay/reconciliation proof; maintenance/release records; incident timelines/actions/status/notices/corrections; client/provider DR results; post-incident findings; and outstanding owner/external sockets.

Evidence has access controls, retention, digests, review/approval, and effective interval. A current dashboard cannot reproduce a past incident without historical config/topology/schema/rule/model versions. Claims exposed to diligence, customers, regulators, or insurers cite exact evidence and limitations.

## 22. Definition of Done

PX-S13 is implementation-complete only when evidence proves:

1. every critical customer/operator surface has approved, measured SLO/error-budget semantics and honest exclusions;
2. the complete dependency map passes each named failure with scoped degraded behavior and no fabricated authority;
3. region/dependency partitions and failover prove fencing, single writer, sequence continuity, no duplicate money/order intent, and owner-approved RTO/RPO;
4. backups for every authoritative store restore to coordinated recovery points and pass full replay, hash, balance, order, risk, custody, statement, and external reconciliation;
5. severe-market, hot-symbol, cancel, fill, liquidation, reconnect, replay and provider-failure loads fit approved capacity envelopes with safe shedding;
6. cancel/reduce-only/release paths survive new-risk throttles when authoritative, and refuse honestly when they are not;
7. incident declaration, roles, authority, handoff, command log, evidence, status, customer/regulatory decision and closure are exercised;
8. maintenance and releases prove mixed-version compatibility, drain, open-risk handling, writer fence, rollback and customer notice;
9. every required runbook executes in a production-shaped environment and records limitations/remediation;
10. public/private status and notification surfaces remain available, scoped, timely under owner policy, historically immutable, and reconciled before resolution;
11. security, privacy, surveillance, affiliate fairness, provider accountability and evidence retention pass adversarial review;
12. PX-S01/PX-S02/PX-S03/PX-S04/PX-S06/PX-S12 and all enabled product consumers pass integrated recovery/incident conformance.

A completed specification, local unit test, green health probe, tracker row, or isolated restore drill is not venue-wide resilience proof.

### 22.1 Requirement proof map

| Requirement   | Contract closure                                                                            | Required implementation evidence                                                                  |
| ------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `PTX-M18-R01` | §6 defines per-surface SLOs, correctness/freshness/finality indicators and error budgets    | Approved versions, measurement provenance, historical dashboards and budget actions               |
| `PTX-M18-R02` | §7 defines complete dependency edges, blast radius, bounded retry and degraded states       | Fault matrix across database, bus, cache, region, cloud, chain, oracle, venue, custodian and bank |
| `PTX-M18-R03` | §8 defines writer epochs, fencing, failover state and cross-domain sequence law             | Partition/old-writer/region-loss exercises proving no split-brain money or orders plus RTO/RPO    |
| `PTX-M18-R04` | §§11–12 and 18 define coordinated backup, restore, replay, reconciliation and correction    | Restored multi-store recovery points, full ledger/order/risk/custody proof and retained exercises |
| `PTX-M18-R05` | §§9–10 define forecast envelopes, headroom, severe-market loads and safety-ordered shedding | Production-shaped burst/soak/failure results and external-quota evidence                          |
| `PTX-M18-R06` | §§13–15, 18–19 define severity, roles, authority, communications, timeline and closure      | End-to-end incident exercises, delivery/status history, reconciliation and reviewed improvements  |
| `PTX-M18-R07` | §16 defines maintenance/release session, open-risk, compatibility, cutover and rollback law | Mixed-version, drain, failure, rollback and participant-notice exercise                           |
| `PTX-M18-R08` | §17 defines complete scenario runbook structure and mandatory failure catalog               | Versioned, executed runbooks with observed outputs, gaps, remediation and re-test                 |

## 23. Owner and external sockets

| Socket       | Required authority/input                                                                                  | Refuse-closed behavior while absent                                   |
| ------------ | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `PX-S13-O01` | Criticality catalog, surface owners, dependency owners and on-call coverage                               | No venue-wide availability/resilience claim                           |
| `PX-S13-O02` | SLO/SLI populations, targets, windows, exclusions, error-budget and compensation policy                   | Metrics are observations only; no commitment or credit                |
| `PX-S13-O03` | RTO/RPO and maximum-data-loss policy by authoritative domain                                              | Recovery reports actuals; no target compliance claim                  |
| `PX-S13-O04` | Region/cloud topology, writer quorum/lease/fencing authority and failover approvers                       | No automatic cross-region writer promotion                            |
| `PX-S13-O05` | Capacity envelopes, growth/severe-market factors, safety priority and external quota headroom             | No scale claim; affected new risk refuses before unsafe saturation    |
| `PX-S13-O06` | Backup/PITR scope, frequency, encryption, residency, immutability, retention, access and legal hold       | No production-restorable or data-loss claim                           |
| `PX-S13-O07` | Incident severity, declaration, role roster, escalation, break-glass, notification and closure policy     | Conservative containment; no invented notice deadline or closure      |
| `PX-S13-O08` | Maintenance windows, release risk classes, notice, rollback and emergency-change policy                   | High-risk unattended change refuses                                   |
| `PX-S13-O09` | Customer/regulatory/legal/security/privacy notice, status history and evidence retention policy           | Undecided notice is socketed; no false delivery/applicability claim   |
| `PX-S13-O10` | Exercise scope/frequency, designated clients/providers, independent review and accepted residual criteria | Partial exercise labelled partial; no DR certification                |
| `PX-S13-X01` | Cloud/region/network/DNS/TLS/database/event/cache continuity and capacity contracts                       | Affected dependency is degraded/unavailable; no silent failover claim |
| `PX-S13-X02` | Chain/oracle/venue/custodian/bank/settlement continuity, status, reconciliation and exit evidence         | Affected product/rail refuses or remains recovery-required            |
| `PX-S13-X03` | Public status/notification/security-response providers and independent communication path                 | Delivery/independent availability unknown and shown as such           |
| `PX-S13-X04` | Participant/OEMS/provider DR connectivity and executable exercise evidence                                | Internal recovery only; no end-to-end participant claim               |

## 24. Cross-spec dependencies and contradiction register

- **PX-S01:** owns emergency/rule/market/instrument state, governance, public changes, correction/dispute and surveillance. Incident command cannot invent a halt or silently change market law.
- **PX-S02:** owns actor, operator, grant, session, break-glass, dual-control, security/privacy and revocation. On-call role is not standing authority.
- **PX-S03:** owns order/fill state, matching sequence, journals/replay, cancel/mass/kill, correction and execution reconciliation. Capacity cannot reorder or weaken these semantics.
- **PX-S04:** owns protocol/feed health, recovery, rate/capacity dimensions, maintenance compatibility, status/change feeds and client certification. A live connection is not venue health.
- **PX-S06:** owns risk, marks, warnings, liquidation/default/insurance/ADL and refusal. Incident load shedding cannot invent valuation or skip the waterfall.
- **PX-S12:** owns ledger/custody/settlement reconciliation, solvency, asset return and wind-down. Restore never creates a second book or substitutes external balance for ledger finality.
- **PX-S05/PX-S11:** consume per-surface incident/data/risk/account truth for terminal, OMS/TCA, portfolio and institutional reporting; views cannot self-declare recovery.
- **PX-S07–PX-S10/PX-S14–PX-S16:** each product supplies specific settlement, venue, automation and delegated/agent recovery behavior while inheriting writer, authority, money, capacity, status and kill boundaries here.

Resolved contradictions and explicit gaps:

1. The money incident runbook previously said D26-P3-09 was not done, while `MONEY-BACKUP-RESTORE-DRILL.md` records a later bounded exercise. This PR corrects the runbook to the later evidence: a throwaway ledger-schema restore ran, but full hash recomputation, freeze-consistent capture, production cutover, PITR/off-host retention, matching/domain coordination and venue-wide recovery remain unproven.
2. Some tracker rows call metrics or service surfaces done. Those claims prove only their bounded route/dashboard/test. They do not prove per-surface venue SLOs, error budgets, severe-market capacity, public status or DR.
3. `svc-edge` kill state can survive one process restart when configured, but its source explicitly says another replica does not share the file. It is not a multi-replica incident control or fencing system.
4. Matching journal/replay determinism and ledger reconciliation are strong local primitives. Neither proves a coordinated recovery point or prevents two deployed writers; no writer-epoch/fencing implementation was found.
5. Compose health/readiness and dependency-specific flags are operational signals, not a production topology, public status service, or evidence that all customer surfaces are healthy.
6. Existing chaos, concurrency, backpressure and liquidation tests cover valuable cases, but no retained venue-wide cancel-storm/liquidation-burst/region-loss capacity envelope was found.
7. “Cancels pass under a kill” remains the intended safety rule only while target order/authority/dependencies are provable. A transport acceptance cannot fabricate engine cancellation finality.
