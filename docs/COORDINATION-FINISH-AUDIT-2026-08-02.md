> **Supersession (2026-08-09):** Any line that treats **Actions thrift**, run-count caps, `THRIFT_ALLOW`, or holding PRs for CI spend as current law is **void**. The repo is public; thrift was deleted 2026-08-07. See [`GITHUB-CI-SPEND-CONTROL-2026-07-31.md`](GITHUB-CI-SPEND-CONTROL-2026-07-31.md).

# Coordination program — finish audit

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Date:** 2026-08-02  
**Auditor:** agent (this session)  
**Tip under audit:** re-derive `git log origin/main -1`  
**Landed law:** #385 `docs(coord): truth layers…` · seal PR this file

---

## Where we are (not planning)

| Phase                            | Status                                            |
| -------------------------------- | ------------------------------------------------- |
| P1–P6 problem/cause/spec         | **Done** (prior plan doc)                         |
| E1–E4 law + pointers             | **Done** — merged #385 on main                    |
| E5 honesty sweep of all notes    | **Out of scope** for this finish (optional later) |
| E6 multi-week dual-build measure | **Ongoing ops**, not a ship                       |
| E7 hard CI force                 | **Rejected** unless E6 fails                      |

**Mode:** execution complete for the **coordination-contract program**. Not stuck in planning.

---

## What “finished” means here (hard)

This program is **FINISHED** only when all of the following hold:

### Law finished (shippable)

| #   | Criterion                                                                                                | How to audit                                                    | Result                    |
| --- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------- |
| F1  | One binding home exists: `docs/COORDINATION-TRUTH-LAYERS.md`                                             | `git cat-file -e origin/main:docs/COORDINATION-TRUTH-LAYERS.md` | ✅ #385                   |
| F2  | Product ownership / free / human-lock → `features.mjs`                                                   | Layers + START-HERE + SCOREBOARD authority lines                | ✅                        |
| F3  | Campaign micro-next → BOARD-CLEAR-NEXT only                                                              | NEXT banner no longer “never TRACKER as live SoT” for ownership | ✅ #385                   |
| F4  | Session dual-build → LIVE-LANES + path intersect                                                         | LIVE-LANES + PARALLEL law                                       | ✅ (pointer seal this PR) |
| F5  | Mountain events only — no every-craft tax                                                                | Layers guarantees + CONTRIBUTING                                | ✅                        |
| F6  | No new limits: Approves / PR caps / CI force · thrift later deleted (public)                             | Layers “Operator guarantees” + “Hard rejects”                   | ✅                        |
| F7  | Zero Nitro manual                                                                                        | Layers + AGENTS operator mode                                   | ✅                        |
| F8  | Cold entry chain: AGENTS, START-HERE, session prompt, GO, PARALLEL, LIVE-LANES all point or state layers | grep COORDINATION-TRUTH-LAYERS                                  | ✅ after seal             |
| F9  | Decision log records layers decision                                                                     | DECISION-LOG append                                             | ✅ this seal              |
| F10 | Ownership memory architecture includes product tracker layer                                             | NITRO-OWNERSHIP memory table                                    | ✅ this seal              |

### Not part of “finished” (do not block seal)

| Item                                               | Why excluded                                         |
| -------------------------------------------------- | ---------------------------------------------------- |
| Every `features.mjs` note current to last craft PR | Mountain events only by design                       |
| Order-route as new tracker row                     | Optional E5; git + program docs already ground truth |
| Dual-build rate = 0 forever                        | Ongoing agent discipline (E6)                        |
| Denon verbal “thanks”                              | Social, not ship gate                                |

---

## How to re-audit anytime (agent checklist)

```bash
git fetch origin main
git log origin/main -1 --oneline
# F1
git cat-file -e origin/main:docs/COORDINATION-TRUTH-LAYERS.md
# F3 — must NOT say ignore tracker ownership
git show origin/main:docs/BOARD-CLEAR-NEXT.md | head -12
# F8 pointers
git grep -n COORDINATION-TRUTH-LAYERS origin/main -- AGENTS.md docs/START-HERE.md docs/NITRO-SESSION-PROMPT.md docs/LIVE-LANES.md docs/BOARD-CLEAR-PARALLEL-SESSIONS.md docs/BOARD-CLEAR-AUTONOMOUS-RUN.md
# Guarantees still anti-limit
git show origin/main:docs/COORDINATION-TRUTH-LAYERS.md | rg -n "No PR cap|no new Denon|No every-PR|Hard rejects"
```

Cold agent 2-minute orient (A1): tip + open PRs + `pnpm tracker ready` + LIVE-LANES + NEXT if campaign.

---

## Gaps found this audit (closed in seal PR)

| Gap                                                 | Risk                                        | Fix                            |
| --------------------------------------------------- | ------------------------------------------- | ------------------------------ |
| LIVE-LANES had no layers pointer                    | Session agents skip product ownership check | Link + one line                |
| PARALLEL ritual no tracker ready                    | Dual-build only; miss human-mountain theft  | Step for tracker owner / ready |
| GO paste block omitted layers + tracker ready       | AFK agents use paste only                   | Patch fenced GO                |
| Ownership memory table skipped features.mjs         | Product free map not in priority list       | Insert priority row            |
| Decision log still “TRACKER demoted” as last word   | Historical row OK; need superseding append  | Append 2026-08-02 layers       |
| Plan/audit docs still read as “needs fix” in places | Cold reader thinks unfinished               | Seal status on plan + layers   |

---

## Limit check (explicit)

| Could this finish limit us? | Verdict                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| Extra docs to read          | **One** short law; pointers only — net less confusion than 5 competing SoTs                 |
| More agent work             | Claim already required; mountain events only — **less** false thrash than every-PR registry |
| Slower merge                | No new checks/Approves                                                                      |
| Thrift $                    | Pure docs; path-ignore OK                                                                   |
| Parallel agents             | Explicitly preserved                                                                        |

---

## Unspoken needs (abused into requirements)

| Need                                | How finish satisfies                              |
| ----------------------------------- | ------------------------------------------------- |
| Don’t make me judge code            | Agent self-audit F1–F10 + checklist above         |
| Don’t slow the machine              | Guarantees table is law against slowdowns         |
| Don’t leave me unsure “is it done?” | This file’s F1–F10 = finished definition          |
| Denon trust without panic           | Product map layer restored without process empire |
| AFK agents still correct            | GO paste + LIVE-LANES + PARALLEL updated          |

---

## Verdict

**Coordination-contract program: FINISHED** after seal PR merges (F1–F10).  
Ongoing agent behavior (claims, path-intersect) is **ops**, not an open design task.
