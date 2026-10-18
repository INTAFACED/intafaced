# Audit: does the tracker tell the truth?

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Date:** 2026-07-28 · **Scope:** every feature in `tooling/tracker/features.mjs` marked `done` · **Type:** docs + registry only. No service code changed.

**Trigger:** the tracker is about to be shared with the team as a plan. A feature marked `done` that nobody can actually use is worse than one marked `ready`, because `ready` invites someone to build it and `done` tells them not to bother.

---

## The headline

|         | before |  after |
| ------- | -----: | -----: |
| done    | **37** | **18** |
| ready   |     45 |     33 |
| blocked |     21 |     52 |
| socket  |     13 |     13 |
| percent |   36 % |   17 % |

**19 features were downgraded from `done` to `ready`. Nothing was upgraded.**

`blocked` more than doubled because it is computed from `dependsOn` — downgrading `token.staking` and `protocol.smart-accounts` correctly re-blocks everything standing on them. Nobody hand-set a single one.

---

## The one sentence that explains most of it

**Seven of eleven services build a tRPC router and never mount it.**

The pattern is identical every time: `index.ts` calls `createXRouter(...)`, assigns it to `appRouter`, exports the type — and never calls `app.register(fastifyTRPCPlugin, ...)`. It typechecks. It boots. It logs "ready". It serves `/health` and nothing a user wants.

`svc-ledger` says so itself, in its own source (`s2s-http.ts:87`):

> `createLedgerRouter` is constructed in `index.ts` and exported for its TYPE. Nothing registers `fastifyTRPCPlugin` here, so the tRPC procedures — and every guard on them — are unreachable from the port.

That comment was written about a security bug. It describes the shape of nineteen tracker rows.

### What is actually served, per service

Read from each `services/*/src/index.ts`, not from what the router declares.

| Service       | Mounts `/trpc`? | Actually served                                                       |
| ------------- | --------------- | --------------------------------------------------------------------- |
| svc-agents    | **yes**         | 10 scoped procedures                                                  |
| svc-identity  | **yes**         | 17 procedures + `GET /internal/rank/:userId/perks`                    |
| svc-trade     | **yes**         | 7 procedures                                                          |
| svc-token     | **yes**         | 3 procedures (`health`, `stakeOf`, `accessOf`) + `/internal/stake`    |
| svc-ledger    | no              | 3 service-authenticated S2S money routes (`registerS2sHttp`)          |
| svc-matching  | no              | order write (service-auth), public depth + market list                |
| svc-pay       | no              | `POST /webhooks/:railId` only. 13 procedures unreachable              |
| svc-bank      | no              | two **unauthenticated** `/internal/jobs/*`. 17 procedures unreachable |
| svc-protocol  | no              | nothing. 9 procedures unreachable                                     |
| svc-p2p       | no              | index.ts **never imports `./router.js`**. 15 procedures unreachable   |
| svc-blueprint | no              | index.ts **never imports `./router.js`**. 5 procedures unreachable    |

svc-p2p and svc-blueprint are the sharpest cases: their routers are not merely unmounted, they are not referenced from the entrypoint at all. Delete `router.ts` from either service and the build still passes.

---

## The gap under everything, including what is still `done`

**The edge does not exist.** `signPrincipalHeader` and `encodePrincipal` (`packages/contracts/src/edge.ts`) are called by exactly one file: `edge.test.ts`. Nothing in the repo produces a signed principal header.

`createEdgeContext` fails closed, correctly — an unsigned or absent header yields `principal: null`. So **every `scopedProcedure` in the OS refuses every caller today**, including the ones in the four mounted services.

The consequence for reading this tracker: `svc-identity` will register you and hand you a JWT, and there is no door that JWT opens. `docs/decisions/mount-boundary.md:94` states it plainly — "a mounted service is not yet reachable _as a user_."

The 18 remaining `done` features are `done` because their code is **mounted, tested, and not propped up by a stub**. Not because a logged-in human can reach them. Nobody can, yet. That caveat is now in the `features.mjs` header so it is read before the table is.

---

## Every downgrade, with its evidence

Nineteen. Grouped by why.

### A · The router is never mounted (9)

