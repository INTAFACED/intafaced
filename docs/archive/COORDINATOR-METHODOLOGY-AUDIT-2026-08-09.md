# Independent audit — coordinator methodology OS

**Date:** 2026-08-09  
**Scope:** `PROMPT-COORDINATOR-DOCTRINE.md` · `COORDINATOR-WAVE-RUNBOOK.md` · `COORDINATOR-STATE.md` · wave-4 paste practice  
**Stance:** Adversarial. Hunt self-limits, missing unspoken needs, incomplete plan — not confirm the existing writeup.

---

## Verdict

| Question                                                 | Finding                                                                                                                                                                                    |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Is the OS directionally right?                           | **Yes** — tip-true · path walls · variable N · file SoT · `new` as full pipeline                                                                                                           |
| Is it complete enough to survive compact + “always new”? | **Not yet (pre-this-audit)** — gaps below were load-bearing                                                                                                                                |
| Biggest self-limit?                                      | **Hard cap N≤16** while Nitro explicitly allows 16–20; also weak rules for **shared packages**, **mid-wave top-up**, **stop-note banking**, **features.mjs writer**                        |
| Biggest unspoken-need miss?                              | **Aggregate Nitro-only ledger across waves** · **force-new while cooking policy** · **contracts/events first** · **spend/fan-out honesty in pastes** · **durable commit path for OS docs** |

**Post-this-audit action:** runbook + doctrine + state upgraded to v1.1 (same day). This file stays as the gap ledger.

---

## Unspoken needs (full scale — expanded)

Prior OS listed 12. Independent pass adds **N13–N24** that were missing or only implied.

