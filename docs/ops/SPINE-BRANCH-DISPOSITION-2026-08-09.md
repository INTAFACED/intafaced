# Spine branch disposition — 2026-08-09

**CURRENT table is** [`SPINE-BRANCH-DISPOSITION-2026-08-15.md`](SPINE-BRANCH-DISPOSITION-2026-08-15.md). This file stays for seal mechanisms (§3–§6). Do not treat the 1,220-behind counts or DIRECTION §6 RESUME rows as live.

**Board item:** D26-P4-01, `DENON-HARD-PARALLEL-BOARD-2026-08-09.md` §8 — _"architecture cleanup — only you seal without destroy."_
**Method:** read-only. Nothing was merged, rebased, pushed to, or deleted. No code was edited. Every verdict below is from `git show` / `git diff` against `origin/main`.
**Tip at write:** `2d85e546`. Main moved four times during this pass (`6701c4d3 → 0070b551 → 80daedf0 → 2d85e546`); re-derive before acting.
**Gates:** `node tooling/ci/gates.mjs` printed **`✓ all 32 doctrine gates passed — 20151ms total`**. The brief said 31; the catalogue is **32** at this tip. Nothing disabled, nothing skipped.

**Builds on:** [`STRANDED-BRANCH-TRIAGE-2026-08-08.md`](STRANDED-BRANCH-TRIAGE-2026-08-08.md) (pass 1, fifteen branches, zero revivals) and an unwritten pass 2 (~24 branches, including this cluster). This document supersedes pass 2's spine verdicts where they conflict.

---

## 0 · Seal, do not destroy

A branch ref costs nothing. A **wrong** disposition costs either lost work or a regression. So this file recommends deletion only where the content was verified present on `main`, and it states per row how that was verified. Where a branch must never be merged, the mechanism is written out precisely enough that a reader who never saw the branch can confirm it against `main` themselves.

**RESUME-REDO is not the same as revivable.** Both prior passes concluded that rebasing a thousand-commit-behind branch is how a subtle regression lands behind a green diff. This pass found three concrete instances of exactly that, so the rule holds: carry the findings, not the diffs.

---

## 1 · The actual ref set

`git for-each-ref refs/remotes/origin` — 124 remote branches, of which **17 are `spine`-named**: 15 `feat/spine-*` plus `docs/spine-licence-position` and `fix/spine-token-factory-format`. The board's "~17 `origin/feat/spine-*`" counts the whole spine family, not the `feat/` subset.

Two corrections to the brief's framing:

- **`spine-java-custody` was in neither prior pass and not in the brief's list.** It is the largest security branch in the cluster — RPC authentication plus removal of six unauthenticated money and destructive endpoints. It gets a row (§2, SEAL-CLOSED — verified landed).
- **`spine-rebrand` does not exist.** No such ref, and none ever appears in either prior pass. The nearest is `feat/rebrand-english-black-orange` — not spine-named, triaged by pass 1 as LANDED, and it is the branch whose diff is dominated by a 44,727-line lockfile. No branch in _this_ cluster is lockfile-dominated; the one lockfile in the set (`spine-dex-quotes`, 240 bytes of `pnpm-lock.yaml`) is incidental.

All fifteen `feat/spine-*` are `theplugXE`, dated 2026-07-29, and **1220–1236 commits behind** — not the ~942 pass 1 recorded, because main has moved ~280 commits since.

---

## 2 · The table

One row per `spine`-named ref. Disposition is the decision, not a description.

