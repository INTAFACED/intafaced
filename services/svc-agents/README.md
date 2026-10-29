# svc-agents

**The agent fleet runtime and model gateway (§8.2).** Phase 5.

Owns four things: a provider-agnostic model gateway, a per-task routing table, exact per-user metering billed through the ledger, and the `agent_actions` audit trail that makes an agent accountable.

**What this service is:** the fleet runtime **and** the five Stage-1 product factories (navigator / support / scanner / merchant / copy-intel). Boot upserts their guardrails into `agent_definitions`; each mounts a metered `*.runSession`. `riskCompliance`, `coach`, and `growth` are refuse/proposal doors (not fleet `runSession` factories). Portfolio / launch remain doctrine names only until product law. An ungrounded coach is a typed refuse, not a chatbot. Growth proposes and never publishes; a dark warehouse is not a funnel.

It also holds no balances and prices nothing it does not have a rate for. Metered usage moves value exactly once, through `feeCharge`, into svc-ledger.

---

## The provider is configuration, not code

Doctrine §0.7:

> "No third-party system names anywhere in UI, API responses, or docs shipped to users."

§1 names one vendor's API as the first target for the AI layer and then requires providers to be swappable per Doctrine 5. Reconciling those two produced the central design decision in this service: **the provider's identity lives in deployment configuration and never in source.**

| Layer                           | What it knows                                                                          |
| ------------------------------- | -------------------------------------------------------------------------------------- |
| Runtime, metering, audit, API   | a routing `task`, a logical `providerId`, a model **alias** — all configuration values |
| `providers/upstream.ts`         | the wire protocol shape, and nothing about who is on the other end                     |
| `AGENTS_UPSTREAM_*` env / vault | base URL, auth header, protocol headers, alias → concrete model id                     |

The practical test of whether that is real: **swapping providers is editing env and restarting.** No code change, no different build, nothing to review.

The alternative was to hardcode a hostname and a model id and add this service to `brand-scan`'s allowlist. That would have traded a genuine architectural property for a lint exemption, and would have made swapping providers a code change in the one service that exists to make provider swaps free. The scanner was not weakened; `src/copy.test.ts` asserts the same rule from inside the package, over every file in it.

---

## API

Internal tRPC (§1). Every log query is scoped to `ctx.principal.userId` — an audit trail one user can query for another is a privacy incident wearing a feature's clothes.

| Procedure             | Scope            | Input                                      | Output                                                      |
| --------------------- | ---------------- | ------------------------------------------ | ----------------------------------------------------------- |
| `health`              | —                | —                                          | `{ ok, service }`                                           |
| `routes.list`         | `agents:read`    | —                                          | tasks, output ceilings, and the **rate each is billed at**  |
| `agent.get`           | `agents:read`    | `{ agentId }`                              | the guardrail, its permission mode and each tool’s refusals |
| `session.open`        | `agents:execute` | `{ agentId }`                              | session, with the guardrail bound to it                     |
| `session.close`       | `agents:execute` | `{ sessionId }`                            | settles open windows, then closes                           |
| `session.log`         | `agents:read`    | `{ sessionId }`                            | every action, i18n-keyed                                    |
| `run.complete`        | `agents:execute` | `{ sessionId, requestId, task, messages }` | text, token counts, cost, the audit row                     |
| `usage.current`       | `agents:read`    | `{ sessionId }`                            | what the open window would cost. Bills nothing              |
| `usage.settle`        | `admin:write`    | `{ sessionId, windowId }`                  | posts the charge. Idempotent                                |
| `usage.settleSession` | `admin:write`    | `{ sessionId }`                            | settles every open / sealed-unbilled window. Idempotent     |
| `log.mine`            | `agents:read`    | `{ limit }`                                | **the user-visible log** (§8.2)                             |

### Agents a person builds (AG-builder-01)

| Procedure       | Scope                 | Input                                              | Output                                                    |
| --------------- | --------------------- | -------------------------------------------------- | --------------------------------------------------------- |
| `own.catalogue` | `agents:read`         | —                                                  | the templates and the addable tools, money tools marked   |
| `own.create`    | `agents:read`, person | `{ template, createKey }`                          | a new draft; a retried `createKey` returns the same draft |
| `own.save`      | `agents:read`, person | `{ id, name, instructions, tools, perSessionCap }` | the draft, or a refusal code (`agents.own.*`)             |
| `own.get`       | `agents:read`, person | `{ id }`                                           | the caller's own draft and what blocks publishing it      |
| `own.list`      | `agents:read`, person | `{ limit }`                                        | the caller's own agents, newest first                     |

