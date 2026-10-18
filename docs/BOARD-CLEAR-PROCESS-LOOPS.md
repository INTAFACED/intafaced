# Board Clear — Process Loops (mandatory)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Without these loops, agents re-create residual theater.**  
Every ship and every orchestrator turn runs the loops below. Skipping is a campaign defect.

Homes: Constitution · Execution Plan · Agent backlog · Decision authority · Parallel sessions · Scoreboard · Next · this file.

---

## L0 — Outer campaign loop (never exit until finished)

```
while true:
  refresh: main tip SHA, open PRs, scoreboard, NEXT, agent backlog SHIPPED ids
  write Tip when last acted on NEXT
  collision ritual: docs/BOARD-CLEAR-PARALLEL-SESSIONS.md §2
  babysit: red CI → fix → merge green (DECISION-AUTHORITY)
  if agent_residual_open:
      pick EXACT NEXT if path-clear; else first non-overlapping secondary
      fan-out only non-overlapping PATHS_ONLY workers
      queue X1–X5 to HUMAN-BLOCKERS (no Nitro ping mid-run)
  elif agent rows not all Done/Cut:
      polish / §13 agent rows / tests (PHASE B) on free paths
  elif human rows OPEN or HUMAN-BLOCKERS non-empty:
      PHASE C: finalize HUMAN-BLOCKERS; report Nitro once; stop agent implement
  else:
      BOARD-COMPLETE; stop
  if blocked_on_self: replan P1
  if no_merge_and_no_pr_in_this_session_chunk and agent residual:
      force: next path-clear agent ship PR
  write NEXT before any pause/compact/end-turn
  NEVER ask Nitro to continue or re-read after compact
  NEVER treat human OPEN as a stop for agent cooking
  NEVER dual-build paths already open on another live PR
```

**Value gate (L0 metric):** docs-only near-duplicate commits without a `Board-Delta:` trailer are stamp-mill (S-CORE §3). Detector: `tooling/ci/value-gate.mjs` on Docs format CI. A tip SHA / cycle number is not a delta.

