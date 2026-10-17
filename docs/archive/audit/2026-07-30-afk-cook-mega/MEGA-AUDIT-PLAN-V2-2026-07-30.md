# MEGA AUDIT — post AFK cook · PLAN V2 (executable)

**Supersedes:** `docs/MEGA-AUDIT-AFK-COOK-2026-07-30.md` (v1 keeps the intent; v2 is the runnable one).
**Written:** 2026-07-30, after adversarial review of v1 against the live repo and the live machine.
**Verdict on v1:** PASS-WITH-GAPS — right shape, but it dies at Phase 1 on this machine and its baseline reference resolves to nothing. Every gap is closed below.

**Scope:** prove the cook delta is soundproof, fix agent-fixable P0/P1, leave honest residuals, refresh the peace docs. Not a second cook, not the whole Definitive Build.

---

## 0 · FROZEN CONSTANTS (verified 2026-07-30 — do not re-derive, only re-confirm)

| Constant                        | Value                                                                                                                                                                                                           | How it was established                                                                                                                    |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Repo**                        | `Phantom-X-007/intafaced` · local checkout `/Users/Nitro/projects/Sovereign`                                                                                                                                    | `git remote -v`                                                                                                                           |
| **SINCE (baseline) SHA**        | **`8a8c19bc626e6dada49a33be1f88d17873f42502`** = `#107` "fix(audit): proper cleanup after Denon (Track 1)"                                                                                                      | last commit that touched `docs/PEACE-OF-MIND-AUDIT-CURRENT.md`; that file records **no** tip SHA, so this is the only defensible baseline |
| **TIP at plan write**           | `b979406` = `#171` "docs: mega-audit plan + paste"                                                                                                                                                              | `git rev-parse origin/main`                                                                                                               |
| **Delta size**                  | **60 commits** · PRs **#110–#168 + #171** (no #169/#170 — still open)                                                                                                                                           | `git rev-list --count 8a8c19b..origin/main`                                                                                               |
| **pnpm**                        | **NOT on PATH.** Use `npx --yes pnpm@10.25.0 …` (verified prints `10.25.0`)                                                                                                                                     | `which pnpm` → not found; no corepack; no global install                                                                                  |
| **Node**                        | v26.3.1 local · CI pins Node 20                                                                                                                                                                                 | `node -v`                                                                                                                                 |
| **Postgres / Docker**           | **NEITHER EXISTS** on this machine (no `docker`, `psql`, `initdb`, `colima`, `podman`)                                                                                                                          | probed                                                                                                                                    |
| **GH token**                    | `~/.grok/agent-auth/github_token` (exists, 41 bytes) · identity `ZenYoda3` · perms `push+triage`, **`admin: false`**                                                                                            | `gh api repos/... --jq .permissions`                                                                                                      |
| **Branch protection on `main`** | **NONE** (API 404)                                                                                                                                                                                              | `gh api .../branches/main/protection`                                                                                                     |
| **CI reality**                  | Runs DO start and DO fail: `#171` run `30516841506` → jobs `Tests`/`Doctrine gates`/`Typecheck & build` all `failure` in **4–11s with zero steps executed**; `Definition of Done` `skipped`. No successful run. | `gh run list` / `gh run view --json jobs`                                                                                                 |
| **Open PRs**                    | **#169** `feat(uiproof): PR-1 Stream A boot.mjs` (touches root `package.json`, `.gitignore`, `tooling/uiproof/boot.mjs`, 2 docs) · **#170** `docs: Denon↔Nitro parallel board`                                  | `gh pr list --state open`                                                                                                                 |
| **Machine hazards**             | **100 registered worktrees**, `.worktrees` = **13G**, disk **89% full / 50G free**, per-worktree `node_modules` ≈ **558M**                                                                                      | `git worktree list`, `du`, `df`                                                                                                           |

**Re-confirm only two of these at start (tip may have moved, PRs may have merged):** tip SHA, open-PR list. Everything else is settled.

---

## 1 · PHASE ORDER WITH HARD GATES

Gates are hard: a phase cannot start until the previous phase's gate artefact exists on disk. Each phase appends to its own file before moving on (see §7, compaction survival).

### Phase 0 — Environment + freeze · GATE-0

Cannot proceed without all eight lines written to `docs/audit/2026-07-30-afk-cook-mega/00-FREEZE.md`.