| id                        | Evidence                                                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `p2p.offers`              | `svc-p2p/src/index.ts` does not import `./router.js`. 15 procedures dead at runtime. **176 tests, zero user-facing path — and no OTC UI anywhere.**                                              |
| `p2p.escrow`              | Escrow logic and the sweeps are real and do run on boot. Nothing can enter escrow, because no trade can be created.                                                                              |
| `p2p.disputes`            | `disputes.open` / `disputes.resolve` on the unmounted router. No user can raise one; no moderator can reach one.                                                                                 |
| `p2p.reputation`          | Computed from trades that cannot happen. The one served read, `GET /internal/reputation/:userId`, is unauthenticated — the 2026-07-27 audit files it as F7, a leak.                              |
| `bank.accounts`           | `svc-bank/src/index.ts:36` builds `appRouter`, never registers it. 17 procedures unreachable. **What IS served is two unauthenticated job POSTs that move other users' money (F4).**             |
| `pay.gateway`             | `svc-pay/src/index.ts:67`, in a comment: "the router is constructed so the type is exported … mounting it is the API gateway's job (§9)." No hosted checkout or payment link exists in the repo. |
| `protocol.smart-accounts` | `svc-protocol/src/index.ts:68` exports `appRouter` for its type. `fastifyTRPCPlugin` appears nowhere in the file. All 9 procedures unreachable, `relayUserOperation` included.                   |
| `blueprint.onboarding`    | `svc-blueprint/src/index.ts` does not import `./router.js`. The §7.2 export/erase pair is unreachable — the data-ownership promise has no door.                                                  |
| `web.shell`               | See §C — it is also untested.                                                                                                                                                                    |

### B · The code has no caller at all (6)

Not "unmounted" — these have no route, no scheduler, no event consumer, and no importer. `grep` across `services packages apps` returns only the test file.

| id                  | Only caller of the core method                                                                                                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `token.emissions`   | `mintEpoch` → `token-service.test.ts` only. `svc-token/src/router.ts` has three procedures; `index.ts` starts no timer. No epoch can ever be minted.                                               |
| `token.staking`     | `stake` / `unstake` → tests only. The router exposes reads (`stakeOf`, `accessOf`) and no writes. **Nobody can stake.**                                                                            |
| `token.yield`       | `distributeRevenue` → tests only. Fees accrue nowhere; no yield is ever distributed.                                                                                                               |
| `token.buyback`     | `recordBuyback`, `burnedSupply` → tests only.                                                                                                                                                      |
| `identity.kyc`      | `approveKyc` → tests only. The read side IS wired (`kycTier` feeds the session tier the matrix reads) but nothing can write `identity.kyc_records`, so every real user is tier `none` permanently. |
| `venue.aggregation` | `@intafaced/venue-adapter` is imported by **zero** files outside its own package. `LiquiditySource` is an interface with no implementation for any real venue.                                     |

`token.staking` is the expensive one: five other features hang off it (`token.governance`, `trade.otc`, `launch.launchpad`, `academy.ambassadors`, `market.vendors`) and all five were sitting on a foundation with no write path.

### C · No tests (2)

Criterion 2 of the standard, failed outright — `apps/web` and `apps/admin` contain **zero** `*.test.ts(x)` files.

| id          | Evidence                                                                                                                                                                                                                                 |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web.shell` | 7 tsx files, no `use client`, no `useState`, no `fetch`, no WebSocket. Every price is a string literal. The file's own comment: "Every value below is mock."                                                                             |
| `ops.admin` | Has `use client` and state, and makes **no network call of any kind**. Every kill-switch, freeze and reconcile mutates a local React boolean. An operator console that appears to halt the ledger and does not is worse than no console. |

### D · Propped up by a stub (1)

| id          | Evidence                                                                                                                                                                                                                                                                                  |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pay.rails` | The `RailAdapter` interface and the conformance kit are genuinely good and genuinely tested. But `crypto-native` runs on `MemoryChain` — an in-memory reference chain, `index.ts:46`, an explicit §13 socket — and the other rail is named card-**sandbox**. Neither can move real value. |

### E · Nothing imports it (1, counted above under B)