"Person" is the signed-in session itself (`identity:write`, no `kid` or `sub_account`), as for spend limits. A draft's tools come only from `src/own/catalog.ts`; a tool that moves money is offered so it can be refused (`agents.own.money_tool`) and is never stored, and a blank per-session cap stays blank (`agents.spend.cap_unset` blocks publishing). Building an agent moves no value. Table: `own_agents` (migration `0005`).

`requestId` on `run.complete` is supplied by the caller and is the anti-double-bill handle: a client that retries after a timeout reuses it.

### Metered agent runs

Most agent procedures are **pure**: they answer "what would this agent say" without a session, so the declared guardrail is enforced by nothing at call time and the usage is metered by nothing at all. These five drive the real runtime instead — `openSession → act → settle → closeSession` — so every tool call is guardrail-checked and audited, and the run settles through `UsageMeter` → ledger.

| Procedure              | Scope            | Input                            | Output                                                 |
| ---------------------- | ---------------- | -------------------------------- | ------------------------------------------------------ |
| `scanner.runSession`   | `agents:execute` | plane, tier law, tier, tickers   | ranked signals + what the run cost                     |
| `navigator.runSession` | `agents:execute` | plane, tier law, tier, `asks[]`  | grounded findings, **unanswered asks**, what it cost   |
| `support.runSession`   | `agents:execute` | plane, tier law, tier, `asks[]`  | cited article keys, **escalation**, gaps, what it cost |
| `merchant.runSession`  | `agents:execute` | plane, tier law, approval points | approval-rate watch + what the run cost                |
| `copyIntel.runSession` | `agents:execute` | plane, leader fixtures           | audited write path + **directory** presentation + cost |

Copy-Intel also exposes pure reads (no session): `copyIntel.buildStats` (fixtures → audited stats in **leaderId directory order**) and `copyIntel.presentDirectory` (search/filter directory, or typed refuse of returns-rank / marketing-board modes — SPEC-SOVEREIGN §4 / D26-P1-A5). Ok outputs never sort by PnL, win rate, or returns.

All five are mutations, and all five report `metering` on **every** outcome including refusals: "we refused and billed you nothing" is a claim a caller should be able to read rather than infer. Amounts are decimal strings (§0.5).

None of them calls the engine — a rank is arithmetic, and an answer is an echo of tool output — so each opens no usage window and settles to `0`. That zero is reported as a zero. A synthetic charge so a run "looks metered" would be a fabricated cost, which is the same class of lie as a fabricated price.

`navigator.runSession` sends **every** ask to `runtime.act`, including ones a caller-supplied tier matrix wrongly granted. The runtime decides, not the caller and not the run: `trade.order` is not on `navigatorAgentGuardrail()`, so `act` refuses it and its executor is never reached. An ask that produced no fact comes back in `unanswered` with the reason and who refused it — the answer gets shorter, never padded. When nothing at all was reachable the run refuses outright rather than shipping an empty finding list dressed as a result.

Identity-scoped navigator tools are also bound to the authenticated requester. `identity.session.read` refuses `subject_mismatch` when the supplied session belongs to another user; both the direct tool route and the metered runtime pass `ctx.principal.userId` into that check. The refusal is audited, returns no session data, and a tool-only run with no engine usage bills `0`.

`support.runSession` is the same spine with the desk's own honesty rules, because this is the agent whose wrong answer a user acts on. A reply cites only the article keys `support.kb.search` actually returned. A KB that refused, missed, or was never asked for **escalates to a person** (`agents.support.escalated`) — a first-class product outcome, not an error, and never a hedged sentence. A run where no source at all was reachable **refuses** (`no_grounded_read`), because an `ok` carrying an empty finding list would read like an answer. When `identity.account.read` was asked and the fixture is missing, incomplete, owner-mismatched, or smuggles a balance field, the run **refuses** (`account_state_missing` / `balance_field_forbidden`) rather than answering from the KB as if the account were checked. Tool calls are **stoppable** via `AbortSignal`: abort returns `stopped`, settles/closes what opened, and never invents a silent `feeCharge`. A request to move money escalates before a session opens: refunds are `ops.support` plus a `packages/ledger-client` recipe, and reading the KB to discover that would bill a user for a lookup that cannot change the outcome. The requester is always `ctx.principal.userId`, so a ticket or account projection belonging to someone else refuses rather than reads, and the account projection is status + KYC tier with no balance field to leak (§0.6). Money tools are undeclared on `supportAgentGuardrail()`, so a tier matrix that granted `pay.refund` still never reaches its executor — `session-run.test.ts` asserts that over the whole `SUPPORT_MONEY_TOOLS` denylist.