1. **Prune worktree sprawl first** (this is a run-killer, not hygiene — see §9-F1): `git worktree list | wc -l`; `git worktree prune`; remove finished audit/docs worktrees. Target **< 15** registered worktrees before creating a new one.
2. `export GH_TOKEN="$(cat ~/.grok/agent-auth/github_token)"` — never echo it, never write it to a doc.
3. `git fetch origin main` → record **TIP SHA + UTC time**.
4. Record **SINCE = `8a8c19b`** (baseline is settled; do not re-litigate).
5. `gh pr list --state open` → for each open PR, write one of exactly three dispositions: `PRE-AUDIT NOW` (money/auth/deploy touch), `LEAVE — not audit scope, will conflict: <file>`, `LEAVE — docs only`. Default for **#169**: `LEAVE — operator's Stream A lane; conflicts on root package.json; audit rebases around it`. Default for **#170**: `LEAVE — docs only`.
6. `npx --yes pnpm@10.25.0 --version` → must print `10.25.0`. If it does not, **stop and escalate** (§9-F2).
7. Create the audit worktree from `origin/main` **only**: `node tooling/scripts/worktree.mjs create audit/mega-2026-07-30` (equivalent of `pnpm wt`; works without pnpm on PATH). Never edit the main checkout.
8. In the worktree: `npx --yes pnpm@10.25.0 install --frozen-lockfile` → record exit code and elapsed time. **Copy this plan file into the worktree** (`docs/MEGA-AUDIT-PLAN-V2-2026-07-30.md`) so it is committed with the archive and survives the stale main checkout.
9. Enumerate merged PRs in `SINCE..TIP`: `git log --oneline 8a8c19b..origin/main`.

### Phase 1 — L0 machine truth · GATE-1

**Mirror the CI job set exactly** — not a subset, not a superset. CI has four jobs; run all four locally. Write every command's real exit code to `01-L0.md`. All commands prefixed `npx --yes pnpm@10.25.0`.

| CI job                   | Local commands (all of them)                                                                          | Notes                                                                                                                                                              |
| ------------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Doctrine gates           | `scan:brand` · `scan:custody` · `scan:vendor-shell` · `scan:workspace` · `db:check` · `tracker:check` | v1 omitted `db:check` as a named script and mis-called it "migration-check / dod-gate migrations"                                                                  |
| Typecheck & build        | `build` · `typecheck` · `format:check`                                                                | **v1 omitted `format:check` entirely** — CI runs it, so main can be red on a gate the audit never looked at                                                        |
| Tests                    | `test` — see the skip ledger below                                                                    |                                                                                                                                                                    |
| Definition of Done       | `gate` **with no service argument** (all services)                                                    | v1 sampled 6 services; CI gates all of them. Sampling is allowed only as a _fallback_ if the full run exceeds the time box, and then the sampled set must be named |
| Extra (not in CI, cheap) | `scan:i18n`                                                                                           | exists as a script, not wired into CI — run it, report separately, do not treat red as a merge blocker                                                             |

