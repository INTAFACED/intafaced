# SPEC — Rebar all-out (hardened 2026-09-17, audit-3)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Status:** WAITING **start**. Do not execute writers. Audit-5: this is a **work queue + coverage ledger + idle watchdog**, not a graph and not an unbounded loop.  
**Peace file (for the mill / next agent, not homework):** [`ops/boom/REBAR-STATUS.md`](ops/boom/REBAR-STATUS.md)  
**Tip at this rewrite:** `origin/main` `426ea9d43`. Grok door is dirty — ignore it.  
**Parent:** [`SPEC-BACKEND-MEGA-PLAN-2026-09-03.md`](SPEC-BACKEND-MEGA-PLAN-2026-09-03.md) · live-wire [`SPEC-PRO-EXCHANGE-LIVE-AND-DEPTH-2026-09-02.md`](SPEC-PRO-EXCHANGE-LIVE-AND-DEPTH-2026-09-02.md) (on origin) · mountains stay M00–M28 in `PRO_TRADER_EXCHANGE_DEFINITIVE_SCOPE.md` — **do not recook that list**.  
**Queue:** [`ops/boom/REBAR-QUEUE-2026-09-17.md`](ops/boom/REBAR-QUEUE-2026-09-17.md)  
**Doubt:** fresh reviewer 2026-09-17. Paid: pulse-check FAILURES #9–#13.

---

## 0 · Self-prompt (every turn, including after compaction)

You are the Rebar mill owner in **this chat only**. Files are memory.