Also `GET /health` and `GET /ready`.

### `/ready` — honest, not decorative

| Field                     | Meaning                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------- |
| `ready`                   | Process is up (schema + listen succeeded). Always true after boot.                                  |
| `providerMode`            | `mock` (default) or `upstream`. **Mock is not production inference.**                               |
| `providers[]`             | Logical provider ids + usable/healthy (no vendor names — §0.7).                                     |
| `meteringEnabled`         | Billing kill-switch. When off (D26-P1-A6): audit-only forever — no usage_records, no feeCharge.     |
| `meteringMode`            | `billed` when the kill-switch is on; `audit_only` when off.                                         |
| `meteringAllowsFeeCharge` | Forever `false` while metering is off. Process-ready is not a silent bill.                          |
| `fleet`                   | Stage-1 matrix card (agents / runSession / bootRegistered / missing routes). Zeros if not supplied. |
| `tasks`                   | Routing task ids currently configured.                                                              |
| `usefulPath.available`    | Whether a **completion** can leave this process right now.                                          |
| `usefulPath.task`         | First completion task that is currently servable, or null.                                          |
| `usefulPath.residual`     | Why not / what this still is not (mock residual, orphan routes, outage).                            |

A green container with `providerMode: mock` and `usefulPath.available: true` means the gateway answers with the deterministic stand-in. It does **not** mean production inference is live — mock residual is intentional. Stage-1 product agents (navigator / support / scanner / merchant / copy-intel) **are** boot-registered and counted on `productAgentsRegistered` + the `fleet` card; registration is not the same as upstream AI. Process stays in the fleet when the engine is down so operators can still read session logs; degradation is `usefulPath.available: false`, not 503.

The thin useful path on the gateway itself is `runUsefulPath` in `src/useful-path.ts` (one completion, no session/ledger). Fleet metering still goes through `openSession → think → settle`.

---

## Events

**Publishes**

| Subject                             | When                          | Payload                                           |
| ----------------------------------- | ----------------------------- | ------------------------------------------------- |
| `intafaced.agents.action.completed` | an agent did something        | session, sequence, kind, task, tool, token counts |
| `intafaced.agents.action.rejected`  | a guardrail refused an action | session, sequence, `refusalCode`, tool/task       |
| `intafaced.agents.usage.settled`    | a metered window was billed   | window, amount, asset, `chargeKey`                |

No payload carries a prompt, an answer, or a model identifier. §10 keeps user content out of general stores and a durable event stream is one; §0.7 keeps vendor names out of anything shipped. Consumers get counts and codes — anything more detailed is a query against `agent_actions` under the caller's own authorisation.

**Consumes** — nothing yet. Compliance screening of refusals (§8.8) consumes `action.rejected` when svc-core-ops lands.

---

## Ledger

| Recipe                   | Reason code            | Accounts                               |
| ------------------------ | ---------------------- | -------------------------------------- |
| `feeCharge` (asset mode) | `agents.usage.metered` | user available → `houseFees('agents')` |

One recipe, one money path: settling a usage window. Nothing else in this service moves value.

The charge is keyed `agent.usage:<sessionId>:<window>`, which the ledger namespaces to `fee:agents:agent.usage:<sessionId>:<window>`. That key is recorded on `usage_windows.charge_key` alongside the resulting `charge_tx_id`, so every charge reconciles against the ledger from either direction.

---

## Metering: exact, and idempotent three times over

### Exact

`usage_records` stores **integer token counts and the rate that was in force** — never a cost. Cost is computed once per `(window, rate)` at settlement, in scaled bigint. No `number` touches a price at any point.

Where the rounding happens is the design, not a detail. A rate is "X per million tokens", so cost is `rate × tokens ÷ 1,000,000`, and that division is the only lossy step:

- **Round per call, then sum** → one rounding unit of error per call, all in the same direction. A chatty session accrues them in proportion to how much the agent spoke.
- **Sum exact counts, then round once per rate** → integer counts sum losslessly, and at most one rounding unit per rate per window remains.

