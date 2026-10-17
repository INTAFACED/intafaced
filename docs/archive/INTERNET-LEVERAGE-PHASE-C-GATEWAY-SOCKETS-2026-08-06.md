# Internet leverage — Phase C: the gateway sockets we already built

**Status:** ADDENDUM to Phase B · corrects the §4 external shortlist · does **not** supersede the per-ID map
**Date:** 2026-08-06 · tip `ea59e0b0`
**Parents:** [`INTERNET-LEVERAGE-LAW.md`](INTERNET-LEVERAGE-LAW.md) · [`INTERNET-LEVERAGE-CURRENT-AUDIT-2026-08-04.md`](INTERNET-LEVERAGE-CURRENT-AUDIT-2026-08-04.md) (Phase A) · [`INTERNET-LEVERAGE-PHASE-B-FULL-HORIZON-2026-08-05.md`](INTERNET-LEVERAGE-PHASE-B-FULL-HORIZON-2026-08-05.md)

**What this is:** three findings from a fresh survey of tip. One corrects a shortlist row that contradicts our own doctrine, one names a threat we already banned but never instrumented, and one is a whole category the map has no row for.

**What this is not:** a new per-ID map. Phase B §2 stands — every open tracker id still has its path there. Nothing here re-opens a `KILL`.

---

## 0 · Operator one-screen (Nitro)

We built sockets for third-party services as **URLs an operator sets**, not as vendor libraries inside our code. Phase B's shopping list forgot that and listed the libraries. Buying the libraries would undo the thing the sockets were built to give us.

Three actions, cheapest first:

1. **Supply-chain scanning** — we forbade "random npm on custody paths" and never installed anything that checks. Half a day.
2. **One AI gateway container** behind the URL `svc-agents` already reads — unblocks five agent features at once.
3. **Load testing** — nothing in the repo measures speed, on a platform whose core is a matching engine.

Nothing here is Class X. Nothing here touches Shehzad's plane.

---

## 1 · The correction: we buy gateways, not SDKs

### 1.1 What tip actually does

Two services already terminate at a configurable HTTP endpoint and deliberately name no vendor anywhere below it.

| Service      | Socket                                                                                                      | Source                                                                        |
| ------------ | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `svc-notify` | `NOTIFY_EMAIL_GATEWAY_URL` · `NOTIFY_PUSH_GATEWAY_URL` · `NOTIFY_SMS_GATEWAY_URL` (+ `_TOKEN` each)         | [`services/svc-notify/src/env.ts`](../services/svc-notify/src/env.ts) L92–101 |
| `svc-agents` | `AGENTS_UPSTREAM_BASE_URL` · `_AUTH_HEADER` · `_AUTH_PREFIX` · `_COMPLETIONS_PATH` · `_MODELS` · `_HEADERS` | [`services/svc-agents/src/env.ts`](../services/svc-agents/src/env.ts) L96–107 |

`channels/adapters.ts` states the rule outright:

> NO PROVIDER IS NAMED HERE OR ANYWHERE BELOW IT (§0.7). Each adapter posts to a URL the owner sets. That is also what makes swapping a provider an env change rather than a release.

`providers/upstream.ts` makes the same argument at length, and names the alternative it rejected: "hardcoding a hostname and a model id and then adding this service to the brand-scan allowlist — would have traded a real architectural property for a lint exemption."

### 1.2 Where Phase B §4 points the wrong way

