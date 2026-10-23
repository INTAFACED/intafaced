# INTAFACED Agentic Trading Authority and Safety Specification

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Status:** Authoritative product contract; implementation incomplete

**Authority:** `PX-S16`; bounded child of [`PRO_TRADER_EXCHANGE_DEFINITIVE_SCOPE.md`](../PRO_TRADER_EXCHANGE_DEFINITIVE_SCOPE.md)

**Primary requirements:** `PTX-M28-R01–R12`

**Predecessors:** `PX-S01` rulebook/lifecycle/integrity, `PX-S02` participant authority/security, `PX-S03` microstructure/execution, `PX-S04` connectivity/data/certification, `PX-S05` terminal/OMS/TCA, `PX-S06` collateral/risk/default, `PX-S10` liquidity/fees/conflicts, `PX-S11` reporting/service, `PX-S12` custody/reconciliation/wind-down, `PX-S13` resilience/incident command, `PX-S14` multi-venue/on-chain execution, and `PX-S15` quantitative/delegated strategy lifecycle

**Systems of record:** PX-S02 owns identity, account/sub-account, credential, mandate, approval and revocation. PX-S03 owns canonical order intent, preview, parent/child state and execution. PX-S04 owns data/session/schema truth. PX-S06 owns deterministic capital and risk. PX-S12 owns money finality and reconciliation. PX-S13 owns incidents/recovery. PX-S15 owns strategy deployment, delegation, controls and promotion. `packages/ledger-client` plus `svc-ledger` remain the only money book. This contract owns agent modes, model/tool trust boundaries, agent-specific consent and intent evidence, adversarial evaluation, provider privacy, multi-actor conflict and tool-marketplace admission.

---

## 1. Product promise, professional jobs, and boundary

Professional traders, portfolio managers, researchers, brokers, risk and compliance teams, operators, developers, clients and auditors can use natural language and probabilistic models to research, monitor, draft, confirm or autonomously propose bounded trading actions while retaining deterministic account ownership, risk, execution and money authority. They can see what the model knew, which policy transformed or refused its output, what they confirmed, what actually happened and how to revoke it immediately.

This determines primary-venue adoption because an agent is useful only when it compresses workflow without obscuring control. A fluent interface that can duplicate an order, treat hostile content as policy, leak a portfolio to a provider, switch models invisibly, or act outside the user's intended account is less trustworthy than no agent.

Catastrophic or dishonest outcomes include prose mistaken for a confirmed order; a repeated conversation producing duplicate intent; caller-forged approval; prompt injection from news, messages, filings, tools or on-chain text; poisoned market context; cross-tenant or provider leakage; an agent bypassing margin or sanctions; two agents amplifying or unwinding one another; stale state used after a fill; provider failover changing behavior silently; tool/package compromise; credential persistence after revocation; and any model or tool acquiring independent money authority.

M28 remains one contract. Modes, grants, structured confirmation, execution recovery, grounding, adversarial safety, audit, provider governance, conflict control, privacy and tool admission compose one trust boundary. Splitting “AI research” from “AI execution” without the shared lineage would let persuasive text cross into money action without an authoritative transition.

Non-goals:

- no model, provider, prompt, agent, skill, tool, publisher or marketplace holds a balance, posts value, withdraws, transfers, grants credit or changes risk law;
- no model score, confidence or natural-language instruction overrides PX-S01/PX-S02/PX-S03/PX-S06/PX-S12/PX-S15 deterministic checks;
- no provider/model/vendor, live product, jurisdiction, data source, retention term, residency, training permission, risk magnitude, autonomous capital, loss limit, SLO, confirmation threshold or commercial claim is invented;
- no tool description, annotation, package signature, marketplace installation, API credential or user utterance is treated as trading authority by itself;
- no second agent runtime, OMS, money book, product SPA, tracker or SoT is created;
- this specification does not claim current product agents trade, current plans are previews, or hash-chained runtime logs are complete exchange execution evidence.

## 2. Research delta and durable patterns

Current official sources add durable contract requirements:

