# Board Clear — Methodology Audit · 2026-08-02

**Purpose:** Decide whether Nitro must re-spec/plan before GO, or whether the law is sound and only needs CONTINUE hardening.  
**Verdict:** **Sound base + required CONTINUE upgrade (this pack).** Not a greenfield re-spec.  
**Tip when written:** re-check `git log origin/main -1`.

---

## 1 · Question answered

| Question                                 | Answer                                                                                             |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Do we need a new constitution?           | **No** — Done bars, locked B decisions, invent bans hold.                                          |
| Do we need more “planning theater”?      | **No** — we need **accurate residual decomposition + CONTINUE GO**.                                |
| Is Wave A day-one still correct?         | **No** — #289 and most Wave A agent ships **already on main**. Cold GO that re-does them is waste. |
| Can Nitro say GO after this pack merges? | **Yes** — green light for autonomous agent cook + shehzad babysit.                                 |

---

## 2 · What was already world-class (keep)

- Constitution Done bars + anti-invent doctrine
- Shehzad M1–M7 collision wall (parallel spine, not agent gate)
- Process loops L0–L9, engineering standard, subagent protocol
- Evidence-before-merge / Class M
- Vendor shell `:8090` as product UI (not apps/web)
- Compaction read order

---

## 3 · Gaps found (this audit)

| ID  | Gap                                                 | Severity | Fix in this pack                                          |
| --- | --------------------------------------------------- | -------- | --------------------------------------------------------- |
| G1  | NEXT/scoreboard stale vs tip (false “active” ships) | High     | Scoreboard + NEXT truth                                   |
| G2  | GO day-one always starts at #289                    | High     | CONTINUE path + re-derive from scoreboard                 |
| G3  | “Finish needs shehzad” misread as **stall**         | High     | Parallel model explicit; never idle                       |
| G4  | No full remaining **agent** ship DAG                | High     | `BOARD-CLEAR-AGENT-BACKLOG-2026-08-02.md`                 |
| G5  | Decision authority vague (Nitro multi-choice risk)  | High     | `BOARD-CLEAR-DECISION-AUTHORITY.md`                       |
| G6  | Agent backlog exhaustion → thrash or wait           | Medium   | L0/L6 unstall: deepen / polish / babysit / §13 agent-only |
| G7  | Pro-trader positioning not in every GO brief        | Medium   | Product posture block in GO                               |
| G8  | svc-trade path collision with M3/M4                 | Medium   | PATHS_ONLY table in backlog                               |
| G9  | Shehzad PR merge policy ambiguous                   | Medium   | Babysit + merge rules in decision authority               |
| G10 | Host session death still needs re-paste             | Accepted | Documented; not a silent OS                               |

---

## 4 · Research inputs (methodology)

| Practice                        | Application                                                  |
| ------------------------------- | ------------------------------------------------------------ |
| Orchestrator–worker multi-agent | Subagent protocol already; tighten PATHS_ONLY + residual DAG |
| Context engineering             | NEXT + scoreboard as durable memory; CONTINUE re-derive      |
| Verification-before-completion  | Engineering standard unchanged                               |
| Production anti-patterns        | Anti idle-on-human; anti invent-to-unblock                   |

No industry paper replaces doctrine. Research only confirmed: **stale plans kill autonomy more than missing plans.**

---

## 5 · Implicit requirements (Nitro) — hardened

1. One paste → elite parallel cook; no continue prompts.
2. Shehzad deep-works mountains; agents fill **their** board hard same time.
3. Technical forks: agent decides + DECISION-LOG; Nitro only Class X / secrets / true product law.
4. Professional-trader desk quality (Stream A design bar + honesty).
5. Compaction-safe; scoreboard is truth.
6. Quality never traded for speed; speed after evidence.
7. Human blocker surface ≠ campaign stop.

---

## 6 · Completeness of planning for GO

| Layer                | Status after this pack                            |
| -------------------- | ------------------------------------------------- |
| What Done means      | Complete (constitution)                           |
| Who owns what        | Complete (shehzad + LIVE-LANES)                   |
| Agent residual ships | Complete (agent backlog v3)                       |
| Decision rights      | Complete (decision authority)                     |
| Loops                | Complete + CONTINUE patches                       |
| Day-one vs continue  | Complete (autonomous run v3)                      |
| Human M1–M7 PR DAG   | **His** (by design — he designs inside mountains) |

**Architecting for agent half:** done.  
**Architecting for his mountains:** intentionally not agent-owned; he ships under SHEHZAD-HARD-OWNERSHIP.

---

## 7 · Final green light

**GREEN for GO** after this methodology pack is on `main`.

Say GO with enhanced block in `docs/BOARD-CLEAR-AUTONOMOUS-RUN.md`.  
Do **not** re-open locked B decisions.  
Do **not** wait for shehzad to ship agent residual.

**Not claimed:** product board already Done; zero flake; infinite host uptime.