| Phase B §4 row                                | Problem                                                                                                                                                                                            |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "SES/Twilio/FCM/APNs behind svc-notify"       | Importing those SDKs puts a vendor name in source **below** `adapters.ts`, which is the one thing that file exists to prevent. It also re-couples provider choice to a release.                    |
| "DFNS/Turnkey-class" for `socket.mpc-custody` | Same shape. Worth re-taking as a socket question rather than an SDK question when wallet RPC (#763) is fixed — not re-decided here, because custody is not a doctrine question this addendum owns. |

The rows are not wrong about **which capability** we need. They are wrong about **what we install to get it**.

### 1.3 The corrected rows

| Socket / row                                     | Install                                                        | Why it fits                                                                                                                                                                                              |
| ------------------------------------------------ | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENTS_UPSTREAM_BASE_URL` → `agents.*` (5 rows) | **LiteLLM proxy** (self-hosted, MIT)                           | Multi-provider routing, failover, per-key budgets, response caching, retries and cost accounting behind ONE url. `AGENTS_UPSTREAM_COMPLETIONS_PATH` already defaults to `/v1/messages`, which it speaks. |
| `socket.notify-email` / `-push` / `-sms`         | **Novu** (self-hosted) or **Postal** (mail only) + a thin shim | One deployed service instead of three SDK integrations and three credential paths. **Licence check required before adopting Novu** — it has moved toward an open-core model and this was not verified.   |

**Highest leverage in this addendum is the AI gateway row.** Five tracker rows (`agents.navigator`, `.scanner`, `.support`, `.merchant`, `.copy-intel`) all depend on "guardrails" and all need routing, budgets and failover that `gateway.ts` would otherwise grow by hand.

**Non-regression:** this changes nothing about the money plane. `svc-agents` already meters usage through `ledger-client`; a proxy in front of the model does not touch that.

---

## 2 · The threat we banned and never instrumented

Phase B §5 kills "Hot-wallet random npm — custody supply chain." At tip:

- no `.github/dependabot.yml`, no `renovate.json`
- no `pnpm audit`, no SBOM, no lockfile-integrity check in any workflow
- all three GitHub Actions pinned to **mutable major tags** — `actions/checkout@v4`, `actions/setup-node@v4`, `pnpm/action-setup@v4`

We have a mutation-tested secret scanner, a custody scan, a dual-book door scan and Gitleaks. We have nothing at all that asks whether a dependency is known-vulnerable, and nothing that stops a retagged third-party Action from running in the job that builds our images.

| Need                    | Tool                        | Licence          | Shape                                                           |
| ----------------------- | --------------------------- | ---------------- | --------------------------------------------------------------- |
| Known-vulnerable deps   | **OSV-Scanner** (Google)    | Apache-2.0       | Reads `pnpm-lock.yaml` directly; one CI job, no infra           |
| Update flow             | **Dependabot**              | free on GitHub   | Grouped updates; zero infra; no new runner minutes for scanning |
| Image CVEs              | **Trivy** or **Grype**      | Apache-2.0       | Scans what the `Dockerfile` produces                            |
| Workflow lint / pinning | **actionlint** + **zizmor** | MIT / Apache-2.0 | Catches the mutable-tag issue above                             |

**Path:** EXT · **Phase:** NOW · **Owner:** N · **Class:** N (no money path)

Licences above are stated from general knowledge and should be re-confirmed at adoption, per §5 of this file.

---

## 3 · The category with no row: nothing measures speed

There is no load test, benchmark or perf harness anywhere in the repo — no `k6`, `artillery`, `autocannon` or benchmark runner in any `package.json`.

That is a gap on a platform whose core is a 670-line order book (`services/svc-matching/src/engine/book.ts`) plus a WebSocket fan-out. It is also why §14's manual sign-off "At least one SLO dashboard panel exists in Grafana" has stayed unchecked.

**Newly actionable as of tip.** Until #889 there was no registered `TracerProvider`, so every span in all 18 services went to a no-op and Tempo was empty. Latency data now exists for the first time, which makes a perf harness something that can be compared against a baseline rather than a number with no meaning.

| Need                 | Tool                        | Licence      | Note                                                                                         |
| -------------------- | --------------------------- | ------------ | -------------------------------------------------------------------------------------------- |
| HTTP throughput      | **autocannon**              | MIT          | Smallest thing that works; wire to `svc-edge` and `svc-matching`                             |
| Scenario + WebSocket | **Artillery**               | MPL-2.0      | Fits `svc-ws` depth/tape fan-out                                                             |
| Microbenchmark       | **mitata** or **tinybench** | MIT          | The `book.ts` match loop specifically                                                        |
| _(the obvious name)_ | **k6**                      | **AGPL-3.0** | Fine as an external tool we do not distribute — but make that a stated call, not an accident |

**Path:** EXT · **Phase:** MID · **Owner:** N/D · **Class:** N

---

## 4 · Smaller rows worth a line

| Row                                | Finding                                                                                                                                                                                                                                                                                                                                                                | Suggestion                                                                                                                                                                                                             |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `infra.i18n` (100+ languages)      | `packages/i18n/src/catalogs.ts` is ~108 lines and English is still the only catalog. The typed `t()` with compile-time key enforcement is BETTER than i18next and should not be replaced.                                                                                                                                                                              | Add an XLIFF/JSON export + import around the existing catalog and point a translator platform at it — **Tolgee** (Apache-2.0, self-hosted) fits the licence posture better than Weblate (GPL-3.0). Do not touch `t()`. |
| `ops.admin`                        | `apps/admin` is ~14 page/component files (tests included); `@intafaced/ui` is one `tokens.ts` plus one `primitives.tsx`. The ledger and jurisdiction boards are data grids built by hand.                                                                                                                                                                              | **shadcn/ui** is copy-in source with no runtime dependency — components, not a second admin product — plus **TanStack Table** (MIT) for the grids.                                                                     |
| `pay.public-api`                   | Zero `openapi`/`swagger` hits repo-wide, while the row requires "Public REST + webhooks + sandbox (§9)". zod schemas already exist, and #890 established the `@fastify/*` pattern in-tree.                                                                                                                                                                             | `@fastify/swagger` + `@fastify/swagger-ui` + `fastify-type-provider-zod` (all MIT). Generates spec, docs and sandbox from schemas we already wrote.                                                                    |
| Test isolation (law §3.1 / FH §4b) | **Observed, not theorised.** Across the three PRs #889/#890/#891, a full local `pnpm verify` failed four times on four different DB-backed packages — `svc-bank`, `svc-indexer`, `packages/db`, `svc-trade` — each with a 30s hook timeout, and **each passed in isolation**. CI was green on all three because it sets a dedicated `TEST_DATABASE_URL_*` per service. | **Testcontainers** (`@testcontainers/postgresql`, MIT) — a throwaway Postgres per suite retires the nine-variable env matrix and makes a laptop verify mean what it says.                                              |

---

## 5 · Additions to the kill list (§5 of Phase B)

Do not "helpfully" adopt these. Each is hand-rolled for properties a library default would silently drop.

| Do not replace                                           | Why                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services/svc-edge/src/cors.ts` with `@fastify/cors`     | Every `OPTIONS` is terminated at the edge and never proxied; the preflight answer is computed from the `Origin` header alone so it cannot be used as a route oracle; allow-origin survives onto 404/502/503 refusals. All tested, including real Chromium. This was nearly done in the #890 session and would have been a regression wearing the costume of a cleanup. |
| `packages/ledger-client/src/money.ts` with a decimal lib | decimal.js / big.js / dinero.js each reintroduce a float or object-wrapper boundary. Scaled bigint + decimal strings is §4.2 doctrine. The right answer for money correctness is property tests over the existing code — landed as gate 25 in #891.                                                                                                                    |
| `packages/i18n`'s `t()` with i18next                     | Compile-time key and placeholder enforcement is stronger than anything runtime-keyed. Translator tooling is an export problem, not a runtime problem (§4).                                                                                                                                                                                                             |
| `services/svc-p2p/src/linear-pattern.ts` with re2js      | Already locked by law §3.2 — operator patterns keep the full JS surface. Restated here because §4 of this file touches adjacent tooling.                                                                                                                                                                                                                               |
| `@fastify/under-pressure` on `svc-edge`                  | It sheds load with 503s. On a money platform that drops an order cancel exactly when the system is busiest. Load shedding is a product decision about which calls are droppable, and nobody has made it.                                                                                                                                                               |

**Standing note on licences:** every licence in this file is stated from general knowledge and was not verified against the package at write time. Confirm before adopting, especially Novu (open-core drift) and k6 (AGPL-3.0).

---

## 6 · Ownership and collision (checked at write, tip `ea59e0b0`)

Re-derive before acting — this is a snapshot, not a claim.

| Boundary                                                   | State at write                                                                                                                                                |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shehzad plane                                              | **Untouched.** Nothing in this addendum is protocol, chain, bridge, launch contracts or dex self-custody. No `chain.*` / `protocol.*` / `launch.*` row moves. |
| `tooling/tracker/features.mjs`                             | **Held by #346** (shehzad002). No row in this file edits it, and no mountain is claimed here.                                                                 |
| `docs/LIVE-LANES.md`                                       | **Held by #800** (Phantom-X-007). Deliberately not edited — the `ext-infra-adopt` lane added in #889 already covers safe-EXT adopt work.                      |
| `.env.example`, `docker-compose.apps.yml`                  | **Held by #883** (Phantom-X-007).                                                                                                                             |
| `.gitleaks.toml`, `tooling/ci/wallet-rpc-mainnet-scan.mjs` | **Held by #888** (Phantom-X-007).                                                                                                                             |
| `services/svc-agents/**`                                   | Free — no open PR touches it. All five `agents.*` rows are `status: ready` with no owner.                                                                     |

### 6.1 What blocks the AI gateway row today

`agents.*` rows are free, but **starting one is a mountain claim**, and a claim writes `owner`/`wip` into `tooling/tracker/features.mjs` — which #346 holds. Editing it now is a dual-edit of an open partner PR.

**Unblocks when:** #346 merges or the operator releases the tracker file. Then claim one `agents.*` row and stand the gateway up behind the existing env socket. No code in `svc-agents` needs to change to point at it — that is the whole point of §1.

---

## 7 · How to re-verify this addendum

```bash
# §1 — the sockets exist and name no vendor
grep -n "GATEWAY_URL" services/svc-notify/src/env.ts
grep -n "AGENTS_UPSTREAM" services/svc-agents/src/env.ts

# §2 — nothing scans dependencies or pins Actions by digest
ls .github/dependabot.yml renovate.json 2>&1
grep -rho "uses: .*" .github/workflows/*.yml | sort -u

# §3 — no perf harness anywhere
grep -rln "k6\|artillery\|autocannon\|tinybench\|mitata" --include=package.json . | grep -v node_modules

# §4 — no OpenAPI surface
grep -rin "openapi\|swagger" --include="*.ts" --include=package.json services packages | grep -v node_modules
```

Each should return what §1–§4 claim. If one does not, tip has moved and the row is stale — fix it here rather than leaving a note for the operator (law §5, stale map hygiene).

---

## 8 · Non-claims

- Not implemented. Nothing here is installed, and no `package.json` changed in the PR carrying this file.
- Not a re-decision of any `KILL`, any `LAW` row, or any Class X row.
- Not a licence audit — §5 says so explicitly.
- Not a replacement for Phase B §2. Every open tracker id still has its path there.

_Board-Delta: Phase C addendum — gateway sockets over SDKs (corrects §4), supply-chain scanning gap, perf-harness gap, 5 kill-list additions_
