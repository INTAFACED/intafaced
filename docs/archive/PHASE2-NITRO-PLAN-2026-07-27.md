# Session 1 orientation + Phase 2 claim plan (Nitro)

**Audience:** Nitro (director)  
**Date:** 2026-07-27  
**Status:** session-1 product — where the repo is, what Denon holds, what you claim next  
**Claim tags:** `[VERIFIED 2026-07-27]` = checked this session · `[ASSUMED]` = not re-checked

Collab process details (reviews, Free GitHub, worktrees): see [`COLLAB-AUDIT-2026-07-27.md`](COLLAB-AUDIT-2026-07-27.md). This file is **build status + broker (Trade) plan only**.

---

## Verdict

**Phase 1 Core is on `main` and healthy enough to start Phase 2.** Denon already has the Phase-2 keys (matching engine, web shell, admin, i18n) in open green PRs. **Do not re-build those.** Your highest-leverage broker move is: **review his matching PR, then claim `trade.spot` (svc-trade) in small slices after it merges.**

---

## Where the project actually is (not the pitch)

| Layer                    | Reality `[VERIFIED 2026-07-27]`                                                                                                                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Progress                 | **20 / 103 features shipped (19%)** — tracker board                                                                                                                                                                     |
| Phase 0                  | **10/11** — only `infra.i18n` open (Denon PR #29)                                                                                                                                                                       |
| Phase 1 Core             | **10/12** on main: `svc-ledger`, `svc-identity`, `svc-token` + shared packages. Open leftovers: `identity.webauthn`, `token.governance` (neither claimed)                                                               |
| Phase 2 Trade            | **0/16 on main.** Engine + shell exist only as Denon PRs, not merged                                                                                                                                                    |
| Packages ready for Trade | `ledger-client` already has `tradeFill` (6-entry fill), holds, fee paths · `events` already declares matching order accepted/filled/cancelled · `exchange-contract` + `venue-adapter` exist for later bot/terminal work |
| On disk services         | Only three: identity, ledger, token. No `svc-matching`, `svc-trade`, `apps/web` on main                                                                                                                                 |
| Tracker honesty          | **0 wip** — open Denon work is **not** marked `owner`/`wip` yet (collision risk if someone claims from tracker alone)                                                                                                   |
| Remote                   | `Phantom-X-007/intafaced` · default `main` · CI green on recent main and all open PRs                                                                                                                                   |

### Local main checkout caveats

| Item      | Note                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------ |
| Branch    | `main`, **1 commit ahead of origin** (`docs(agents): sandboxed GitHub token load…` — Nitro) — **not pushed** |
| Dirty     | `CONTRIBUTING.md` modified; `docs/COLLAB-AUDIT-2026-07-27.md` untracked                                      |
| Worktrees | None yet (`pnpm wt` not used this session)                                                                   |
| Rule      | **Still: never implement features in this checkout** — only pull/read                                        |

---

## Machine health proof

Run on this machine, main checkout, after `pnpm install` (local pnpm via `.tools/` because system pnpm/corepack were unavailable).

| Check                      | Result                   | Notes                                                                                          |
| -------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------- |
| `pnpm install`             | **Green**                | 13 workspace packages, lockfile clean                                                          |
| `pnpm test`                | **Green**                | All package unit suites passed                                                                 |
| Postgres integration tests | **Skipped** (not failed) | `svc-ledger` / `svc-identity` / `svc-token` DB tests skip without `TEST_DATABASE_URL` + Docker |
| `pnpm typecheck`           | **Green**                | 12 packages                                                                                    |
| `pnpm scan:brand`          | **Green**                | 147 files, 0 forbidden names (after removing accidental in-repo `.pnpm-store`)                 |
| `pnpm scan:custody`        | **Green**                | No Protocol Plane services yet                                                                 |
| `pnpm db:check`            | **Green**                | 3 migrations, all reversible                                                                   |
| `pnpm gate`                | **Green**                | svc-identity · svc-ledger · svc-token DoD automated path                                       |
| Docker Compose             | **Not run**              | `docker` binary / socket **not available** in this agent environment                           |
| CI on GitHub               | **Green**                | Open PRs #25–#29 all SUCCESS on Doctrine / Typecheck / Tests / DoD                             |

**Plain language:** the code that is already on main is healthy under unit tests and doctrine gates. Full “stack up” (Postgres ledger integration + compose) was **not** proven here because Docker is missing on this runner. GitHub CI green on main/PRs is the second witness.

---

## Denon’s open work — do not double-build

All by `@Phantom-X-007`, **CI green**, **0 reviews**, mergeable.

| PR      | Branch                     | Tracker id                                          | Size      | What it is                                     | Nitro action                      |
| ------- | -------------------------- | --------------------------------------------------- | --------- | ---------------------------------------------- | --------------------------------- |
| **#26** | `feat/matching-engine`     | `matching.engine` (+ claims determinism done in PR) | ~3.3k add | Orderbook engine, journal, replay, kill-switch | **Review first** — unblocks Trade |
| **#27** | `feat/web-shell`           | `web.shell`                                         | ~2.5k     | `apps/web` shell + trade page scaffold         | Leave · review when small time    |
| **#28** | `feat/admin-console`       | `ops.admin`                                         | ~3.0k     | `apps/admin` operator console                  | Leave                             |
| **#29** | `feat/i18n-scaffold`       | `infra.i18n`                                        | ~2.3k     | `packages/i18n` + scan                         | Leave                             |
| **#25** | `fix/config-operator-gaps` | (config flags / jurisdiction)                       | ~270 add  | Small ops config fix                           | **Easy review first** (warm-up)   |

**Ready-on-tracker but already spoken for by open PRs:** `matching.engine`, `web.shell`, `ops.admin`, `infra.i18n`. Treat them as **Denon’s until merged or abandoned** even though tracker still shows 🟢 (owner not set).

---

## Ready to claim vs leave alone (broker lens)

### Leave for Denon (or only review)

- Matching engine · web shell · admin · i18n · config operator gaps (open PRs)
- Anything Protocol Plane (`protocol.*`) unless he asks you to own self-custody — separate risk surface

### High leverage for **you** (broker / Phase 2)

| Priority | Feature                                                 | Status after Denon #26        | Why                                                                         |
| -------: | ------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------- |
|    **1** | **`trade.spot`** — svc-trade spot markets, orders, fees | Unblocks when matching merges | Real broker product + **money path** (hold → match → `tradeFill` → release) |
|        2 | `ws.gateway`                                            | After matching                | Depth/trades/orders streams terminals need                                  |
|        3 | `matching.determinism`                                  | May land inside #26           | Only claim if still open after merge                                        |
|        4 | `trade.convert`                                         | After trade.spot              | Retail one-tap path                                                         |
|    later | `trade.futures` / copy / OTC / terminal                 | After spot solid              | Do not skip spot discipline                                                 |

### Ready but **not** Phase-2-first (don’t start unless you want side work)

`identity.webauthn` · `token.governance` · `pay.gateway` · `p2p.offers` · bank/agents/academy/market/ops.\*

These are real and unblocked, but they **do not** advance the broker heart. Pay/P2P are Phase 3 product lines.

---

## Recommended ordered PR plan (Nitro)

### Move 0 — today, no worktree (collab)

1. On GitHub: **review PR #25** (small) then **PR #26 matching** with money/doctrine eyes: no balances in engine, journal before process, events match catalog, no vendor names in UI copy.
2. Telegram: say you’re claiming **trade.spot after matching merges** so he doesn’t start it.
3. Optional: ask him to set `owner` + `wip` on open PRs in `features.mjs` so tracker matches reality.

### Move 1 — first **code** claim (after you approve this slice)

**Claim: `trade.spot` (svc-trade), sliced — not one mega PR.**

| Slice PR | Scope                                                                                      | DoD (plain)                                                              | Risks to raise before coding                                       |
| -------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| **T1**   | Contracts + events for trade product surface (if anything missing beyond matching catalog) | Schemas reviewed alone; no service yet                                   | Agent protocol: contract PR **before** service PR                  |
| **T2**   | `svc-trade` scaffold: markets read, env, schema, README, kill-switch hook                  | Service boots; gate path starts; no money yet                            | One service only                                                   |
| **T3**   | Order accept path: risk checks + **`ledger.hold`** + submit to matching                    | Insufficient funds rejected; hold idempotent; no fill yet                | **Money path** — ≥95% coverage, failure branches, no float amounts |
| **T4**   | Fill consumer: matching `order.filled` → **`tradeFill` recipe**; cancel → release hold     | Ledger reconciles on multi-fill sim; double-delivery no double-fill      | Crash mid-fill must not strand user funds                          |
| **T5**   | Fees + rank discount branch + XP emit                                                      | Fee math matches recipe tests; IFC discount wired via identity rank read | Brand scan; no vendor names                                        |

**Definition of Done for the whole `trade.spot` claim (tracker `done`):**

- Spot market CRUD/list + order lifecycle live against matching
- Every value move only via `packages/ledger-client` recipes
- Reconcile / invariant tests green; `pnpm verify` green on the PR
- Tracker: `status: 'done'`, `requires` lists real paths
- Denon (or you) human-approved the money slices before merge

### Move 2 — after trade.spot baseline

- `ws.gateway` (live book to terminal)
- `trade.convert` (retail path)
- Leave pro terminal polish to whoever owns `web.shell` after it merges

### Explicitly not first

- Futures / options / OTC / copy / forex / algo / MM bot — all blocked on solid spot money path
- New architecture, second ledger, or “temporary” balances in svc-trade

---

## Implicit requirements (raised before you have to ask)

| Rule                               | Why it bites on Trade                                                            |
| ---------------------------------- | -------------------------------------------------------------------------------- |
| **Ledger is law**                  | svc-trade never holds a balance; only account ids + ledger posts                 |
| **No money in `number`**           | Prices/qty/fees = decimal strings on wire, scaled bigint in memory               |
| **Recipes only**                   | Fills use `tradeFill`; no inline entry lists                                     |
| **Matching has no users/balances** | Engine speaks order ids + account ids already funded                             |
| **Brand scan**                     | No partner/model vendor names in user-facing copy                                |
| **Custody scan**                   | Trade is Fiat Plane custodial path — do not invent Protocol withdrawal APIs here |
| **Jurisdiction**                   | Order entry must respect `checkAccess` / KYC tiers for fiat module               |
| **One service per PR**             | Contracts first, then svc-trade; don’t mix apps/web into the money PR            |
| **Worktrees only**                 | `pnpm wt feat/svc-trade-spot-…` — never edit in this main checkout               |

---

## Recommended first claim (one line)

**Review Denon #26 (matching); then claim `trade.spot` slice T1→T3 first (contracts if needed, scaffold, hold+submit).** That is the broker-critical path and does not stomp open branches.

**Do not start a worktree until you reply which slice (or “review only first”) you want.**

---

## Next 2–3 moves (for you)

1. **Approve or tweak this plan** in chat (especially: start with review-only vs claim T1 now while matching is still open).
2. **Review PR #25 + #26** on GitHub (approve if solid; request changes if money/doctrine fails).
3. After #26 merges (or you green-light parallel prep): **`pnpm wt feat/svc-trade-…`** and implement the approved slice only.

---

## How to re-check health later

```bash
export PATH="/opt/homebrew/bin:$PATH"   # + pnpm on PATH
pnpm install
# when Docker Desktop is running:
# cp .env.example .env && docker compose up -d
pnpm test && pnpm typecheck && pnpm gate
pnpm tracker ready
export GH_TOKEN="$(tr -d '\n\r ' < ~/.grok/agent-auth/github_token)"
gh pr list --state open
```

---

## Pointers

- Law: [`INTAFACED_DEFINITIVE_BUILD.md`](../INTAFACED_DEFINITIVE_BUILD.md) §5 Phase 2
- Rules: [`tooling/agent-protocol/AGENT_PROTOCOL.md`](../tooling/agent-protocol/AGENT_PROTOCOL.md)
- Board: [`TRACKER.md`](TRACKER.md) · `pnpm tracker ready`
- Collab: [`CONTRIBUTING.md`](../CONTRIBUTING.md) · [`COLLAB-AUDIT-2026-07-27.md`](COLLAB-AUDIT-2026-07-27.md)