The second is what happens. `usageCost` exists for display and for the spend guardrail; the bill always goes through `windowCost`. A test asserts the gap between the two is real and in the direction claimed.

Direction is `ceil`, matching `mulBps`'s fee convention in ledger-client: a fee that rounds to zero is a fee the house pays. At 18 decimals the bias is bounded at 1e-18 per rate per window.

The rate is snapshotted onto every usage record, so a price change mid-window cannot re-price calls that already happened.

### Idempotent

Three independent layers, in the order they engage:

1. **`usage_records` is unique on `(session_id, request_id)`.** A retried completion inserts the same request id, the insert is discarded, the tokens are counted once. This is the layer that does the work.
2. **The seal.** Settlement seals the window _before_ it touches the ledger, in its own transaction. A sealed window rejects further usage (trigger), so the amount is frozen the instant it is computed.
3. **The ledger key.** Re-posting `agent.usage:<sessionId>:<window>` returns the original transaction rather than a second charge.

**The order matters and is the whole design: seal → post → record the tx id.** Posting first would leave a window a concurrent completion could still grow, so a resumed settlement would compute a larger amount than the ledger had already accepted under that key — and the difference would be invisible on both sides. Sealing first means a crash anywhere after it resumes to the _same_ amount.

A retried completion is still logged — the engine really was called again — but the duplicate row carries zero cost, because zero is what it added to the bill.

### When things break

| Failure                                 | Result                                                                                                                                                |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider is down                        | Refused on health before the request leaves the process. No usage, no charge, logged `failed`                                                         |
| Provider fails mid-call                 | No usage is reported, so nothing is metered. Logged `failed`                                                                                          |
| Provider succeeded, our DB write failed | The house absorbs a call it cannot account for. The user is **not** billed — the only acceptable direction for that error — and the attempt is logged |
| Crash between seal and ledger post      | Resumes to the same sealed amount; the ledger key makes the re-post a no-op                                                                           |
| Usage arrives after settlement          | Rejected by trigger with `agents.window_sealed`, rather than being billed twice or never                                                              |

---

## Spend holds

A held reservation stays until `reconcileSpendHolds` is called with an owner-set age. A blank age refuses `agents.spend_hold_max_age_unset`. A replayed held row refuses `agents.spend_reservation_conflict` instead of calling the provider.

Nothing in the running app calls `reconcileSpendHolds` yet. The operator door (admin scope, second factor, age from owner config) is #6044. Until that lands, a stuck hold stays held.

## Guardrails: refused before execution, not after

Each agent declares a toolset and limits. `parseGuardrail` rejects contradictions at write time — a tool granted in a module the agent may not act in is refused where it is written, because a contradiction in a security policy resolves however the enforcement code happens to be ordered.

| Rule                                                                     | Refusal code                |
| ------------------------------------------------------------------------ | --------------------------- |
| Tool not in the declared toolset                                         | `agents.tool_not_declared`  |
| Tool's per-session call budget spent (`0` means disabled, not unlimited) | `agents.tool_call_limit`    |
| Tool's module not granted                                                | `agents.module_not_allowed` |
| Task not in the agent's allowed tasks                                    | `agents.task_not_allowed`   |
| Session action budget spent                                              | `agents.action_limit`       |
| Call's **worst case** would cross the session spend cap                  | `agents.spend_limit`        |
| More output requested than the agent may produce                         | `agents.output_limit`       |
| Tool needs the user's confirmation                                       | `agents.approval_required`  |
| Session closed                                                           | `agents.session_closed`     |

Two properties worth stating:

**The spend cap is checked against worst case, not expected cost.** A ceiling that one unlucky generation can cross is not a ceiling, and the real cost is unknowable until the tokens are already gone. The input estimate used for that check is deliberately pessimistic (3 chars/token, tighter than any real tokeniser) so the guardrail errs toward refusing. The recorded spend is always the provider's exact counts.

**The guardrail is bound at session open.** It is copied onto `agent_sessions.guardrail`, not referenced. Widening an agent's powers must not retroactively legitimise a call an in-flight session already made under narrower terms — the same reason `stakes.multiplier_bps` is snapshotted in svc-token.

---

## The audit log

§8.2's Agentic Law: _"Every action → `agent_actions` table + user-visible log."_ The word doing the work is **every** — an agent that only logs what succeeded produces a record in which nothing ever went wrong. Refusals are appended with the same ceremony as successes, and a refusal without a machine code is rejected by a `CHECK`.

