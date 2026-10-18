# Swarm all-out orient — cold agents (GitHub tip)

> **Historical orientation (2026-08-03), not a live queue.** Keep the anti-stamp and ownership principles, but re-derive the tip, open PRs, tracker ownership, claims, and ledger before acting. Dated statuses and example queues never override live state.

**Status:** BINDING for multi-chat / multi-model / insane parallel when Nitro says go all-out / AFK / swarms  
**Audience:** every agent (any coding agent CLI) — Nitro does not run git  
**Re-derive tip every fire.** Chat memory is never high water.

---

## 0 · Can you “just go”? (honest)

| Question                                 | Answer on tip after this PR lands                                                                                                        |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Are Denon’s specs/docs on GitHub?        | **Yes — and more are on branches.** You must `git fetch` + read **main docs** and **open PR / branch specs**, not only main.             |
| Do you know what to build without Nitro? | **Yes if you run §1 discovery.** Free work is derived, not remembered.                                                                   |
| Insane swarms without drift?             | **Yes if** every writer has a claim, worktree, path allowlist, and collision check. **No if** 100 agents open the same file.             |
| Board Clear agent Done bars still free?  | **No.** Campaign is **AGENT-COMPLETE**. Free = craft residual + REGROUP product queue + hygiene + babysit + reports — not re-open M1–M7. |

---

## 1 · Discovery ritual (mandatory — before any code)

Run in order. Do not skip to “vibe implement.”

```bash
export GH_TOKEN="$(tr -d '\n\r ' < /Users/Nitro/.grok/agent-auth/github_token)"  # sandboxed agents
git fetch origin
git log -1 --oneline origin/main
# Machine free board (Wave 1) — residual ∩ REGROUP ∩ open PR files
pnpm swarm:freeze          # writes docs/ops/FREEZE-LIVE.md
pnpm swarm:status          # free vs blocked counts
pnpm swarm:next            # first free claim paste
pnpm swarm:next --all       # ALL free product pastes (anti-under-spawn)
pnpm swarm:claim <id>       # atomic lock docs/ops/claims/<id>.md (not LIVE-LANES)
# Before first edit on claimed paths:
pnpm claim:check <paths>   # or pnpm claim:check after your branch has diffs
gh pr list --state open --limit 50
# product free / human locks
#   tooling/tracker/features.mjs · docs/BOARD-CLEAR-NEXT.md · docs/BOARD-CLEAR-SCOREBOARD.md
# Denon same-day product queue (now on main):
#   docs/REGROUP-2026-08-03.md
# FE residual machine SoT:
#   tooling/frontend/residual-register.json · pnpm frontend:residual
# Fleet surface for Nitro:
#   docs/ops/DASHBOARD.md  ·  pnpm swarm:report
# in-flight shell work (may be branch-only until PRs open):
#   origin/fix/shell-landing-honesty · origin/fix/shell-money-on-the-wire · origin/fix/shell-wire-validation
```

**NO-FLEET proof:** Docker may be absent — honesty ships with `proof_missing: fleet-blocked`, never fake browser done. **:8090:** if `lsof` listener cwd ≠ your worktree, visual proof is invalid.\n\n**Anti-under-spawn:** if `pnpm swarm:status` shows free product claims, the coordinator must spawn or residual-own each — idle free claims = FAIL for an all-out run.

### freeProduct=0 — do not drift into stamp mill (mandatory)

**Law home:** [`docs/ops/SWARM-MANDATE.md`](ops/SWARM-MANDATE.md) AFK priority ladder.  
`pnpm swarm:status` / `swarm:next` print the ladder when product is empty. **Enforce it.**

| Do                                                           | Don't                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------- |
| Land stranded `origin/feat/*` after path-intersect           | Open `docs(ops): R07 cycleN freeProduct=0` every few minutes  |
| Partner babysit: **exact** CI fail extract + one NEW comment | Merge Denon/Shehzad PRs or dual-edit their files              |
| Deepen thin `docs/ops/trk/*` (code-grounded)                 | Invent depth UI / Shehzad M1–M7 implement                     |
| Invent re-scan only after shell code changed                 | Invent re-scan / P-WS report stamps with **no board delta**   |
| Merge green Nitro Class N when checks complete               | Treat freeProduct=0 as session kill **or** as license to spam |

Schedulers (30m/45m keep-alives) must run the ladder, not open stamp PRs when freeze is unchanged.

### What answers which question

