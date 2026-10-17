# Board Clear — World-Class Agentic Engineering Standard

**Status:** BINDING under Board Clear  
**Purpose:** Kill vibe-coding / AI slop while staying fully autonomous (no human in the loop for tech).  
**Grounded in:** industry multi-agent + context engineering practice; agentic production anti-patterns; verification-before-completion; INTAFACED doctrine.

---

## 0. Thesis

Autonomous agents fail production systems by looking busy and green while drifting, inventing, or shipping unproven claims.  
**Right** here means: **elite engineer behavior encoded as durable gates** — not more prose in a god prompt.

Token budget is a feature (multi-agent spends tokens to solve hard problems) — **waste** is thrashing, re-reading without writing, and CI as a debugger.

---

## 1. Iron laws (never optional)

| #   | Law                           | Violating looks like                                       |
| --- | ----------------------------- | ---------------------------------------------------------- |
| 1   | **Evidence before claims**    | “Should pass” / “CI will catch it” without local run       |
| 2   | **Durable memory > chat**     | Plan only in conversation; NEXT empty at turn end          |
| 3   | **Orchestrator ≠ god prompt** | One agent holds all programs and invents scope mid-flight  |
| 4   | **Workers get closed briefs** | Subagent “figure out trade” with no Done bar / paths       |
| 5   | **Tests are not vibes**       | Green tests that assert mocks only; no money failure paths |
| 6   | **No invent**                 | Fake mid/depth/rates/candles/balances/partner names        |
| 7   | **Surgical diffs**            | Drive-by refactors, format-only noise, “while I was here”  |
| 8   | **One concern per PR**        | “and” in title; cross-service without contracts first      |
| 9   | **Merge is accountability**   | Class M without self-audit; Class X as agent-done          |
| 10  | **Scoreboard is truth**       | Tracker Done without constitution bar                      |

---

## 2. Anti-slop catalog (detect → refuse → rewrite)

| Slop pattern                | Detection                                      | Required rewrite                    |
| --------------------------- | ---------------------------------------------- | ----------------------------------- |
| **Vibe green**              | Claim done, no command output in session       | Run verify; paste real exit         |
| **Mock theater**            | Tests only pass with total mocks of money path | Add MemoryLedger / recipe invariant |
| **Happy-path only**         | No insufficient funds / cancel / retry         | Add failure tests                   |
| **God branch**              | 50-file “cleanup”                              | Split PRs; revert noise             |
| **Spec amnesia**            | Build without R1 research note                 | Stop; write R1 then resume          |
| **Partial forever**         | 4th ship on same row still OPEN                | Force Done or §13 Cut               |
| **Invent to unblock**       | Hardcoded mid “for now”                        | Refuse; null skip or oracle port    |
| **Copy-paste architecture** | New framework because “clean”                  | Match repo style                    |
| **Docs as product**         | Only markdown, row still OPEN                  | Code ship or honest Cut             |
| **CI as debugger**          | Push storm fixing prettier                     | Local prettier/verify first         |
| **Secret in code**          | API keys in source                             | Refuse; env/agent-auth only         |
| **UI on wrong tree**        | apps/web as product                            | Vendor :8090 only                   |
| **Orphan PR**               | #289 style diverge forever                     | Rebase/merge/absorb same program    |

**If you catch yourself in a row:** treat as L6 stall; smallest honest next step.

---

## 3. Evidence format (every ship)

Before merge claim, durable PR body **must** include:

```markdown
## Evidence

- Commands run: `…` (verbatim exit 0 / fail count)
- Files touched: (list, surgical)
- Done bar slice: (quote constitution)
- Invent check: mid/rates/depth/balances? none
- Money path? yes/no — if yes: crash stranding answer + Class M self-audit
- Tracker/scoreboard: updated yes/no
```

**No evidence block → do not merge.**

---

## 4. Role separation (orchestrator-worker)

Inspired by production multi-agent systems: **lead plans + memory; workers execute in clean context.**

| Role                               | May                                                                                       | Must not                                                 |
| ---------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| **Orchestrator**                   | Prioritize ships, spawn workers, babysit CI, merge policy, update NEXT/scoreboard, replan | Implement large code dumps across programs               |
| **Worker**                         | One ship / one program paths, R1–M1, PR                                                   | Touch other programs; reopen B decisions; stop for Nitro |
| **Reviewer (same or second pass)** | Adversarial check vs anti-slop + doctrine                                                 | Merge without orchestrator/policy                        |

Worker brief is **self-contained**: objective, Done bar, paths, bans, proof commands, when done.

---

## 5. Compaction / context engineering

| Technique                      | Board Clear home                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------------------- |
| Structured notes               | NEXT, SCOREBOARD, DECISION-LOG, ship R1 notes in PR                                       |
| Compaction resume              | Re-read PREFLIGHT → UNSPOKEN → CONSTITUTION → LOOPS → STANDARD → PLAN → SCOREBOARD → NEXT |
| Subagent isolation             | SUBAGENT-PROTOCOL; workers don’t inherit polluted mega-context                            |
| Plan in memory before overflow | NEXT + DECISION-LOG updated **before** long tool runs                                     |

**Never** rely on chat summary alone as high water.

---

## 6. Wave audit (quality pulse)

Every **4 merged product ships** (or weekly wall-clock if slower):

1. Re-derive tip + open PRs
2. Sample last 4 PRs against anti-slop catalog
3. Confirm scoreboard matches tracker
4. Write 10-line note under `docs/BOARD-CLEAR-WAVE-AUDIT-LATEST.md` (overwrite)
5. Resume L0

Not a stop; a **quality heartbeat**.

---

## 7. Financial OS special (INTAFACED)

- Ledger recipes only; money as decimal strings / scaled bigint
- Prefer empty-honest over pretty lies
- Class M: recipes + failure tests + idempotency business keys
- Protocol: deploy log + audit package, not “looks audited”
- Pay card: sandbox E2E; no invented captures

---

## 8. Success metric

World-class agentic engineering **here** = board rows Done/Cut with **evidence**, **no invent**, **no drift**, **no human tech loop** — not LOC shipped.