**Append-only, in the database.** A trigger raises on `UPDATE` and on `DELETE`. There is no update path in the service, and a future one would not work either. Correcting a bad row means appending a correcting row, exactly as on the ledger.

`TRUNCATE` is deliberately not trapped: it is an owner-only privilege held by the migration role, not by the runtime role a deployed service connects with, and leaving it available is what lets a test database reset.

**Tamper-evident.** Rows form a per-session hash chain (`prev_hash → hash`), the construction svc-ledger uses for transactions. The trigger stops the service from rewriting a row; the chain makes a rewrite made _around_ the service detectable. `verifyChain` is the check. Neither alone is enough.

**Content is stored as digests, never text.** A prompt is exactly the kind of thing a user did not consent to have retained (§10). A SHA-256 still proves what was sent — replay it, hash it, compare — without this table becoming a transcript archive.

**Every log line is an i18n key plus parameters**, never rendered prose (§14 DoD 4). Storing English would freeze one locale into the audit trail and would be the one place an upstream's error text could reach a screen unnoticed. The catalogue is `src/copy.ts`.

---

## Database constraints as a backstop

The service checks these; the database enforces them regardless.

| Constraint                               | What it catches                                                    |
| ---------------------------------------- | ------------------------------------------------------------------ |
| `agent_actions_no_update` / `_no_delete` | **the audit trail being rewritten by the thing it is a log of**    |
| `usage_records_no_late_usage`            | usage landing in a period that has already been billed             |
| `usage_records_request_idx` (unique)     | a retried completion billed twice                                  |
| `usage_windows_seal_once`                | a settled window re-settled, breaking the ledger reconciliation    |
| `usage_windows_seal_complete_ck`         | a sealed window with no amount or key — unreconcilable             |
| `agent_actions_refusal_coded_ck`         | a refusal nobody can explain afterwards                            |
| `agent_actions_refusal_free_ck`          | a refused action carrying token usage — a bill for work never done |
| `agent_definitions_guardrail_shape_ck`   | a hand-written `INSERT` creating an agent with no declared limits  |

---

## Kill-switches

| Switch                                         | Effect when off                                                                                                                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agents.premiumTiers` flag (`packages/config`) | Registry / admin label only — `NOT_ENFORCED` today; **nothing in svc-agents reads it**. Do not treat the flag as a live billing gate.                                                       |
| `AGENTS_METERING_ENABLED=false`                | billing halts. **No** `usage_records` / window / feeCharge — including settle of leftover windows. Action audit still holds token counts (knowable cost without inventing a deferred bill). |
| `agent_definitions.enabled = false`            | one agent stops opening sessions; running ones are unaffected until they close. Boot re-register refreshes the guardrail only — it does **not** re-enable a killed agent.                   |

---

## Configuration

```bash
AGENTS_PROVIDER=mock                     # 'mock' (default) or 'upstream'
AGENTS_FEE_ASSET_ID=IFC
AGENTS_USAGE_WINDOW_MINUTES=60           # required; blank refuses; must divide 1440
AGENTS_METERING_ENABLED=true
ACADEMY_URL=http://svc-academy:4016      # coach spine; blank = empty catalog refuse