| Question                                | Source                                                                        |
| --------------------------------------- | ----------------------------------------------------------------------------- |
| What is product UI?                     | Shell `:8090` · `vendor/**/05_Web_Front` · not `apps/web` · ADR retire on tip |
| Who merges what?                        | `docs/NITRO-OWNERSHIP-AND-DENON-DIRECTION-2026-07-31.md`                      |
| Product free / human mountain?          | `tooling/tracker/features.mjs`                                                |
| Campaign next?                          | `docs/BOARD-CLEAR-NEXT.md` (sequence only — **AGENT-COMPLETE**)               |
| **What FE to build now (Denon queue)?** | **`docs/REGROUP-2026-08-03.md` §5–7**                                         |
| What honesty craft residual?            | residual-register · AFK campaign                                              |
| Who is coding this hour?                | `docs/LIVE-LANES.md` + open PR **file lists**                                 |
| Partner walls?                          | Shehzad M1–M7 · Denon open PR paths                                           |

### Specs on GitHub — not only “docs on main”

Denon puts direction in: **merged docs**, **open PRs**, and **branches without PRs yet**.  
**All-out agents must:**

1. Read tip docs
2. `gh pr list` + `gh pr view N --json files` before claiming paths
3. For known free branches: `git log origin/main..origin/<branch> --oneline` and prefer **finish that branch** over re-implementing

---

## 2 · Free work matrix (spawn all path-clean in parallel)

### A · REGROUP product-surfaces (priority FE writers)

From `docs/REGROUP-2026-08-03.md` (do not invent alternatives):

| Claim       | Build                                                                          |
| ----------- | ------------------------------------------------------------------------------ |
| **RP1**     | `Exchange.vue` call sites → `ix-money` (money-on-wire real finish)             |
| **RP2**     | `Index.vue` landing honesty (wire copy; kill null / green ▲ / PRICE TREND lie) |
| **RP3**     | Announcement strip stated reason (sockets / IxNoSurface)                       |
| **RP4**     | `ix-wire` golden + adopt schemas on `ix-trade` reads                           |
| **RP5**     | Terminal residual ports after RP1–4 progress                                   |
| **RP-LAND** | Open/finish PRs from `fix/shell-*` branches without rewriting from zero        |

**One owner for `Index.vue`** (RP2 wins over AFK-INDEX if both free).

### B · AFK residual writers

`pnpm frontend:residual` → every `afk_safe` open/partial id = one worker (except Index if RP2 claimed).

### C · Ops / hygiene / babysit (parallel, always)

| Claim                   | Action                                  |
| ----------------------- | --------------------------------------- |
| LIVE-LANES refresh      | Keep board true to tip + open PRs       |
| Nitro green Class N PRs | Merge per ownership matrix              |
| #346 Shehzad            | Babysit only                            |
| Denon open PRs          | No dual-edit files; optional CI comment |
| Reports R00–R11         | See §4                                  |

### D · Platform integrity (report first)

Depth/tape **blocked** until WS market-ID edge∩matching + nginx `/ws`→`/stream` fixed.  
**Do not** spawn 20 depth UI agents. Spawn **one integrity report** or implement only free non-colliding paths.

### E · Explicitly forbidden writers

Shehzad M1–M7 · dual-edit Denon open PR files · invent prices/depth/balances · Class X · apps/web as product · force-push spine · main-checkout code

### F · Research swarms (unlimited readers)

Invent-money scan · PR risk rank · branch-ahead audit · design critique → **disk report** or new free claim. No report = waste.

---

### G0 · RP1 fabricated-money trap (agents — mandatory)

→ [`docs/ops/RP1-FABRICATED-MONEY-RATCHET-TRAP.md`](ops/RP1-FABRICATED-MONEY-RATCHET-TRAP.md)

### G · Denon hard board (not free agent implement)

While Nitro agents swarm residual, **Denon’s invent-risk / product-complete / integrity mountains** are tracked here — agents babysit only, do not dual-edit, do not take those engines:

→ **Live:** [`docs/LAST-MVP-BOARDS-2026-08-23.md`](archive/LAST-MVP-BOARDS-2026-08-23.md) · historical 120-ID [`docs/DENON-HARD-PARALLEL-BOARD-2026-08-09.md`](archive/DENON-HARD-PARALLEL-BOARD-2026-08-09.md)  
→ Factory done: [`docs/SPEC-FACTORY-INDEX-2026-08-04.md`](archive/SPEC-FACTORY-INDEX-2026-08-04.md)  
→ Historical: [`docs/DENON-HARD-TASK-BOARD-FROM-NITRO-SWARM-2026-08-03.md`](DENON-HARD-TASK-BOARD-FROM-NITRO-SWARM-2026-08-03.md)