**THE SKIP LEDGER (mandatory — this is the plan's most important honesty gate).**
`packages/db/src/testing.ts` hard-fails only when `CI=true` or `REQUIRE_POSTGRES=1`. Locally there is no Postgres and no Docker, so **money suites skip silently and `pnpm test` can still exit 0.** A green exit code here is _not_ money-path proof.

Required in `01-L0.md`:

- vitest's `passed / failed / skipped` counts, verbatim.
- **Every skipped suite named by file path**, with a `money?` column. Minimum expected skips to look for: `services/svc-ledger/src/ledger/postgres-ledger.test.ts`, `services/svc-trade/src/spot/trade-service.test.ts`, `services/svc-token/src/economics/economics.test.ts`, `services/svc-indexer/src/projection/postgres-store.test.ts`, `services/svc-blueprint/src/matching/crew-matching.test.ts`, plus any `TEST_DATABASE_URL_*` suite for pay / identity / p2p / bank / agents.
- One literal sentence in the verdict: **"N money suites did not execute locally (no Postgres on this host); their green on CI has never been observed because CI has no successful run."**
- Run `node tooling/ci/assert-test-db-env.mjs` and report — it is CI's own residual-#9 guard.

**Postgres decision (operator fork, do not silently pick):** installing Postgres 16 locally is the only way to actually execute the money suites (~5–10 min, machine-level install, needs network, disk is 89% full). Until it exists, the audit's money verdict rests on code reading + non-DB unit tests + the skip ledger. Put the fork to the operator once, in one line, and proceed with the honest path meanwhile — **never** upgrade "suites skipped" into "money paths verified".

**CI wording (exact, no improvisation).** Do not write "CI never starts" and do not write "billing-blocked" as a bare assertion. Write the evidence: _"Actions runs exist and complete as `failure` in 4–11s with zero steps executed (run 30516841506); no successful run exists. Consistent with a spending-limit / billing block at job start — human-only fix."_ Never claim Actions green. Never open a doc line that could be read as green.

**Merge policy (v1 was factually wrong here).** The token has **no admin rights** and `main` has **no branch protection**. `gh pr merge --admin` will 403. Merges succeed as ordinary merges (that is how #110–#171 landed, all by `ZenYoda3`). So: **normal `gh pr merge --squash --delete-branch`, with the local proof block pasted into the PR body.** Never push directly to `main` even though nothing prevents it. Correct the phrase "admin-merge" wherever it appears in the audit docs.

**GATE-1 rule:** any red in _Doctrine gates_ or _Typecheck & build_ is a **P0 by definition** — fix it before writing any narrative. Red in _Tests_ → triage per §3 rubric. A red gate that is human-only (billing) is recorded, not fixed.

### Phase 2 — Delta inventory · GATE-2

`02-DELTA.md` must contain a table with one row per touched surface: **surface | files | PRs | money? | auth? | deploy? | migration? | judged-by-phase-3-layer**. No surface may be absent, including the ones v1's list dropped.

Verified real delta surfaces (`git diff --name-only 8a8c19b..origin/main`, file counts):

| Surface                   | Files               | v1 listed it?                                                                                 |
| ------------------------- | ------------------- | --------------------------------------------------------------------------------------------- |
| `services/svc-notify`     | 16                  | yes                                                                                           |
| `services/svc-trade`      | 9                   | yes                                                                                           |
| `services/svc-pay`        | 9                   | yes                                                                                           |
| `services/svc-identity`   | 8                   | yes                                                                                           |
| `services/svc-ws`         | 7                   | yes                                                                                           |
| `services/svc-edge`       | 6                   | yes                                                                                           |
| `apps/web`                | 6                   | yes                                                                                           |
| `vendor/**`               | 4                   | **NO — silent drop** (dual-book surface)                                                      |
| `tooling/**`              | 4                   | partly (tracker only)                                                                         |
| `services/svc-token`      | 3                   | **NO — silent drop** (money)                                                                  |
| `packages/config`         | 3                   | **NO — silent drop**                                                                          |
| `services/svc-protocol`   | 2                   | yes                                                                                           |
| `packages/i18n`           | 2                   | **NO — silent drop**                                                                          |
| `packages/events`         | 1                   | **NO — silent drop** (bus contract, §1 two-PR rule)                                           |
| `packages/auth`           | 1                   | **NO — silent drop** (auth primitive)                                                         |
| `Dockerfile` (root)       | 1                   | **NO — silent drop** (deploy)                                                                 |
| `docker-compose.apps.yml` | 1                   | partly ("compose/ports")                                                                      |
| `pnpm-lock.yaml`          | 1                   | **NO — silent drop** (supply chain: diff it for new deps)                                     |
| `docs/**`                 | 21                  | n/a                                                                                           |
| `README.md`, `.gitignore` | 2                   | n/a                                                                                           |
| `packages/ledger-client`  | **0 files changed** | listed first in v1 — state this explicitly; it is good news and must be _stated_, not assumed |

**Migrations in the delta (4 files + downs) — all four judged individually:**

- `services/svc-identity/drizzle/0002_sub_accounts_revoke.sql` (+ `.down.sql`)
- `services/svc-notify/drizzle/0000_notify_init.sql` (+ `.down.sql`)
- `services/svc-pay/drizzle/0002_pay_payment_links.sql` (+ `.down.sql`)
- `services/svc-trade/drizzle/0001_multi_asset_instruments.sql` — **EDITED IN PLACE by #167**, no new migration added. See §3 P0-candidate M1.

### Phase 3 — Risk layers on the delta only · GATE-3

Keep v1's L1–L9 questions (they are good) and add the layer it lacks. `03-FINDINGS.md`, one row per finding: `id | layer | file:line | claim | severity | evidence | fix-owner`.

| Layer                             | Question                                                                                                                                                                             | Runs in parallel batch |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| L1 Doctrine                       | Balances only via `ledger-client`? Money never a `number` on any wire/DB path? Any inline ledger entry assembly?                                                                     | A                      |
| L2 Auth                           | Private REST/tRPC fail-closed without an edge principal? Scopes right? `packages/auth` change safe? `ifc_` bearer exchange (#113/#114) not a bypass?                                 | A                      |
| L3 Money                          | place / cancel / cancelAll / convert / deposit-withdraw / yield-buyback (#112) / payment links + hosted checkout: single money path, claim-before-post, business-key idempotency?    | B                      |
| L4 Plane                          | Protocol surfaces non-custodial? Factory not inventing addresses or `0x0` success? `vendor/**` still UI-only, not the books?                                                         | B                      |
| L5 Edge/deploy                    | `/api/v1` preservePath; svc-notify has compose service + port + Dockerfile + env; root `Dockerfile` and `docker-compose.apps.yml` changes coherent?                                  | C                      |
| L6 Mount honesty                  | Every "shipped" surface: router built **and** registered **and** edge-routed **and** reachable?                                                                                      | C                      |
| L7 WS / terminal                  | Private orders/fills streams JWT-gated (#119); public tape (#162) has no invented candles; chart stays honestly empty                                                                | C                      |
| L8 Tracker                        | `done`/`wip`/`ready` match code; `tracker:check` green **and** notes not lying; scoreboard "next" items real                                                                         | D                      |
| L9 Brand                          | No model-vendor / partner names in shipped docs or UI (`scan:brand` + eyeball the 21 changed docs)                                                                                   | D                      |
| **L10 Migration integrity** (new) | Immutability: was an applied migration edited? Does `db:check` catch it? Is every `.sql` matched by a `.down.sql`? Does any migration constrain before backfilling (the #167 class)? | B                      |
| **L11 Supply chain** (new, cheap) | `pnpm-lock.yaml` diff: any new third-party dependency added during the cook? Named, with why                                                                                         | D                      |

### Phase 4 — Maker-checker adversarial · GATE-4

Per **new** P0/P1 finding, in this order, all recorded in `04-ADVERSARIAL.md`:

1. Implementer proposes the fix in the audit worktree.
2. **Critic is a separate fresh-context agent, read-only tools, briefed to assume the finding is wrong AND the fix is wrong.** Second-family critic where one is configured; otherwise a fresh-context critic agent on the session model. The critic never implements. The implementer never grades its own fix.
3. **False-done check on the fix diff** (§3 rubric, false-done list).
4. Local proof re-run: the _affected_ L0 commands only, real exit codes pasted into the PR body.
5. PR → normal squash merge with the proof block (not `--admin`, see Phase 1).

A finding the critic refutes is written down as **refuted, with the critic's reason** — not deleted. Silent disappearance of a finding is itself a false-done.

### Phase 5 — Fix loop until exit · GATE-5

See §4 for iteration bounds. Severity → action:

| Severity  | Action                                                                                                                                                                          | Bound                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **P0**    | Fix in this program, merge, re-run affected L0                                                                                                                                  | max **3** fix attempts per finding, then escalate                       |
| **P1**    | Fix in this program if the fix is inside the delta's blast radius; else open a PR with a named owner. Never leave silent                                                        | max **2** attempts, then downgrade to residual **with the attempt log** |
| **P2**    | Residual queue in PEACE + archive, each with a name and a why                                                                                                                   | no fix attempts                                                         |
| **Human** | Named only, never "fixed": billing/Actions, real chain + RPC, licences, wallet secrets, counsel list, kill drill, multi-asset rails, real payment rails, candle source, futures | never                                                                   |

### Phase 6 — Close the books · GATE-6

1. Update `docs/PEACE-OF-MIND-AUDIT-CURRENT.md`: **write the literal tip SHA this time** (its missing SHA is what made v1's baseline unresolvable), scoreboard rows, residual queue, claim tag `[VERIFIED 2026-07-30]`.
2. Complete `docs/audit/2026-07-30-afk-cook-mega/` (files per §7).
3. Fix the stale scoreboard lines in `docs/AFK-COOK-SCOREBOARD-2026-07-30.md` if they still misstate reality.
4. Update `docs/GRIND-LOOP-ACTIVE.md` only if high water or audit status changed. Set its status line to note the audit ran.
5. Correct the "admin-merge" phrasing in any doc that carries it.
6. One PR (or a small named set), merged with the proof block.
7. Chat to operator: **verdict only** — pass/fail, P0 count, PR links, what a reviewer would still flinch at.

### Exit criteria (all required, all machine-checkable)

- [ ] Tip SHA + UTC time recorded; SINCE = `8a8c19b` recorded
- [ ] Worktree count pruned below 15 before the run
- [ ] All four CI-mirror job families run locally with real exit codes pasted
- [ ] **Skip ledger present, every skipped suite named, money-suite sentence written verbatim**
- [ ] Every delta surface from Phase 2's table named and judged (including the 8 v1 dropped)
- [ ] All four migrations judged individually; L10 answered
- [ ] Every P0 fixed, or escalated with reason + attempt log
- [ ] Every P0/P1 has a named critic pass; refuted findings recorded as refuted
- [ ] All 9 known residuals re-verified with a verdict each (§6)
- [ ] PEACE updated **with a literal SHA**; archive complete; scoreboard not lying
- [ ] Explicit CI honesty line present; nothing implies Actions green
- [ ] No agent-owned audit PR left open

---

## 2 · PARALLEL FAN-OUT MAP + STAGE ROUTING

Sequential spine (never parallel): **Phase 0 → 1 → 2 → [3 fan-out] → 4 → 5 → 6.**

| Batch             | Layers                                                                        | Parallel?                                                                                | Tier                                                                                                                 |
| ----------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Phase 1 gates     | the 4 CI job families                                                         | **parallel across job families** (independent commands) — but `build` before `typecheck` | mechanical: cheap tier, low effort                                                                                   |
| Phase 2 inventory | git diff aggregation, PR list, lock diff                                      | **parallel**, 1 agent                                                                    | mechanical: cheap tier, low effort                                                                                   |
| A                 | L1 Doctrine, L2 Auth                                                          | parallel with B/C/D                                                                      | **judgment: session model**                                                                                          |
| B                 | L3 Money, L4 Plane, L10 Migration                                             | parallel with A/C/D                                                                      | **judgment: session model**                                                                                          |
| C                 | L5 Edge/deploy, L6 Mount honesty, L7 WS/terminal                              | parallel with A/B/D                                                                      | mixed → **session model** (mount honesty is a lie-detector)                                                          |
| D                 | L8 Tracker, L9 Brand, L11 Supply chain                                        | parallel with A/B/C                                                                      | mechanical greps + judgment on notes → **cheap tier for the greps, session model for the "is this note a lie" call** |
| Phase 4 critics   | one critic per P0/P1                                                          | **parallel across findings**                                                             | **judgment: session model / second family**                                                                          |
| Phase 5 fixes     | one worktree per fix if two fixes touch the same file; otherwise one worktree | serialize merges                                                                         | session model                                                                                                        |

Rule: unclear whether a stage is mechanical or judgment → **judgment**. State the batch→tier map before spending.

---

## 3 · SEVERITY RUBRIC WITH THIS COOK'S EXAMPLES

**P0 — money can move wrong, auth can be bypassed, or the fleet goes down.**

- A private REST/tRPC/WS path reachable without an edge principal (delta: #113/#114 `ifc_` bearer exchange, #119 private order stream).
- Money as `number`, or a balance held outside `ledger-client` (delta: #112 yield/buyback, #145 balance projection).
- A migration that takes the fleet down, or an **applied migration edited in place** — candidate **M1: #167 edited `svc-trade/drizzle/0001_multi_asset_instruments.sql` rather than adding `0002`.** Question to answer: on a database that already ran `0001`, does the backfill ever apply, and does the runner re-run or reject the changed file? If either answer is bad, this is a live P0 with a trivial fix (new `0002` migration).
- Any doctrine gate red on tip (`scan:brand`, `scan:custody`, `scan:vendor-shell`, `scan:workspace`, `db:check`, `tracker:check`).
- Anything that would let a reviewer say "this pretends to have money it does not".

**P1 — wrong or dishonest, but not a value/auth breach.**

- A shipped surface built but not registered or not edge-routed (L6).
- `format:check` or `typecheck` red (CI would have caught it; nothing did).
- A tracker `done` that the code does not support (delta: #149 `trade.convert` done, #152/#159/#161 honesty passes).
- An event published but not in `packages/events` catalog.
- A missing `.down.sql`, or a migration whose down does not reverse.

**P2 — residual, named, not fixed now.**

- Pay rail double-submit until rails are real. Dual-book policy discipline. L2-6 S2S body-bind design. Secret scanning in CI.

**Human — never marked done.**

- Actions billing, real chain + RPC, licences, wallet secrets/keystore ops, counsel sanctions list, freeze/kill drill e2e, multi-asset owner merge rule, real payment rails, candle aggregation source, futures product.

**False-done detection (run on every fix diff, and on the cook's own claims):**

- A test weakened, `.skip`ped, or an assertion deleted to make a fix pass.
- `catch {}` / swallowed error / `?? 0` on a money or auth branch.
- `as any`, `@ts-expect-error`, `any` on a money type or a principal.
- Invented data to fill an honest empty: candles for OHLCV (#146), positions for `[]` (#147), a factory address, a balance, a fake `0x0` success.
- A `done` flip in `tooling/tracker/features.mjs` without a mounted route + a test.
- A scoreboard or PEACE line that claims a verification that never ran (the skip ledger exists exactly to catch this).
- "CI green", or any phrasing a reader could take as green.

---

## 4 · LOOP DESIGN (bounded — this is what v1 lacked)

**Phase-level loop:** each phase runs `until GATE-n artefact is complete`, **max 2 passes**. A second pass happens only if the gate artefact is incomplete (a named surface missing, an exit code absent). Third pass = escalate.

**Fix loop (Phase 5):** `while (open P0 exists && iteration < 5)`. Per finding: P0 max 3 fix attempts, P1 max 2. Attempt = write fix + critic pass + local proof.

**Re-trigger rules (a phase re-runs, it is not "done forever"):**

- A merged fix re-triggers **only the affected L0 commands**, not all of Phase 1.
- A fix touching a money path re-triggers **L3 + L10** for the touched files.
- A fix touching auth re-triggers **L2 + L6**.
- Tip moved during the run (someone merged) → re-freeze tip, re-run Phase 2 **for the new commits only**, note it in `00-FREEZE.md`. Do not restart the program.

**Stop and write the verdict when:** no open P0, every P1 fixed-or-owned, all 9 residuals verdicted, exit criteria checked. Absence of findings is a valid result — do not manufacture findings to look thorough.

**Escalate to the operator (one batched message, do not spin) when:**

- A P0 survives 3 fix attempts.
- A fix requires a machine-level install or a paid/human action (Postgres install, Actions billing, a licence).
- Two findings' fixes conflict and the choice is a product decision.
- The delta turns out to contain something the audit cannot judge without a product answer (e.g. is a surface _meant_ to be public).
- Iteration 5 of the fix loop is reached.

**Time box:** if Phase 1 `build`+`test` exceeds ~25 min wall clock, fall back to per-service `typecheck` + `test` for **every service in the Phase 2 table** (not a sample), and record the fallback and why. `gate` may then be sampled — with the sampled service list named.

---

## 5 · COMPACTION SURVIVAL FILE SET

Write **as you go**, never only at the end. Directory: `docs/audit/2026-07-30-afk-cook-mega/`.

| File                                  | Written at                                 | Contains                                                                                               |
| ------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `00-FREEZE.md`                        | end of Phase 0                             | tip SHA + time, SINCE SHA, open-PR dispositions, env probe results, worktree path, prune result        |
| `01-L0.md`                            | end of Phase 1                             | every command + real exit code, **skip ledger**, CI evidence line, merge-policy correction             |
| `02-DELTA.md`                         | end of Phase 2                             | the full surface table + migration list + lock diff summary                                            |
| `03-FINDINGS.md`                      | **appended per finding, live**             | id, layer, file:line, claim, severity, evidence                                                        |
| `04-ADVERSARIAL.md`                   | appended per critic pass                   | finding id, critic verdict, refutation reasons, false-done check result                                |
| `05-FIXES.md`                         | appended per fix                           | finding id, PR link, attempt count, affected-L0 re-run codes                                           |
| `06-VERDICT.md`                       | Phase 6                                    | one-breath verdict, scoreboard, residual queue, human-only list, what a reviewer would still flinch at |
| `MEGA-AUDIT-PLAN-V2-2026-07-30.md`    | Phase 0 (copied in)                        | this plan, so the archive is self-contained                                                            |
| `docs/PEACE-OF-MIND-AUDIT-CURRENT.md` | Phase 6                                    | **literal tip SHA**, scoreboard, residuals, claim tag                                                  |
| `docs/GRIND-LOOP-ACTIVE.md`           | Phase 6, only if status/high-water changed |                                                                                                        |

**Recovery rule for a cold session:** read `00-FREEZE.md` → last complete `0N-*.md` → resume at phase N+1. Never restart from Phase 0 if `00-FREEZE.md` exists and the tip has not moved.

---

## 6 · KNOWN RESIDUALS TO RE-VERIFY (each needs an explicit verdict line)

Do not drop, do not assume closed. Verdict per item: `HOLDS` / `BROKEN (Pn)` / `CANNOT VERIFY LOCALLY (why)`.

1. **Balance self-only** — `account/balance` (#145) scoped to `principal.userId`, no cross-user read.
2. **Convert path** — kill-switch honored, hold path correct, bind verified (post-#105 fix still in place).
3. **Pay checkout invents no card** — hosted checkout HTML and payment links do not fabricate a card/rail success.
4. **`subAccounts.revoke` soft only** (#158) — `revoked=true`, no hard delete, no orphaned value.
5. **`subAccountId` ownership/revoked gate on `placeOrder`** — prior residual; is the gate present and does a revoked sub-account get refused?
6. **Market order `cost` when price is null** — no `NaN`, no zero-cost fill, no money-as-number leak.
7. **Scoreboard "free mountains" stale line** — still lying? fix or delete.
8. **Migration backfill discipline post-#167** — plus the immutability question (M1, §3).
9. **Factory honesty** (svc-protocol) — no invented addresses, no `0x0` success, still not chain-done and says so.

Additions this plan requires alongside them: 10. **OHLCV honest empty** (#146) and **positions honest `[]`** (#147) — still empty, no invented candles/positions. 11. **Notify fan-out skips events without user ids** (#148/#150/#157) — and `p2pDisputeResolved` still deliberately skipped. 12. **`packages/events` catalog** contains every subject the delta publishes.

---

## 7 · REQUIRED COMMANDS + WHAT COUNTS AS PROOF

Every command runs **in the audit worktree**, prefixed `npx --yes pnpm@10.25.0` where it is a pnpm script.

```
# Phase 0
git fetch origin main && git rev-parse origin/main
git worktree list | wc -l && git worktree prune
node tooling/scripts/worktree.mjs create audit/mega-2026-07-30
npx --yes pnpm@10.25.0 install --frozen-lockfile
gh pr list --state open

# Phase 1 — Doctrine gates
npx --yes pnpm@10.25.0 scan:brand
npx --yes pnpm@10.25.0 scan:custody
npx --yes pnpm@10.25.0 scan:vendor-shell
npx --yes pnpm@10.25.0 scan:workspace
npx --yes pnpm@10.25.0 db:check
npx --yes pnpm@10.25.0 tracker:check
npx --yes pnpm@10.25.0 scan:i18n            # not in CI; report separately

# Phase 1 — Build / Tests / DoD
npx --yes pnpm@10.25.0 build
npx --yes pnpm@10.25.0 typecheck
npx --yes pnpm@10.25.0 format:check
npx --yes pnpm@10.25.0 test                 # capture passed/failed/SKIPPED + skipped file names
node tooling/ci/assert-test-db-env.mjs
npx --yes pnpm@10.25.0 gate                 # all services

# Phase 2
git log --oneline 8a8c19b..origin/main
git diff --name-only 8a8c19b..origin/main
git diff 8a8c19b..origin/main -- pnpm-lock.yaml | head -100

# Phase 5/6
gh pr create ... && gh pr merge --squash --delete-branch   # NOT --admin (no admin rights)
```

**Proof format** — a claim without this block is not a claim:

```
$ <command>
<last 5-15 lines of real output>
exit=<code>
```

For `test`, the proof block must additionally carry the skip ledger. "Ran clean" / "all green" without output is a false-done and is rejected by GATE-1.

---

## 8 · EXPLICIT NON-GOALS

- Finishing the Definitive Build (tracker ~⅓ — out of scope).
- Any new product surface: futures, candle aggregation, real chain factory, push/email/SMS, `pay.public-api` beyond links, `ops.admin` real wiring, terminal charts/hotkeys.
- Re-shipping or re-reviewing merged PRs #110–#171 as product work.
- Full monorepo / vendor-media archaeology outside the delta.
- Re-opening closed 2026-07-29 P0s (#80/#81/#86/#96/#99/#101/#102/#105 + Proper Track 1) unless a **regression is proved on tip**, with the proving command in the finding.
- Live exploit frameworks or pen-testing without explicit authorization.
- Messaging Denon.
- Touching the operator's open PR #169 (Stream A lane).
- Fixing Actions billing, buying licences, or anything on the human-only list.

---

## 9 · FAILURE MODES AND WHAT PREVENTS EACH

| #       | How the run dies                                                                                                                                                                                                | Prevention in this plan                                                                                                                                     |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F1**  | **Shell breaks outright.** 100 registered worktrees inflate the sandbox deny-list past the OS exec argument limit — commands fail with `E2BIG` before running. This already happened while reviewing this plan. | Phase 0 step 1: prune to < 15 worktrees **before** anything else; if `E2BIG` still appears, relax the sandbox for the session or restart the harness        |
| **F2**  | Every command fails `pnpm: command not found`; agent either stops or silently "reports" gates it never ran                                                                                                      | Frozen constant + `npx --yes pnpm@10.25.0` in every command; Phase 0 step 6 gate                                                                            |
| **F3**  | Baseline unresolvable — PEACE records no SHA, so "delta since PEACE tip" is a dead reference and the agent guesses a range                                                                                      | SINCE pinned to `8a8c19b` as a frozen constant; Phase 6 forces a literal SHA into PEACE so this never recurs                                                |
| **F4**  | **False green.** `pnpm test` exits 0 while every money suite silently skipped (no Postgres); audit reports "money paths verified"                                                                               | Mandatory skip ledger + verbatim money-suite sentence + `assert-test-db-env.mjs`; skipped ≠ verified is an exit criterion                                   |
| **F5**  | Merge blocked at the last step: `gh pr merge --admin` 403s on a non-admin token, agent thinks it is locked out and strands finished work                                                                        | Merge policy corrected to plain squash merge; `admin: false` is a frozen constant                                                                           |
| **F6**  | CI misreported as "never starts" / "billing-blocked" with no evidence, or worse as green                                                                                                                        | Exact wording + run id + job evidence required in `01-L0.md`                                                                                                |
| **F7**  | Compaction mid-Phase-3 loses everything because archive was a Phase 6 task                                                                                                                                      | Append-as-you-go file set (§5) + cold-resume rule                                                                                                           |
| **F8**  | Infinite fix loop on one stubborn P1, or premature stop after one shallow pass                                                                                                                                  | Bounded loops (§4): per-finding attempt caps, 5-iteration ceiling, named escalation triggers, phase re-trigger rules                                        |
| **F9**  | Silent surface drops — 8 real delta surfaces absent from v1's inventory get judged by nobody                                                                                                                    | Phase 2 table derived from `git diff --name-only` with file counts; GATE-2 requires every row judged                                                        |
| **F10** | Migration risk mis-framed as "check backfills", missing that an applied migration was edited in place                                                                                                           | L10 layer + named P0 candidate M1 with the exact question                                                                                                   |
| **F11** | Product work races the audit: the 45m grind scheduler or open PR #169 merges into the delta mid-run                                                                                                             | Pause the grind scheduler for the duration (it is DRAINED anyway); #169 disposition `LEAVE` recorded in Phase 0; tip-moved re-trigger rule handles the rest |
| **F12** | Self-graded fixes — implementer declares its own fix sound                                                                                                                                                      | Phase 4 maker-checker with read-only critic + false-done check; refuted findings recorded, not deleted                                                      |
| **F13** | `pnpm verify` too heavy / times out and the agent quietly skips it                                                                                                                                              | Time box + named per-service fallback covering **every** service in the Phase 2 table                                                                       |
| **F14** | Disk fills (89% used, 50G free, 558M per worktree install) mid-run                                                                                                                                              | Prune first; one audit worktree, reuse it for fixes; if a fix needs isolation, remove the previous fix worktree first                                       |
| **F15** | Audit invents work to look busy, or re-ships merged cook PRs                                                                                                                                                    | Non-goals §8 + "absence of findings is a valid result" in §4                                                                                                |

---

## 10 · WHAT SUCCESS LOOKS LIKE

| Signal                                | Meaning                                                                                                                            |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Sound for review**                  | Doctrine gates green locally, no open P0, residuals named and unembarrassing, skip ledger honest about what did not run            |
| **Not yet**                           | Named P0s, each with a PR in flight or a human blocker                                                                             |
| **Honest flinch list (fine to have)** | Actions red/billing, money suites unexecuted locally, OHLCV/positions honestly empty, chain not propped, sandbox rails, tracker ~⅓ |