| ID      | Need                                         | Why it fails without encoding                      |
| ------- | -------------------------------------------- | -------------------------------------------------- |
| N1      | Peace of mind without code                   | Already in OS                                      |
| N2      | Max AFK leverage / all-out                   | Already; must not thin under brevity               |
| N3      | Compact-safe                                 | Already; **must re-read files every turn risk**    |
| N4      | `new` is enough                              | Already                                            |
| N5      | No collisions                                | Incomplete without **packages/** walls             |
| N6      | No invent money/product                      | Incomplete without **contracts-first** rule        |
| N7      | Not busywork                                 | Incomplete without **second-pass “is N theater?”** |
| N8      | Shehzad / Denon / Class X                    | Denon fence under-specified                        |
| N9      | Ratchet quality                              | Already quality bar                                |
| N10     | Disposable builders                          | Need **stop note banked before wall freed**        |
| N11     | Clipboard ergonomics                         | Already                                            |
| N12     | Honesty when drained                         | Already                                            |
| **N13** | **Always-on max seats when residual exists** | Cap 16 fought his “20 is fine”                     |
| **N14** | **Top-up without full rewrite**              | Half-finished wave + early closers                 |
| **N15** | **Running ledger of Nitro-only decisions**   | Same questions re-asked every wave                 |
| **N16** | **Force-new / abort policy**                 | He will say new while some chats still cook        |
| **N17** | **features.mjs single-writer protocol**      | 16 lanes thrash tracker                            |
| **N18** | **Shared package collision**                 | contracts/events/auth/ledger-client                |
| **N19** | **Stop-note → main banking**                 | Uncommitted stop notes vanish                      |
| **N20** | **Spend / fan-out judgment in pastes**       | “Token free” ≠ unguided model thrash               |
| **N21** | **Mid-wave peace pulse**                     | AFK fear: “are they stuck or shipping?”            |
| **N22** | **OS docs on a durable branch/PR**           | Local-only dies with worktree                      |
| **N23** | **Paste skeleton frozen**                    | Quality drifts wave to wave                        |
| **N24** | **Absorb dead lanes**                        | Subscription die / abandoned chat                  |

---

## Gap register (ordered by severity)

### G1 · Self-imposed N≤16 ceiling — HIGH

**Was:** clamp 4–16.  
**Truth:** Nitro said seats aren’t the constraint; evidence is.  
**Fix:** Soft target 8–16; **hard max 20** only with method/babysit fillers; no artificial floor of 4 if drained (honest 2–3 ok).

### G2 · No mid-wave `topup` — HIGH

**Was:** only full `new` or wait.  
**Truth:** some lanes SAFE TO CLOSE hours earlier; seats idle.  
**Fix:** trigger **`topup`** — re-derive, only mint pastes for **freed walls** + new residual, don’t reshuffle live walls.

### G3 · Shared packages not walled — HIGH

**Was:** service walls only.  
**Truth:** `packages/contracts`, `events`, `auth`, `ledger-client` are multi-lane magnets.  
**Fix:** paste quality requires **package claim protocol**: contracts/events PR first; only one lane holds a package path cluster per wave (or serialize via L-BOARD).

### G4 · features.mjs writer protocol vague — HIGH

**Fix:** default **mountain-event only by owning lane**; bulk honesty edits owned by BOARD lane if present; never 16 concurrent tracker rewrites.

### G5 · Stop-note banking — HIGH

**Was:** builders write stop notes; coordinator may not verify on main.  
**Fix:** on `new`, walls whose last stop note is **missing or only local** stay **hot residual** (not “free for random reassignment”) until banked or abandoned policy fires.

### G6 · Force-new while cooking — MEDIUM-HIGH

**Fix:** default refuse full re-wall of live lanes; offer **topup** or **force-new** (explicit) that **absorbs** live walls as fenced babysit.

### G7 · Nitro-only aggregate ledger — MEDIUM-HIGH

**Fix:** STATE section `nitro_only_open` append-only across waves; every paste Nitro-only must union this list for related domains.

### G8 · Denon fence thin — MEDIUM

**Fix:** every `new` lists open PRs by author/login if available; fence paths on Denon money/spine PRs.

### G9 · No paste skeleton file — MEDIUM

**Fix:** `docs/COORDINATOR-PASTE-SKELETON.md` frozen template so waves don’t drift thin.

### G10 · No spend/fan-out line in quality bar — MEDIUM

**Fix:** pastes must say: judgment stages strong; bulk harvest can be parallel cheap; no escalate-on-uncertainty thrash; Nitro has final say on spend beyond stated map — but AFK default is go.

### G11 · Peace pulse / mid-wave status thin — MEDIUM

**Fix:** `status` includes: merges since wave start (if countable), open PRs from wave branches pattern, lanes with stop notes on tip vs missing.

### G12 · Dead-lane absorb — MEDIUM

**Fix:** if no commits/PRs for wall in wave window and no stop note → on `new`/`topup` reassign residual to fresh paste; mark prior lane abandoned in STATE.

### G13 · OS uncommitted — MEDIUM

**Fix:** methodology recommend docs PR same day; STATE tracks `os_pr` if any.

### G14 · Cross-service “contracts first” missing from bar — MEDIUM

**Fix:** quality bar: if unit needs cross-service types/events, Engine A unit “contracts PR first”.

### G15 · Second-pass “is N theater?” — MEDIUM

**Fix:** before deliver, one adversarial sentence: list walls that are only docs thrash; cut them.

### G16 · Clipboard index after bulk clip — LOW

**Fix:** STATE `clipboard_index` = last clipped id.

### G17 · Worktree explosion — LOW

**Fix:** BOARD/tooling lane or status mentions wt:gc discipline; don’t leave as only builder problem.

### G18 · Class M template missing — LOW-MEDIUM

**Fix:** money lanes paste snippet for self-audit + adversarial checklist (short).

---

## What was already good (keep)

- Tip re-derive · harvest trust order · path walls · quality bar v2 · `new` auto-audit · file SoT · anti-fixed-16 _intent_ · sealed bans · SAFE TO CLOSE · high-signal delivery
- Wave 4 practice proved multi-lane residual ships real PRs

---

## Completeness checklist for “plan is done”

- [x] Unspoken needs expanded N13–N24
- [x] Self-limits named (N cap, no topup, packages)
- [x] Runbook/doctrine/state upgraded to close G1–G18 (v1.1)
- [x] Paste skeleton added
- [ ] First real `new` executed under v1.1 (waits for Nitro)
- [ ] Methodology docs PR to main (recommended; Nitro can ignore)

---

## Independent judgment (not sycophancy)

This system **can** run indefinitely **if** residual exists and `new` stays tip-true.  
It **cannot** manufacture infinite product from a drained board without becoming waste — the OS must prefer **honesty over seat count**.

The prior OS was ~70% of a production coordinator. Missing pieces were mostly **lifecycle** (mid-wave, dead lanes, banking) and **shared-path law**, not philosophy.