# Only when AGENTS_PROVIDER=upstream. Secrets come from vault in prod (§9).
AGENTS_UPSTREAM_BASE_URL=https://…
AGENTS_UPSTREAM_API_KEY=…                # matches the `_KEY` secret pattern; redacted from logs
AGENTS_UPSTREAM_AUTH_HEADER=x-api-key
AGENTS_UPSTREAM_HEADERS={"…":"…"}        # protocol version pins, tenant ids
AGENTS_UPSTREAM_MODELS={"reasoning-lg":"…"}   # routing alias → concrete model id
AGENTS_ROUTING_TABLE={…}                 # overrides the built-in default table
```

`AGENTS_PROVIDER=mock` is the default deliberately: a developer should be able to run the fleet with no upstream credential, and starting this service by accident must not be able to spend money.

---

## Running it

```bash
docker compose up -d
pnpm --filter @intafaced/svc-agents db:migrate
pnpm --filter @intafaced/svc-agents test
```

## Tests

Pure layers (no database): cost arithmetic, guardrails, adapters, **readiness honesty**, **gateway useful path**. Cost is a pure function of counts and rates, so it is tested exhaustively and cheaply, including the two assertions about _where_ the rounding happens that justify the whole `usage_records` design.

### Residual (honest — not Done by this package alone)

| Gap                               | State on tip (W6 banked; W9 residual honesty)                                                                                                                                                                          |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Guardrail registration at boot    | **Wired** — `registerProductAgentsAtBoot` upserts the five Stage-1 factories into `agent_definitions` before listen (#1336).                                                                                           |
| Stage-1 product agents (5)        | Factories + routing + metered `runSession` for navigator / support / scanner / merchant / copy-intel on tip (#1285 matrix 5/5).                                                                                        |
| Fleet integrity pins              | Mount matrix (`#1296`), money-write register deny (`#1300`), request-id free-replay (`#1306`), sealed-unbilled recover (`#1286`), money-scope pin (`#1339`), hostile fleet pin (`#1433` + `bank.withdraw`).            |
| Live data behind agent tools      | Caller-supplied fixtures. Dark / blank-tier / empty refuse unbilled. Live allowlists are Class X.                                                                                                                      |
| i18n surface keys                 | svc-agents `COPY_KEYS` complete; packages/i18n EN parity banked (`#1337`).                                                                                                                                             |
| Production inference              | `AGENTS_PROVIDER=upstream` + vault credentials (Class X). Mock residual on `/ready` is intentional.                                                                                                                    |
| Agent pricing §8                  | Rates on routing table / env; blank rate refuses. Product magnitudes are Nitro-only.                                                                                                                                   |
| Metering kill-switch              | **Wired** — `AGENTS_METERING_ENABLED=false` writes no `usage_records`, posts no `feeCharge` (including settle of leftover windows). Token counts on action audit only. Re-open usage_records only with product ruling. |
| Admin multi-window settle         | **Wired** — `usage.settleSession` is `admin:write` multi-window (#1426). `usage.settle` remains per-window; `session.close` still settles.                                                                             |
| v2 agents (portfolio…growth)      | Doctrine names only — no factory until product law.                                                                                                                                                                    |
| Full premium-tier product surface | Phase 5 shell UX + live planes on top of this runtime. `agents.premiumTiers` flag is `NOT_ENFORCED` (registry only).                                                                                                   |

The money and audit paths run against real Postgres with the ledger's in-memory reference implementation, which the conformance suite proves equivalent to svc-ledger's Postgres engine (§4.4). Real Postgres because every property worth testing here — append-only, the window seal, the unique request id — lives in the database, and a fake would test the fake.

`src/copy.test.ts` runs the brand law over every file in the package. It spells the forbidden names in pieces so the test that enforces the rule is not the thing that breaks it — which is strictly better than allowlisting the file and carving a permanent hole in the rule in order to test the rule. It also plants a violation and asserts the check catches it: a scanner nobody has seen fail is a scanner nobody should trust.

Failure branches covered: an unrouted task, a route naming an unregistered provider, an engine outage, a transient blip retried, a tool that threw, a guardrail widened mid-session, usage arriving after settlement, and settlement run three times.

## Service keys: ledger calls

The ledger client signs with svc-agents' own key when `S2S_AUTH_MODE`, `S2S_SIGNING_KID` and `S2S_SIGNING_KEY` are set (`dual` also sends the shared secret, `keypair` the key only); unset, it signs with the shared secret as before. Setup and rotation: `services/svc-ledger/CALLER-BINDING.md`.

## Service keys: inbound doors

`/trpc` names the caller from its own service key when `S2S_AUTH_MODE`, `S2S_KEYRING` and the signing pair are set: `dual` accepts the key and the shared secret, `keypair` the key only. Unset, the shared secret works exactly as before. A key-signed call that fails is refused and never retried against the shared secret. Usage settle still runs only for a call named svc-agents. Setup and rotation: `services/svc-ledger/CALLER-BINDING.md`.

## Service keys: outgoing calls

Beyond the ledger, svc-agents' other hand-signed calls sign with its own key when `S2S_AUTH_MODE`, `S2S_SIGNING_KID` and `S2S_SIGNING_KEY` are set (`S2S_KEYRING` too for the inbound door): affiliate accrue and payout and the account and session reads go to svc-identity, the curriculum read to svc-academy, merchant watch metrics to svc-pay and copy leader fixtures to svc-trade. `dual` also sends the shared secret, `keypair` the key only. Unset, they are signed with the shared secret exactly as before.