**Value gate, code half (L0 metric — added 2026-08-06 after #832–#876):** a near-duplicate **series** subject whose new symbols **nothing outside them calls** is the same stamp-mill in source form. Same detector, wired on the CI `gates` job. Volume is not the metric and neither is taste — reachability is. Warns twice, blocks on the fourth in a row, escapes on an auditable `Serial-Work:` trailer.

**Session end rule:** If context will compact or turn ends, last write is `BOARD-CLEAR-NEXT.md` with the exact next command/ship. Ending without NEXT = **failure**.

---

## L1 — Per-ship loop (R-S-P-B-V-M-U)

For **each** ship ID from the **agent backlog** (preferred) or execution plan:

| Step    | Name     | Must produce                                                                                                                 |
| ------- | -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **R1**  | Research | Written notes: law cites, existing code paths, prior PRs, bans. Min 1 file read of SoT + 1 code grep. No code until R1 done. |
| **S1**  | Spec     | Acceptance bullets in PR draft = Done bar slice. “How we know” tests named.                                                  |
| **P1**  | Plan     | File list + order of commits + risk (money? invent?). ≤15 lines.                                                             |
| **B1**  | Build    | Worktree; surgical code; match repo style.                                                                                   |
| **V1**  | Verify   | Tests / package verify / CI. Real output. Money path: failure cases.                                                         |
| **RV1** | Review   | Adversarial self-check: invent? stranded funds? tracker lie? scope creep?                                                    |
| **M1**  | Merge    | Green CI + Class M self-audit if money; squash-merge.                                                                        |
| **U1**  | Update   | Scoreboard + tracker + NEXT same turn.                                                                                       |

**Anti-research-forever:** R1 max ~1 focused session chunk; then S1/B1. Research-only PRs only if they unlock multiple ships (rare).

**Anti-partial-forever:** After **3 merged ships** on the same board row without Done/Cut, next ship **must** either clear the Done bar or open §13 Cut with tracker honesty. No fourth “almost.”

---

## L2 — Parallel coordinator loop

```
every orchestrator cycle:
  map programs → running worktrees / open PRs (Board Clear + foreign)
  if two agents touch same path → stop one, reassign (PARALLEL-SESSIONS)
  if foreign open PR intersects PATHS_ONLY → skip ship or babysit theirs
  LIVE-LANES claim before code; first claimer wins
  prefer merge order: contracts → ledger recipes → service wire → UI
  no PR cap (COORDINATION-TRUTH-LAYERS "No PR cap" — CI-enforced); babysit red CI, never throttle green work
  local verify green before push (speed, not spend — CI is free on a public repo)
  after any main tip move: rewrite NEXT open-PR table + tip line before next ship
```

---

## L3 — Quality loop (every money or protocol ship)

1. Doctrine §0 check (ledger, no invent, no cross-SQL)
2. Idempotency / crash stranding question answered in PR
3. Failure tests if new recipe
4. Self-audit Class M block in PR body
5. If protocol: deploy proof path + audit package section

Fail any → do not merge.

---

## L4 — Replan loop (when reality breaks the plan)

Triggers: CI architecture conflict, Done bar impossible without invent, Denon main collision, secret class absent, #289 explosion.

```
1. Write what broke (1 paragraph in NEXT or plan addendum)
2. Choose: rewrite Done bar + §13 | split ship | change order | sandbox proof
3. Patch EXECUTION PLAN or SCOREBOARD
4. Resume L0 — never wait for Nitro
```

---

## L5 — Compaction / cold-start / CONTINUE loop

```
1. Open docs/BOARD-CLEAR-NEXT.md FIRST (EXACT NEXT SHIP) — never chat summary
2. git fetch; gh pr list; main tip → update Tip when last acted
3. Run PARALLEL-SESSIONS §2 collision ritual
4. If NEXT ship already merged or path-blocked → pick next OPEN non-overlapping agent ship; rewrite NEXT same turn
5. SCOREBOARD for campaign row status; WAVE-AUDIT-LATEST never live SoT. Product free/human-lock still = features.mjs (COORDINATION-TRUTH-LAYERS)
6. Do not re-open locked B; do not re-ship SHIPPED backlog IDs
7. Decision default: DECISION-AUTHORITY (agent acts; X1–X5 only after agent residual)
```

---

## L6 — Stall detector (self)

You are **stalling** if any is true:

- Explaining plan for >1 turn without opening worktree/PR
- Waiting for Nitro
- Waiting for shehzad before cooking **agent** residual
- “Blocked” without §13 or alternate path
- Research notes with no ship ID
- Re-opening shipped Wave A IDs as primary work
- Scoreboard unchanged after claimed work

**Unstall:** pick smallest unblocked **agent** ship from backlog → R1 immediately.  
If no agent residual: babysit human PRs + pro-trader polish under design bar.

---

## L7 — Finish gate loop

```
for each constitution board row:
  assert DONE or CUT with proof link + evidence
run EXECUTION PLAN §7 checklist
if any fail → L0
if all pass → write SCOREBOARD campaign status COMPLETE; stop
```

Only then may the agent stop.

---

## L8 — Anti-slop / evidence gate (every ship)

Before merge:

1. Run `docs/BOARD-CLEAR-ENGINEERING-STANDARD.md` anti-slop catalog against the PR
2. Evidence block present (commands + exit)
3. Invent check clean
4. RV1 adversarial: would an elite reviewer reject this? if yes, fix

Fail any → do not merge.

---

## L9 — Wave quality heartbeat

Every **4 merged product ships**:

1. Overwrite `docs/BOARD-CLEAR-WAVE-AUDIT-LATEST.md`
2. Sample PRs for slop
3. Confirm scoreboard ≡ tracker
4. Resume L0

Not a stop for Nitro.
