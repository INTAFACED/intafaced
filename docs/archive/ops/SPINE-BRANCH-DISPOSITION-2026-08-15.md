# Spine branch disposition — 2026-08-15 (CURRENT)

**Tracker:** D26-P4-01. **Lane:** `denon-d26-p4-01-spine`.
**Replaces as current:** [`SPINE-BRANCH-DISPOSITION-2026-08-09.md`](SPINE-BRANCH-DISPOSITION-2026-08-09.md) (mechanisms still law; behind-counts and the DIRECTION-2026-07-31 §6 table are historical).
**This PR does not implement, rebase, force-push, or delete any spine.**

**Tip at write:** `1723273b` (`origin/main`, `test(svc-pay): card gateway stays Class X refuse, no invented issuer (#1995)`).
**Method:** `git fetch --prune` · `git ls-remote --heads origin` · `git rev-list --count` vs `origin/main` · `gh pr list --head` / `gh pr view` on Phantom-X-007/intafaced.

Leverage (Phase A IN): git + [`DIRECTION-2026-07-31.md`](../DIRECTION-2026-07-31.md) §6 + [`HANDOVER-NITRO-BRANCHES.md`](../HANDOVER-NITRO-BRANCHES.md) + the 2026-08-09 seal pass. No second SPA, no second book, no invented mids.

---

## Vocabulary (done-bar)

| Call        | Meaning                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------- |
| **merged**  | Work is on tip via a named PR. The leftover `origin` ref (if any) is not a resume candidate.   |
| **gone**    | No `refs/heads` on origin. Merge PR named where one existed.                                   |
| **abandon** | Ref still exists. Do not merge, rebase, or force-push. Delete when the ref-owner chooses.      |
| **rewrite** | Genuine gap on tip. Recut on `origin/main`. Never resume the 2026-07-29 branch.                |
| **resume**  | Rebase / continue that branch. **Count this run: 0.** Nothing 1,792 commits behind is resumed. |
| **triage**  | Still unread. **Count this run: 0.**                                                           |

**Shehzad chain spines are not resumed.** `feat/spine-dex-quotes`, `feat/spine-amm-reserves`, `feat/spine-academy-launch` (launchpad re-planed to Protocol) stay merged or abandon. Agents babysit only.

**Zero of the live refs should be merged or rebased.** Same headline as 2026-08-09; behind-count has grown ~570 commits since that pass (1,220 → 1,792).

---

## 1 · Ref set on origin (2026-08-15)

`git ls-remote --heads origin` matching `spine`: **17 refs** — 15 `feat/spine-*` plus `docs/spine-licence-position` and `fix/spine-token-factory-format`.

All fifteen `feat/spine-*` are still `theplugXE`, dated **2026-07-29**, **1,792–1,808 behind / 1–3 ahead**. None has an open or merged GitHub PR **from that head** (`gh pr list --state all --head feat/spine-<name>` → `[]` for every live feat ref).

`feat/spine-rebrand` still does not exist (confirmed `ls-remote`).

---

## 2 · CURRENT table

### Live `feat/spine-*` (15)

| Branch                        | Behind / ahead | Call        | Proof                                                                                                                                                                                                                                                                                |
| ----------------------------- | -------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `feat/spine-venue-fabric`     | 1792 / 1       | **merged**  | `#209` (`ee334a6f`) is an ancestor of `origin/main`. No PR from this head.                                                                                                                                                                                                           |
| `feat/spine-dex-quotes`       | 1792 / 1       | **merged**  | `#101` (`843bde64`). `services/svc-dex/src/quote/quote-service.ts` on tip. **Shehzad plane — do not resume leftover.**                                                                                                                                                               |
| `feat/spine-market-seeder`    | 1793 / 3       | **merged**  | `#101`; seeder present as `vendor/upstream-exchange/seed-market-data.{js,mjs}` after `#771` rename.                                                                                                                                                                                  |
| `feat/spine-java-custody`     | 1808 / 1       | **merged**  | `#86` (`60031cfd`); path-moved `#771`. Endpoint-level seal is in the 2026-08-09 file §4.                                                                                                                                                                                             |
| `feat/spine-otc-desk`         | 1792 / 1       | **abandon** | Branch never had a PR. `apps/web` deleted `#757`. Domain is tip `services/svc-trade/src/otc/**` (later OTC PRs, including `#1814` / `#1812`). Do not rebase.                                                                                                                         |
| `feat/spine-derivatives`      | 1792 / 1       | **abandon** | Branch never had a PR. DIRECTION §6 said rewrite; that rewrite already happened on tip (`svc-trade` futures). Do not rebase the crash-WIP.                                                                                                                                           |
| `feat/spine-screening-guard`  | 1792 / 1       | **abandon** | Merging reopens `#432` (`33154d2a` ancestor). Mechanism: 2026-08-09 §3.1. DIRECTION §6 “RESUME” is stale.                                                                                                                                                                            |
| `feat/spine-scope-issuance`   | 1808 / 1       | **abandon** | Reverts landed auth (2026-08-09 §3.2). No PR from this head.                                                                                                                                                                                                                         |
| `feat/spine-java-rename`      | 1792 / 2       | **abandon** | False-green / third vendor directory (2026-08-09 §3.3).                                                                                                                                                                                                                              |
| `feat/spine-bank-card`        | 1792 / 2       | **abandon** | DIRECTION §3 still blocks sponsor-bank cards. Branch also has a silent migration collision (2026-08-09 §3.4). `assertProgramme` still absent under `svc-bank` — recut only when cards are unblocked, as a new tip PR, not this ref.                                                  |
| `feat/spine-academy-launch`   | 1792 / 1       | **abandon** | **Shehzad / Protocol.** `services/svc-launch` still absent on tip. Do not resume. Prior art only (2026-08-09 §6.1).                                                                                                                                                                  |
| `feat/spine-amm-reserves`     | 1792 / 2       | **abandon** | **Shehzad / `svc-indexer`.** Tip drizzle is still only `0000_indexer_init`. Do not resume. Prior art only (2026-08-09 §6.2). Protocol `poolReserves` on tip is a chain read/refuse door, not this branch’s indexer projection.                                                       |
| `feat/spine-agent-fleet`      | 1792 / 1       | **rewrite** | Spend-hold ledger plane still absent (`packages/ledger-client` has no `agentSpend` / spend-hold recipe). Recut on tip under a claimed lane. Never rebase this ref.                                                                                                                   |
| `feat/spine-dod-gate`         | 1792 / 1       | **rewrite** | `tooling/e2e/` still absent. Branch CI would drop the gate catalogue if its side won (2026-08-09 §3.6). Carry the harness onto tip; never take the branch workflow.                                                                                                                  |
| `feat/spine-market-stability` | 1792 / 2       | **rewrite** | `CoinExchangeRate.java` is still **268** lines on tip (branch’s honesty rewrite never landed). Compose `restart: unless-stopped` **has** landed on tip `docker-compose.yml` — do not take the branch compose (2026-08-09 §3.5 bindings). Recut Java rate-source honesty on tip only. |