## 3 · Swarm anti-negatives (accounted for)

| Negative                     | Combat                                                            |
| ---------------------------- | ----------------------------------------------------------------- |
| Double-write same path       | LIVE-LANES claim + open PR file intersect **before** edit         |
| Stale tip                    | PRE-FLIGHT fetch every fire                                       |
| Swarm tax (duplicate agents) | One writer per claim id; research is read-only                    |
| Context exhaustion           | Progressive load: this file → REGROUP/residual slice → paths only |
| Semantic merge hell          | Sequential merge Class N; rebase after tip moves                  |
| Fake board clear             | Residual honesty + H-peace tip SHA                                |
| Continue-loop                | AFK residual drain; no “wait for Nitro” on free Class N           |
| Drift to apps/web / Next     | Product law every paste                                           |
| Depth thrash while WS broken | Integrity gate                                                    |
| Push storms                  | Local `pnpm verify` first                                         |
| Meta forever                 | Each agent ends in PR link, residual stamp, or report path        |

**Insane N is OK** when N ≈ free claims + research readers + verifiers — **not** N writers on one mountain.

---

## 4 · Reports (so Nitro sees control without code)

Agents write under `docs/ops/` (or update existing) on cadence:

| ID               | Purpose                                        |
| ---------------- | ---------------------------------------------- |
| R00 inventory    | Tip · PR counts · residual open count · FREEZE |
| R01 PR matrix    | Every open PR: CI · mergeable · Nitro action   |
| R02 free claims  | Living claim table                             |
| R05 Denon return | What shipped · what waits · WS handoff         |
| R07 peace        | Finish status + residuals + tip SHA            |

---

## 5 · Roles for insane parallel

| Role      | N                 | Job                                |
| --------- | ----------------- | ---------------------------------- |
| Coord-FE  | 1                 | REGROUP + residual writers         |
| Coord-OPS | 1                 | Reports + babysit + merges Class N |
| Writers   | = free claims     | One claim · worktree · PR          |
| Landers   | 1–3               | Shell branches → PRs               |
| Verifiers | 1 per 2–4 writers | Prefer second model                |
| Research  | many              | Reports only                       |

---

## 6 · Worker paste (one claim)

```
PRE-FLIGHT: pnpm swarm:freeze · pnpm claim:check · docs/SWARM-ALL-OUT-ORIENT-2026-08-03.md §1.
You own ONLY claim: <id>   # or use: pnpm swarm:next
Allowed paths: <list from FREEZE-LIVE / REGROUP>
Forbidden: Shehzad M1–M7; files in open Denon PRs; invent money/depth; apps/web product; main checkout.
Worktree from origin/main. Claim LIVE-LANES. pnpm verify. One PR. Stamp residual if FE.
```

## 7 · Coordinator / Nitro GO paste

```
Go all-out swarms. Law: docs/SWARM-ALL-OUT-ORIENT-2026-08-03.md + docs/REGROUP-2026-08-03.md + residual + ownership.
PRE-FLIGHT: git fetch · pnpm swarm:freeze · pnpm swarm:status · pnpm swarm:report · docs/ops/DASHBOARD.md
Loop: pnpm swarm:next → spawn worker → re-freeze after merge → until free product empty or blocked-only.
Anti-under-spawn: every free product claim gets a worker or residual owner.
No dual-edit Denon open PRs. No Shehzad implement. No invent. No depth UI until integrity free.
Tokens unlimited for productive width+depth+reports. Worktrees. claim:check. Verify.
I am AFK. Peace scoreboard when free residual empty or blocked-only.
```

---

## 8 · Related tip docs

| Doc                                                        | Role                                     |
| ---------------------------------------------------------- | ---------------------------------------- |
| `docs/REGROUP-2026-08-03.md`                               | Denon product queue + blockers           |
| `docs/ops/DASHBOARD.md`                                    | Fleet surface (`pnpm swarm:report`)      |
| `docs/ops/FREEZE-LIVE.md`                                  | Machine free board (`pnpm swarm:freeze`) |
| `docs/adr/2026-08-03-retire-apps-web-port-to-vue-shell.md` | One surface law                          |
| `docs/FRONTEND-AFK-AUTONOMOUS-CAMPAIGN-2026-08-02.md`      | AFK residual drain                       |
| `docs/NITRO-PARALLEL-OPS.md`                               | Multi-agent board ops                    |
| `docs/PERMANENT-TIP-AND-HYGIENE-2026-08-03.md`             | Tip hygiene                              |
| `docs/NITRO-SESSION-PROMPT.md`                             | Paste PRE-FLIGHT                         |