| Branch                           | Behind/ahead | Disposition                                 | Where it went, or why not                                                                                                                                                                                                                             |
| -------------------------------- | ------------ | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `feat/spine-venue-fabric`        | 1220 / 1     | **SEAL-CLOSED**                             | `ee334a6f` (#209) — the §27 fabric. Main is a strict superset: adds `adapter.ts`, `index.ts`, tests, `tsconfig.test.json`, then hardened past the branch by `00864921` (#1163)                                                                        |
| `feat/spine-dex-quotes`          | 1220 / 1     | **SEAL-CLOSED**                             | `843bde64` (#101). `quote/quote-service.ts` **byte-identical** to main; all nine `quote/*` modules present, main adds `permissionless.test.ts`, `router-quote.ts`, `tracing.ts`. Shehzad plane (`svc-dex`) — reported, not proposed                   |
| `feat/spine-market-seeder`       | 1221 / 3     | **SEAL-CLOSED**                             | `843bde64` (#101), path-moved by `9b3f9016` (#771). Both seeder files present on main under the current vendor path                                                                                                                                   |
| `feat/spine-java-custody`        | 1236 / 1     | **SEAL-CLOSED**                             | `60031cfd` (#86), path-moved by `9b3f9016` (#771). See §4 — verified endpoint-by-endpoint, not by filename                                                                                                                                            |
| `feat/spine-otc-desk`            | 1220 / 1     | **SEAL-CLOSED**                             | All 5 files are under `apps/web/**`, deleted wholesale by `54763b3e` (#757). The domain logic landed far richer as `services/svc-trade/src/otc/**` — 10 modules with tests, including `mid-source.ts` and `desk-law.ts`                               |
| `feat/spine-derivatives`         | 1220 / 1     | **SEAL-CLOSED**                             | `positionCollateralAccount` on main (`accounts.ts:108`, purposed `position:<id>`) is the branch's `perpMarginAccount` under a different name, plus **52** modules under `services/svc-trade/src/futures/`. See §4 for the one idea main did not adopt |
| `docs/spine-licence-position`    | —            | **SEAL-CLOSED**                             | `60031cfd` (#86). Verified by pass 1 at full-diff level; not re-verified here                                                                                                                                                                         |
| `fix/spine-token-factory-format` | —            | **SEAL-CLOSED**                             | `0f5c43b3` (#217) + `2f6ab476` (#221). Verified by pass 1; not re-verified here                                                                                                                                                                       |
| `feat/spine-screening-guard`     | 1220 / 1     | **SEAL-DANGEROUS**                          | Reopens the #432 sanctions boot-guard hole. §3.1                                                                                                                                                                                                      |
| `feat/spine-scope-issuance`      | 1236 / 1     | **SEAL-DANGEROUS**                          | **Prior verdict wrong.** Pass 2 said LANDED/SUPERSEDED. It reverts three landed auth fixes, one of them a forever-valid token. §3.2                                                                                                                   |
| `feat/spine-java-rename`         | 1220 / 2     | **SEAL-DANGEROUS**                          | Flips a truthful "not started, on purpose" into a false green, and targets a third vendor directory name. §3.3                                                                                                                                        |
| `feat/spine-bank-card`           | 1220 / 2     | **SEAL-DANGEROUS** + narrow **RESUME-REDO** | Migration ordinal collision that breaks the database **silently, exiting 0**. §3.4. One file worth re-cutting: §5.4                                                                                                                                   |
| `feat/spine-market-stability`    | 1220 / 2     | **SEAL-DANGEROUS** + **RESUME-REDO**        | Re-exposes four datastores on all interfaces. §3.5. **Prior verdict incomplete** — it also carries a real, still-missing outage and rate-honesty fix: §5.3                                                                                            |
| `feat/spine-dod-gate`            | 1220 / 1     | **SEAL-DANGEROUS** + **RESUME-REDO**        | Stale CI would drop 32 gates to 6 if its side wins a conflict. §3.6. Its `tooling/e2e/` harness is genuinely absent from main and is the whole value of the branch: §5.1                                                                              |
| `feat/spine-academy-launch`      | 1220 / 1     | **SEAL-DANGEROUS** + **RESUME-PARTNER**     | Merging is a 21,953-line academy deletion plus three reverted safety fixes. §3.7. Launch half genuinely missing — but **re-planed to Protocol under `shehzad002`**, so RESUME-**PARTNER**, not RESUME-OWNER as pass 2 had it: §6.1                    |
| `feat/spine-agent-fleet`         | 1220 / 1     | **RESUME-REDO**                             | Genuine gap. Agent spend-hold ledger plane absent from main. §5.2                                                                                                                                                                                     |
| `feat/spine-amm-reserves`        | 1220 / 2     | **RESUME-PARTNER**                          | Genuine gap **inside `shehzad002`'s HUMAN lock** (`svc-indexer`). Prior art only. §6.2                                                                                                                                                                |

**Totals:** 8 SEAL-CLOSED · 7 SEAL-DANGEROUS (5 of them carrying a salvageable half) · 2 RESUME-REDO outright · 2 RESUME-PARTNER · 0 RESUME-OWNER.

**Zero of the seventeen should be merged or rebased.** Pass 1's headline holds one cluster further out.

---

## 3 · SEAL-DANGEROUS — the mechanisms

These are the reason this file exists. All seven look safe by the usual heuristics: recent authorship, coherent commit messages, small diffs in four cases, and a plausible stated purpose. Six of the seven are dangerous through **staleness reversion** rather than a bad idea — the branch was correct on 29 July and `main` has since gone further, so the harm arrives by taking the branch's side of a file, not by an author's mistake. That distinction matters for tone, not for the decision: the disposition is the same.

### 3.1 `spine-screening-guard` — reopens the #432 sanctions boot-guard hole

Prior verdict **confirmed**, with the mechanism now written out.

The branch's intent is sound and its guard really does throw — it hard-refuses at boot when `APP_ENV` is enforced and the sanctions list is unconfigured. The harm is not "warn versus throw". It is **what is allowed to satisfy the throw condition.**

- **Branch:** `activeScreeningList()` returns `mergeScreeningLists(envScreeningList(env), MATRIX_SCREENING)`. `MATRIX_SCREENING` maps every `JURISDICTION_MATRIX` entry carrying `blocked: true` into screened regions. `mergeScreeningLists` contains `if (!a.configured) return b;` — so **either** side being non-empty yields `configured: true`. The guard predicate is `if (enforced && !status.configured)`.
- **Main:** `activeScreeningList()` is a deliberate pass-through, `envScreeningList(env)` only. Screening state is a three-value `ScreeningDeclaration` — `'unset' | 'listed' | 'reviewed-empty'` — produced **only** by the parser reading the sanctions-regions environment variable. Matrix entries are a separate nominal type, `BusinessBlock { authority: 'business' }`, which cannot be assigned into a `ScreeningList`. The guard predicate is `if (enforced && list.declaration === 'unset')`. `mergeScreeningLists` and `MATRIX_SCREENING` **do not exist on main** — they were deleted.

**Merging replaces the second predicate with the first.** Then, with the sanctions list unset and **one** commercially-blocked matrix region present, production boots and serves traffic with an empty sanctions list, while `/ready` reports `configured: true` — a green tick. `33154d2a` (#432) exists to close precisely this, and its own body names it: _"one commercially-blocked region flipped the production boot guard from 'refuse to start' to 'satisfied'."_ Main's regression lock is `packages/config/src/screening.test.ts:299`, `describe('a business block cannot satisfy the screening guard')`.

**Stated honestly:** neither ref's shipped matrix carries a `blocked: true` entry today, so behaviour is identical _right now_. The harm is re-arming the footgun and deleting both the type-level barrier and the test that catches it. The trigger is a routine commercial config change by someone with no reason to know a sanctions guard is downstream.

Collateral in the same merge: deletes `denied.region_unknown`, `isRegionResolved`, `AccessDecision.regionResolved` and `blockedBy`; and its `services/svc-edge/src/index.ts` is ~130 lines behind, deleting CORS origin allowlisting, security headers, rate limiting, the kill-switch guard, admin routes, metrics, telemetry startup and `trustProxy`. That file alone disqualifies the merge independently of screening.

### 3.2 `spine-scope-issuance` — the prior verdict was wrong

**Pass 2 recorded this as LANDED or SUPERSEDED and admitted its guards were not diffed line by line. Diffed line by line, it is SEAL-DANGEROUS.** This is the most valuable correction in this document, because "LANDED or SUPERSEDED" is the verdict under which someone merges a branch to tidy up.

The branch is **not** a privilege escalation — that was checked first, and set-diffing the whole scope universe yields **no branch-only scope** (main 38, branch 32). Its grant set is a strict subset. The danger is the opposite direction: it is a **regression carrier**.

Merging reverts three landed fixes:

1. **`64321c02` (#1078) — "an access token with no expiry verified, and verified forever."** The branch deletes `requiredClaims: ['exp']` from `verifyAccessToken` and restores `new Date((payload.exp ?? 0) * 1000)`. That fallback fabricates a 1970 expiry for a token that simply has no `exp`.
2. **`5e03e0da` (#1088)** — downgrades `] as const satisfies readonly Scope[]` to `] as const`, losing the compiler guarantee that every scope is issued-or-withheld in writing.
3. **`b9fc015b` (#1014)** — deletes the `key_env` claim, the live/sandbox rail discriminator.

It also removes six scopes (`market:ops`, `notify:read/write`, `support:read/write/ops`) that three shipped services now depend on, drops `denied.region_unknown`, and resurrects three `apps/web` files from the retired scaffold.

The branch's own stated bug — that `svc-bank` and `svc-blueprint` answered `403 scope.denied` to every user — **does not exist on main**. `defaultScopes()` is byte-identical on both refs, and every scope in the branch's headline claim (`bank:read/write`, `blueprint:read/write`, `protocol:read`) is issued by main today. Landed across #36, #86, #129, #208, #752, #1109. **Nothing to cherry-pick.**

### 3.3 `spine-java-rename` — a false green over an unrenamed tree

Prior verdict **confirmed**, mechanism proven on both sides.

`main`'s `docs/SPLIT-BOARD.md:180` reads, today:

> `7. **The Java rebrand — 666 files.** Investigated 29 July; **not started, on purpose.**`

The branch rewrites that row to `7. ~~**The Java rebrand — 666 files.**~~ **Done — feat/spine-java-rename.**`, and deletes three `tooling/ci/brand-scan.mjs` allowlist entries (`HANDOVER-2026-07-29.md`, `STATUS-2026-07-29-EVENING.md`, `SPLIT-BOARD.md`) on the written assertion that _"Both are now done."_

Both are not done, on two counts:

- **`main` has 888 paths still under the upstream Java package root.** The rename never happened on main. The vendor _directory_ rename did (`9b3f9016`, #771) — the _package root_ did not, and all four remaining allowlist entries plus three more still carry the removal condition _"Remove this entry once the vendor directory and Java package root are renamed."_
- **The branch's own tree is only partially renamed** — 666 paths moved, **207 still on the upstream root**. Its own `SPLIT-BOARD` edit admits `01_wallet_rpc` keeps the upstream package root.

So the mechanism is exact: the docs get scrubbed to read as though the rename completed, the allowlist entries that flagged them as pending get deleted, and `brand-scan` goes green over three documents that now state something false about the tree. A pending-work marker becomes a completion marker with a passing gate behind it — and the gate is satisfied _because_ the doc was scrubbed, not because the work was done.

Independently: the branch renames the vendor directory to `vendor/exchange`. Main settled on `vendor/upstream-exchange`. Merging produces a **third** name and 1,876 file moves fighting a completed rename.

### 3.4 `spine-bank-card` — a migration collision that breaks the database silently

Pass 2 inferred the adapter fate rather than proving it. Proven now, and **both of pass 2's specific claims are wrong** while its overall direction was right.

- **"Collides in the journal" — disproved.** There is no `_journal.json` in this repo. `services/svc-bank/scripts/migrate.ts` is hand-rolled: `readdirSync().filter(.sql).sort()`, tracking applied migrations in `bank.__migrations` **keyed on the full filename**.
- **"Strictly weaker schema" — disproved.** Neither side dominates. Main is stronger on settlement (`card_settlements` with per-authorisation capture/reversal rows), cashback (`card_cashback`), §18 JIT FX (`card_conversions`), and two-phase `pending/settled/rejected` crash recovery. The branch is stronger on programme modelling, custody/KYC coupling, velocity ceilings and channel controls. Money columns are `numeric(38,18)` on both — no float anywhere.

**The real mechanism is worse than a hard collision, because it is silent.** The branch's cards migration sits at ordinal `0002`; main's `0002` is **loans**, and main's cards migration is `0003`. Because tracking is per-filename, nothing dedupes, and `.sort()` orders the branch's `0002_bank_cards.sql` _first_. Main's `0003_bank_cards.sql` then reaches its `CREATE TABLE IF NOT EXISTS "bank"."cards"` and `"bank"."card_authorizations"` and **both silently no-op** — the tables already exist under those names with entirely different columns. Main puts its constraints _inline in the CREATE TABLE_, so every constraint is skipped too.

The result is `bank.cards` with no `issuer`, `simulated`, `issuer_ref`, `pan_tail`, or `cashback_bps`, and `bank.card_authorizations` with no `authorization_ref`, `decision`, `decline_code`, `status`, or `merchant_category`. Main's live `card-service.ts` then fails at runtime on its `INSERT INTO bank.card_authorizations (...)`. **The migration exits 0.** Green CI, broken database. The down path is all `IF EXISTS`, so the reversibility gate does not catch it either.

Also proven and absent from pass 2: **the branch's card code is entirely unwired and untested** — no router procedure, no service wiring, zero tests for 1,686 new lines. The tip commit is `wip(...): process crashed mid-task, work preserved`. The webhook signature file is a **verbatim duplicate** of main's `svc-pay` version, including the numbered rules in its doc comment; main already does HMAC-SHA256 with a length check before a constant-time compare and a replay window. Salvage value there is nil.

### 3.5 `spine-market-stability` — re-exposes four datastores on all interfaces

Prior verdict **confirmed** and now mechanised. This branch is also the clearest case of a dangerous merge carrying a genuinely missing half (§5.3).

Main's compose file opens with a deliberate warning block:

> `# ── Every published port is bound to 127.0.0.1, deliberately ───` … `So the exposure was: four unauthenticated datastores, on all interfaces` … `Changing 127.0.0.1: back to nothing re-opens all four at once`

Main honours it: every published port is `'127.0.0.1:${...}:...'`, and Redis runs `--requirepass`. **The branch's compose file contains zero occurrences of `127.0.0.1`** — its port lines are bare (`'${COINEX_MONGO_PORT:-57017}:27017'`, `'${COINEX_REDIS_PORT:-6381}:6379'`), and Redis has no `requirepass`.

It is also at the **pre-rename path**. Main's file is `vendor/upstream-exchange-compose.yml`; the branch's is at the old vendor-named path. So merging does not conflict with main's hardened file at all — it **adds a second compose file** carrying the pre-hardening bindings. Nothing would flag that. A developer who runs the wrong file re-opens MySQL, MongoDB, Redis and Kafka on every interface, with the datastores' own authentication still off.

### 3.6 `spine-dod-gate` — stale CI that would drop the gate catalogue from 32 to 6

Prior verdict **partly wrong in its framing, and the correction changes nothing about the disposition.** Pass 2 called these "three enforcement downgrades". The branch's own edits to `ci.yml` and `dod-gate.mjs` are **purely additive** — no `continue-on-error`, no `|| true`, no lowered threshold, no widened allowlist authored anywhere on it. Its `dod-gate.mjs` change _widens_ enforcement. The regressions are real against main today but arrive by **staleness**, and only if the branch's side wins a conflict resolution. Named precisely because "not a downgrade" must not be read as "safe to take":

1. **The gate catalogue.** Main runs `pnpm gates` — the single list, **32 ids** at this tip. The branch hand-lists **6** scans. Taking its side stops ~26 gates running in CI, including `secrets`, `secret-scan-mutation`, `fabricated-money`, `dual-book-door`, `killswitch`, `coverage`, `money-property-mutation`, `reachability` and the wallet-RPC scans. Second-order: `gates.mjs` self-fails when a script appears under `tooling/ci/` that neither the list nor a documented exclusion claims — losing the single list restores the exact failure main's own comment cites, a gate sitting wired to nothing for weeks.
2. **The value gate stops blocking and would be blind anyway.** The branch has no value-gate step, and its checkout is `@v4` with no `fetch-depth`. `VALUE_GATE_STRICT=1` is what makes near-duplicate detection blocking; `fetch-depth: 0` is what lets it see history at all. Main's comment: _"a gate that can see nothing must never print clean."_
3. **Money suites lose infrastructure, and the detector that would notice.** Test DB reverts off the isolated `_test` database (which `assertTestDatabase` requires), `svc-notify` and `svc-support` lose their URLs entirely, the EVM anvil steps and `REQUIRE_EVM_CHAIN` go, NATS reverts to a `services:` container which cannot be given a command — so JetStream is off while every service publishes through it. And `tooling/ci/infra-verdict.mjs`, the step whose whole job is to fail when a required suite _skipped_ rather than ran, is absent. Skip-instead-of-run plus deletion of the skip detector: green means less, invisibly.
4. **Action pinning** reverts from SHA-pinned to floating `@v4` at all four job sites.
5. **One genuine branch-authored defect** (not staleness): its `tooling/infra/prometheus.yaml` adds a `labels: {service: svc-edge}` block. Main's version deliberately has none, and its deleted comment says why — Prometheus renames a scraped label to `exported_service` and keeps both, so every dashboard query matching on `service` silently matches nothing. Main's `observability-wiring.test.ts` asserts exactly this, so the block is both a live defect and a red test.

**On the metrics half: the brief's caution was right.** `64dfe308` (#1167) delivers everything the branch's metrics half does and more — same Grafana provisioning path and settings, a `promtool`-verified `prometheus.yaml`, and the emitter moved into `packages/telemetry` so metric names and buckets are decided once for all 19 services rather than service-locally. Its live proof is real containers (`prom/prometheus:v3.0.1` reporting `job=svc-edge health=up`; `grafana/grafana:11.4.0` `provisioned=true`, 5 panels, every panel query returning live series). The **1 of 19** coverage statement is corroborated in `tooling/coverage.yaml`. So the metrics half is **fully redundant and strictly inferior** — and worse, the metric names differ (`intafaced_edge_*` versus main's `intafaced_http_*`), so landing the branch's dashboard beside main's emitter yields a dashboard querying metrics nothing emits. Drop it entirely; do not repeat it as missing.

### 3.7 `spine-academy-launch` — merging is a 21,953-line deletion

Pass 2's "rewrites an already-applied migration" is **correct but mislocated**, and its shallow spots are now closed — `launch-service.ts` was read in full (917 lines), along with the allocation and vesting maths.

- **The migration collision is in the academy half only.** `services/svc-academy/drizzle/0000_academy_init.sql` is the **same filename** with different content on both sides (119 lines on main, 208 on the branch, +90/−1) — the branch appends five new tables into an already-applied file, and deletes main's `0001`–`0005` entirely. The launch half collides with **nothing**: `services/svc-launch/` does not exist on main.
- **The academy half is superseded, and understated as such.** `git diff --stat origin/main <branch> -- services/svc-academy/` is **974 insertions, 21,953 deletions across 89 files**. Whole subsystems on main are absent from the branch snapshot: ambassadors, tournaments, certs, paper trading, spatial, curriculum. It is also a _design_ supersession — main code-seeds cert definitions from `certs/catalog.ts` with three thin progress tables; the branch puts the curriculum in the database as `curricula`/`curriculum_items` with a DB-side `certifications` table. Mutually exclusive designs for one feature. Main's won, across ~20 PRs (#970 … #1371).
- **Three merged safety fixes reverted in the same merge**, via files the diffstat understates because it is taken against the merge base: `packages/ledger-client/src/recipes/index.ts` reverts the `tradeFill` fee guard from `<= 0n` back to `< 0n` (main's comment records 2,329 fuzz cases where `fee == amount` produced a permanently unpostable fill) and deletes `escrowRelease`'s `feeBps` bounds check; `svc-edge/src/routes.ts` drops the `module: ModuleId` field, reintroducing the derive-from-prefix hazard that let a killed module keep placing orders on the CCXT prefix; `svc-token/src/index.ts` reverts DB-sourced emission and buyback params to code defaults and un-registers the TracerProvider.

**Two previously unreported money defects in the branch's own new code**, both worth recording because they must not be re-implemented: on a ledger post that succeeded but timed out, `launch-service.ts:743-748` rolls the vesting watermark back while leaving `release_seq` consumed, so the retry posts under a **different** idempotency key and the beneficiary is paid twice; `launch-service.ts:527-533` has the identical shape on contribution, double-debiting the contributor and stranding escrow with no allocation row to refund it. Both docstrings assert the safety property the code does not have.

Credit where due, because it bears on the redo (§6.1): the branch is **clean on §0.6 and on money typing.** No balance field, no hand-assembled ledger entries, no pooled raise pot — contributions escrow per contributor. Zero `parseFloat`, zero `toFixed`, no float DDL; amounts are scaled bigint in memory, `numeric(38,18)` in Postgres, decimal strings on the wire. And it hardcodes **no** price, fee rate, or tier threshold.

---

## 4 · SEAL-CLOSED, verified here rather than taken on report

### `spine-java-custody` — the branch nobody triaged

Verified **endpoint by endpoint**, not by filename, because the auth half landing does not imply the endpoint-removal half landed.

The branch closes three custody holes: unauthenticated `/rpc/**` across 13 wallet RPC services, ETH keystores unlocked with the empty string plus committed hot-wallet passwords, and a hardcoded shared secret gating six endpoints that were explicitly excluded from the member and admin interceptors — order placement as a fixed uid, a red-envelope endpoint crediting an arbitrary member's wallet, and an admin endpoint rewriting a trading pair's price bounds. Plus two unauthenticated destructive endpoints found while mapping: one running `TRUNCATE TABLE` on a wallet table, one an unauthenticated write into the Redis data dictionary.

Verified on `main` at `2d85e546`:

| Branch change                                         | On main                                             |
| ----------------------------------------------------- | --------------------------------------------------- |
| `RpcSecurityConfig` / `RpcAuthInterceptor`            | present in `rpc-common` + 6 per-coin modules        |
| `KeystorePasswordValidator`                           | present in `eth-support`                            |
| `RpcAuthRequestInterceptor` (framework caller side)   | present in `00_framework/core`                      |
| Hardcoded gate secret                                 | **3 files at the merge base, 0 on main**            |
| `authno/AuthExchangeCoinController.java`              | **absent from main** (deleted)                      |
| `ucenter-api/.../TestController.java`                 | **absent from main** (deleted)                      |
| `TRUNCATE` endpoint · Redis dictionary-write endpoint | **0 occurrences on main**, 1 each at the merge base |

Landed as `60031cfd` (#86) — the same consolidated commit pass 1 cited for `docs/spine-licence-position` and `feat/rebrand-english-black-orange`, so #86 absorbed three spine branches at once — then path-moved by `9b3f9016` (#771). **Safe to delete the ref.**

Pass 1's separate finding still stands and is not affected: the wallet-RPC `act` module's duplicated dependency coordinate remains `RECORDED UNPROVEN` and owner-gated. Frozen is not fixed.

### `spine-derivatives` — superseded, with one idea main did not adopt

Its 42 lines are two account-ref helpers. `perpMarginAccount(userId, assetId, positionId)` is main's `positionCollateralAccount` under a different name — both key per position, so the branch's own argument against pooling (_"which is cross margin, silently"_) does not apply to main's implementation. Behind it sit 52 futures modules.

Stated so it is not mistaken for a gap: main has **no per-market perp settlement pool**; it uses a per-asset `insuranceFund` plus `insurance-bound.ts`. The branch's per-market pooling argument — that a blow-up on a thin book should not be paid for by an unrelated market's open interest — is a **design opinion main did not adopt**, not missing work. Recorded as prior art; the ref is still safe to delete, because deleting it loses an argument, not a capability.

---

## 5 · RESUME-REDO — genuinely missing, re-implement from tip

Enough detail that an implementer needs no access to the branch.

### 5.1 `tooling/e2e/` — the fleet-level harness (from `spine-dod-gate`)

Pass 2 did not read these. Read now, and they are real.

`git ls-tree -r origin/main -- tooling/e2e` is **empty**. Main has no `tooling/e2e`, no `harness.ts`, no `e2e` CI job, no `pnpm e2e`. What main has under an `e2e` name is **in-process, not fleet-level**: `svc-edge/src/control-plane.e2e.test.ts` builds a Fastify instance in-process and **stubs the upstream services** — no containers, no ledger, no money.

The branch's harness is 363 lines with **zero mocks** (`vi.mock|vi.fn|nock|msw` → 0 matches). It drives real `fetch` against `svc-edge` on `http://localhost:4000`; every user-facing call goes through the edge, nothing addresses a service port. It registers and logs in over the real identity routes, does `kyc.submit → kyc.approve → re-login` (correctly, because tier is a token claim stamped at issue), deposits over the card sandbox rail, and reads balances from the **ledger's** number rather than `svc-trade`'s. Its only direct SQL is one insert and one update on `trade.markets`, with an `information_schema` probe, `ON CONFLICT DO NOTHING`, per-run unique symbols, and an explicit refusal to run DDL.

Three suites, **24 `it()`, 54 `expect()`, 11 `expectOk()`, zero `it.skip`, zero `expect(true)`** — and the assertions are on money and state, not status codes: exact hold semantics, fee arithmetic derived from the market's own `makerBps`/`takerBps`, a base-conservation check across maker and taker, a balance assertion paired with **every** refusal, a proof that cancel returned the hold, a forged-JWT case, an under-scoped deposit that asserts nothing was minted, and a raw-`fetch` principal-smuggling case expecting 401. The kill-switch suite drives the console rather than the edge and asserts the behaviour delta both ways, restoring the module in `afterAll`. Config is `fileParallelism: false`, `retry: 0` — _"a retried e2e hides the exact class of bug only an e2e can find."_

**Implementer notes.** Re-cut on tip; do not rebase. Re-apply the additive `e2e` CI job and `needs: [..., e2e]` on top of main's **current** `ci.yml` — never by taking the branch's side of that file (§3.6). Salvage `checkE2e()` and delete only the matching checklist line; `checkSloDashboard()` and `checkKillSwitch()` are worth having as gate code but must be retargeted at main's artefact names (`edge-slo.json`, `intafaced_http_*`, `packages/telemetry`, `control-plane-client.ts`). Drop the entire metrics and Grafana half. Main's `dod-gate.mjs` still prints all four items as manual sign-off, so the gate half of this is genuinely open even where the implementations landed.

The harness's three in-place findings are **unverified against main** and should be re-checked before being treated as live: that `TradeService.listMarket()` is exposed by no router; that no login the platform can perform produces an operator, so a token must be minted out of band; and that the ops role hits `permission denied for schema trade`.

### 5.2 Agent spend-hold ledger plane (`spine-agent-fleet`)

Genuine gap, verified: main's `services/svc-agents/drizzle/` contains **only** `0000_agents_init.sql`; there is no `0001`, and `agentSpendHold*` / `spend_holds` match nothing anywhere on main.

What to build:

- **Account shape.** `agentSpendHoldAccount(userId, assetId, sessionId, windowId)` → `userHold(userId, assetId, 'agent:<sessionId>:<windowId>')`. The load-bearing detail is that it is purposed **by window, not just by session**: settlement bills a window and returns that window's unspent remainder, so a session-wide pot lets the current period's charge draw down the next period's reservation — the P0-3 commingling failure, one level down.
- **Four recipes** in `packages/ledger-client`: `agentSpendHold`, `agentSpendVoid`, `agentUsageSettle`, `agentSpendRelease`. Value moves only here (§0.6).
- **`agents.usage_holds`** table with the invariants in the database rather than trusted in the service: `amount > 0`; `voided_at IS NULL OR void_tx_id IS NOT NULL`; `voided_at IS NULL OR hold_tx_id IS NOT NULL`; `released_at IS NULL OR sealed_at IS NOT NULL`. The branch's own header states the property to preserve — metered honestly but billed only at settlement, so the hold is a budget check rather than a charge.
- Next free ordinal on tip, not `0001` blind — re-derive.

**Collision warning.** `svc-agents` has a **live agent residual wave** (`w6-l01-*` fleet branches open, and many recent `fleet/` and `copy-intel/` modules on main). Path-intersect open PRs before starting. The brief's own constraint keeps this document out of `services/**`; the _implementation_ is a separate claim under LIVE-LANES.

### 5.3 Rate-source honesty and restart policy (`spine-market-stability`)

**Pass 2 recorded only the danger and missed that this branch carries a real, still-missing fix.** Verified by line count: `CoinExchangeRate.java` is **268 lines at the merge base and 268 on main** — byte-identical, touched since #73 only by the rename. The branch's 497-line version never landed. Same for `ExchangeRateController.java` (76 / 76 / 104). And `restart: unless-stopped` appears **0 times** in main's compose file.

Three things are genuinely missing, and the first is the opposite of the failure mode agents are distrusted for — it **removes** invented numbers:

1. **Configurable rate sources with staleness honesty.** The merge-base file — still what main runs — hardcodes four third-party endpoints inside the rate component, one of which carries an inline `key=` credential in its query string. The branch replaces them with empty-default config keys (`market.rate.usdt-cny.url`, `.value-path`, `market.rate.forex.url`, plus `max-age-minutes` bounds), tracks `volatile long ...UpdatedAt` per source where `0` means "never succeeded", exposes `isUsdtCnyRateStale()` / `isForexRateStale()`, and on every failure path calls `reportNotRefreshed(...)` with a **named reason** — no source configured, URL set but value-path missing, fetch failed — instead of silently continuing to serve the last or a default value. Nothing is invented: the defaults are empty, so an unconfigured deployment reports "not refreshed" rather than a number.
2. **`NettyStartupGuard.java` (+71) and `RootContextNettyApplicationStartup.java` (+82)** — absent from main.
3. **`restart: unless-stopped`** on the eight compose services. The branch's own header records the incident: the quote centre was down three hours forty minutes after a clean Spring shutdown on a stray SIGTERM, container exit 0, `RestartCount 0`, and nothing noticed until a human looked. Its comment is honest that this is not monitoring and not a substitute for it.

**Implementer notes.** Take the Java and the restart policy; **never** take the compose file (§3.5) — re-apply `restart:` onto main's hardened `vendor/upstream-exchange-compose.yml`, preserving every `127.0.0.1:` binding and `--requirepass`. On the hardcoded credential, see §5.5 — it is a separate finding and an owner action, not part of this redo.

### 5.4 `policy.ts` — card programmes and the §22 gate (`spine-bank-card`)

The one file worth re-cutting from an otherwise closed branch. Proven absent: `assertProgramme`, `resolveCardAccess`, `CardProgrammeStatus`, `card_programmes`, `fundingSource`, `self_custody`, `requiredTier` and `checkAccess` are **0 matches** across `services/svc-bank/**` on main. Main's card procedures do only `assertSelf(...)` — an ownership check. **Main has no KYC or jurisdiction gate on card issuance inside `svc-bank`.**

What to build: `CARD_FUNDING_SOURCES = ['ledger', 'self_custody']`; `assertProgramme(p)` enforcing five invariants **on read as well as on write**, so a row hand-edited in `psql` fails closed at the moment it would authorise — chiefly `requiredTier === 'none' && fundingSource !== 'self_custody'` → throw `programme.zero_tier_requires_self_custody`, plus limits-positive, `perAuth ≤ daily ≤ monthly`, cashback 0–9999 integer bps, and `status === 'live'` requiring both `reviewedBy` and `reviewedAt`. Then `resolveCardAccess(q)` calling `checkAccess({ module: 'bank', plane: 'fiat', region, kycTier })` and returning its refusal **unchanged** before layering the issuer's own tier floor — matrix first, stricter wins, `plane` hardcoded not caller-supplied. The safety property is the ordering: because the matrix is consulted first, a programme row asking for `requiredTier: 'none'` changes nothing by itself; reaching the low-verification tier requires a counsel-signed matrix change in a file `svc-bank` does not own.

Re-cut against main's `cards` / `card_authorizations` shape, at the next free ordinal. Do **not** carry the branch's `CREATE UNIQUE INDEX ... (issuer_auth_ref)` — globally unique on the scheme's reference, which the branch's own adapter file argues against and main scopes correctly as `unique(card_id, authorization_ref)`.

**Two follow-ups, not in scope here:** main has no daily or monthly velocity ceiling (only per-authorisation), which it documents as belonging to a rail — worth an explicit decision rather than an inherited silence; and the cashback-clawback question on refunds is unanswered on both sides.

### 5.5 Side finding — an unrecorded credential on `main`, and the gate gap that hides it

Found while verifying §5.3, so it is recorded here rather than dropped. **Not a branch disposition, and not for an agent to fix.**

The vendor market rate component on `main` — the file whose line count proves the branch's fix never landed — hardcodes a third-party FX endpoint whose credential is carried as a **query-string parameter** rather than in userinfo or a config assignment. No value is reproduced here, deliberately: a document that records a finding by copying its text inherits none of the original site's gate exemptions.

**`secret-scan` does not catch it, and neither does the frozen list.** The gate reports clean at this tip — 122 credential-shaped assignments, 6 known-disclosed awaiting rotation — and **none of the six is this one**. Its single `inline-url-credential` finding is the unrelated wallet-RPC test client. Searching the gate's own frozen block and `docs/SECRET-ROTATION-READINESS-2026-08-03.md` for this component returns nothing. So this is **open and unrecorded**, which is a narrower statement than it looks: pass 1's "nothing is open and unrecorded" was scoped to unauthenticated-`/rpc/**` findings and is not contradicted.

The likely gate gap — **stated as inference, not proven**: the `inline-url-credential` rule appears to match `user:pass@host` userinfo form, and a credential passed as a query parameter in a string literal assigned to a local variable inside a method is a different shape. Confirming that requires reading the rule, which was out of scope here.

**Two owner actions, neither of them code an agent should write:** record this in the rotation-readiness doc so it stops being invisible, and decide whether the `inline-url-credential` rule should cover query-parameter credentials — the second is the durable fix, because it re-arms the gate for the next one. The edit itself is inside unreviewed, never-compiled third-party code, so the same reasoning as pass 1's `act` module applies: **frozen is not fixed, and unrecorded is worse than frozen.**

---

## 6 · RESUME-PARTNER — inside another lane's lock

Surfaced as prior art. **No agent should build either.** `docs/LIVE-LANES.md` row `shehzad-protocol-chain`, owner `shehzad002`, status **HUMAN**.

### 6.1 The launchpad raise half (`spine-academy-launch`) — reclassified

Pass 2 called this "owner-gated", i.e. RESUME-OWNER. **That is now wrong, and the correction is the point.** `docs/TRACKER.md:250` reads: _"HUMAN on-chain launch @shehzad002. Agents babysit only. **Plane corrected to P 2026-08-07** — presale, vesting and allocation are contracts."_ The branch is a **Fiat-Plane** launchpad for a row since re-planed to **Protocol** under a named human owner, blocked on `launch.token-factory` — the exact misrendering the 2026-08-07 correction was made to fix. The TRK pack's own header (`owner: none`) is stale.

Genuinely missing, and confirmed unambiguously: `services/svc-launch/**` (~3,600 lines), `packages/ledger-client/src/recipes/launch.ts`, and three account shapes. Main **declares** the slot — `packages/config/src/modules.ts` maps `launch → svc-launch`, and `packages/auth/src/scopes.ts` carries `'launch:read': 'svc-launch not built'`.

Recorded as prior art because the economics are the owner's ruling to make, not because they should be reused as written. The branch encodes raise **law** an owner reserves — pro-rata over queue on oversubscription, refund-on-dust versus partial fill, no fee on a failed raise, fee rounding toward the house, an open raise being uncancellable — against a TRK pack that reads _"research only. Agents do not invent raise economics / refund / dispute law."_ It also invents a **second stake-tier system**, discarding the `tier` field it already receives and ignoring `svc-token`'s canonical `launchpadAllocationTier` ladder, which contradicts the pack's own done-bar #4. And it carries the two double-move defects in §3.7. Anyone building this should read those as things to avoid.

### 6.2 AMM pool reserves (`spine-amm-reserves`)

Prior verdict **confirmed**. Verified: main's `services/svc-indexer/drizzle/` contains **only** `0000_indexer_init`, and `pool_reserves` / `poolReserve` match nothing under `services/svc-indexer` on main.

The branch adds `0001_pool_reserves.sql` (+132, with a reversal file), a reserve projection across `projection/store.ts`, `memory-store.ts` and `postgres-store.ts`, chain-source ingestion, 309 lines of router, and a 243-line `testing/conformance.ts` suite. `svc-indexer` is Protocol Plane. **Classified and reported only.**

---

## 7 · Coverage, honestly

**Read in depth, first-hand:** the ref enumeration and every ahead/behind count; `spine-java-custody`'s full file set, commit body, and per-artefact verification against main including four endpoint-absence checks at both the merge base and tip; `spine-market-stability`'s compose diff on both sides plus line-count comparison of both Java files at base/branch/main and the additions to the rate component; `spine-derivatives`' complete 42-line diff against main's `accounts.ts:108`; `spine-otc-desk`'s file set against the `apps/web` deletion commit and main's `svc-trade/src/otc/**`; `spine-agent-fleet`'s account helper, recipe names and SQL constraints; `spine-java-rename`'s `brand-scan.mjs` and `SPLIT-BOARD.md` diffs plus package-root path counts on all three refs; `spine-dex-quotes` byte-identity on `quote-service.ts`; main's compose header, `gates.mjs` catalogue, and the gate run itself.

**Read in depth by four parallel read-only agents, whose evidence I spot-checked but did not re-derive line by line:** `spine-academy-launch` (`launch-service.ts` all 917 lines, allocation and vesting maths, both migrations, the 21,953-line academy delta); `spine-dod-gate` (`harness.ts` all 363 lines, all three e2e suites with exact assertion counts, the `ci.yml` and `dod-gate.mjs` diffs, `64dfe308` and `coverage.yaml`); `spine-bank-card` (all five card files, both schemas column by column, `migrate.ts`, the wiring and test-absence greps); `spine-scope-issuance` and `spine-screening-guard` (both scope universes set-diffed, both guard control flows, `33154d2a`/#432 and its regression test). I verified the load-bearing claims independently where a verdict turned on them — the gate count, the `apps/web` deletion, the `svc-indexer` and `svc-launch` absences, `positionCollateralAccount`, and the compose bindings.

**Sampled, not exhaustive:** `spine-venue-fabric` and `spine-market-seeder` — verified at file-set and landing-commit level; the 915 and 731 changed lines were **not** diffed line by line. `spine-dex-quotes` — one file proven byte-identical, the other sixteen confirmed present by name only.

**Enumerated only, carried forward from pass 1 and not re-verified:** `docs/spine-licence-position` and `fix/spine-token-factory-format`. Pass 1 verified both at full-diff level; I confirmed only that the cited commits are ancestors of main.

**Explicitly unproven — do not read these as findings:**

- Whether `main`'s absence of a card KYC gate is compensated at the edge or in `svc-identity`. **Proven absent within `svc-bank`'s own tree; the full request path was not audited.**
- The three platform gaps the e2e harness documents in-place (no router for `listMarket`, no login producing an operator, the ops role's schema permission). Read from the branch's comments, **not re-verified against main.**
- Whether `spine-academy-launch`'s appended-migration drift is silent or fatal — that depends on whether the academy migration runner checksums, and `scripts/migrate.ts` was not read for that service.
- Whether main's outbound card-authorisation model can meet the §20 latency budget without an inbound webhook path. Both designs are plausible; no document deciding between them was found.
- Whether `.github/workflows/supply-chain.yml` enforces SHA pinning. Inferred from its existence, not read.
- **Why** `secret-scan` misses the §5.5 credential. The miss itself is proven — the gate prints clean and the finding is in neither its frozen block nor the rotation doc. The query-parameter-versus-userinfo explanation is **inference**; the rule was not read.
- CI or review state of any branch. No GitHub data was consulted for the verdicts; `git` only.

**Not in scope, and untouched:** `services/**` and `packages/**` were read but never edited. The agent residual wave is in `services/**`.

---

## 8 · What to do with this

1. **Delete nothing yet.** Eight refs are SEAL-CLOSED and safe to delete on the evidence above; that is a separate, deliberate action for whoever owns the ref namespace, not a side effect of merging this document.
2. **Close the seven SEAL-DANGEROUS branches without merging** — with a comment pointing at the section number, so the next person to find them does not have to re-derive the mechanism.
3. **Never resolve a conflict toward any branch in this cluster.** Five of the seven dangerous ones are dangerous only if their side of a file wins.
4. The RESUME rows are **findings, not claims.** Implementing §5.1–§5.4 means claiming under LIVE-LANES and path-intersecting open PRs first; §6.1 and §6.2 are `shehzad002`'s and are reported here so nobody rebuilds them by accident.
5. **§5.5 is the only item here with a clock on it.** An unrecorded credential is worse than a frozen one, because nothing is watching it. Recording it costs one line in the rotation doc; the gate-rule question behind it is the durable fix.
