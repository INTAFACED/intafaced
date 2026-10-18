> **Not current rules (2026-10-18).** Kept as history. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

> **Supersession (2026-08-09):** Any line that treats **Actions thrift**, run-count caps, `THRIFT_ALLOW`, or holding PRs for CI spend as current law is **void**. The repo is public; thrift was deleted 2026-08-07. See [`GITHUB-CI-SPEND-CONTROL-2026-07-31.md`](GITHUB-CI-SPEND-CONTROL-2026-07-31.md). Historical text below may still _mention_ thrift as what was once believed.

# Tracker coordination — proper framing, diagnosis, plan

**Status:** **PROGRAM FINISHED** 2026-08-02 — E1–E4 + entry-chain seal. Finish audit: [`COORDINATION-FINISH-AUDIT-2026-08-02.md`](COORDINATION-FINISH-AUDIT-2026-08-02.md).  
**Date:** 2026-08-02  
**Trigger:** Denon call — multi-dev truth DB; unregistered main → agent conflict.  
**Landed:** [`COORDINATION-TRUTH-LAYERS.md`](COORDINATION-TRUTH-LAYERS.md) (#385) + seal. E5 note-sweep optional; E6 ops; E7 rejected by default.

**Operator constraints (locked from Nitro this turn):**

| Constraint                          | Meaning                                                                            |
| ----------------------------------- | ---------------------------------------------------------------------------------- |
| No manual work for Nitro            | Agents own claim, update, merge hygiene                                            |
| Do not limit agents                 | No new human gates, no PR caps, no “wait for Denon,” no thrift that kills parallel |
| No over-engineering                 | Prefer delete/clarify over new systems                                             |
| Preserve speed · quality · autonomy | Solution must not trade one for another silently                                   |
| Hunt negatives                      | Explicit anti-list before any build                                                |

---

## Phase 0 — How this work must be approached

| Phase                  | Question                                           | Done when                                    |
| ---------------------- | -------------------------------------------------- | -------------------------------------------- |
| **P1 Problem**         | What exactly is broken / at risk?                  | Named failure modes with evidence; not vibes |
| **P2 Cause**           | What produces those failures?                      | Ranked causes; thrift tested in/out          |
| **P3 Reason / intent** | What is Denon (and Nitro) actually optimizing for? | Intent separate from literal wording         |
| **P4 Constraints**     | What must any solution not damage?                 | Limit map (speed / quality / autonomy)       |
| **P5 Solution space**  | What could work?                                   | Named options + rejected options with why    |
| **P6 Spec**            | What does “good” mean?                             | Acceptance tests a cold agent can check      |
| **P7 Plan**            | What to do in what order later?                    | Smallest safe path; later chats execute      |

**Rule:** Do not implement gates, CI heuristics, or new boards until P1–P6 hold. Spec before build (Board Clear constitution already demands this).

---

## Phase 1 — Problem identification (what’s up)

### 1.1 Symptom Denon reported

When work lands on main (from a worktree or elsewhere) without the **project tracker** reflecting it, the shared picture of “where the project is” lies, and **other devs/agents conflict**.

That is a **coordination symptom**, not a code bug and not a money-path bug.

### 1.2 What is _not_ the problem (ruled out with evidence)

| Not the problem               | Why                                                                    |
| ----------------------------- | ---------------------------------------------------------------------- |
| Ledger / doctrine collapse    | No signal; CI doctrine gates unrelated                                 |
| Tracker CI broken             | `pnpm tracker:check` still runs on code PRs; blocks false `done`       |
| Thrift “broke merges”         | Thrift cuts waste CI; does not skip claim law on code paths            |
| “Nobody claims anything”      | LIVE-LANES + human M1–M7 + some `features.mjs` owners exist            |
| Need for Nitro to babysit git | Operator mode already exists; issue is _which truth file agents trust_ |

### 1.3 The real problem (precise)

**There is more than one “truth surface,” and they answer different questions — but agents (and campaign docs) sometimes use the wrong surface as the only map.**

| Question agents need                                     | Designed home                               | Often used instead            |
| -------------------------------------------------------- | ------------------------------------------- | ----------------------------- |
| What product features exist / done / free / human-owned? | `tooling/tracker/features.mjs`              | Board Clear scoreboard / chat |
| What should _this campaign_ ship next?                   | `docs/BOARD-CLEAR-NEXT.md`                  | same (correct for campaign)   |
| Who is coding _this hour_ on which paths?                | `docs/LIVE-LANES.md` + open PRs             | memory / nothing              |
| What files may agents not invent?                        | ownership docs + CODEOWNERS + tracker owner | incomplete read               |
| What code is actually on main?                           | `git` / merged PRs                          | tracker notes (lag)           |

**Failure modes that matter:**

| ID  | Failure                                                                                            | Impact                              |
| --- | -------------------------------------------------------------------------------------------------- | ----------------------------------- |
| F1  | **Dual-build** — two agents edit same paths                                                        | Speed loss, thrash, CI burn         |
| F2  | **Human-mountain theft** — agent implements shehzad/Denon exclusive work                           | Quality + political risk            |
| F3  | **False free** — tracker says ready/wip unclear while work is claimed elsewhere                    | Conflict                            |
| F4  | **False lag** — code on main but tracker still looks empty/stale                                   | Denon distrust; rebuild temptation  |
| F5  | **False done** — mark done without proof                                                           | Quality (already partly CI-guarded) |
| F6  | **Orient tax** — agent must read 5–15 docs to know what not to touch                               | Autonomy + speed drag               |
| F7  | **SoT contradiction** — Board Clear says “never TRACKER as live SoT”; START-HERE says tracker wins | Agents pick randomly                |

**Denon’s sentence maps mainly to F1, F3, F4.** F5 is already engineered. F6–F7 are self-inflicted process debt that _cause_ F1–F4.

### 1.4 Evidence snapshot `[VERIFIED 2026-08-02 tip 26289f3]`

- Coarse WIP rows exist (`web.terminal` Nitro, `ws.gateway` Nitro, `pay.gateway` / futures shehzad, etc.)
- Large volume of micro-ships under those mountains without registry note refresh
- Order-route program heavy on main, **not** a first-class tracker id (status lives in side docs)
- Board Clear PARALLEL + LIVE-LANES already try to stop dual-build via **path intersect + first claimer**
- `tracker:check` does **not** require “code change ⇒ features.mjs change”

**Problem statement (one sentence):**

> Multi-person agent shipping is limited by **split coordination truth** (product registry vs campaign boards vs session lanes), not by missing thrift or missing elite code gates — so agents can still dual-build or under-report product state even when CI is green.

---

## Phase 2 — Causes (what produced it)

Ranked. More than one can be true.

| Rank   | Cause                                  | Mechanism                                                                                                      | Produces                                       |
| ------ | -------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **C1** | **Layer collapse / SoT contradiction** | Campaign docs elevated NEXT over TRACKER (“never live SoT”) while law still says tracker is product scoreboard | F3, F4, F6, F7                                 |
| **C2** | **Granularity mismatch**               | Tracker rows = mountains; ships = tiny craft PRs. Updating registry every PR feels wrong → skip                | F4 (notes lag), sometimes F1                   |
| **C3** | **Enforcement only on false-done**     | CI cannot see “silent progress”                                                                                | F4 persists green                              |
| **C4** | **Scale-up of actors**                 | Nitro agents + Denon + shehzad + multi-chat Board Clear                                                        | F1, F2 cost rises                              |
| **C5** | **Orient sprawl**                      | Many honest docs (residual, order-route, frontend AOS, LIVE-LANES, constitution…)                              | F6 → wrong surface → F1/F2                     |
| **C6** | **Thrift (secondary)**                 | Docs-only waves + “honesty later” feel virtuous; path-ignore skips full CI on pure md                          | Delays F4 repair; **does not create** F1 alone |
| **C7** | **Success of autonomy**                | Agents ship fast without waiting — claim ritual skipped under time pressure                                    | F1, F4                                         |

**Thrift verdict:** contributor to _when_ honesty is delayed, **not** root of dual-build. Killing thrift would not fix C1–C5 and would **hurt** speed/budget.

**Root cause cluster (not single villain):**  
**C1 + C2 + C4** under autonomy. The designed tracker is fine for product lifecycle; the campaign invented a second live map without a clear “which question → which file” contract that every agent must obey.

---

## Phase 3 — Intent / reason (what “success” means to people)

### 3.1 Denon (inferred from words + role)

- Shared **current context** without re-auditing the whole repo every return
- Agents and humans do not step on each other
- Tracker remains a trusted **product map**, not a dead file

Literal “every push/merge updates tracker” may be **shorthand** for “never leave main’s product story lying,” not “50 note edits for 50 CSS PRs.” Treating the literal extreme as law **over-fits** and risks process tax (see Phase 4).

### 3.2 Nitro (stated + unspoken)

| Spoken                    | Unspoken                                               |
| ------------------------- | ------------------------------------------------------ |
| Know what’s up            | Not panic or false “everything’s fine”                 |
| Proper phases             | Don’t ship medicine before diagnosis                   |
| No over-engineering       | No new dashboard empire                                |
| No manual                 | He never becomes the claim clerk                       |
| Don’t limit agents        | No new Approves, caps, or slow gates                   |
| Avoid negative caveats    | Solutions must not secretly tax speed/quality/autonomy |
| Best solution later chats | Spec + plan durable enough to execute cold             |

### 3.3 What the system was always optimizing for

From ownership law + thrift + Board Clear constitution:

**quality · speed · parallel · autonomy · ship/merge fast · zero Nitro bottleneck · Denon direction not day-to-day approve.**

Any tracker fix that breaks that list is the wrong fix.

---

## Phase 4 — What can limit us (hole-poking)

Every candidate “fix” must be checked against these limiters.

### 4.1 Limit map

| Lever                                | How it helps                  | How it limits us if misused                                                                         |
| ------------------------------------ | ----------------------------- | --------------------------------------------------------------------------------------------------- |
| **features.mjs claim/done**          | Product ownership truth       | Touching every micro-PR → edit tax, merge noise, thrift-irrelevant churn                            |
| **LIVE-LANES**                       | Session dual-build prevention | Stale lanes → false busy/false free; docs PR spam                                                   |
| **Board Clear NEXT**                 | Campaign focus                | Becomes second product tracker; contradicts law                                                     |
| **Open PRs + path intersect**        | Real dual-build detector      | Ritual time if done manually in chat only                                                           |
| **CODEOWNERS required review**       | Path ownership                | **Directly limits autonomy** if required approvals on agent lanes — **hard reject for agent paths** |
| **CI “must touch features.mjs”**     | Forces honesty                | False fails on refactors; agents game empty note edits; slows good ships                            |
| **PR checklist**                     | Reminder                      | Manual theater; Nitro/agent checkbox fatigue; no force                                              |
| **Telegram claims**                  | Human signal                  | Invisible to cold agents; not durable                                                               |
| **GitHub Projects / Linear**         | Nice boards                   | Dual-tracking anti-pattern; more SoTs                                                               |
| **Bigger docs / more scoreboards**   | Feel organized                | **F6 worsens** — proven failure mode already                                                        |
| **Stop parallel / serialize agents** | Fewer conflicts               | **Violates operator goals** — hard reject                                                           |
| **Undo thrift / full CI on docs**    | Honesty jobs always run       | $ burn; doesn’t fix C1                                                                              |
| **Wait for Denon on every PR**       | Human gate                    | Autonomy death — hard reject                                                                        |

### 4.2 Negatives we must actively combat (anti-list)

1. **Dual tracking** — two boards that both claim “product done” (industry + in-repo history: boards rot or fight).
2. **Status theater** — updating status instead of shipping (process overhead kills velocity).
3. **Literal “every PR edits features.mjs”** — granularity tax; agents will invent fake churn.
4. **New human Approves / CODEOWNERS-required on agent code** — kills autonomous merge.
5. **CI path heuristics without allowlists** — noise red, agents thrash.
6. **More scoreboard files** — orient tax rises.
7. **Making Nitro the claim clerk** — fails unspoken need.
8. **Blaming thrift and removing parallel-friendly rules** — wrong medicine.
9. **Collapsing LIVE-LANES into features.mjs** — mixes hour-scale claims with product-scale state → permanent WIP pollution.
10. **Ignoring Denon** — product map stays untrusted; political + conflict cost.

### 4.3 Industry-shaped cautions (external, light)

- Process layers that don’t gate outcomes become theater; dual status systems fight.
- Ownership automation (CODEOWNERS) is for **review routing**, not for high-autonomy agent merge — using required reviews as “tracker” would fight this repo’s asymmetric merge model.
- Single source of truth per **question type** beats one mega-file for everything.

Use as design smell checks — not as “install Linear.”

---

## Phase 5 — Solution space (no pick yet until criteria pass)

### 5.1 Hard rejects (do not build)

| ID  | Idea                                                | Why rejected                                                                       |
| --- | --------------------------------------------------- | ---------------------------------------------------------------------------------- |
| R1  | Required CODEOWNERS approval on all agent paths     | Limits autonomy; asymmetric review law                                             |
| R2  | Max open PRs / serialize agents                     | Limits speed + parallel                                                            |
| R3  | New GitHub Project / external PM as product SoT     | Dual tracking                                                                      |
| R4  | Undo thrift as primary fix                          | Done 2026-08-07 for the right reason (public/free Actions); not a coordination fix |
| R5  | Nitro manual board updates                          | Violates no-manual                                                                 |
| R6  | CI: any code file change requires features.mjs diff | Over-fit literal Denon; false fails                                                |
| R7  | Another permanent scoreboard file                   | Worsens F6                                                                         |

### 5.2 Plausible solution families (evaluate later; not implement now)

| ID     | Family                            | Core idea                                                                                                             | Speed | Quality | Autonomy | Manual | Over-eng risk      |
| ------ | --------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----- | ------- | -------- | ------ | ------------------ |
| **S0** | **Clarify only**                  | One short “question → file” law; fix Board Clear vs START-HERE contradiction; agents keep shipping                    | +++   | =       | +++      | 0      | Low                |
| **S1** | **Layered claim contract**        | Product claim = features.mjs; session claim = LIVE-LANES; campaign = NEXT; **never collapse**                         | +++   | +       | +++      | 0      | Low                |
| **S2** | **Event-light honesty**           | On **mountain** open/close only (claim, done, owner handoff, human lock) — not every craft PR; note optional on waves | +++   | +       | +++      | 0      | Low                |
| **S3** | **Agent automation (no Nitro)**   | Operator-mode agents auto-update the right layer in same PR when they claim/finish; session prompt                    | ++    | +       | +++      | 0      | Low                |
| **S4** | **Path-intersect automation**     | Script agents already run (`gh pr list` + path check) documented as **the** dual-build gate                           | +++   | +       | +++      | 0      | Med if overbuilt   |
| **S5** | **Cheap CI only on false states** | Keep false-done; maybe fail if `wip` lacks owner (exists); **no** path→registry force                                 | =     | +       | +++      | 0      | Low                |
| **S6** | **One-time honesty sweep**        | Align notes/order-route visibility once                                                                               | +     | +       | +++      | 0      | Low                |
| **S7** | **Hard CI coupling**              | Force registry on path globs                                                                                          | −−    | +       | −        | 0      | High — last resort |

### 5.3 Best-fit direction (provisional — not locked implementation)

**Preferred shape if P6 acceptance is met:** **S0 + S1 + S2 + S3**, optional **S6** once.  
**Avoid:** S7 unless F1/F4 still dominate after clarify+agent contract.  
**Thrift is deleted (2026-08-07).** Keep parallel. Keep asymmetric merge. Public repo = no Actions spend meter.

This satisfies Denon’s _intent_ (truth DB for product context + less conflict) without literal micro-PR registry spam.

---

## Phase 6 — Spec: what “solved” means (acceptance)

A solution is **good enough** only if all of these are true:

### 6.1 Outcomes

| #   | Acceptance test                                                                                 | Who checks                          |
| --- | ----------------------------------------------------------------------------------------------- | ----------------------------------- |
| A1  | Cold agent can answer in ≤2 minutes: free mountains, human-locked, session-busy paths           | Agent                               |
| A2  | Dual-build rate on same paths drops (no two live PRs same files without handoff)                | `gh pr` ritual / log                |
| A3  | Human M1–M7 never agent-implemented                                                             | PR audit                            |
| A4  | Tracker `done` still cannot lie (existing CI)                                                   | CI                                  |
| A5  | Denon can read product ownership without reading Board Clear novel                              | features.mjs / TRACKER              |
| A6  | **Zero new Nitro steps**                                                                        | Nitro never opens a board           |
| A7  | **No new human Approve gate** for agent Class N/P/M under existing ownership law                | AGENTS.md still true                |
| A8  | Parallel agent count not capped by policy                                                       | Law text                            |
| A9  | ~~Thrift law~~ **Deleted 2026-08-07.** Keep local verify + one-concern PRs (quality, not spend) | retirement: GITHUB-CI-SPEND-CONTROL |
| A10 | No second permanent product board created                                                       | Doc inventory                       |

### 6.2 Non-goals

- Perfect note text on every craft commit
- Replacing git as ground truth of code existence
- Making tracker the campaign micro-scheduler
- Nitro reviewing tracker diffs

### 6.3 Denon-alignment note

Success with Denon = **trusted product context + low conflict**, not **diff volume in features.mjs**.  
If he later insists on literal every-PR updates, re-open P3 with him — do not silently over-fit.

---

## Phase 7 — Execution plan for _later_ chats (not this turn)

Ordered. Stop if a phase fails its check.

| Step   | Work                                                                               | Do not                            |
| ------ | ---------------------------------------------------------------------------------- | --------------------------------- |
| **E1** | ✅ `docs/COORDINATION-TRUTH-LAYERS.md` + AGENTS/CONTRIBUTING/START-HERE pointers   | —                                 |
| **E2** | ✅ NEXT / SCOREBOARD / AUTONOMOUS-RUN / PROCESS-LOOPS / constitution wording fixed | —                                 |
| **E3** | ✅ Mountain events only in layers + CONTRIBUTING §3.5                              | —                                 |
| **E4** | ✅ NITRO-SESSION-PROMPT + Board Clear cold-start                                   | —                                 |
| **E5** | Optional one-shot honesty later if Denon still can’t see context                   | Endless theater                   |
| **E6** | Measure dual-build / Denon trust in real sessions                                  | Jump to S7                        |
| **E7** | Last resort only if E6 fails                                                       | CODEOWNERS-required agent reviews |

**Exit criterion for the program:** A1–A10 green without S7.

---

## Phase 8 — Prompt enhancement (for future sessions working this)

```
TASK CLASS: coordination / tracker truth (planning or implement only if plan says so)

OPERATOR CONSTRAINTS (absolute)
- Zero manual work for Nitro. Agents own claims, updates, PRs.
- Do not limit agent speed, parallel, or autonomous merge under existing ownership law.
- Do not over-engineer: prefer one contract + existing files over new boards/CI.
- Do not undo GitHub thrift. Do not add Denon Approve gates.
- Preserve quality: false-done stays CI-blocked; no invent money.

PHASE DISCIPLINE
1) State which phase you are in (P1 problem → P7 plan / E-steps).
2) Do not implement gates or new systems before P1–P6 are satisfied in docs/TRACKER-COORDINATION-PROPER-PLAN-2026-08-02.md.
3) Separate: symptom (Denon) vs problem (split SoT) vs causes (ranked) vs solution family (S0–S7).
4) Every proposal must pass the anti-list (no dual tracking, no status theater, no every-PR registry tax, no required human review on agent paths, no Nitro clerk).

TRUTH LAYERS (do not collapse)
- Product ownership / done / free / human lock → tooling/tracker/features.mjs
- Campaign “ship next” → Board Clear NEXT (sequence only)
- Session “who codes what now” → LIVE-LANES + open PRs path intersect
- Code existence → git / merged PRs
If two docs disagree on ownership: features.mjs + ownership law win. NEXT does not erase tracker.

DENON INTENT
- Trusted multi-dev context + low agent conflict — not maximizing features.mjs diffs.
- Mountain events (claim / handoff / done / human lock), not every craft PR.

BEFORE CLAIMING DONE ON THIS PROGRAM
- A1–A10 acceptance from the proper plan must be checkable.
- List negatives avoided explicitly.
```

---

## Completeness checklist (this document)

| Need                            | Covered                            |
| ------------------------------- | ---------------------------------- |
| Did we jump steps before?       | Yes — called out; prior §9 demoted |
| Problem identified              | §P1 F1–F7 + one-sentence problem   |
| Cause ranked                    | §P2 C1–C7                          |
| Reason / intent                 | §P3                                |
| Limits speed/quality/autonomy   | §P4                                |
| Hole-poke / anti-list           | §P4.2, R1–R7                       |
| Solution space without over-fit | §P5 S0–S7                          |
| Spec / acceptance               | §P6 A1–A10                         |
| Forward plan for other chats    | §P7 E1–E7                          |
| No code this turn               | Yes                                |
| Unspoken needs                  | §P3.2 + constraints header         |
| Enhanced prompt                 | §P8                                |

---

## What Nitro decides (only real fork)

Nothing required to “start fixing” yet. When you want execution:

1. **Approve the layered contract (S0–S3 shape)** → later chat runs E1–E4 only.
2. **Also run honesty sweep (S6)** after E1–E4.
3. **Hold** — leave plan; agents keep current Board Clear rules until you say GO on E1.

Default recommendation when you say GO: **1**, then measure; **2** only if Denon still can’t see context; **never 3=S7 first**.
