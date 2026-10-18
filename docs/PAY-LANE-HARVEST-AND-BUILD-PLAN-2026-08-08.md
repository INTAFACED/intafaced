# Pay lane — harvest findings and build plan

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Date:** 2026-08-08 · **Tip read:** `8519bea5` · **Method:** ten parallel read-only scouts over the fresh tip, every load-bearing claim re-verified by the lead agent directly against the code.

Provenance tags: **RAN-IT** = the lead agent executed the check. **AGENT** = a scout reported it and the lead confirmed by reading the cited code. **DOC** = quoted from a repo document.

---

## 1 · The headline

Three defects were found in already-merged code. Each is more valuable than any of the nine mountains this lane was dispatched to build, and one of them makes most of the nine pointless until it is resolved.

### 1.1 No merchant can authenticate to Pay at all — **RAN-IT**

The four merchant permissions (`pay:read`, `pay:write`, `pay:refund`, `pay:payout`) are all listed in `WITHHELD_FROM_SESSION` in `packages/auth/src/scopes.ts:265`. The written justification beside them is _"Merchant acquiring surface — granted by merchant onboarding."_

Merchant onboarding does not grant them. Nothing does.

- Every `pay:*` reference in non-test source is a **consumer** — `scopedProcedure('pay:write', …)` in `services/svc-pay/src/router.ts`, `principalOf(req, reply, 'pay:read')` in `services/svc-pay/src/public-rest.ts`. Not one is a grant.
- `assertDelegatableScopes` (`packages/auth/src/scopes.ts:329`) refuses any scope the granting session does not hold, and `grantorScopes` comes from the verified principal, never the request body (`services/svc-identity/src/router.ts:656`).
- `services/svc-identity` contains zero non-test references to any `pay:*` scope.
- The only callers that authenticate are our own e2e scripts (`services/svc-pay/scripts/card-sandbox-e2e.mjs`, `live-rail-e2e.mjs`), which sign their own principals with the internal edge key.

**Consequence:** the entire merchant surface — tRPC and REST both — is unreachable in production by any real merchant. The test suite is green because the tests forge credentials no merchant can obtain.

This is already known and written down: `docs/DIRECTION-2026-07-31.md:88` — _"`pay:write` is withheld with **no granting mechanism at all** — so the entire merchant surface is unreachable in production today. The gate is KYB tier. **Mine to decide, not agent-inventable.**"_ It is DIRECTION §8.4, owner-only.

The scope file's own header explains the design exists so that _"a scope nobody can be issued"_ cannot happen by accident. It happened anyway: the intended grant path was written down as the justification and never built.

### 1.2 The public payments API returns 404 for every external call — **RAN-IT**

`services/svc-pay/src/public-rest.ts:70` sets `const BASE = '/api/pay/v1'`. The edge strips the `/api/pay` prefix before forwarding — `services/svc-edge/src/routes.ts:74` declares the pay upstream with no `preservePath`, and `resolve()` at `routes.ts:180` does `pathname.slice(upstream.prefix.length)`.

So `/api/pay/v1/payments` arrives at the pay service as `/v1/payments`, which it does not serve. All 11 public endpoints are unreachable from outside. The first `curl` in our own published merchant quickstart does not work.

Every other pay mount follows the strip convention correctly (`/trpc` at `index.ts:390`, `/webhooks/:railId` at `index.ts:351`). The REST surface is the only one that double-counts the prefix.

