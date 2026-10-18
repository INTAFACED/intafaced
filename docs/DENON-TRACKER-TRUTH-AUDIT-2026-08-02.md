> **Not current rules (2026-10-18).** Kept as history. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

> **Supersession (2026-08-09):** Any line that treats **Actions thrift**, run-count caps, `THRIFT_ALLOW`, or holding PRs for CI spend as current law is **void**. The repo is public; thrift was deleted 2026-08-07. See [`GITHUB-CI-SPEND-CONTROL-2026-07-31.md`](GITHUB-CI-SPEND-CONTROL-2026-07-31.md). Historical text below may still _mention_ thrift as what was once believed.

# Denon call audit — tracker as truth database

**Date:** 2026-08-02  
**Source:** Nitro–Denon call (“intafaced tracker”) — Denon: update the project tracker on every push/merge (worktree or main) so other devs/agents share one truth of current context; main work not registered → agent conflict.  
**Scope:** Analysis only. No code changes. No process ceremony executed this turn.  
**Verdict status:** `[VERIFIED 2026-08-02]` against `origin/main` tip `26289f3` (#381) + live `features.mjs` + CI workflow + Board Clear docs.  
**Supersession:** Solution executed — [`COORDINATION-TRUTH-LAYERS.md`](COORDINATION-TRUTH-LAYERS.md) (#385) + finish seal. Plan: [`TRACKER-COORDINATION-PROPER-PLAN-2026-08-02.md`](TRACKER-COORDINATION-PROPER-PLAN-2026-08-02.md). Finish audit: [`COORDINATION-FINISH-AUDIT-2026-08-02.md`](COORDINATION-FINISH-AUDIT-2026-08-02.md).

---

## 1. One-line verdict

**Denon is right about the risk and the rule.** The repo already wrote that law; **practice partially left it.** This is **coordination debt**, not a money-doctrine break and **not mainly the GitHub thrift rule.** Platform is not “ruined”; multi-dev agent conflict risk **is real and currently elevated**.

---

## 2. What Denon actually means (plain language)

| His words                                                          | Operational meaning                                                                                                                                                          |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| “Always when pushing or merging … update the project tracker”      | Every ship that changes product state (claim, progress, done, owner) must touch the shared feature registry in the **same change path** — not “maybe later in a honesty PR.” |
| “Work tree or merging on domain”                                   | Doesn’t matter whether work lives in a side folder/branch or lands on main — **main’s tracker must reflect what main now is.**                                               |
| “Truth database of actual current context”                         | Next human or agent cold-starts from the tracker and can answer: **what’s done, who’s on what, what’s free, what not to double.**                                            |
| “More things pushed onto main not registered → agents on conflict” | Stale registry → two agents claim the same mountain, rebuild finished work, or treat unfinished human work as free agent work.                                               |

**He is not asking for:** a new product feature, a GitHub Projects board, or more CI spend.  
**He is asking for:** the existing multi-person coordination database to stay honest under parallel agents + a third builder.

---

## 3. Unspoken needs (inferred)

| Who                             | Unspoken need                                                                                                        |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Denon**                       | Predictable handoffs when he returns; no surprise main state; agents don’t invent ownership of his/human mountains.  |
| **Nitro**                       | Keep parallel speed without becoming the git/conflict bottleneck; know if “we broke something” vs “process hygiene.” |
| **Agents (all)**                | One cold-start answer to “what can I claim right now?” without reading 20 board docs.                                |
| **Third human (`@shehzad002`)** | Exclusive M1–M7 claims stay visible in the same place agents look first.                                             |
| **Implicit product**            | Trust in tracker Done bar so “done” still means mounted + proven, not vibes.                                         |

---

## 4. Designed system (what the repo already says)

Canonical chain (already written):

1. **Source of truth for features:** `tooling/tracker/features.mjs`
2. **Generated board:** `docs/TRACKER.md` via `pnpm tracker`
3. **Claim ritual:** set `owner` + `status: 'wip'` on first PR; on ship set `done` + `requires` paths (`CONTRIBUTING.md` §3.5, `AGENTS.md` claim steps)
4. **CI honesty gate:** `pnpm tracker:check` in `.github/workflows/ci.yml` (“Tracker is honest”)
5. **START-HERE:** if docs disagree, **law + tracker win** over memory/Telegram

What CI **does** enforce:

- Registry structurally valid (deps exist, no cycles, no duplicate ids)
- `done` has path evidence that exists on disk (anti-wishful done)
- `wip` must have an `owner`
- Generated `TRACKER.md` / README band not stale vs registry

What CI **does not** enforce:

- “This code PR changed product behavior → registry must be updated”
- “Something on main must appear as done/wip somewhere”
- Session-level “who is coding which file right now” (that is `docs/LIVE-LANES.md`)
- Campaign micro-slice status (Board Clear NEXT / residual register / order-route scoreboards)

So Denon’s rule is **policy + practice**, not a missing robot. The robot only catches **false done** and **stale render**, not **silent ship**.

---

## 5. Audit: is Denon right?

### 5.1 Principle — **yes**

Multi-agent + multi-human without a shared claim/done registry **does** produce conflict. That is not theoretical: the project already hired a third human owner for M1–M7 and runs parallel agent campaigns. Denon’s “truth database” framing matches the original tracker design intent (“a tracker nobody trusts is worse than none”).

### 5.2 Practice — **partially violated**

Evidence on `origin/main` (2026-08-02):

| Signal                    | Observation                                                                                                                                                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tracker update cadence    | Last `features.mjs` touch on tip path: **#376** (venue mark ops honesty). Tip is **#381**.                                                                                                                        |
| Volume without registry   | Since ~2026-07-28: **~125** `feat(`/`fix(` merges did **not** touch `features.mjs` (coarse count). Many are valid micro-slices under a coarse `wip` row — but **notes/owners often lag**.                         |
| Coarse WIP still open     | `web.terminal` (Nitro), `ws.gateway` (Nitro), `pay.gateway` (shehzad002), `trade.futures` (shehzad002) — correct as open mountains, but **web.terminal notes lag a flood of shell craft** (#358–#381 class).      |
| Programs outside registry | **Order-route** (many merged PRs through #380) has **no feature id** in the registry; status lives in order-route docs/scoreboards. Agents who only read tracker miss that mountain.                              |
| Competing live SoT        | `docs/BOARD-CLEAR-NEXT.md` on tip says explicitly: **never use TRACKER.md as live SoT** — use NEXT + open PRs + scoreboard. That **directly competes** with Denon’s framing and with START-HERE’s “tracker wins.” |
| Session claims            | `LIVE-LANES.md` is the real-time lane board (Board Clear programs P-UI / P-OR / HUMAN M1–M7). Healthy as a **second layer**; unhealthy if agents treat it as a **replacement** for feature registry.              |
| Local main lag            | Main checkout can sit **100+ commits behind** `origin/main` while uncommitted docs pile up — cold agents in wrong folder read wrong world.                                                                        |

### 5.3 Severity — **coordination risk, not platform ruin**

| Not broken                                                 | At risk                                                              |
| ---------------------------------------------------------- | -------------------------------------------------------------------- |
| Money path doctrine / ledger rules                         | Agent double-claim / double-build                                    |
| CI green as merge seal (when CI runs)                      | False “ready” reads if someone only skims tracker                    |
| Ownership lock for shehzad (registry rows exist for M1–M7) | Order-route / Board Clear progress invisible to tracker-only readers |
| Ability to re-derive truth from git + `gh pr list`         | Speed loss + Denon trust loss if he can’t trust the board            |

**You did not “fuck the money stack” by thrift or tracker drift.**  
**You did let the coordination story fragment** under Board Clear + thrift-friendly docs cadence + micro-PR craft.

---

## 6. Is GitHub thrift the cause?

**Secondary contributor at most. Not the root.**

| Thrift rule                                       | Effect on tracker                                                                                                                                                                                                                                    |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local `pnpm verify` before push                   | Neutral — does not remove claim ritual                                                                                                                                                                                                               |
| Batch fixes / no push storms                      | Neutral-to-good for coherent claim+code PRs                                                                                                                                                                                                          |
| Prefer pure docs PRs so path-ignore skips full CI | **Soft pressure** to land “honesty later” as docs-only waves; product code PRs often omit `features.mjs`                                                                                                                                             |
| `paths-ignore: docs/**, **/*.md`                  | Full CI (including `tracker:check`) **skips** pure markdown PRs. Comment in `ci.yml` admits brand/tracker gates “still run on any PR **touching code**.” A docs-only tracker narrative that doesn’t touch `features.mjs` can drift without that job. |
| No ban on parallel PRs                            | Parallel without claim discipline **amplifies** conflict — thrift did not invent parallel                                                                                                                                                            |

**Root causes ranked:**

1. **Multiple “live truth” surfaces** during Board Clear (NEXT, LIVE-LANES, residual-register, order-route scoreboards) **outcompeted** `features.mjs` for agent orientation — including an explicit “don’t use TRACKER as live SoT” line.
2. **Granularity mismatch** — tracker rows = coarse product features; ships = tiny craft/residual PRs. Agents skip registry because “this isn’t a whole feature.” Denon’s rule still wants **at least note/owner honesty** when progress is real.
3. **CI only blocks false-done**, not silent-ship — so practice can drift forever and stay green.
4. **Thrift** makes “tracker honesty later” feel virtuous (cheap docs PR) — delayed honesty is still drift.
5. **Third human + parallel agents** raised the cost of drift; Denon is responding to that scale-up, not inventing a new worry.

---

## 7. What “conflict” looks like in this repo (concrete)

| Failure mode                             | How it happens here                                                                                                           |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Two agents polish the same shell surface | `web.terminal` stays vague `wip`; LIVE-LANES claim skipped; two `feat/app-*` PRs edit same vendor paths                       |
| Agent starts human mountain              | Misses shehzad owner on `pay.gateway` / futures if they only read a stale Board Clear row or chat memory                      |
| Agent rebuilds finished spine            | Tracker still `ready` while code on main (false under-claim of progress) — less common for big services, more for thin slices |
| Denon returns cold                       | Tracker ≠ tip narrative; he loses trust in the “truth database” and has to re-audit git                                       |
| Order-route invisible                    | Huge program only in side docs — tracker-ready list doesn’t show it                                                           |

---

## 8. What is okay / what is not

### Okay (do not overreact)

- Micro-PRs under an already-`wip` feature **without** flipping `done` every time
- Separate LIVE-LANES for **session** “who is coding now”
- Board Clear campaign docs for **ordered next ship**
- Thrift rules that cut waste CI dollars
- Class N shell craft continuing under Nitro ownership of `web.terminal`

### Not okay (Denon’s bar)

- Merging product-meaning changes with **no** registry reflection when status/owner/progress actually moved
- Treating Board Clear / chat as replacement for feature registry
- Leaving main ahead of tracker in a way that another cold agent would claim the same free mountain
- Fake `done` (CI already fights this; keep that bar)

---

## 9. Forward plan (no code this turn — decision completeness)

### 9.1 Immediate posture (Nitro can adopt in chat without coding)

1. **Accept Denon’s statement as binding reaffirmation** of CONTRIBUTING/AGENTS claim law — not a new invention.
2. **Do not “fix thrift by killing thrift.”** Keep spend control; **add claim hygiene** on code ships.
3. **Orient order for agents (proposed, one stack):**
   - (a) `git fetch` + tip + open PRs
   - (b) `tooling/tracker/features.mjs` / `pnpm tracker ready` for **product ownership & done/wip**
   - (c) `docs/LIVE-LANES.md` for **session lane**
   - (d) Board Clear NEXT only for **campaign sequencing** — never as exclusive SoT that erases tracker
4. **Reconcile the contradiction:** **DONE** (#385) — NEXT = campaign sequence only; product ownership remains `features.mjs`.
5. **When shipping under a coarse WIP row:** same PR (or same PR stack) updates `note` + keeps `owner`; don’t invent 40 new feature ids for craft.
6. **When a mountain actually meets Done bar:** flip `done` + `requires` with proof — P-TRACK style honesty pass.
7. **Order-route / other programs:** either register a feature id or an explicit socket/wip row so tracker-only readers see the mountain exists.

### 9.2 Optional later hardening (ask before implementing)

| Option                        | What                                                                         | Cost / risk                                       |
| ----------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------- |
| A. Prompt + AGENTS line only  | Soft re-enforce claim on every code PR                                       | Cheap; relies on agents                           |
| B. PR template checklist      | “Tracker claim/status updated?”                                              | Cheap social enforcement                          |
| C. CI heuristic               | Fail if certain paths change without `features.mjs`                          | Risk of noise on pure refactors; design carefully |
| D. One tracker honesty PR now | Sweep notes for web.terminal / ws / order-route visibility                   | One-time; good gift to Denon                      |
| E. Collapse SoT docs          | Point Board Clear → tracker for ownership; keep NEXT for micro-sequence only | Doc surgery; reduces future drift                 |

**Recommended default:** **A + D soon**, B if agents keep skipping, C only if A/D fail. Do **not** turn off thrift.

### 9.3 What Nitro does **not** need to do

- Panic-stop all shipping
- Ask Denon to Approve every PR
- Rebuild services
- Spend a full week on process theater
- Blame thrift as the main villain

### 9.4 What to tell Denon (if you reply)

> You’re right — tracker is the shared truth DB; we’ll keep claim/owner/status on the same path as merges. We had campaign boards (Board Clear / LIVE-LANES) carrying live sequencing and under-updating the feature registry on micro-ships. Not a money-path failure. Fixing hygiene, not undoing thrift.

---

## 10. Enhanced session prompt (paste block — additive)

Use this **in addition to** `docs/NITRO-SESSION-PROMPT.md`, or fold into it when you next allow doc edits.

```
TRACKER TRUTH (Denon 2026-08-02 — binding)
- Project tracker = multi-dev truth DB: tooling/tracker/features.mjs → docs/TRACKER.md.
- On claim: set owner + status wip in features.mjs, run pnpm tracker, include both files in first PR.
- On ship/merge that moves product state: same PR updates status/note/requires as needed. Do not leave main ahead of the registry.
- Worktree vs main does not matter — main’s registry must match what main is.
- LIVE-LANES = who is coding which lane right now (session). Board Clear NEXT = campaign micro-sequence only.
- Neither LIVE-LANES nor Board Clear replaces feature ownership in features.mjs.
- Never treat “docs-only honesty later” as optional if the code PR already changed meaning.
- Local verify first; pure docs when docs-only — Actions thrift deleted 2026-08-07. Never use thrift as a reason to skip tracker claim.
- Before starting work: pnpm tracker ready + open PRs + LIVE-LANES. If free on tracker but human-owned (shehzad M1–M7 / Denon spine), do not implement.
- If you ship code and skip tracker, you created agent-conflict debt — fix in the same session.
```

---

## 11. Completeness check (this audit’s coverage)

| Question                       | Covered?                            |
| ------------------------------ | ----------------------------------- |
| What Denon means               | §2                                  |
| Unspoken needs                 | §3                                  |
| Designed law vs practice       | §4–5                                |
| Is he right?                   | §5 yes principle / partial practice |
| Root cause vs thrift           | §6                                  |
| Severity / fucked or not       | §7–8                                |
| Forward plan options + default | §9                                  |
| Enhanced prompt                | §10                                 |
| Code touched?                  | No                                  |

---

## 12. Next decision for Nitro

Pick one:

1. **Hygiene-only** — adopt enhanced prompt now; next coding session updates tracker on every product ship (no special sweep).
2. **Gift Denon a honesty sweep** — one docs/chore PR: refresh `web.terminal` / `ws.gateway` notes + register or note order-route mountain; align Board Clear wording so tracker remains ownership SoT.
3. **Harder enforcement later** — PR checklist or CI path heuristic (only if 1–2 fail).

**Pick if unsure:** **2** once, then run on **1** forever. Thrift deleted 2026-08-07 — do not restore it.