| id           | Evidence                                                                                                                                                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `infra.i18n` | `@intafaced/i18n` is imported by zero files outside its own package. `apps/web` hardcodes English in a `copy` object whose comment calls i18n "being built in a separate worktree". The title claims "keyed from day one"; no surface is keyed at all. |

---

## The two the owner named

**`bank.*`** — svc-bank has 17 well-scoped procedures, ownership checks tightened by #58, and a real test suite. **None of it is reachable.** The router is built and dropped on the floor. The only served surface is the pair of `/internal/jobs/*` POSTs, which have no authentication and run standing orders and interest accrual for every user. `bank.accounts` → `ready`, and `bank.loans` / `bank.earn` / `bank.cards` follow it into `blocked`.

**`bank.cards`** — asked directly: is it real or a socket? **Neither.** There is no `CardIssuerAdapter` anywhere in the repo; the only match for "card" is `CardSandboxAdapter`, which is a svc-pay _payment rail_, not a card issuer. `bank.cards` was already `ready` (correct — nothing built), and is now `blocked` behind `bank.accounts`. `socket.live-issuer` correctly remains a §13 socket for the live rail behind it.

**`p2p.*` / OTC** — asked directly: is there ANY user-facing path? **No. Not one.** `svc-p2p/src/index.ts` does not import its own router. The 176 tests all drive `P2pService` directly. Separately, `trade.otc` (the RFQ desk) has never been started — it is a `dependsOn` entry and nothing more, and it is now `blocked` behind `token.staking` as well as `trade.spot`.

---

## What survives as `done`, and why

18 features. Each is mounted or genuinely imported, tested, and unpropped.

- **Phase 0 (10):** `infra.monorepo`, `infra.compose`, `infra.config`, `infra.events`, `infra.contracts`, `infra.auth-pkg`, `infra.db-pkg`, `infra.ui-tokens`, `infra.gates`, `infra.worktrees`. All are libraries or tooling with real consumers — `packages/ui` in both apps, `requireScope` from `packages/auth` on svc-trade's live order path, `scan:brand` / `scan:custody` / `db:check` / `tracker:check` all wired into `.github/workflows/ci.yml`.
- **Phase 1 (4):** `ledger.double-entry` (the S2S money plane is mounted, and #50 gave it service auth), `ledger.recipes` (`@intafaced/ledger-client` imported by every value-moving service), `identity.accounts` (register/login/refresh/logout are mounted public procedures that work), `identity.rank` (`/internal/rank/:userId/perks` is served and svc-trade reads it at order accept).
- **Phase 2 (3):** `matching.engine` (mounted plain HTTP; writes service-authed since #55), `matching.determinism` (`engine.test.ts` exists and runs), `trade.spot` (mounted `/trpc`, 7 scoped procedures, settles from the bus).
- **Phase 5 (1):** `agents.gateway` (mounted, 10 scoped procedures, 5 test files).

Its old note — "Only service that already mounts /trpc" — was stale and is corrected: four services mount, not one.

---

## Gap found, not fixed: `packages/market-data` has no tracker row

`packages/market-data` landed in #56 with `depth.ts`, a test file, and a careful design (`applyDelta` refuses an out-of-order delta rather than silently drifting). **No feature in the registry mentions it**, and like `venue-adapter` it is imported by zero files.

Not invented a row for it here — that is a product call about which feature it belongs to (`ws.gateway` is the obvious candidate, per its own §5.2 reference). Flagging it so it is decided rather than forgotten.

---

## Honest summary

The code in this repo is better than the tracker was. That is the actual finding, and it is worth saying before the numbers land badly.

The services are carefully written: scopes declared on procedures, ownership checks, idempotency that was verified rather than assumed, tests that mutation-test their own guards. What is missing is almost entirely **wiring** — four `app.register` calls, two `import` statements, a scheduler, and an edge. Nineteen features were marked `done` on the strength of the code existing, and `requires` (which only checks that a path exists on disk) could not catch it.

**36 % → 17 % is not a regression. It is the first honest reading.** The work to close most of the gap is small and mechanical; `docs/decisions/mount-boundary.md` already contains the four-step mount recipe. Doing it would take a large fraction of these nineteen back to `done` quickly — and the point of correcting them first is that someone will now actually do it, instead of reading a green tick and moving on.