### Other live spine-named refs (2)

| Branch                           | Behind / ahead | Call       | Proof                                                                       |
| -------------------------------- | -------------- | ---------- | --------------------------------------------------------------------------- |
| `docs/spine-licence-position`    | 1808 / 1       | **merged** | `#86` (`60031cfd`). No PR from this head. Pass 1 + 2026-08-09 §2.           |
| `fix/spine-token-factory-format` | 1677 / 6       | **merged** | `#217` (`0f5c43b3`) + `#221` (`2f6ab476`). Both ancestors of `origin/main`. |

### Gone (historical names; `ls-remote` empty)

| Name                            | Call     | Merge PR (head was this branch)                                                |
| ------------------------------- | -------- | ------------------------------------------------------------------------------ |
| `feat/spine-token-factory`      | **gone** | [\#217](https://github.com/Phantom-X-007/intafaced/pull/217) merged 2026-07-30 |
| `feat/spine-indexer-readmodels` | **gone** | [\#218](https://github.com/Phantom-X-007/intafaced/pull/218) merged 2026-07-30 |
| `feat/spine-trading-hours`      | **gone** | [\#102](https://github.com/Phantom-X-007/intafaced/pull/102) merged 2026-07-29 |
| `feat/spine-wallet-perimeter`   | **gone** | [\#189](https://github.com/Phantom-X-007/intafaced/pull/189) merged 2026-07-30 |
| `feat/spine-venue-hours`        | **gone** | [\#194](https://github.com/Phantom-X-007/intafaced/pull/194) merged 2026-07-30 |
| `feat/spine-rebrand`            | **gone** | Never existed as a spine ref (2026-08-09 §1).                                  |

---

## 3 · Counts (this re-derive)

| Call                                |  Count | Notes                                                                                                       |
| ----------------------------------- | -----: | ----------------------------------------------------------------------------------------------------------- |
| **merged** (live refs, work on tip) |  **6** | 4 `feat/spine-*` + licence-position + token-factory-format                                                  |
| **abandon**                         |  **8** | includes 2 Shehzad (`academy-launch`, `amm-reserves`) + 2 superseded crash-WIPs (`otc-desk`, `derivatives`) |
| **rewrite** (greenfield on tip)     |  **3** | `agent-fleet`, `dod-gate`, `market-stability` — not this PR                                                 |
| **resume**                          |  **0** |                                                                                                             |
| **triage**                          |  **0** |                                                                                                             |
| **gone**                            |  **6** | 5 merged-and-deleted + 1 never-existed                                                                      |
| Live `feat/spine-*` still on origin | **15** | all 2026-07-29                                                                                              |

DIRECTION-2026-07-31 §6 said RESUME on `market-seeder`, `java-custody`, `screening-guard`. Those three calls are **wrong on this tip**: first two are merged; screening-guard is abandon.

---

## 4 · What not to do

1. Do not merge or rebase any remaining `feat/spine-*`.
2. Do not resume Shehzad chain spines (`dex-quotes` leftover, `amm-reserves`, `academy-launch`).
3. Delete SEAL-CLOSED leftover refs only as a separate owner action (2026-08-09 §8). This file does not delete them.
4. Rewrite rows are findings, not claims. Implementers claim LIVE-LANES and path-intersect open PRs first.

Dangerous-merge mechanisms (sanctions boot-guard, forever-valid token, false-green rename, silent migration, compose bind-all, CI gate drop, academy deletion) are unchanged: [`SPINE-BRANCH-DISPOSITION-2026-08-09.md`](SPINE-BRANCH-DISPOSITION-2026-08-09.md) §3.