Four merged PRs (#988, #994, #1006, #1014) and a large test file missed it because every test injects at the internal path against a bare Fastify instance. There is no edge-level reachability test for pay — `services/svc-edge/src/routes.test.ts` contains zero pay assertions.

**Precedent, six lines away in the same file:** a comment above the indexer route records that `svc-indexer` once 404'd at the edge identically, ending _"A service reachable only from inside the network is not reachable."_ Same bug class, caught once, recurred.

**Fix:** change `BASE` to `'/v1'` and keep the public-facing `servers: [{ url: '/api/pay/v1' }]` in the OpenAPI document so the advertised external path stays correct. Do **not** use `preservePath: true` on the edge route — that would break `/api/pay/trpc` and `/api/pay/webhooks`, which rely on stripping. Add one edge-level assertion so it cannot recur.

### 1.3 Suspending a merchant does not stop their money leaving — **RAN-IT**

`merchant.status !== 'active'` is checked in exactly two places in the whole service: `services/svc-pay/src/payment-service.ts:945` (open checkout) and `:1155` (create payment).

`settleWindow` (`:1737`), `prepareSettlement` (`:1812`) and `payoutSettlement` (`:1933`) all call `getMerchant(...)` and never read `.status`. A merchant suspended for fraud stops taking new payments and continues to be settled and paid out on everything already booked.

**The tracker states the opposite in writing.** The `pay.gateway` note in `tooling/tracker/features.mjs` reads _"`payment.create`, `checkout.open`, `settlement.run` and the withdrawal path all gate on `merchants.status`, never on KYB."_ Two of those four do. Anyone auditing this row from the board would conclude it is covered.

Migration `drizzle/0006` asserts in its own header that _"`merchants.status` is the switch that decides WHETHER money flows at all"_ — not true of the outbound half.

**Fix:** one guard in `settleWindow` before `prepareSettlement`, one in `payoutSettlement` before the `withdrawHold` post, reusing the existing `pay.merchant_inactive` code. Confirmed independently by two scouts and by direct reading.

---

## 2 · The board does not describe the code

A systemic finding, not three coincidences. Every pay row examined has a tracker title that names capabilities its governing spec does not.

| Row           | Tracker title says                              | `docs/SPEC-PAY-VERTICALS-2026-08-02.md` says                                     |
| ------------- | ----------------------------------------------- | -------------------------------------------------------------------------------- |
| `pay.psp`     | own the merchant, digital KYB, custom pricing   | §1 is **rail orchestration**; never says any of the three; puts KYB under payfac |
| `pay.routing` | geo, method, risk, approval rate                | §5 mandates **none of the four**; mandates four different things                 |
| `pay.payfac`  | sub-merchant trees, **14 permission areas**     | §2 has **no done bar at all** — 15 lines of prose, one design constraint         |
| `pay.plugins` | Woo / Magento / OpenCart                        | **no plugins section exists** in the spec                                        |
| `pay.gateway` | branded gateway, hosted checkout, payment links | **no gateway section exists** in the spec                                        |

**The 14 permission areas do not exist — RAN-IT.** The phrase appears in exactly six files (`tooling/tracker/features.mjs:413`, `tooling/coverage.yaml:896`, `INTAFACED_DEFINITIVE_BUILD.md:677`, plus three derived board renders). All six are the same title string copied between boards. Nobody ever enumerated them. The only implementation hint anywhere is the words "svc-pay role grants", and no role-grant table, type or module exists.

Building to these titles means inventing product law. Building to the spec means building something real but differently shaped, and in several cases smaller.

**Three tracker notes are factually wrong or stale:**

- `pay.gateway` — claims settlement gates on merchant status (§1.3 above).
- `pay.rails` — names a single-process `MemoryBroadcastStore` as a production blocker. `PostgresBroadcastStore` exists (`rails/broadcast-store.ts:123`), has migration `0004`, and is the one wired at boot (`index.ts:88`). That residual is closed.
- `pay.public-api` — describes step 3 as "in flight" and step 4 as future. Both merged (#1006, #1014), and step 5 merged too (#1024, 2026-08-07). The board row still calls step 5 the open residual.

---

## 3 · Two documents contradict each other on the product

### 3.1 Crypto subscriptions cannot work as promised — **RAN-IT**

`INTAFACED_DEFINITIVE_BUILD.md:607` promises _"subscriptions (recurring pull via user-granted allowances)."_

`services/svc-protocol/src/session/spec.ts:41` puts `approve`, `permit`, `transferFrom`, `increaseAllowance`, `setApprovalForAll` and the Permit2 `approve` on `FORBIDDEN_SIGNATURES`. `SessionKeyLib.sol` refuses them **at grant time** — a session key with outbound-transfer power cannot be constructed, on the stated reasoning that _"an allowance is a delayed transfer."_

The chain port confirms it structurally: `CryptoChainPort` (`rails/chain-port.ts:62`) has exactly three methods — `acceptanceAddress`, `inboundTransfer`, `send`. There is no pull of any kind.

**Consequence:** a crypto subscription on this codebase is an **invoice-and-watch** loop. Our schedule decides when to _ask_; it never decides when to _take_. That is a real and useful product (recurring invoicing with automatic reconciliation) but it must be named that way in the API, the docs and the merchant screens, or we claim an automation that does not exist.

### 3.2 CI disagrees with itself about who owns svc-pay — **AGENT**

`docs/adr/2026-08-04-pay-rails-and-psp-socket.md:73` records that `tooling/ci/unreported-suites.mjs` and `tooling/ci/gates.mjs` still name `svc-pay` as M1–M7 human-locked while tip law says reclaimed — _"Two sources disagree inside the same CI run right now; one of them is wrong and neither knows it."_ Unresolved at tip.

---

## 4 · The claim fence, resolved

**Corrected position.** My first read was that the lane was hard-blocked. That was over-cautious; the correct answer is narrower.

**How the fence works — RAN-IT.** `tooling/ci/claim-check.mjs:140` pushes `services/svc-<module>` as an owned path for _any_ feature with a non-null owner, and `tooling/scripts/path-collide.mjs:5` matches bidirectionally on `/` boundaries. So any owned `module: 'pay'` row locks the entire `services/svc-pay` directory, including files that do not yet exist. This is deliberate, not an artifact — the header explains it was added precisely because path-only checking reported `clear` for unstarted human mountains, and it names `pay.fraud` as one of the rows agents were wrongly dispatched into.

**Who actually holds the lane:**

| Row              | Owner            | Real status                                                                                                                                                                                                                                                                                                                      |
| ---------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pay.gateway`    | `Nitro`          | Him. Released to agents per his 2026-08-08 dispatch. `AGENTS.md:16`, `docs/LIVE-LANES.md:12,15` and `docs/COORDINATION-TRUTH-LAYERS.md:111` all record pay as reclaimed, ordinary Class M from tip.                                                                                                                              |
| `pay.public-api` | `nitro-money-w3` | **Ghost — RAN-IT.** Branch `feat/pay-residual-stage3` does not exist on the remote. No open PR touches `services/svc-pay`. `docs/ops/claims/TRK-pay.public-api.md` already marks the claim closed on 2026-08-07 with a note that it was reporting _"a session that no longer exists."_ The `docs/LIVE-LANES.md:25` row is stale. |
| other seven      | `null`           | Genuinely free, `status: 'ready'`.                                                                                                                                                                                                                                                                                               |

**claim-check is advisory** — its own header (`:33`) says _"not wired into `verify` and it does not gate a merge"_, and `tooling/ci/gates.mjs:302` lists it under `NOT_GATES`. Nothing in `.github/workflows/ci.yml` or `tooling/ci/verify.mjs` invokes it.

**Conclusion:** the lane is workable. The remaining obstacle is procedural, not technical — multi-dev law (`CLAUDE.md` non-negotiable 5, `docs/COORDINATION-TRUTH-LAYERS.md:60`) requires a `tooling/tracker/features.mjs` edit to claim a mountain, and that file is fenced to another lane for this wave. **Whoever lands the ownership release must clear both `pay.gateway` and `pay.public-api`** — clearing only the first leaves the directory locked by the ghost.

---

## 5 · The nine mountains, honestly graded

Ranked by value per unit of work, not by the order they were dispatched in.

| #   | Mountain                | Real state                                                                                                                                                                                                                                                                                | Honest slice                                                                                                                                                                                                                                                                     | Size                        |
| --- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| 1   | **`pay.settlement`**    | Never assessed — defaulted to `ready` and sat there. The crypto half is ~85% **built**: two-phase freeze-then-post, per-asset idempotency via a unique index, a DB conservation constraint (`gross = fees + net`), ceil-rounded fees, ledger-only movement, refuse-path tests throughout. | Add the two missing status guards (§1.3); validate `destination.kind` against the rail — today a crypto payout accepts an IBAN and passes it to `chain.send`; register a `bank-payout` adapter with `mode: 'absent'` so "settle to bank" refuses by name via existing machinery. | **4 × S**                   |
| 2   | **`pay.public-api`**    | Genuinely strong build — all 11 routes, auth, idempotency, webhook signing, sandbox routing, all with refuse-path tests. Dead at the edge (§1.2).                                                                                                                                         | The `BASE` fix, one edge reachability test, refresh the stale board and tracker rows.                                                                                                                                                                                            | **3 × S**                   |
| 3   | **`pay.routing`**       | Mis-titled. The **seam is already cut, named and tested** — `selectPublicCheckoutRail` (`rails/posture.ts:412`) has five passing refuse-path tests and its own comment says routing _"replaces this function and nothing else."_                                                          | A named routing seam that walks the rail set, skips every rail that cannot honestly accept, and records a per-decision reason (including every rail considered and why each was skipped) into the append-only `payment_events`. Zero new inputs, zero invented numbers.          | **2 × S + 2 × M**           |
| 4   | **`pay.fraud`**         | The opposite of expected. **Chargebacks are the buildable part** — four ledger recipes exist, tested, exported (`packages/ledger-client/src/recipes/chargeback.ts`), plus a full dispute port on `RailAdapter`. Only the middle is missing. Risk scoring is the blocked part.             | The `disputes` table, the `dispute.*` case in `applyWebhook` (a verified dispute delivery is currently recorded and silently ignored), the `settled → disputed` transition the map already permits, and a sandbox dispute producer. Ships `Done (sandbox)`.                      | **L**                       |
| 5   | **`pay.subscriptions`** | The schedule half is **already written in `svc-bank`** — pure clock-free occurrence arithmetic, executions-table-as-truth, `unique(scheduleId, occurrence)`, stranded-claim sweep, external-cron-not-setInterval. Transplantable, not designable.                                         | Mandate object + executions table + charge driver keyed `pay.subscription:<subId>:<occurrence>`, re-consent refusal, bounded dunning reusing the existing webhook ladder. Crypto ships as recurring **invoicing** (§3.1).                                                        | **2 × S + 3 × M**           |
| 6   | **`pay.psp`**           | Two competing done bars (§2). Under the spec's reading ~70% is buildable; under the tracker's, ~25%. Cannot ever reach bare `done` — "two different rails" needs a second live rail, which is a sponsor bank.                                                                             | Rail-outage typed refusal (distinct from rail-unsupported, which exists); durable submission outbox; reconciliation against the rail boundary.                                                                                                                                   | **1 × S + 3 × M**           |
| 7   | **`pay.gateway`**       | ~90% built. Payment links exist and are properly tested (a prior assumption of mine, corrected). Remaining gap is the KYB flag having no consumer, plus §1.3.                                                                                                                             | Wire `kybStatus` into the money gates with a distinct `pay.kyb_required` code — **but only after a real approver exists**, or every live merchant bricks.                                                                                                                        | **S, sequenced after §6.1** |
| 8   | **`pay.payfac`**        | Blocked one layer lower than the board suggests. Not by `pay.psp` — by `uniqueIndex('merchants_user_idx')` on `db/schema.ts:91`, one merchant per account at the database level, with no parent column. `'payfac'` is already an accepted `merchant.create` input that changes nothing.   | Tree migration (`parent_merchant_id` + `settling_party`, the spec's one hard constraint), ancestor-aware ownership check, cycle/depth refusal.                                                                                                                                   | **2 × M**                   |
| 9   | **`pay.plugins`**       | No spec, no board file, no code, and no PHP path in CI. The house already ruled: _"Wrong stack; pay.plugins is residual craft on our API."_                                                                                                                                               | **Not three plugins.** A decision doc, frozen webhook signature vectors, the three undocumented contract details, and one TypeScript reference client whose tests fail when the API breaks.                                                                                      | **3 × S + 1 × M**           |

---

## 6 · What only Nitro can decide

1. **Who grants a merchant `pay:read` / `pay:write` / `pay:refund` / `pay:payout`, and after what check.** DIRECTION §8.4, already flagged owner-only. **Nothing on the merchant surface is reachable until this exists.** Highest priority by a wide margin.
2. **Which done bar governs `pay.psp`** — the spec's rail-orchestration definition, or the tracker's title. Changes the work substantially and settles whether `merchant.mode` survives at all.
3. **The 14 permission areas for `pay.payfac`** — enumerate them, or drop the claim from the title. They have never been written down.
4. **Wiring the chargeback recipes.** `packages/ledger-client/src/recipes/chargeback.ts:10` carries an explicit banner: owner sign-off required, DIRECTION §3 Class M carve-out, four named questions. The file merged unwired; the sign-off gate moved from landing it to calling it.
5. **The crypto-subscription contradiction (§3.1)** — amend the build doc, or open a §13 socket for the pull mechanism. Either way one document is currently lying.
6. **The `pay.gateway` tracker wording.** It can never reach bare `done`; card acquiring is a commercial relationship. Its honest ceiling is `Done (crypto-native live; card absent — socket.psp-partners)`.

Class M carve-outs that stay with him regardless (`docs/DIRECTION-2026-07-31.md:91`): anything moving value to an external counterparty, anything granting or widening a scope, anything adding or changing a ledger recipe, anything touching a posture gate, kill-switch or custody scan.

---

## 7 · CI traps that would have bitten this lane

- **`value-gate` stamp-mill rule.** Nine near-identical `feat(svc-pay): …` PRs off four parallel streams is exactly the signature it was built to catch. Two siblings warn; **the fourth consecutive one is red**. It runs `VALUE_GATE_STRICT=1` in CI and is _not_ in `pnpm gates`, so local verify stays green and it fails only in CI. Mitigations: write titles describing genuinely different work, and wire what you add — similarity alone never blocks; a symbol nothing outside the PR calls is the real trigger, and it also trips the `reachability` gate.
- **`fabricated-money` is at zero tolerance.** `BASELINE = {}`; every prior debt paid. The way this lane trips it is not a fake price on a page but an **invented increment** — a settlement fee default, a plan-price fallback, a routing cost weight. Those are also DIRECTION §8.6 numbers. Refuse-closed with a named error; never default.
- **Ratchet gates fail in both directions.** `skip-honesty`, `fabricated-money`, `test-typecheck`, `shell-brand` and `dependency-audit` all go red if you _fix_ a listed item without deleting its baseline row in the same PR.
- **`format:check` is step 2 of verify and covers `**/*.md`.** One unformatted markdown file blocks every gate behind it; it has taken main red three times.
- **DB-dependent suites: 53, not ~42 — AGENT.** 45 Postgres-gated plus 9 chain-gated, 53 unique of 333 total. Plus 9 suites that cannot report either way.
- **Free win available now.** `tooling/ci/unreported-suites.mjs` lists `services/svc-pay/src/payment-service.test.ts` as a private-probe debt whose stated lift condition — _"LIFTS WHEN: #346 merges"_ — was met on 2026-08-06. A one-line change to `postgresAvailable` plus deleting the entry pays it off and unblocks `infra-verdict` from reporting COMPLETE.

---

## 8 · Recommended sequence

Everything below assumes the ownership release lands clearing **both** owner fields.

1. **The three defects first** (§1.2, §1.3, and the private-probe debt). All small, all high-value, none needing a decision. They fix shipped code that is currently wrong.
2. **`pay.settlement` and `pay.public-api`** — nearest to done, cheapest to finish.
3. **`pay.routing`** — the seam is pre-cut.
4. **`pay.fraud` chargebacks** _(after decision 4)_ and **`pay.subscriptions`** — both large but honest.
5. **`pay.psp`, `pay.payfac`** _(after decisions 2 and 3)_.
6. **`pay.plugins`** last, reclassified as a decision doc plus a reference client.

`pay.gateway`'s KYB wiring is sequenced after decision 1, not before — turning that gate on without a real approver bricks every live merchant.

**Do not order the lane around `pay.gateway`.** Its `wip` is a truthful label on a mountain that is ~90% built, and none of the five rows nominally depending on it is actually waiting for the missing 10%.