1. `git fetch origin main`. Tip = `origin/main`. Never the Grok door.
2. Re-read this spec + the queue. Chat residuals lose to **merged PRs on origin/main**.
3. **Leftover** = any row still `PLAN` or `OPEN` or unfalsified `IN-LEAD` or unexploded `HMAC-LIST` **or** any `REBAR-COVERAGE.md` class `UNHUNTED`. **FINISHED is illegal** while leftover is non-empty **or** this mill has an open GitHub PR **or** a mill worktree still listed **or** the watchdog still scheduled. Terminal: `LIVE-DOOR` | `NAMED-REFUSE` | `SEALED` | `SOCKET` | `FRONTEND` | `KEEP` | `SKIP`. `SOCKET` named ≠ mill stop. `PLAN` counts. `LIVE-DOOR` from a PR title alone is illegal — test file on `origin/main` must still assert the door.
4. Never stop for: compaction, CI, verify, pulse, empty local writer, IN-stamp, closed-unmerged PR, Dependabot, “builder table done.” If leftover remains and writers are 0, **spawn** — idle is a defect.
5. Width: **3–6** path-disjoint **services** (not cards). Floor 3 while ≥3 services have `OPEN`. **Never 1** while another service has `OPEN` (FAILURES #9). Matching’s many cards are **one seat**.
6. One service per PR. `pnpm wt`. `graphify query "<symbol>" --budget 400`. No `vendor/`. After edits: `GRAPHIFY_MAX_WORKERS=1 graphify update .`. Do not mill `graphify-out` as product.
7. Class M → fail-first + doubt-driven before merge.
8. **You merge.** Squash to `main`, never push `main`. Merging follows [`AGENTS.md`](../AGENTS.md); never delete branches. Never merge Dependabot, partner, or non-mill PRs. Auth: `GH_TOKEN` from `~/.grok/agent-auth/github_token` — never print.
9. No frontend. No `svc-chain`. No ccxt. No hand-rolled FIX/SBE/Greeks. Blank owner env → refuse. **Do not** change compose `INTERNAL_SERVICE_BODY_BIND:-accept-both` (pin tests are law).
10. Nitro has **no** check, click, merge, or terminal step after start. STATUS is written for the mill and the next agent.
11. Desk close-out only trees **this mill** created (`spec-rebar-*` / writer branch prefix). Never `wt:gc` the world.
12. Compaction: resume same turn. `PLAN` still leftover.
13. Writers: `isolation` **none**; they `pnpm wt` themselves. Never `isolation=worktree` (child edits do not merge).
14. AFK: durable scheduler 20m (lock `REBAR-LOCK`). On `FINISHED`, delete the scheduler. One mill only.
15. Close-out (same turn as last merge): mill worktrees gone · mill scheduler deleted · lock deleted · mill PRs squash-merged · STATUS=`FINISHED`. Skip any of those → not finished.

**Banned occupancy (THEATER if two in a row):** `unset refuse` / `no invented N` as the whole PR; GET `/markets` (or any milled door) **clients**; `*-honesty.ts` factories; `Number(limit)` / pagination; compose `${VAR:-}` hunts that are not a **named fee**; inventing `pending` money-skip rows; dual-implement halt/convert/isolated-IM; global HMAC `require`.

---

## 1 · Unspoken needs (binding — audit-2 added)

| Need                                                    | How                                                                                                                                                                                                   |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Peace **before** start, not after a mill                | Queue already shows **kills from tip evidence**. Start is not 50× PLAN.                                                                                                                               |
| The plan itself can be theater                          | First draft copied Sep 3 cards and pre-seated live doors. Adversarial rewrite required.                                                                                                               |
| Stage 1 must **kill**, not manufacture OPEN             | Default kill. OPEN only with missing door **file:line** + independent verify.                                                                                                                         |
| September mill loop (102 “unset refuse” commits)        | Banned occupancy. NAMED-REFUSE is success, not a writer seat.                                                                                                                                         |
| HMAC compose pin is law                                 | Matching dropped v1; compose stays `accept-both`. No fleet 401.                                                                                                                                       |
| Do not money-wrong IM                                   | `margin_current` already exists. AUG7 is not a Class M seat from a paragraph.                                                                                                                         |
| Completeness ≠ card table                               | Every mega section + §21 packages + money-skip roots + Wave 0 merged-vs-closed have rows. Taxonomy: SEALED / leftover-software / SOCKET / OWNER-SET / FRONTEND (FAILURES #13). Do not recook M00–M28. |
| He cannot read tests                                    | Remaining line names **ids**. Check = what a door now does in English.                                                                                                                                |
| One compact safe chat                                   | Subagents die. Spec+queue survive. Docs commit does **not** decrement leftover.                                                                                                                       |
| All-out without lazy                                    | Real leftover halves (WS L3, FIX process, bank retry, ledger non-recipe, venue 0) stay named until killed.                                                                                            |
| Come back and it is actually finished                   | STATUS file + watchdog. Chat dying is not a stop if the scheduler still fires.                                                                                                                        |
| High impact / compute                                   | Cheap explore kills IN-LEAD; 4.6 only on missing-door judgment, critics, money writers.                                                                                                               |
| Finished ≠ go-live                                      | SOCKET/FRONTEND/OWNER stay listed. No “the venue is live.”                                                                                                                                            |
| After start: no merge click, no GitHub, no file to open | §19 close-out is the mill’s job. FINISHED illegal with open mill PRs.                                                                                                                                 |
| Don’t stop after a kill pass / don’t shrink scope       | Stage 3 always hunts the full coverage ledger. IN-LEAD dying is not finished.                                                                                                                         |

---

## 2 · Methodology (unchanged wins)

Origin `AGENTS.md` graphify **400**. Merge per AGENTS.md. Doors not shell clicks. Thrift void. Door AGENTS 1500 is stale.

Wave 0 this turn (gh): `#3771 #3772 #3779` **MERGED**. `#3777 #3708 #3746 #3707` **CLOSED unmerged** — not “on tip.” Intake/honesty for protocol = falsify **code on origin/main**, never “PR closed.”

---

## 3 · Tools

No marketplace installs. Fire in-repo gates + graphify + fail-first + doubt. Compose HMAC pin tests **forbid** `:-require`. H8 register on tip has **one** row (`svc-pay` evm-chain live / anvil) — not a skip mill.

---

## 4 · What Stage 1 is allowed to do

Default for any `IN-LEAD` / `PLAN` row: **kill** to `LIVE-DOOR` or `NAMED-REFUSE` or `SEALED` if `git show origin/main:<file>` plus a named door test exists.

`OPEN` requires **all**:

1. Missing door named as `path:line` (compose or HTTP or FIX process or JobHost or PG).
2. One sentence: what is not live.
3. Independent second agent sets `real=true` with that evidence.
4. One service. Not a GET-client. Not a compose-pin fight.

Unverified `OPEN` **cannot** spawn a writer.

Stage 1 **cannot** add work that was not a queue row, except HMAC: it must emit the **complete** list of inbound **mutate** S2S doors that still accept unbound HMAC (no cap). Zero is valid. GET identity/account-state is not a row. Compose default is not a row.

`LIVE-DOOR` / `IN-LEAD` kill: `git show origin/main:<test>` **and** the assertion still in the file (rg). PR number without that = not a kill.

---

## 5 · Finish predicate (one sentence, both files)

Leftover = `PLAN` ∪ `OPEN` ∪ unfalsified `IN-LEAD` ∪ unexploded `HMAC-LIST` ∪ any coverage class still `UNHUNTED`.  
Finished iff leftover is empty **and** every row in [`ops/boom/REBAR-COVERAGE.md`](ops/boom/REBAR-COVERAGE.md) is `HUNTED` **and** close-out §19 is all true **and** STATUS starts with `FINISHED`.

Killing IN-LEAD in Stage 1 is **not** finished. Stage 3 always runs the coverage ledger. Skipping Stage 3 because “OPEN was zero” is thinning (FAILURES #10).

Stage 3 **must not** re-open a Stage 1 kill without a **new** path. Marking a coverage class `HUNTED` without reading the named files is theater. Absence of STATUS=`FINISHED` = not finished.

---

## 6 · Fan-out (after start only)

| Role                 | Type                  | Model    | Count          | Rule                                                                                                 |
| -------------------- | --------------------- | -------- | -------------- | ---------------------------------------------------------------------------------------------------- |
| Coordinator          | this chat             | grok-4.6 | 1              | no product commit on door                                                                            |
| Stage 1 IN-LEAD kill | explore               | grok-4.5 | ≤4 parallel    | `git show` + rg assertion; mechanical                                                                |
| Stage 1 PLAN / HMAC  | explore               | grok-4.6 | ≤6             | judgment: missing door or empty HMAC list                                                            |
| Stage 1 critic       | code-reviewer         | grok-4.6 | 1              | **disprove** every `OPEN`                                                                            |
| Writers              | general-purpose       | grok-4.6 | 3–6 services   | critic-passed `OPEN` only; `isolation=none`; `pnpm wt`                                               |
| Class M doubt        | code-reviewer         | grok-4.6 | 1 per money PR | ARTIFACT+CONTRACT, no CLAIM                                                                          |
| Merge auditor        | explore               | grok-4.5 | 1              | door still on origin/main?                                                                           |
| Watchdog             | scheduler 20m durable | —        | 1              | critic-passed `OPEN` + 0 live children → spawn Stage 2 only; never Stage 1; `FINISHED` → delete self |

Do **not** use: `isolation=worktree` writers · Rhai workflow for ship (does not merge) · ponytail · impeccable · a second coordinator.

**No pre-named first seats.** First seats = whatever is `OPEN` after critic, path-disjoint, width 3–6.

Spend: Stage 1 is the expensive judgment. Writers only on survivors. Naive 26-service re-audit = waste. Pre-seating H1/H7/H11/HMAC = the first-draft failure.

**Path walls:** `packages/contracts` `events` `ledger-client` serial. Two writers never share `services/<x>`.

**Worktrees:** if `pnpm wt` fails, GC only `spec-rebar-*` / this mill’s prefix. Not `pnpm wt:gc` all junk on a 300-tree host unless the script classifies junk **and** it is ours.

---

## 7 · Stages

### Stage 1 — kill (same hour, no writers)

Fill every row to a terminal or to critic-passed `OPEN`. Expand HMAC-LIST or kill it. Split multi-service cards (H2 ws half, H4 trade half, H7 consumer vs adapter, R-agentic) **or** kill the missing half.

### Stage 2 — ship survivors

Width 3–6 **services**. Writer who finds the door already live: mark `LIVE-DOOR`, die, do not invent a refuse. Banned occupancy applies.

### Stage 3 — full coverage hunt (always — not optional)

Hunt **every** class in `REBAR-COVERAGE.md`. That file is the scope. Do not shrink it mid-mill. Do not add GET-clients or unset-refuse occupancy.

Each class → `HUNTED` only after the named files were read on `origin/main` and the class is `LIVE-DOOR` / `NAMED-REFUSE` / `SEALED` / `SOCKET` **or** a critic-passed `OPEN` that Stage 2 then ships.

Confirmed new `OPEN` → back to Stage 2 (width 3–6). **At most 3** hunt→ship cycles. Same `path:line` twice = occupancy, `rejected`. Two cycles with **zero new** critic-passed fingerprints → remaining read classes become `HUNTED` (LIVE/REFUSE/SEALED) or `needs_validation` (named in STATUS, **no writer**). Then close-out.

Watchdog must **not** restart Stage 1, must **not** spawn if this chat already has live children, must **not** treat `UNHUNTED` as `OPEN`. It only wakes Stage 2 when critic-passed `OPEN` sits idle.

---

## 8 · Writer brief

```
GOAL: critic-passed OPEN row <ID> only.
SUCCESS: fail-first door test + one-service PR merged, OR you prove the door live and mark LIVE-DOOR without a PR.
HARD: ledger-client only; no number money; pnpm wt; graphify --budget 400; one service;
      never 05_Web_Front; never svc-chain; merge per AGENTS.md; blank env refuse; no ccxt;
      hitch FIX/SBE/Greeks; never global INTERNAL_SERVICE_BODY_BIND=require;
      never GET-client chase; never unset-refuse occupancy; never Number(limit);
      never pending skip rows; never graphify-out as the PR; IN-stamp ≠ door.
If the door is already live on origin/main — say so and stop. Do not mill.
If my reasoning is wrong, say so before acting.
```

---

## 9 · Chat contract

- **Changed:** one sentence.
- **Check:** PR URL + what the door does now (English), or “nothing for you.”
- **Remaining:** leftover **ids named**. Not `OPEN n`.

Docs-only commit of this spec does not appear as progress.

---

## 10 · Go ritual (after start — still no writers until Stage 1 critic returns)

1. Fetch `origin/main`.
2. Optional: `pnpm wt spec-rebar-all-out` to put spec+queue on git. **Does not** decrement leftover.
3. Stage 1 + critic.
4. Writers only on critic-passed `OPEN`.
5. Never ping. Never frontend. Never invent §8.

---

## 11 · Tip evidence already used (so start is not 50 PLAN)

Kills / IN-LEAD (Stage 1 still confirms, **writers forbidden** until then):

| id           | evidence this turn                                  | default                                      |
| ------------ | --------------------------------------------------- | -------------------------------------------- |
| H2 matching  | #3783 MERGED native L3 HTTP                         | kill unless WS half missing                  |
| H3           | #3968 SBE Real Logic                                | kill unless image still utf8                 |
| H5           | #3787 mass-quote                                    | kill                                         |
| H6           | #3790 JobHost dated settlement                      | kill                                         |
| H7           | #3792 QuantLib link-or-refuse + greeks-adapter 1.43 | **kill** (first draft lied “no Sep commits”) |
| H8c          | #3815/#3831                                         | kill                                         |
| H8e          | #3807/#4245                                         | kill                                         |
| H9           | #3800 surveillance persist                          | kill                                         |
| H10          | #3850/#3855 basket                                  | kill                                         |
| H11          | compose `DEX_INTERNAL_BOOK_FEE_BPS:-` empty         | **kill** (first draft treated OPEN)          |
| H8-skip      | register = 1 anvil journalled skip                  | **SOCKET** not a mill                        |
| HMAC compose | pin test forbids `:-require`                        | **SEALED**                                   |
| A1           | #3702 MERGED STP surveillance                       | kill                                         |
| A2           | #3703 MERGED convert 10/200 refuse                  | kill                                         |
| AUG7-funding | `margin_current` migration on tip                   | default **kill**; no Class M from paragraph  |
| Q-dex 20bps  | same door as H11                                    | drop duplicate                               |

Still **unfalsified leftover** (Stage 1 must actually open files): H1/H1b FIX process+drop-copy · H2 WS L3 · H4 trade combo holds · A3/A4 execution hitch · A5/A6 FIX account/TIF/passthrough · A7 rulebook compose · R-E5 · R-promo · S2-1/2/3/5/6 · S3-3 · S4-3 · S8-1 · S14 · HMAC-LIST mutate doors · Q honesty not already refuse.

---

## 12 · Hold-back / doubt

First draft hold-back: copied Sep 3 table, pre-seated live H7/H11/HMAC, H8 blob, PLAN not leftover, packages off-queue, Stage 3 gameable, Wave 0 “closed=merged,” AUG7 money risk, remaining as counts, banned occupancy not in writer brief.

This rewrite restores those. Still not mill (correct): frontend, P1 chain, marketplace installs, Semgrep, ponytail, Java-as-SoT, recooking M00–M28, exploding 266 PTX into PRs, flipping compose HMAC default.

**Cross-model:** this contract is high-stakes. Codex/Gemini second opinion on **this file** is available before start — not silent-skip.

---

## 13 · Spec self-review (audit-2)

- Finish texts unified (`PLAN` is leftover).
- First seats deleted.
- HMAC compose SEALED; list must be closed and mutate-only.
- H8-skip not a mill.
- AUG7 default kill.
- Packages + money-skip roots + Wave 0 closed-unmerged are queue rows.
- Stage 3 closed file list.
- Q-support KEEP not SKIP.
- Writer bans verbatim.
- No TBD. UNVERIFIED leftover is named in §11, not “the card table.”

---

## 14 · What “finished” means (Nitro — zero steps)

After **start** you do nothing. No merge click. No GitHub. No file to open. No “is it done?”

The mill is finished when **all** of these are true (coordinator verifies; you are not the gate):

1. Queue leftover software empty **and** every coverage class `HUNTED` (SOCKET / FRONTEND / OWNER / KEEP / SEALED / SKIP may remain — those are not your work).
2. Every PR **this mill opened** is **squash-merged** to `origin/main`. Zero mill PRs still open.
3. Mill worktrees removed. Watchdog scheduler deleted. Lock file gone.
4. `REBAR-STATUS.md` line 1 is `FINISHED` and lists merged PR numbers.

**Not finished:** open mill PRs, unmerged branches sitting on GitHub, STATUS `RUNNING`/`STUCK`/`NOT STARTED`, leftover `PLAN`/`OPEN`.

**Not claimed:** go-live · licensed venue · frontend · INTACHAIN · owner lists · unknown bugs outside the named leftover.

**STUCK** is recorded in STATUS for the next agent. It is not a ping to you. Owner SOCKET leftover is success, not a task.

---

## 15 · AFK (you leave after start)

This chat is the mill. Subagents run in background. A **durable 20m scheduler** re-reads spec §0 + queue + STATUS. If leftover and no live writers → spawn (FAILURES #9/#12). If `FINISHED` → delete scheduler, stop.

Lock: `docs/ops/boom/REBAR-LOCK.json` (heartbeat). A second mill must no-op. Scheduler expiry is 7 days — mill should be done in hours, not days.

If the process is killed **and** the scheduler cannot fire: STATUS stays `RUNNING` or `STUCK` with leftover ids — you do **not** see `FINISHED`. That is honest, not a silent success.

---

## 16 · Impact / compute (do not 4.6 the git-log)

Most queue rows are `IN-LEAD` with a PR already on tip. Confirming a test still asserts is **cheap explore**. Missing-door judgment and money writes are **4.6**.

Fast path (likely): Stage 1 mass-kills IN-LEAD → few `OPEN` (FIX process, WS L3, bank retry, ledger non-recipe, venue 0, HMAC mutates) → 3–6 writers → Stage 3 empty-or-tiny → `FINISHED`.

Waste path (banned): 12× 4.6 rereading H5–H11; unset-refuse occupancy; Stage 3 whole-repo hunt when `OPEN`=0.

HMAC-LIST is the **complete** remaining mutate set (no cap, GET banned). Two banned-occupancy PRs in a row → freeze **that occupancy class**, keep real leftover moving.

---

## 17 · Watchdog / stuck

`STUCK` if: `pnpm wt` cannot create a tree after our-prefix GC · 40m leftover `OPEN` with 0 writers and watchdog already spawned once this hour and still 0 · critic `OPEN` that no writer can touch without violating one-service (name it, do not invent a fourth shared system).

`STUCK` is not `FINISHED`. Named leftover stays for the next agent. Do not ping Nitro.

---

## 18 · Audit-3 holes closed

| Hole                                       | Fix                                                               |
| ------------------------------------------ | ----------------------------------------------------------------- |
| Chat dies → mill dies, you think it’s done | STATUS never `FINISHED` unless predicate; durable scheduler; lock |
| `isolation=worktree` writers never merge   | isolation none + `pnpm wt`                                        |
| All-4.6 Stage 1                            | 4.5 explore on IN-LEAD kills                                      |
| `LIVE-DOOR` from PR title                  | test file + assertion required                                    |
| Stage 3 forced hunt = mill loop            | empty list legal if `OPEN`=0                                      |
| HMAC list unbounded                        | cap 8                                                             |
| Idle with leftover                         | watchdog spawn                                                    |
| You check chat                             | Nitro has zero steps; mill writes STATUS                          |
| Finished = go-live                         | §14 forbids that claim                                            |

---

## 19 · GitHub + cleanup (machine gate — Nitro never in this loop)

Branch prefix for this mill: `rebar/` (example `rebar/h1-fix-compose`). One service per PR.

**Open:** `gh pr create` from the worktree. Body names the queue id + door proof.

**Merge (same turn the writer is done, coordinator owns this):**

```
export GH_TOKEN="$(tr -d '\n\r ' < /Users/Nitro/.grok/agent-auth/github_token)"
gh pr merge <N> --squash   # branch is kept (AGENTS.md)
```

Merge only through the AGENTS.md merge rule (merge check first); never delete the branch.

Never: ask Nitro to merge · merge `#dependabot` · merge a partner PR · `git push origin main` · `git branch -D`.

**Cleanup same turn, last merge:**

1. `git -C /Users/Nitro/projects/Sovereign worktree remove <path>` (never `--force`) each mill tree (`rebar/*`, `spec-rebar-*`).
2. `scheduler_delete` the mill watchdog.
3. Delete `docs/ops/boom/REBAR-LOCK.json`.
4. Write `REBAR-STATUS.md` `FINISHED` + merged PR list + remaining SOCKET names.
5. If the spec/queue/STATUS live only on the door, they must already be in a merged mill PR (first PR after start). Do not leave the contract untracked.

**FINISHED check (run before writing FINISHED):**

- `gh pr list --search "head:rebar/" --state open` → empty
- `git worktree list` → no mill paths
- queue leftover software empty
- `REBAR-COVERAGE.md` has zero `UNHUNTED` (each row `HUNTED` or `needs_validation`)
- scheduler gone

Any fail → STATUS stays `RUNNING` or `STUCK`. Do not write `FINISHED`.

---

## 20 · Audit-4 (this pass)

| Hole                        | Fix                                            |
| --------------------------- | ---------------------------------------------- |
| “Open STATUS” was homework  | Nitro zero steps. File is mill/next-agent only |
| Merge mentioned, not gated  | FINISHED illegal while mill PRs open           |
| No branch prefix / delete   | `rebar/` + squash, branch kept                 |
| Cleanup optional            | §19 checklist is the gate                      |
| Spec stuck on dirty door    | first mill PR lands spec+queue+STATUS          |
| Merge Dependabot / partners | banned                                         |
| Wait for you to click merge | banned                                         |

---

## 21 · What this actually is (plain)

**Not** graph engineering. Graphify is a **map** to open one `services/`/`packages/` file (`--budget 400`). It is not the mill.

**Not** an unbounded agent loop (no Ralph `while :; do`). **Not** a 1,000-agent swarm.

**It is:** one coordinator (this chat) + a **work queue** (what to ship) + a **coverage ledger** (what must be hunted) + an **idle watchdog** (if leftover `OPEN` sits with zero writers). Stages are a DAG with a **bounded** return from hunt→ship (max 3). Then merge + cleanup.

Verdicts (Cloudflare 2026-09 ledger, encoded, **not installed**): `confirmed`/`OPEN` (writer) · `needs_validation` (named leftover, no writer, no severity) · `rejected` (disproved or occupancy).

---

## 22 · Loop brakes (this is the mill-killer)

Paid here: caller-chase, unset-refuse occupancy, compaction-as-stop, thinning. Paid in the industry **today (2026-09-17):** Google Agent Anomaly Detection — infinite loops, **oscillating retries**, rogue role-abandon. Cloudflare anti-patterns — prose findings that cannot be deduped, re-reporting the same source. A coding-agent vendor’s own report (Provencher, today) — >2 overlapping agents “double-checking homework” as a **coordination tax**. arXiv 2607.24604 — generate–test–revise can **destroy a correct patch**.

Brakes (all binding):

1. **Fingerprint** every candidate: `service + path:line + one-sentence hole`. Same fingerprint twice → `rejected`. No writer.
2. **Max 3** Stage 3→2 cycles. Then stop that class: `HUNTED` or `needs_validation`.
3. Two cycles, **zero new** fingerprints → not a fourth hunt. Mark remaining **read** classes hunted. That is not thinning; that is stall.
4. Watchdog **only** if critic-passed `OPEN` exists **and** zero live children. Never restart Stage 1. Never a second coordinator.
5. Stage 3 hunters **read-only**. They do not edit product. Writers edit. (Cloudflare: hunter never writes target source.)
6. Do not restamp a `LIVE-DOOR` and then rewrite it. Preserve the kill (arxiv: looping is not reliability).
7. `needs_validation` = exact unresolved fact, listed in STATUS, **does not** get a PR, **does not** block `FINISHED`.
8. Width 3–6 is **path-disjoint services**, not 12 agents on one file. IN-LEAD kills: cheap explore, not a swarm.

Occupancy still banned. Frontend / P1 / owner env still out. Those are law, not a loop.

---

## 23 · Research this turn (2026-09-17) — encoded, not installed

| Source                                                         | What we take                                                         | What we skip                                                                 |
| -------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Cloudflare security-audit-skill (ledger rework **this month**) | coverage units, critic, three verdicts, additive, hunters don’t edit | marketplace install; generic OWASP checklist as findings                     |
| Google Agent Anomaly Detection (**today**)                     | loop / oscillating-retry as a defect                                 | Gemini Enterprise product                                                    |
| Provencher / Codex (**today**)                                 | coordination tax; don’t swarm one file                               | “never more than 2 agents” — we keep 3–6 **disjoint services** (FAILURES #9) |
| arXiv 2607.24604 (14 Sep)                                      | don’t revise away a verified door                                    | HumanEval harness                                                            |
| agentic-ledger / Ralph overnight loops                         | completion promise + iteration cap                                   | `while :; do` overnight                                                      |

Do **not** `npx skills add` Cloudflare. Method is in this file. Marketplace malware rates still apply.
