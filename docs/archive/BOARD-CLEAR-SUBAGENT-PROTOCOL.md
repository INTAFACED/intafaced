# Board Clear — Subagent / Orchestrator Protocol

**Status:** BINDING  
**Why:** Production multi-agent systems win by **orchestrator-worker** + **clean worker context**, not one god agent. Prevents drift and context pollution.

---

## 1. Orchestrator duties (lead)

Every cycle:

1. Read NEXT + tip + open PRs (PARALLEL-SESSIONS §2 collision ritual)
2. Read SCOREBOARD + AGENT-BACKLOG + LIVE-LANES
3. Babysit red CI; shehzad PRs per DECISION-AUTHORITY
4. Pick **path-clear** agent ships (skip SHIPPED; never M1–M7; no dual-build)
5. Spawn N workers with PATHS_ONLY exclusive (**6–8** concurrent, per `docs/ops/SWARM-MANDATE.md` spawn width; 3–6 when only tracker rows are free)
6. On worker return: verify evidence; merge if gates pass
7. Update SCOREBOARD + NEXT (tip + exact ship + open PRs) + DECISION-LOG if needed
8. Wave audit every 4 product merges
9. **Never** stop with OPEN rows and empty NEXT
10. **Never** idle because human rows are OPEN

Orchestrator may do **small** Class N fixes itself; large ships go to workers.

---

## 2. Worker spawn brief (copy template)

```text
You are a Board Clear WORKER. Nitro is not in the loop.

PROGRAM: <P-ID agent only — never H-PAY/H-PROT/H-TRADE-HARD/H-ID/H-P5-MONEY>
SHIP_ID: <e.g. A-TRADE-MM-3 from AGENT-BACKLOG>
OBJECTIVE: <one sentence>
DONE_BAR_SLICE: <quote from constitution / agent backlog>
PATHS_ONLY: <glob from backlog §0 — do not edit outside>
BANS: no invent mid/depth/rates/balances/candles; no apps/web as product UI;
      no force-push spine; no Class X go-live; worktree only; one concern PR;
      no M1–M7 implementation; pro-trader / Stream A design bar if UI
LOOPS: R1 research → S1 spec → P1 plan → B1 build → V1 verify → RV1 review → M1 PR
STANDARD: docs/BOARD-CLEAR-ENGINEERING-STANDARD.md (anti-slop + evidence block)
AUTHORITY: docs/BOARD-CLEAR-DECISION-AUTHORITY.md
PROOF_COMMANDS: <e.g. pnpm --filter X test …>
RETURN: PR URL + evidence block + any blocker for orchestrator (one line)

Do not: ask Nitro; touch other programs; reopen locked B decisions;
mark whole board row Done unless this ship alone clears the bar;
push to main; leave NEXT empty if you are also orchestrator (you are not).
```

---

## 3. Worker return contract

Worker output **must** be structured:

```markdown
## Ship <ID>

- status: PR_OPEN | MERGED | BLOCKED
- pr: <url or none>
- evidence: <commands + results>
- invent_check: clean
- outside_paths: none | <list if accidental>
- blocker: none | <needs program X>
```

Orchestrator **rejects** returns without evidence or with outside_paths without fix.

---

## 4. Parallel safety

| Rule             | Detail                                                          |
| ---------------- | --------------------------------------------------------------- |
| Path exclusivity | Workers’ PATHS_ONLY must not overlap                            |
| Contracts first  | Shared contracts/events = separate ship, merge before consumers |
| Ledger recipes   | One money recipe PR at a time preferred                         |
| UI               | Only P-UI touches vendor shell                                  |
| Matching         | Only if ship explicitly owns it; coordinate P-TRADE/P-OR        |

---

## 5. Model / effort routing (when available)

| Stage                                    | Prefer                     |
| ---------------------------------------- | -------------------------- |
| Bulk search / fetch / format             | cheaper / low effort       |
| Spec judgment / money / security / merge | strong session model       |
| Unclear class                            | treat as judgment (strong) |

Do not silent-inherit cheap models onto Class M.

---

## 6. Failure handling

| Worker failure | Orchestrator action                          |
| -------------- | -------------------------------------------- |
| CI red         | Fix or re-spawn same ship; no new scope      |
| Blocked on dep | Queue dep ship; park worker ship on NEXT     |
| Invent attempt | Reject PR; rewrite brief with ban emphasized |
| Path bleed     | Revert bleed; tighten PATHS_ONLY             |

---

## 7. Anti-god-prompt

If the orchestrator prompt grows into a novel: **split into docs** (already done) and keep paste = pointer + locked decisions + START NOW.  
Subagents get **narrow** briefs, not the whole constitution pasted thrice.
