> **Supersession (2026-08-09):** Any line that treats **Actions thrift**, run-count caps, `THRIFT_ALLOW`, or holding PRs for CI spend as current law is **void**. The repo is public; thrift was deleted 2026-08-07. See [`GITHUB-CI-SPEND-CONTROL-2026-07-31.md`](GITHUB-CI-SPEND-CONTROL-2026-07-31.md). Historical text below may still _mention_ thrift as what was once believed.

# FRAME + how we plan this program (hardened)

**Status:** FRAME WORKING · methodology locked · tools/workflows landscape filled · Nitro does **not** restate — agent owns quality  
**Date:** 2026-07-31  
**Precedence:** doctrine + Denon DIRECTION (#272) → **this file for how we run** → **tools landscape** `ORDER-ROUTE-TOOLS-WORKFLOWS-LANDSCAPE-2026-07-31.md` → Spec `ORDER-ROUTE-SPEC-v1-2026-07-31.md` → domain inventory  
**Phase:** Frame + Spec + Architect + **Plan ready** → Build = `ORDER-ROUTE-PLAN-2026-07-31.md` P0→P1-1

---

## 0 · Honest audit of the previous “research” pass

| What was done                                  | Why it was insufficient                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| Domain inventory of svc-trade / matching / dex | That is **terrain mapping** (necessary, not sufficient)                               |
| Gap board + waves W0–W8                        | That jumped toward **decompose/build list** without a proper Frame or planning method |
| Light internet on order books / DEX quotes     | **Feature-domain** research, not **how to plan a money-path program**                 |
| Implicit “go ship waves”                       | Violates your ladder: Frame → Spec → Architect → Decompose **before** Build           |

**This document fixes the missing first half:** research on _how elite teams plan and gate complex work_, synthesis with _your_ software ladder, and a **complete Frame** for Denon’s order-route / DEX–CEX harden intent — so Spec and later rungs are constrained, not improvised.

Domain gaps still live in the companion program doc; they are **inputs to Spec**, not a plan by themselves.

**Tools & workflows landscape (Frame research beat — all-out v2):**  
[`ORDER-ROUTE-TOOLS-WORKFLOWS-LANDSCAPE-v2-2026-07-31.md`](ORDER-ROUTE-TOOLS-WORKFLOWS-LANDSCAPE-v2-2026-07-31.md) — last30days community signal · star-ranked GitHub map (Spec Kit / OpenSpec / BMAD / TigerBeetle / Jepsen / Toxiproxy / …) · steal playbooks · Tier A/B/C.  
(v1 landscape file kept historical only.)

---

## 1 · Research funnel — how to plan properly (sources + what we take / reject)

### 1.1 Method clusters studied

| Cluster                                       | Core idea                                                                                              | Relevance here                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| **Your ladder (9 rungs + loop)**              | Altitude order; fractal; adversarial every rung; builder never grades self; evidence = done            | **Primary operating system** for this program                                   |
| **Spec-driven development (2025–26)**         | Spec is the product of thinking; code is derived; phases Specify→Plan→Tasks→Implement with human gates | High — stops vibe coding money paths                                            |
| **Adversarial planning / design review**      | Separate Planner vs Architect/Critic; attack the plan before build; fresh context                      | High — money + multi-agent blind spots                                          |
| **Doubt-driven development (your skill)**     | Fresh-context disproof of non-trivial claims; ARTIFACT+CONTRACT only                                   | High — use on Frame, Spec, Arch, each PR                                        |
| **Google design docs**                        | Goals/non-goals, trade-offs, alternatives, cross-cutting (security/ops); review before major code      | High for Architect + high-stakes Spec slices                                    |
| **Amazon Working Backwards (PR/FAQ)**         | Customer outcome first; FAQ forces hard questions; **not** an eng spec                                 | Medium — use for Frame “done looks like” narrative, not for Class M recipes     |
| **SRE Production Readiness Review (PRR)**     | Service must meet reliability/ops bar before “owned as production”; launch checklists                  | High — defines **outcome** of harden ≠ “more tests”                             |
| **Walking skeleton**                          | Smallest end-to-end path live early; evolve architecture with function                                 | High — adapted: _prove the money path E2E under failure_, not greenfield deploy |
| **Chaos Engineering principles**              | Steady state → hypothesis → inject real-world faults → disprove                                        | High — verify bar for “stable under real money”                                 |
| **Superpowers brainstorming / writing-plans** | One question at a time; design before code; bite-sized TDD tasks                                       | Medium — use after Frame approved; collapse for small slices                    |
| **Design-docs-as-waterfall critique**         | Docs can become blame theater if not updated; code can be design                                       | Partial — we keep living docs + PR as proof; **do not** multi-week doc theater  |

### 1.2 What we **adopt** (non-negotiable for this program)

1. **Loop, not one-way ladder** — verify fail → rebuild or re-spec; post-ship work re-enters Frame.
2. **Adversarial check on every rung’s artifact** before it “stands” — Frame, Spec, Arch, Plan, Code, Ship notes.
3. **Builder never grades own work** — verify/review in **fresh session or fresh agent**; different question than “does it pass tests I wrote.”
4. **Frame first** — what / for whom / why / outcome-level done; research beat included; **should this exist?** answered.
5. **Spec owns invisible requirements** — security, failure modes, money conservation, scale, cost, ops — not bolted later.
6. **Architect names 2–3 approaches + recommendation + failure modes** for ambiguous seams only (not every micro-PR).
7. **Decompose to one-pass agent pieces** with defined checks; seams follow architecture, not “whatever file is open.”
8. **Build test-first** where behavior is money-path; source-driven for frameworks; systematic-debug on break.
9. **Verify = evidence** (test output, demo, reconcile numbers) — claim ≠ done. **Two levels:** piece green **and** assembled path green.
10. **Review ≠ verify** — correctness/security/over-engineering lenses after proof of behavior.
11. **Ship small/often** — Class matrix; walking proof path before big features. (Actions thrift deleted 2026-08-07.)
12. **Operate / readiness** — scoreboard + chaos steady-state metrics; go-live stays §8 human.
13. **Docs hygiene** — one home per fact; update before session end.
14. **Fractal** — whole program runs the ladder; each subsystem (dual-book, CEX chaos, DEX quote, seed) runs a mini-ladder.

### 1.3 What we **reject or constrain** (so methodology does not limit us)

| Temptation                              | Why reject / constrain                                                                                                      |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Full Amazon PR/FAQ as eng contract      | Wrong altitude for Class M; Denon already wrote direction. Use only Frame narrative.                                        |
| Google design-doc for every PR          | Overhead; use mini-design (1–3 pages) only when solution space is ambiguous or money-coupled                                |
| “Run chaos in production first”         | Wrong for non-go-live; run chaos on **dev fleet + CI** with production-_like_ failure modes; PRR mindset without prod blast |
| Spec-kit 4-phase ritual as religion     | Keep intent (spec constrains agents); drop tool ceremony that slows without evidence                                        |
| Multi-week design freeze                | Bias to ship small after Frame+Spec for first walking proof; iterate design docs when reality hits                          |
| One chat does Frame→Ship                | Violates builder-grades-self; **phase-aware sessions** (see §5)                                                             |
| Replace domain law with generic process | Doctrine + Denon §8 + Class M carve-outs always win over any methodology blog                                               |
| Perfect Frame before any terrain map    | We already mapped terrain; Frame **uses** it; we do not re-research forever                                                 |

### 1.4 Synthesis law (how research enhances without boxing us)

> **Methodology is a force multiplier for error-finding, not a permission system.**  
> If a method would block a reversible Class N ship that already has green verify + no money risk, drop the ceremony.  
> If a method would let a Class M change merge without adversarial + evidence, the method is wrong — restore the gate.

---

## 2 · FRAME (complete) — what this program is

### 2.1 What is this?

**A production-readiness program** for INTAFACED’s **existing** CEX order route and DEX quote/routing plane — so Denon’s bar (“order machine hardened and stable when real money flows; orders, retries, execution”) is **provable**, not claimed.

It is **not**:

- A greenfield exchange
- A futures product build (explicitly not first)
- A UI rebrand
- Permission to flip go-live

### 2.2 For whom?

| Stakeholder        | What they get                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| **Denon**          | Evidence the money spine won’t double-pay, second-book, or lie under failure; engine order respected; §8 untouched |
| **Nitro**          | High-level control; checkable outcomes; no git homework; scoreboard for later go-live judgment                     |
| **Users (future)** | Honest balances, honest depth, honest quotes, cancel/exit under kill — when humans say go                          |
| **Agents**         | Unambiguous Frame → Spec contracts; adversarial gates; lanes so they don’t thrash                                  |

### 2.3 Why now?

- Spot path **exists and is strong in unit tests** but **dual-book + seed honesty + ops chaos + dual-plane story** still block “real money stable.”
- Denon said verbally **and** wrote DIRECTION: seed first, futures not first, dual-book Option B, Class M rules.
- Residual campaign had a **stale engine order** (futures first) — Frame corrects course.
- Nitro’s system must prove it can own hard money work without Denon as default ship machine.

### 2.4 Should this exist at all?

| Option               | Verdict                                                                                |
| -------------------- | -------------------------------------------------------------------------------------- |
| Do nothing           | Fail Denon’s real-money bar; second book + empty depth remain silent risks             |
| Only Stream A polish | Looks better, still unsafe money path                                                  |
| Jump to futures      | Violates his #1 decision; liquidates against empty books                               |
| **This program**     | **Yes** — highest leverage for “stable when money moves” without inventing product law |

### 2.5 Outcome-level “done” (Frame altitude — not Spec checkboxes)

**Done for the program** means all of the following are **true and re-provable**:

1. **One book:** Nothing in the vendored money surface can create a second balance of record; scans enforce it.
2. **CEX path steady state under fault:** Hold→match→fill/cancel/retry conserves money under the chaos experiment set (defined in Spec); piece tests + **assembled** path both green.
3. **DEX path honesty:** Quotes never invent prices; degraded routing disclosed; execute remains an explicit socket (not a fake fill).
4. **Depth without lies:** Seeded liquidity exists, is flagged, is killable, and does not fake user-facing volume stats.
5. **Roadmap honesty:** Futures/OTC/copy not mis-marked done; Denon engine order followed.
6. **Readiness scoreboard:** Human can see green/red per axis; **go-live flip remains human §8**.

**Non-goals (Frame-level):**

- Production go-live declaration
- Best-in-class HFT latency
- Full multi-venue execute on protocol plane
- Copy trading / icebergs
- Replacing matching engine

### 2.6 Working-backwards narrative (one paragraph — PR/FAQ style, not eng spec)

> _When real money is allowed on the Fiat plane, every order either settles correctly or fails closed; retries never double-spend; kill-switch still lets users cancel; the shell never shows a second balance of record; the book has honest depth or admits it is empty; DEX quotes either come from live venues or refuse. Operators can show a scoreboard that this is true. We did not invent futures or claim go-live._

### 2.7 Success metrics (steady state — chaos / PRR style)

Measurable proxies (Spec will pin numbers/tests):

| Steady-state signal                    | Disturbed when…                        |
| -------------------------------------- | -------------------------------------- |
| Ledger conservation on trade path      | Double fill/release or stranded hold   |
| Open-order ↔ hold ↔ engine consistency | Indeterminate submit or lost events    |
| Dual-book scan green                   | Java mutator or second-book write path |
| Public volume integrity                | Seeded volume counted as real          |
| Quote integrity                        | Stale/synthetic price accepted as live |
| Cancel under halt/kill                 | User funds trapped                     |

---

## 3 · How we approach the program (planning method for THIS repo)

### 3.1 Fractal program structure

```
PROGRAM (order-route harden)
├── Subsystem A: Dual-book enforcement     → mini Frame→…→Ship
├── Subsystem B: CEX path readiness        → mini Frame→…→Ship  (walking proof first)
├── Subsystem C: DEX quote honesty         → mini Frame→…→Ship
├── Subsystem D: Seed / mm honesty         → mini Frame→…→Ship
├── Subsystem E: Multi-asset resume        → mini Frame→…→Ship
└── Subsystem F: Readiness scoreboard/ops  → mini Frame→…→Ship
```

**Walking skeleton for this program (adapted):**  
Not “deploy empty app.” It is the **smallest assembled proof** of:

> place two-sided spot order → hold → match → fill → ledger closed → cancel/retry under injected fault → still conserves

on tip with real services (or closest platform:up). That proof is built **early** (after Spec slice for CEX readiness), then dual-book and seed hang more weight on a path we already walk end-to-end.

### 3.2 Rung map for this program

| Rung            | Artifact                                            | Adversarial gate           | Nitro role                                    |
| --------------- | --------------------------------------------------- | -------------------------- | --------------------------------------------- |
| **1 Frame**     | This doc (outcome done / non-goals / method)        | Fresh agent adversarial    | High-level only; agent owns quality           |
| **2 Spec**      | `ORDER-ROUTE-SPEC-v1-…` checkable REQs              | Fresh agent doubt on Spec  | Status + phase only — no restatement homework |
| **3 Architect** | Per ambiguous seam: 2–3 options, rec, failure modes | Fresh agent                | Agent picks safe default; escalates only §8   |
| **4 Plan**      | Task graph with checks; every REQ mapped            | Fresh agent: Spec coverage | High-level “plan complete?”                   |
| **5 Build**     | Code TDD in worktree; one concern/PR                | — (builder)                | Out of loop                                   |
| **6 Verify**    | **Fresh** session: evidence                         | Not the builder            | Proof links                                   |
| **7 Review**    | Fresh money/security/bloat                          | Class M mandatory          | Rare                                          |
| **8 Ship**      | Merge under Class matrix + carve-outs               | CI + self-audit            | Link only                                     |
| **9 Operate**   | Scoreboard, WAVE-AUDIT                              | Recurring                  | Go-live later                                 |

**Loop:** Verify fail → Build or Spec. Review fail → Build or Architect. Post-merge defect → new Frame slice.

### 3.3 Session / agent topology (implements “builder never grades self”)

| Chat type                                      | Allowed rungs                 | Forbidden                                              |
| ---------------------------------------------- | ----------------------------- | ------------------------------------------------------ |
| **Frame/Spec/Arch coordinator** (this lineage) | 1–4, program docs, LIVE-LANES | Massive feature implementation without Spec            |
| **Build lane**                                 | 5 only for claimed tasks      | Merging on own “looks good”; inventing Spec            |
| **Verify lane**                                | 6 only                        | Fixing by rewriting product without failing test first |
| **Review lane**                                | 7 only                        | Shipping                                               |
| **Babysit/ship**                               | 8 under matrix                | Expanding scope                                        |

When one human chat must do more (Nitro preference for fewer windows): **hard phase markers** + mandatory spawn of fresh subagent for verify/review; never “I just built it and it passes in my head.”

### 3.4 Planning sequence after Frame approval (do not skip)

```
Frame approved (Nitro)
  → Spec v1 (program-level checkable requirements + subsystem acceptance)
  → Adversarial doubt on Spec (fresh agent)
  → Nitro Spec sign-off (plain language restatement)
  → Architect notes only for open seams (dual-book enforcement shape; chaos harness location; seed model)
  → Decompose: ordered task graph + walking-skeleton first
  → Build/Verify/Review/Ship per piece
  → Scoreboard + WAVE-AUDIT
  → Operate loop
```

**Domain research** (companion program doc) is **attachment to Spec**, not a substitute for Spec.

### 3.5 Chaos / readiness planning (from principles, adapted)

Before calling CEX “stable,” Spec must define:

1. **Steady state metrics** (ledger conservation, open-order consistency, error rate on place/cancel)
2. **Hypothesis** (steady state holds under listed faults)
3. **Fault catalog** (engine timeout after hold, NATS redelivery, concurrent cancel+fill, kill-switch, process kill mid-settle, journal restart)
4. **Blast radius** (dev/CI only until go-live)
5. **Disproof procedure** (automated tests preferred over manual chaos theater)

### 3.6 Design-doc policy (Google, constrained)

| Write a mini design doc when   | Skip when                           |
| ------------------------------ | ----------------------------------- |
| Dual-book enforcement strategy | Pure test addition for known recipe |
| Chaos harness architecture     | Docs-only path (when docs-only)     |
| Seed flag data model           | Tracker honesty wording             |
| Multi-asset resume conflicts   | Format fix                          |

Each design doc: context, goals/non-goals, design + **trade-offs**, alternatives, failure modes, open questions. Update if pre-ship reality diverges.

### 3.7 Spec policy (SDD, constrained)

Spec must be **checkable** by a stranger agent:

- Given / when / then or explicit pass criteria
- Security: who can move value; what must never happen
- Money: recipes allowed; no invent; Class M carve-out list
- Explicit **out of scope**
- Traceability: each Spec ID → later task IDs

### 3.8 Decomposition policy (writing-plans, constrained)

- Tasks sized for one agent pass + independent check
- No TBD steps
- Test-first steps for money behavior
- Integration task explicit (assembled path) — **never** “assume unit tests imply E2E”

### 3.9 Cross-cutting always-on

- LIVE-LANES claim before code
- Worktree never main checkout
- `pnpm verify` real output
- Local green before push (fast feedback, not spend caps)
- project-doc-hygiene
- Denon §8 never agent-closed

---

## 4 · How Frame connects to domain inventory (without confusing altitudes)

| Altitude            | File / home                          | Question answered                        |
| ------------------- | ------------------------------------ | ---------------------------------------- |
| **Frame**           | **This file**                        | What/why/whom/done-outcome/how we plan   |
| **Domain evidence** | `ORDER-ROUTE-HARDEN-PROGRAM-…` §§3–5 | What already exists; gaps G0–G8          |
| **Direction law**   | Denon `DIRECTION-2026-07-31` (#272)  | Product decisions agents must not invent |
| **Spec**            | _Not written yet_                    | Checkable requirements                   |
| **Arch / plans**    | _Not written yet_                    | Seams and task graphs                    |

**Rule:** Do not treat G-tables as Spec. Promote G-items into Spec requirements with acceptance tests.

---

## 5 · Enhanced meta-prompt (Frame-aware, non-lazy)

```
You own the Order-Route / DEX–CEX Money-Path program for INTAFACED.

Altitude discipline:
- FRAME: outcome done, non-goals, method — this chat until Nitro signs Frame
- SPEC: checkable requirements + security/money failure modes — fresh artifact, doubt-driven
- ARCHITECT: only ambiguous seams; 2–3 options + failure modes
- DECOMPOSE: bite-sized tasks with checks; walking-skeleton CEX proof early
- BUILD: worktree, TDD money paths, one concern/PR
- VERIFY: FRESH agent/session — evidence only
- REVIEW: FRESH — money/security/bloat lenses
- SHIP: Class matrix + Denon carve-outs
- OPERATE: scoreboard; go-live is human

Laws:
1. Adversarial check every rung artifact before it stands
2. Builder never grades own work
3. Methodology enhances; doctrine + Denon §8 always win
4. Domain inventory is not a plan
5. Surprise by rigor and completeness, not feature invention
6. Nitro is high-level only — no git homework

Re-derive git + LIVE-LANES every fire. Docs true before session ends.
```

### Nitro’s enhanced prompt (paste)

```
Program home: docs/ORDER-ROUTE-FRAME-AND-PLANNING-METHODOLOGY-2026-07-31.md
Domain gaps: docs/ORDER-ROUTE-HARDEN-PROGRAM-2026-07-31.md

I am Nitro — high-level orchestrator. You run Frame→Spec→…→Ship under the
methodology in the Frame doc. Adversarial every rung. Builder never grades self.
Denon direction (#272) is law. Dual-book + CEX chaos + DEX honesty + seed first;
futures not first. Go-live is mine/§8. I approve Frame/Spec in plain language;
you handle the rest. No lazy skip of Frame/Spec into build. Complete boards;
fresh verify; evidence or not done.
```

---

## 6 · Adversarial pre-check of THIS Frame (self-doubt before Nitro sign-off)

Issues a fresh agent should hunt (we pre-list so we do not hide):

| Risk                                    | Mitigation                                              |
| --------------------------------------- | ------------------------------------------------------- |
| Frame still too vague for Spec          | §2.5 outcomes + §2.7 steady-state metrics bound Spec    |
| Process theater slows ship              | §1.3 reject list + Class N can ship with light ceremony |
| Walking skeleton misread as deploy prod | Explicitly dev/CI assembled path                        |
| Domain doc and Frame diverge            | §4 altitude table; Frame owns method                    |
| Multi-chat hard for Nitro               | §3.3 allows one chat with forced fresh subagents        |
| Denon still thinks we invent futures    | Non-goals + engine order restated                       |

**Required before Spec:** Nitro sign-off **or** explicit “Frame approved, write Spec.”  
**Recommended:** one fresh-agent adversarial pass on this Frame file (ARTIFACT=this doc, CONTRACT=§2 outcomes must be clear and non-goals explicit).

---

## 7 · Next actions (current)

1. ~~Frame~~ · ~~Spec v1~~ (written)
2. Fresh adversarial pass on Spec (recommended, agent-owned)
3. Architect notes: dual-book enforcement shape · chaos harness home · seed model
4. **Plan** — full task graph, every REQ-ID mapped, walking skeleton first
5. Build lanes only after Plan stands
6. **Never** require Nitro to restate Spec/Frame in his own words

---

## 8 · Research bibliography (planning methods)

- Nitro software ladder (user input, 2026-07-31)
- Spec-driven development guides 2025–26 (spec as contract; adversarial agent pattern)
- Adversarial planning for SDD (Planner + Architect critic)
- Doubt-driven development skill (fresh-context disproof)
- Google design docs (trade-offs, non-goals, cross-cutting; when not to write)
- Amazon Working Backwards PR/FAQ (customer outcome; not eng spec)
- Google SRE PRR / launch coordination mindset
- Walking skeleton / dancing skeleton literature
- Principles of Chaos Engineering (steady state, hypothesis, real-world faults, blast radius)
- Superpowers: brainstorming, writing-plans, verification-before-completion
- Prior domain pass: `ORDER-ROUTE-HARDEN-PROGRAM-2026-07-31.md` (terrain only)

---

## 9 · Changelog

| When       | What                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------- |
| 2026-07-31 | Planning-method deep research + full Frame; supersedes “waves as plan” thinking in companion domain doc for process |