- [OKX Agent Trade Kit](https://www.okx.com/docs-v5/agent_en/) distinguishes demo/read-only capability and permission-aware exchange tools, while its [API agreement](https://www.okx.com/en-us/help/okx-api-agreement) preserves customer responsibility, independent pre-trade controls and market-integrity boundaries. These are patterns, not imported legal terms or permission to open autonomous trading.
- [NIST AI 100-2 E2025](https://csrc.nist.gov/pubs/ai/100/2/e2025/final) treats prompt injection, data/model poisoning, evasion, privacy and misuse as lifecycle attack classes rather than one-time content-filter problems. [NIST's Generative AI Profile](https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf) reinforces governed measurement, testing, provenance, incident and third-party risk across the lifecycle.
- [Model Context Protocol security principles](https://modelcontextprotocol.io/specification/2025-03-26/index) require explicit consent for data exposure and tool invocation, user control, and treatment of tool descriptions as untrusted unless their server is trusted. Its [tool specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) keeps schemas/results distinct from untrusted annotations.

The delta is that consent must bind the exact structured consequence and exact disclosure, not merely an agent/tool name; tool metadata and results remain untrusted input; and prompt-injection/data-poisoning tests must be continuous across sources, models, tools and versions. A provider's safety controls supplement but never replace exchange-side authorization and recovery.

## 3. Repository evidence audit and contradictions

| State       | Evidence and bounded truth                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BUILT`     | `svc-agents` has versioned declared guardrails snapshotted into sessions; pre-call task/tool/module/action/output/spend/call limits; hard money-write denial for the five product agents; provider capability/health checks; exact usage metering; append-only hash-chained session actions; prompt/output digests; refusal audit; service/agent kill and honest mock/live-plane readiness.                                                       |
| `PARTIAL`   | Navigator/support/scanner/merchant/copy-intel use grounded read/draft/statistics paths and typed dark refusal. Risk/compliance returns proposals, never decisions. Portfolio agent is plan-only, owner-targeted, killed by default and refuses cross-plane rebalance. The gateway records logical provider/model routing and refuses unavailable providers.                                                                                       |
| `SPECIFIED` | PX-S02/PX-S03/PX-S06/PX-S12/PX-S15 already bind delegation, structured order truth, risk, money and automation controls. Existing agent doctrine forbids product-agent money tools and provider brands in customer copy. Current OKX/NIST/MCP/provider documentation contributes patterns only.                                                                                                                                                   |
| `SOCKET`    | Agentic legal capacity, permitted modes/actions, live provider/model/endpoints, account/product scopes, autonomous budgets, confirmation classes, data sharing/retention/residency/training terms, evaluation thresholds, tool publishers and live SLOs remain owner/legal/risk/security/external sockets. Blank means no live trading autonomy or affected disclosure.                                                                           |
| `OWNER-SET` | Existing product agents remain non-money agents. Any new trading-agent class, withdrawal exception, autonomous capital/loss envelope, provider/tool admission, conflict/netting priority or customer claim requires explicit owner authority. A tool cannot widen an account mandate.                                                                                                                                                             |
| `EXTERNAL`  | Model/embedding providers, MCP/tool servers, publishers, package/signature registries, data/retrieval sources, exchanges/brokers, cloud/runtime services and independent evaluators require authenticated identity, contracts, telemetry, incident notification and exit paths.                                                                                                                                                                   |
| `ABSENT`    | No exchange-native `AgentGrant`/mode state, trading agent, durable account/environment/expiry credential binding, canonical preview-confirmation token, runtime tool input schema/authorization, tool idempotency/recovery spine, source/context manifest, injection isolation, adversarial evaluation suite, multi-agent position-intent coordinator, provider privacy policy engine, or tool marketplace admission/revocation system was found. |

Five implementation boundaries must not be overstated:

1. `requiresApproval` is enforced from a caller-supplied `approved` boolean. It is not bound to an authenticated actor, structured preview hash, action parameters, account, expiry or one-use nonce. It exercises a guardrail but does not prove professional confirmation.
2. `AgentRuntime.act` checks only the declared tool name/mode and then runs an opaque caller closure. It neither validates/authorizes canonical tool arguments nor records an input digest. A declared tool can therefore conceal a wider argument shape unless the module adapter independently prevents it.
3. Completion `requestId` prevents duplicate metering/re-inference when metering is enabled. Tool calls have no equivalent request/intent key, terminal lookup or recovery contract; completion idempotency is not execution idempotency.
4. The action chain retains prompt and output digests but no source/context manifest, structured intent, confirmation, policy evaluation, tool input, exchange order/fill lineage or revocation. A digest proves equality only when the protected original can be produced; it does not prove grounding or completeness.
5. Provider health and routing hot-swap are useful availability controls, but a session is not bound to an evaluated provider/model release or fallback policy. Refusal is safe today; invisible substitution would not be. No trading autonomy may infer approval from gateway readiness.

Tracker completion and a green `/ready` prove bounded agent runtime and product-agent doors, not M28 completion or permission to trade.

## 4. Actors, capacities, objects, IDs, versions, and clocks

Agentic capacities are `RESEARCH_ONLY`, `READ_ONLY_MONITOR`, `DRAFT_PREVIEW`, `CONFIRM_EACH`, and `BOUNDED_AUTONOMOUS`. Capacity is explicit in every surface and event. A transition to a more powerful capacity requires fresh authenticated consent and policy checks; downgrade and revoke are always available. No mode is inferred from a tool, prompt wording, provider or prior conversation.

Actors include account owner, organization administrator, trader, researcher, reviewer/approver, agent owner, credential owner, operator, control function, tool publisher and external provider. The model is not an actor. It produces `ModelOutput`; the accountable actor and deterministic policy own every accepted `StructuredIntent`.

Canonical objects include `AgentDefinition`, `AgentVersion`, `AgentGrant`, `AgentSession`, `ProviderRelease`, `ContextManifest`, `SourceObservation`, `ModelInvocation`, `ModelOutput`, `StructuredIntent`, `ActionPreview`, `Confirmation`, `ToolDefinition`, `ToolRelease`, `ToolInvocation`, `PolicyDecision`, `AgentOrderLink`, `ConflictCase`, `EvaluationRun`, `PrivacyManifest`, `Revocation`, `AgentIncident`, and `MarketplaceAdmission`.

Stable IDs cover owner/organization/user, legal entity/account/sub-account/portfolio, agent/agent version/grant/session/epoch, provider/model/release/route, context/source/observation/document/chunk/hash, invocation/output/intent/preview/confirmation, tool/server/release/call/attempt, policy/rule/risk snapshot, parent/child/client-order/order/fill, hold/ledger transaction, conflict/evaluation/revocation/case/incident and schema/version.

Clocks distinguish source event/publication/retrieval, platform receive, context freeze/expiry, model request/response, intent resolution, preview construction/expiry, confirmation challenge/response, deterministic recheck, tool dispatch/ack/result, venue order/fill/cancel, revocation fence, provider/route change, evaluation, correction and retention/deletion. Source or model time never overwrites platform causality.

Every definition, grant, provider release, tool release, policy and context schema is immutable/versioned. A material prompt/system policy, model, provider endpoint, tool schema/code/permission, data source, account/product scope or risk change creates a new version and invalidates affected evaluation/approval under policy.

## 5. Agent modes, grants, sessions, and consent

An `AgentGrant` binds named owner and responsible organization; purpose; capacity/mode; environment; legal entity; account/sub-account; products/instruments/venues; read/write tools and exact operations; position ownership/netting policy; capital/order/position/exposure/loss/drawdown/concentration/message/cost budgets; provider/data disclosure; credential reference; schedule/expiry; child-order disposition; approvals; and revocation route.

`RESEARCH_ONLY` has only approved research sources and no private account or write tool unless separately scoped. `READ_ONLY_MONITOR` reads named private data but cannot draft an executable tool call. `DRAFT_PREVIEW` may produce a canonical preview but cannot dispatch. `CONFIRM_EACH` needs a one-use confirmation for every high-consequence intent. `BOUNDED_AUTONOMOUS` may release only within the immutable grant and PX-S15 deployment envelope; withdrawals remain absent unless a separate product/legal/security contract explicitly justifies and approves one. This specification creates no such exception.

Grant state is:

`PROPOSED → REVIEW_PENDING → CONSENT_CHALLENGE → ACTIVE`

with `REFUSED`, `EXPIRED`, `PAUSED`, `REVOKING`, `REVOKED`, `SUSPENDED`, `COMPROMISED` and `WIND_DOWN`. Mode elevation creates a new grant/version; mode reduction fences disallowed work immediately. Consent displays provider/data recipients, tools/operations, account, scope, budgets, duration and revocation consequences.

Session state is:

`OPENING → BINDING → ACTIVE → PAUSING → PAUSED → CLOSING → CLOSED`

or `REFUSED`, `EXPIRED`, `REVOKED`, `PROVIDER_DEGRADED`, `RECOVERY_REQUIRED`. Session snapshots the grant, guardrail, provider/tool allowlists and versions, but deterministic account/risk/market state is rechecked at action time. Closing a conversation does not cancel orders or flatten positions; those are separate PX-S15 controls.

Credentials are per agent/grant/environment/account, least privilege, non-exportable where supported, rotated, expiring and immediately revocable. The agent/provider sees only mediated tool capability, never raw exchange, wallet, database or ledger secrets. User-facing mode and trading-enabled state are globally visible and cannot be hidden by a chat scroll.

## 6. Context, grounding, uncertainty, and advice truth

A `ContextManifest` freezes each source's identity/owner, type, authority class, entitlement/licence, environment, event/publication/receive times, sequence/version/hash, quality/staleness, transformations, corrections, trust zone, injection treatment and disclosure eligibility. It distinguishes exchange fact, external fact, user assertion, model inference and unsupported claim.

Research output cites the specific observations used; states market/data environment, as-of time, assumptions, missing/stale/conflicting inputs, model limitations and calibrated uncertainty; and labels scenario/opinion versus fact. It cannot claim professional, legal, tax or investment advice unless separately authorized. Citations must resolve to retained evidence or a permitted external source and never imply the source endorsed the generated conclusion.

Conflicting authoritative sources are surfaced and gate dependent action. Missing data does not become zero, stale last-known data does not become live, and a model's plausible reconstruction does not become an exchange price, balance, position, rule or order state. Only canonical service APIs supply those facts.

Model-generated structured output is schema-constrained but still untrusted. A deterministic resolver validates enums, IDs, exact decimal strings, product/account entitlement, source freshness and semantic consistency before any preview. Parse failure, ambiguity, unsupported field, overflow or conflicting intent refuses and requests a new explicit instruction; it never “best guesses” a money action.

## 7. Untrusted-content isolation and adversarial safety

Untrusted zones include web/search, issuer/market documents, email/chat/social, support tickets, user-uploaded files, on-chain metadata/calldata/events, tool descriptions/annotations, tool outputs, retrieved memory, third-party agents and model-generated text. Content is data, never system/developer policy or authorization.

The runtime separates trusted policy, user instruction, authorized context and untrusted payload into typed channels with provenance. Untrusted content cannot add/change tools, reveal secrets, alter mode/grant, approve a preview, select a provider, widen scope, suppress audit, instruct another tool or exfiltrate data. Tool results are validated/sanitized before re-entry; active content, hidden instructions, remote references and nested encodings are bounded or refused.

Controls include source allowlists and content-type limits; retrieval entitlement and tenant isolation; canonical parsing; instruction/data separation; output schema validation; tool input minimization; egress/DLP policy; secret redaction; recursion/delegation depth; token/tool/time budgets; sandboxing; human confirmation; and deterministic downstream authorization. A classifier or “ignore previous instructions” prompt is not a security boundary by itself.

Continuous adversarial evaluation covers direct/indirect prompt injection, tool-description poisoning, retrieved-document poisoning, malicious files/images/metadata, exfiltration, confused deputy, cross-tenant memory, excessive agency, privilege escalation, recursive tool calls, data/model poisoning, evasion, denial/cost exhaustion and multi-turn persistence. Tests span every admitted model/provider/tool/source/version and include adaptive private cases. New attacks create regression cases; failing high-consequence cases block promotion or downgrade capability.

## 8. Structured intent, preview, confirmation, and deterministic policy

The model may propose only a `StructuredIntent`. For an order it includes side, instrument/product, order type/time-in-force, exact quantity/notional, limit/trigger/peg/algo parameters, account/sub-account, position mode, reduce-only, route/venue constraints, expiry and client intent key. Other high-consequence operations use their canonical product schema, never free-form tool arguments.

The platform constructs `ActionPreview` from authoritative current data and deterministic calculators, not model prose. It shows actor/agent/mode; account and ownership; product/instrument; side; order/algo/legs; exact quantity/notional/price/trigger; current position and projected exposure; leverage/margin/liquidation effects; fees/rebates/funding/borrow/FX; market/source age; estimated impact/uncertainty; risk/limit headroom; child/cancel/flatten blast radius; unsupported facts; and expiry. Decimal values remain strings on boundaries and scaled bigint in memory.

A `Confirmation` binds authenticated actor/session, grant/version, preview hash, canonical intent hash, account, action class, one-use nonce, challenge method, issue/expiry and response time. Any intent, account, price-sensitive input, risk result, preview schema, grant or expiry change invalidates it. Confirmation text such as “yes,” an API boolean, model claim or stale UI click is insufficient without the binding record.

Before release, deterministic policy rechecks PX-S01 market/rule state, PX-S02 authority/mandate, PX-S03 canonical order schema, PX-S04 data freshness, PX-S06 balance/margin/risk, PX-S10 fees/conflicts, PX-S14 route eligibility and PX-S15 deployment/strategy budgets. The tightest user, organization, agent, account, strategy and product limit wins. Model output cannot waive, reinterpret or retry around refusal.

## 9. Tool registry, invocation, idempotency, and recovery

Each `ToolDefinition` identifies trusted publisher/server, purpose, module/capacity, read/write/consequence class, exact input/output schemas, account/tenant binding, required scopes, idempotency semantics, timeout/retry/lookup/cancel/recovery behavior, data disclosed/received, side effects, rate/cost bounds, version compatibility and owner. Tool descriptions and annotations are display hints, not authority.

The runtime resolves a tool name to one admitted `ToolRelease`; validates canonical arguments; intersects grant, session, account, mode and tool scopes; attaches actor/grant/intent/confirmation IDs; and calls a typed module adapter. The adapter repeats its own authorization and product validation. Opaque arbitrary closures and server-selected nested tools cannot form the professional write path.

Every consequence-bearing call carries a stable business `intentId`, `toolCallId`, `idempotencyKey` and attempt. Conversational repetition and transport retry reuse them. Before retry after dispatch uncertainty, the orchestrator queries the authoritative module/venue using the same key and reconciles order/fill/cancel/ledger state. A new economic intent requires a new authenticated preview/confirmation or autonomous policy decision.

Tool call state is:

`PROPOSED → SCHEMA_VALIDATED → AUTHORIZED → PREVIEWED → CONFIRMED → DISPATCHING → ACK_PENDING → WORKING → RECONCILING → TERMINAL`

with `REFUSED`, `STALE`, `EXPIRED`, `PARTIAL`, `OUTCOME_UNKNOWN`, `CANCEL_PENDING`, `RECOVERY_REQUIRED`, `CORRECTION_PENDING` and `REVOKED`. Terminal preserves product-specific outcome; tool success is not an order fill or ledger finality. Partial success returns completed and unresolved children and stops unsafe continuation.

Bounded retries have class-specific count/time/backoff and never retry deterministic refusal. Stale context or expired confirmation triggers fresh preview. Late events remain facts. Tool/provider failure cannot fabricate success, suppress earlier fills, release holds or cause another tool to compensate without separate authority.

## 10. Audit, explanation, privacy, and customer export

The immutable causal record retains user instruction reference, agent/grant/session/mode/version, provider/model/release/route, system/policy/context/source manifests and hashes, model invocation/output digest, resolved intent and parser/version, preview/hash, confirmation actor/challenge/nonce, policy/risk decisions and versions, tool release/input/output, dispatch/attempt/lookup, exchange parent/child/order/fill/cancel IDs, money/ledger references, refusals/partial/unknown states, operator action, revocation and correction.

Audit separates raw protected content from broadly searchable metadata. Digests are useful but the evidence store must retain or reproducibly reference the protected original under access/retention law; otherwise it labels the content unavailable. Secrets, credentials, unrelated tenants/followers and unnecessary private text never enter general logs. Hash chaining and append-only storage detect mutation but do not replace completeness, external reconciliation or legal retention.

User explanation states what instruction was resolved, which data/facts were used, what the model inferred, which deterministic checks changed/refused it, what was confirmed or autonomously permitted, what tool/order actually did, costs and unresolved uncertainty. It does not expose hidden security controls, other users, provider secrets or chain-of-thought.

Customer export is scoped by owner/account/time/agent and includes causal structured evidence, actions/refusals, confirmations, orders/fills/costs and revocations in machine-readable form. Corrections append; they do not rewrite prompts, intent or outcomes. Legal hold, dispute, regulator/auditor access and deletion exceptions follow PX-S01/PX-S11/PX-S12.

`PrivacyManifest` binds every provider/model/endpoint/tool to allowed data classes/fields, purpose, region/residency, transport/encryption, subprocessors, retention/application state/abuse logs, training or improvement prohibition/opt-in, deletion/export, incident notice and contractual exit. Data minimization/redaction occurs before provider/tool dispatch. A provider/tool without acceptable current terms is unavailable for affected data; fallback cannot silently receive a wider dataset.

## 11. Evaluation, promotion, provider change, controls, and incidents

Agent promotion reuses PX-S15 and adds:

`DEMO → HISTORICAL_EVALUATION → ADVERSARIAL_EVALUATION → SHADOW → LIVE_CANARY → LIVE`

with `FAILED`, `CHANGES_REQUIRED`, `PAUSED`, `ROLLED_BACK`, `SUSPENDED`, `PROVIDER_DEGRADED` and `RETIRED`. Research/read-only capability may have a shorter owner-approved path, but no high-consequence mode bypasses schema, injection, privacy, conflict, control and recovery tests.

Evaluation freezes agent/prompt/policy/model/provider/tool/data versions and test corpus. Measures structured-intent accuracy, refusal/abstention, hallucinated IDs/facts, stale/conflicting data, confirmation integrity, limit bypass, duplicate/partial recovery, injection/poisoning/exfiltration, privacy leakage, unsafe tool selection, multi-agent conflict, severe-market behavior and kill/revoke. Results include failures and confidence limits; a public benchmark is not exchange-specific proof.

Provider/model/tool change runs compatibility, behavioral, safety, privacy, latency/capacity and cost evaluation plus shadow comparison. Canary uses owner-set accounts/capital/action classes and rollback conditions. If the bound provider is unavailable, safe behavior is refuse/pause/read-only downgrade. Fallback requires a pre-evaluated compatible release, equivalent or tighter privacy, fresh policy and explicit grant; it is never an invisible “best available model.”

Controls are pause new model calls, pause tool writes, downgrade mode, kill agent/session/grant, revoke credential, cancel authorized children, flatten only with separate authority, disable provider/model/source/tool, and global high-consequence stop. Scope and blast radius are explicit and audited. Revocation fences new actions before acknowledgement and reconciles already dispatched work; it does not erase or invent closure.

Agent incidents reuse PX-S13 and distinguish provider outage/behavior change, injection, data/model/tool poisoning, privacy breach, credential compromise, duplicate/unauthorized action, control failure and audit/reconciliation gap. Response fences affected capability, preserves evidence, revokes access, reconciles orders/positions/money, communicates customer truth, corrects reports and requires evaluated canary restore.

## 12. Multi-agent and manual-trader coordination

Every open order and position effect is attributed to account, owner, strategy/deployment, agent/grant, manual actor and causal intent. An `AccountIntentCoordinator` evaluates all concurrent manual, deterministic strategy, copy and agent intents against shared atomic risk/message/capital budgets and product-specific ownership/netting law.

Conflict classes include duplicate equivalent intent, opposing/netting intent, one actor reducing another's attributed position, shared parent/child/hedge collision, cancel/amend ownership, limit/capital contention, incompatible position mode, priority inversion and feedback loop where agents respond to one another's actions. Detection occurs before release and again on stale/recovered state.

Policy may deduplicate, serialize, reserve budgets, require confirmation, refuse, or allow under explicit netting/priority authority. It never silently merges intents, assigns one agent another's fills, or lets “latest message wins.” Manual action is not universally privileged: it follows account ownership/mandate and sees the consequence of interfering with agent/strategy orders. Emergency deterministic risk controls retain their separately published precedence.

When position attribution is ambiguous or state is stale, affected new actions refuse or reduce risk only within explicit authority. Cross-agent communication is typed events with provenance and bounded recursion; one agent cannot delegate tools, credentials or approval to another merely through text.

## 13. Tool/skill marketplace and supply-chain governance

`MarketplaceAdmission` verifies publisher legal identity and beneficial ownership; tool/server/package repository and build provenance; source/review/signature/SBOM/dependencies; version/compatibility; exact permissions/data flows/side effects; security/privacy testing; claims/evidence; pricing/conflicts/affiliate relationships; support/incidents/vulnerability disclosure; update policy; suspension/revocation; escrow/availability where required; and exit/export.

Listing state is `SUBMITTED → VERIFYING → ADMITTED → SUSPENDED → REVOKED → RETIRED`, with `REFUSED`, `COMPROMISED` and `REVIEW_REQUIRED`. Updates are new releases and never auto-expand permission. Publisher signatures authenticate provenance but do not establish safety, accuracy or authority.

Installation grants no data, tool, account or trading permission. The user/organization separately reviews the concrete release and creates a least-privilege grant. Tool discovery is scoped to admitted compatible releases; server-returned descriptions/annotations cannot rewrite registry facts. Dependencies and remote code are pinned; runtime download/execute is refused unless the admitted distribution model explicitly supports and verifies it.

Compromise or revocation blocks new invocation immediately, inventories affected sessions/actions, reconciles consequences, notifies customers and preserves evidence. Offline/disappeared publishers or servers have a defined disable/export/replace path. Marketplace ranking or promotion cannot hide permissions, incidents, conflicts or paid placement.

## 14. Interfaces, degraded truth, capacity, and wind-down

Terminal, mobile, REST, WebSocket, FIX/event and operator surfaces expose agent/mode/environment, account/grant/expiry, provider release category, source/data age, intent/preview/confirmation, policy/refusal, tool/order lineage, partial/unknown state, budgets/headroom, conflicts, monitoring and revoke/kill. Natural language is explanation; canonical structured state is authoritative.

Degraded states name provider unavailable/changed, tool/source untrusted or stale, privacy terms incompatible, evaluation expired/failed, confirmation stale, account state unknown, conflict unresolved, credential revoked, audit/reconciliation gap and high-consequence path disabled. Read-only fallback cannot claim full autonomy; no status derives agent trading readiness from process or model health alone.

Capacity tests cover concurrent sessions, long context, retrieval bursts, tool fan-out, recursive proposals, model/provider latency/rate loss, market-data bursts, order/cancel/fill storms, simultaneous confirmations/revocations, multi-agent account contention, region failure, audit/event backlog and recovery lookup. Shed research/generation before deterministic risk, control, order-state and audit paths. Owner-set SLO categories cover preview age, confirmation-to-dispatch, revoke/kill fence, tool unknown-state recovery, context freshness, audit lag and provider degradation; blanks remain unset.

Migration preserves agent/grant/session/intent/preview/confirmation/tool/order IDs and evidence. Schema/provider/tool changes use dual-read/shadow, compatibility and rollback. Decommission downgrades/stops new action, fences grants/credentials, resolves unknown tools/orders, hands positions back to account authority, reconciles ledger/fees, exports evidence, applies retention/deletion law and proves no orphan agent, credential, remote server or marketplace subscription remains.

## 15. Testable Definition of Done

Implementation is complete only when evidence proves:

1. every surface and event distinguishes all five modes; authenticated elevation, downgrade, expiry and revocation bind one immutable owner/account/environment grant;
2. credentials/tools/providers cannot exceed grant, sub-account, product, instrument, budget or expiry, and no model/provider receives raw withdrawal/ledger/venue secrets;
3. adversarial output cannot bypass ordinary ownership, compliance, balance, margin, risk, price, message, loss, drawdown, concentration, route or ledger controls;
4. high-consequence previews are produced from authoritative data, bind exact structured intent/account/risk/cost/blast radius and invalidate on change/staleness;
5. one-use confirmation proof binds actor, preview and intent; replay, conversational repetition, timeout, partial success, restart and retry cannot duplicate economic action;
6. grounding tests cover stale/missing/conflicting sources, publication clocks, unsupported claims, uncertainty and advice labels, with reproducible citations;
7. continuous private/public adversarial suites cover direct/indirect injection, tool/result poisoning, malicious documents/metadata, exfiltration, privilege escalation, recursion, cross-tenant memory and model/data poisoning for every admitted release;
8. the causal audit reproduces instruction through context/model/intent/preview/confirmation/policy/tool/order/fill/ledger/revocation without secrets or unrelated private data, and correction/export/retention work;
9. demo/evaluation/shadow/canary/live promotion and provider/model/tool change prove behavior, safety, privacy, capacity, rollback, downgrade, kill and credential revoke;
10. multi-agent/manual fault and concurrency tests prove duplicate, opposing, netting, priority, shared-budget, cancel/amend, position-attribution and feedback-loop behavior without silent interference;
11. provider/tool privacy tests prove field minimization, recipients, retention/application state, training-use rule, residency, deletion/export and no weaker fallback;
12. marketplace tests prove publisher/package/server provenance, permissions, version/change, claims, conflicts, incident/revocation and that install never grants data or trading authority;
13. severe-market, provider/region/tool loss, order/cancel storms, audit backlog and simultaneous revoke/kill stay within owner SLO/capacity and customer-truth contracts;
14. migration, compromise, suspension, provider/tool exit and wind-down leave no orphan credential, session, unknown action, order, position, money break or missing evidence.

## 16. Owner/external sockets and contradiction register

| Socket or conflict                         | Required authority / safe blank behavior                                                                                                                                                                                     |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `socket.agentic-capacity-and-modes`        | Owner/legal/risk publish eligible entities/users, modes, actions, accounts/products, autonomous budgets, approvals and disclosures. Blank: research/read-only approved surfaces only; no agentic trading release.            |
| `socket.provider-model-release`            | Owner/security/privacy publish provider/model/endpoint, evaluation, data terms, residency, retention/training use, capacity and fallback. Blank/incompatible: affected invocation refuses; no invisible substitution.        |
| `socket.tool-and-marketplace-admission`    | Owner/security/legal publish trusted publishers/servers/releases, permissions, supply-chain evidence, conflicts, support and revocation. Blank: tool not discoverable or callable.                                           |
| `socket.autonomous-risk-and-confirmation`  | Owner/risk/security publish action classes, preview fields, step-up/dual control, capital/loss/drawdown/concentration/message limits and canary/rollback. Blank: confirm-each or draft only according to existing authority. |
| `socket.agent-data-and-advice-law`         | Owner/legal/privacy publish data classes, recipients, purposes, retention/residency/training, claims/advice/disclosures and export/deletion. Blank: private data stays local/unshared and no professional-advice claim.      |
| Current five product-agent money denylist  | Remains authoritative. PX-S16 does not add trade/order/ledger tools to those agents. A future trading agent is a new admitted capacity under this contract and PX-S15, not a flag flip or denylist exception.                |
| Caller `approved` boolean                  | Useful test/runtime gate but not professional consent. Canonical truth requires authenticated one-use confirmation bound to preview/intent/account/expiry before consequence.                                                |
| Opaque `execute` callback/tool name        | Current runtime does not authorize tool arguments or record input. Professional writes require admitted typed adapters, schema validation, least privilege, input digest and module-side repeated authorization.             |
| Completion request ID versus tool replay   | Completion metering idempotency does not protect economic tools. Every consequence-bearing call needs stable business intent/call keys, authoritative lookup and partial/unknown recovery.                                   |
| Hash-chain versus complete execution audit | Append-only digests are substantive foundations, not context/consent/order proof. PX-S16's causal manifest and PX-S03/PX-S12 external reconciliation have precedence.                                                        |
| Gateway hot-swap/provider readiness        | Healthy/servable provider proves inference availability only. Provider/model/tool release changes require evaluation, privacy compatibility and bound fallback policy; otherwise high-consequence sessions pause/refuse.     |
| PX-S15 deterministic boundary              | Agent output is another proposal source. PX-S15 account, risk, order, ledger, revocation, kill, recovery and wind-down laws remain authoritative; probabilistic confidence cannot widen them.                                |

## 17. Requirement-level proof map

| Requirement   | Authoritative clauses     | Implementation truth after this specification                                                                                                                                                |
| ------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PTX-M28-R01` | §§1, 4–5, 8, 11, 14–16    | Mode and consent semantics are authoritative; current runtime sessions do not bind professional mode/elevation/trading-enabled truth.                                                        |
| `PTX-M28-R02` | §§4–5, 9–11, 13–16        | Versioned guardrail/session ownership foundations exist; complete provider/model/purpose/environment/account/expiry/credential grant is unimplemented.                                       |
| `PTX-M28-R03` | §§1, 4–5, 8–12, 14–16     | Product agents deny money writes and draft-only surfaces refuse safely; future trading-agent deterministic account/risk/order integration remains absent.                                    |
| `PTX-M28-R04` | §§4, 6, 8, 10, 14–16      | Plan/draft fragments exist; authoritative structured preview and bound impact/margin/fee/liquidation proof are unimplemented.                                                                |
| `PTX-M28-R05` | §§4, 8–11, 14–16          | Completion metering IDs and module idempotency fragments exist; tool-level business keys, lookup, stale/partial/unknown recovery and confirmation replay protection remain absent.           |
| `PTX-M28-R06` | §§2, 4, 6–8, 10–11, 15–16 | Grounded dark-refusal foundations exist; complete source manifest, citations, observation environment, uncertainty and unsupported/advice truth are incomplete.                              |
| `PTX-M28-R07` | §§2, 4, 6–7, 9–11, 13–16  | Untrusted-zone, instruction/data isolation, tool-result and continuous prompt-injection/data-poisoning evaluation semantics are authoritative; implementation is absent.                     |
| `PTX-M28-R08` | §§3–4, 8–11, 14–16        | Append-only hash-chained action audit is substantial; full protected context/intent/confirmation/policy/tool/order/fill/revocation evidence remains incomplete.                              |
| `PTX-M28-R09` | §§4–5, 7, 9–11, 14–16     | Provider health/refusal and kill/readiness foundations exist; complete demo/evaluation/shadow/canary/live lifecycle, credential revoke and evaluated degradation remain incomplete.          |
| `PTX-M28-R10` | §§4–5, 8–12, 14–16        | Multi-agent/manual conflict, attribution, atomic budget, netting, priority and feedback-loop semantics are authoritative; coordinator implementation is absent.                              |
| `PTX-M28-R11` | §§2, 4–7, 9–11, 13–16     | Audit minimizes prompt content and provider abstraction exists; complete endpoint-specific privacy, residency, training, deletion, redaction and customer export enforcement is absent.      |
| `PTX-M28-R12` | §§2, 4–5, 7, 9–11, 13–16  | Publisher/tool/package admission, permissions, provenance, claim, incident, revocation and installation-without-authority semantics are authoritative; marketplace implementation is absent. |

Every primary ID assigned to `PX-S16` appears exactly once in this map. This contract specifies product semantics; it does not promote implementation maturity, admit a provider/tool/publisher, create autonomous capital or authorize a live trading agent.

## 18. Implementation gaps and precedence

Specification completeness is not product completion. Material gaps are the agent grant/mode/consent spine; a separate admitted trading-agent capacity; structured resolver/preview/confirmation; typed tool registry and argument authorization; tool idempotency/lookup/recovery; context/source manifests; injection/poisoning isolation and continuous evals; complete causal audit; release-bound provider change/privacy; multi-agent coordinator; tool marketplace; severe-market capacity and exercised wind-down.

Precedence is: doctrine and canonical SoT; accepted owner/legal/security/privacy rulings; PX-S01/PX-S02 rule and authority; PX-S03 execution; PX-S04 data/session truth; PX-S06 risk; PX-S10 fees/conflicts; PX-S12 ledger/finality; PX-S13 incident/recovery; PX-S14 external route truth; PX-S15 deterministic automation/delegation; then this agent-specific contract. A model output, prompt, tool annotation, provider safety feature, marketplace listing, guardrail flag, approval boolean, service readiness or hash digest cannot weaken those boundaries.
