# GRIND LOOP — ACTIVE (compaction-safe)

> **SUPERSEDED for campaign goal by Board Clear (2026-08-01).**  
> Use `docs/BOARD-CLEAR-AUTONOMOUS-RUN.md` + constitution + mega audit.  
> This file remains historical babysit reference only. Do **not** follow residual “leave #289” or “wait for Denon product law” while Board Clear is active.

**Status:** **SUPERSEDED** by Board Clear · O1 babysit still useful under Board Clear L0  
**Board Clear law:** `docs/BOARD-CLEAR-CONSTITUTION-2026-08-01.md`  
**Ownership law:** `docs/NITRO-OWNERSHIP-AND-DENON-DIRECTION-2026-07-31.md` (Board Clear precedence for Done bars)  
**Last tip:** re-check `origin/main`

```
STATUS 2026-07-31T09:55Z residual COOK
tip: re-check origin/main (expect post-#321)
open: #289 order-route (leave) · #279 stale
residual: futures #291–#315 · mm seed planner #321 · pay honesty
next: house seeder money path OR candle job · no invent mid
```

---

## How to survive compaction / new chat

1. Read **this file** on `origin/main` first.
2. Read `docs/OVERNIGHT-LOOP-PLAN-2026-07-30.md` + `docs/GRIND-LOOP-WHAT-IT-DOES-AND-PROMPT-FIX-2026-07-30.md`.
3. `git fetch origin main && git log --oneline origin/main -25`
4. `gh pr list --state open` and `gh pr list --state merged --limit 20`
5. **Never re-ship MERGED** (#110-#246 high water; WAVE-AUDIT residual archive is docs Class N only).
6. **Worktree only.** Never edit the main checkout. Never push main.
7. Light gates every product PR; wave audit every 3–4 product ships.
8. **Update this file** before you stop (queue + high water + STATUS block).
9. Never invent green CI. Never mark human-only done. Never invent candles / balances / factory addresses.

---

## Modes (do not collapse)

| Mode                      | When                                       | Job                                                                                                       |
| ------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| **O1 BABYSIT**            | Always (overnight default)                 | Open PRs → classify → gates → comment → merge **only if policy allows**                                   |
| **O2 STREAM-A / HYGIENE** | Parallel lanes claimed in `LIVE-LANES.md`  | Shell polish N1–N8 · tracker honesty · WAVE-AUDIT · LIVE-LANES · brand reds                               |
| **COOK (RUNNING)**        | Status RUNNING with a **named** NEXT QUEUE | Ship residual campaign + Stream A under ownership law + LIVE-LANES — **do not invent** engine product law |
| **MEGA / WAVE AUDIT**     | Explicit audit fire                        | Batch tip audit — not a merge machine                                                                     |

**Futures/OTC/copy/algo product law** still waits on Denon direction (or explicit research-only stub). Implementation residual work is Nitro-owned.

---

## Merge privilege matrix (hard — Nitro agents)

Classify every open PR before merge:

| Class | Meaning                                                           | Nitro merge?                                                                                         |
| ----- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **M** | Money / custody / ledger / pay / bank / withdraw / settlement     | **Yes** after money self-audit + second-pass adversarial + green CI; **no** if Denon/author **hold** |
| **H** | PR body says "not for a fast merge" / needs review / do not merge | **NO** — comment only                                                                                |
| **P** | Spine non-money                                                   | Yes if CI+local green + self-audit + no hold language                                                |
| **N** | Nitro / Stream A / docs / tracker honesty                         | Yes after **audit → fix → debug → prove**                                                            |
| **X** | Human-only surface (billing, licences, go-live, counsel content)  | Never treat as agent-done                                                                            |

Canonical matrix also in `docs/NITRO-OWNERSHIP-AND-DENON-DIRECTION-2026-07-31.md` + residual campaign §5.3 — if conflict, ownership law wins.

**Babysit is not rubber-stamp.** Always post a PR comment: what you ran, what you verified, what you did **not** verify.

**Your bar for Nitro-owned PRs:** audit → fix → debug → then merge. Green CI alone is not enough if a known fail case is unfixed.

---

## O1 — Babysit fire (each 45m)

1. `gh pr list --state open`
2. For each PR: classify M/H/P/N/X → run CI check + local gates when mergeable
3. Hold language → **comment only**. Class M → merge only if self-audit + adversarial + green (ownership law); else comment blockers.
4. Denon WIP radar (do not compete):

   ```bash
   git ls-remote origin 'refs/heads/feat/spine*' | head
   # never force-push Denon branches; never touch feat/multi-asset-instruments
   ```

5. If no open PRs: optional brand/custody/vendor-shell/tracker:check; update high water if tip moved; **stop** (no ceremony)
6. Update STATUS block at top of this file

---

## O2 — Stream A / hygiene (parallel — claim LIVE-LANES first)

**Allowed without Nitro product judgment:**

| #     | Work                                                                                                           | Done when                               |
| ----- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| N1–N8 | Stream A shell (`feat/app-*` only) — empty/error states, order-entry polish, honest empty panes, mobile drawer | PR green + territory clean              |
| N10   | WAVE-AUDIT after Denon wave lands                                                                              | `docs/WAVE-AUDIT.md` / residual honesty |
| N11   | Tracker honesty — notes match main; **never** mark Denon residual done falsely                                 | `pnpm tracker:check` green              |
| N12   | Brand / custody / workspace mechanical reds                                                                    | Scans green                             |
| N13   | Babysit open **Nitro** PRs                                                                                     | Merged or fixed                         |
| N14   | LIVE-LANES + this file current                                                                                 | Board matches live                      |

**Forbidden overnight:**

- Tracker 🟢 rows that are **Denon mountains** (futures, OTC, copy, algo, MM-bot, live rails, multi-asset merge, …)
- `services/**` / packages money / edge / compose / Java as Stream A
- Resuming crash-WIP `feat/spine-*` without Denon reclaim
- Inventing candles, balances, factory addresses, CI green

**Parallel cap:** ≤3 active Nitro lanes; non-overlapping paths; worktrees only.

---

## Enhanced prompts (paste)

### O1 BABYSIT

```
AFK O1 BABYSIT (Nitro away). Merge when Class gates pass — not rubber-stamp.

LAW: docs/NITRO-OWNERSHIP-AND-DENON-DIRECTION-2026-07-31.md + this file merge matrix on origin/main.
LIVE: gh pr list --state open · git log origin/main -10

For each open PR → class M/H/P/N/X.
- H: NO merge. Comment only.
- M: merge ONLY after money self-audit + second-pass adversarial + green CI + no hold. Else comment blockers.
- P: merge if CI+local green + self-audit + no hold.
- N: audit→fix→debug→prove→merge.
- X: never mark done.

If no open PRs: honesty scans optional; update high water; stop.
Never invent product law. Never invent green CI. Update STATUS before stop.
```

### O2 STREAM-A / HYGIENE

```
AFK O2 — Stream A / hygiene (Nitro away).

LAW: ownership law + GRIND-LOOP-ACTIVE + LIVE-LANES. Residual campaign may also use services under claimed residual lanes.
Claim LIVE-LANES before edits. Worktree from origin/main.

Ship: empty/error honesty, order polish, tracker honesty, WAVE-AUDIT, LIVE-LANES refresh, or residual-campaign slice if lane free.
Never invent futures/OTC product law. Never fake numbers/candles. Never force-push feat/spine-*.
One concern per PR. Light gates. Update LIVE-LANES + grind STATUS when done.
```

### COOK (only if Status becomes RUNNING)

```
AFK COOK — GRIND Status RUNNING + named NEXT QUEUE (residual campaign / ownership law).
Worktree. Claim LIVE-LANES. One concern per PR.
Audit→fix→debug→prove→merge YOUR PRs under Class matrix (M needs self-audit + adversarial).
Do not invent engine product law. Update this file before stop.
If queue empty → rebuild queue from residual campaign or return to O1+O2.
```

---

## MERGED (do not redo) — high water

**#110–#235** on main. Agent micro high water **#162–#163**; Stream A **#169/#172/#182** floor; mega-audit **#176–#177**; Denon spine wave **#201–#218**.

| PR       | What                                                                  |
| -------- | --------------------------------------------------------------------- |
| **#221** | fix(ci): DevVenue artefacts + invisible main reds                     |
| **#218** | indexer read models against a real chain + harness watching the wire  |
| **#217** | token factory on dev chain; deployed bytecode ≠ artefact (immutables) |
| **#216** | blueprint share card + false `done` corrected on ownership            |
| **#215** | docs high water through #213–#214                                     |
| **#214** | pay hosted checkout + public sandbox refuse                           |
| **#213** | docs: vendored exchange 0% used                                       |
| **#211** | test DB isolation                                                     |
| **#210** | protocol local EVM + CREATE2 cross-check                              |
| **#209** | venue §27 fabric                                                      |
| **#208** | academy lobbies host-by-rank                                          |
| **#207** | notify multi-channel (honest refuse)                                  |
| **#206** | P0 trade rank-perks credentials                                       |
| **#202** | bank loans (collateral LTV liquidation)                               |
| **#201** | CCXT answers honesty                                                  |

Earlier cook product (#110–#163): CCXT REST slices, notify fans, trade tape, payment links, etc. — do not rebuild.

---

## NEXT QUEUE

### Backend micro (still DRAINED)

Empty of agent-invented product. Do **not** pad.

### O2 active queue (agent-safe)

| #    | Item                                                   | Disposition                         |
| ---- | ------------------------------------------------------ | ----------------------------------- |
| O2.1 | Tracker honesty — `bank.loans` was still 🟢 after #202 | **This PR** marks done + note       |
| O2.2 | Stream A empty/error states / order-entry polish       | **Claim** `overnight-stream-a` lane |
| O2.3 | LIVE-LANES + high water after each Denon tip move      | Ongoing                             |
| O2.4 | WAVE-AUDIT after next Denon wave                       | After open merges settle            |

### Not agent micro / do not fake done

- Futures · candle aggregation job
- Production chain / contract audit (dev chain #210/#217 ≠ go-live)
- Live pay rails · multi-asset merge · licences · kill drill · counsel
- `ops.admin` real kill-switches
- Crash-WIP `feat/spine-*` until Denon reclaims

---

## Human-only (never fake done)

- GitHub Actions billing / minutes
- **Production** chain / RPC / audited factories (local anvil ≠ done for go-live)
- Licences, wallet secrets, counsel list, kill drill, multi-asset rails
- Push/email/SMS **provider credentials** (#207 adapters refuse until configured)
- Futures / positions product
- Candle aggregation

---

## Un-drain protocol (who may set RUNNING)

Only when:

1. NEXT QUEUE lists **named Pool A** items (Stream A / hygiene / explicitly assigned), **or** Denon assigns a ticket
2. LIVE-LANES claims exist
3. Parallel ≤3 non-overlapping

Empty queue → stay O1+O2 / DRAINED micro. **Never invent product to un-drain.**

---

## Scheduler

Every **45 minutes:** re-read this file on `origin/main`.

- Run **O1 babysit**
- Continue **O2** claimed lanes only
- Update high water if tip moved (#218+)
- Do **not** open Denon mountains

**Next agent after compact:** O1+O2 · money = no Nitro merge · do not re-ship #110–#235 · Stream A / hygiene only for product volume.
