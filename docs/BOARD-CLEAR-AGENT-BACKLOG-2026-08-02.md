# Board Clear — Agent residual backlog · 2026-08-02

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Owner:** Board Clear orchestrator (agents only)  
**Human mountains:** out of scope — see `SHEHZAD-HARD-OWNERSHIP-2026-08-01.md`  
**Rule:** On every GO/CONTINUE, **re-derive** from this file + scoreboard + `gh pr list`. Do not re-ship completed IDs.

**Shipped on main (do not reopen as primary):**  
A-OR-1 #289 · A-OR-CX8 #370 · A-WS-1 #336 · A-WS-MOCK-E2E #357 · A-UI-1 #337 · A-UI-HONESTY #349 · A-UI-SUB #358 · A-UI-A11Y #367 · A-UI-PRO craft wave #368/#371/#374/#377 · A-TRADE-MM-1 #338 · A-TRADE-MM-2 #340 · A-TRADE-MM-3 #356 · A-TRADE-SPOT-1 #345 · A-TRADE-SPOT-OPS #373 · A-TRADE-VENUE-1 #344 · A-TRADE-VENUE-OPS #376 · A-P5-CURRICULUM #341 · A-P5-OPS #360 · A-P5-AGENTS #375

---

## 0 · Path exclusivity (collision wall inside monorepo)

| Program           | PATHS_ONLY (agent)                                                                                              | Never touch                                                     |
| ----------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **P-UI**          | `vendor/**/05_Web_Front/**`                                                                                     | `apps/web` as product; pay/protocol services                    |
| **P-WS**          | `services/svc-ws/**`                                                                                            | Inventing futures payloads; H-TRADE-HARD risk math              |
| **P-TRADE-LIGHT** | `services/svc-trade/src/mm/**`, `.../spot/*candle*`, venue-mark wiring under trade env/index **only as needed** | `futures/` risk/margin/liq truth; otc/copy/algo product engines |
| **P-P5-LIGHT**    | `services/svc-academy/**`, `services/svc-agents/**`, ops docs/surfaces non-bank                                 | `services/svc-bank/**` money; pay recipes                       |
| **P-TRACK**       | `docs/BOARD-CLEAR-*.md`, tracker honesty                                                                        | Lying Done                                                      |
| **P-OR**          | **DONE** — only residual docs if scoreboard lag                                                                 | Re-open dual-book Java (M7 shehzad)                             |

---

## 1 · Priority order (orchestrator)

When overloaded, pick top unblocked:

1. **P-UI** pro desk gaps (sub-accounts UI after APIs / honesty residual / design bar)
2. **P-TRADE-LIGHT** A-TRADE-MM-3 mid port
3. **P-P5-LIGHT** ops + agents usefulness
4. **P-WS** deepen tests / mock E2E without invent
5. **P-TRADE-LIGHT** venue/spot ops docs + tracker honesty toward Done
6. **Babysit** shehzad open PRs (#346 etc.)
7. **Wave audit** every 4 product merges

Never: A-PAY / A-PROT / futures risk / OTC / copy / algo / bank money / identity money routing.

---

> **2026-08-02 residual:** Agent program ships largely SHIPPED. Scoreboard agent WIP left: **ws.gateway** live futures E2E (M3). See BOARD-CLEAR-NEXT.

## 2 · Remaining agent ships (Wave A2)

### P-UI — web.terminal

| Ship ID       | Status                                                               | Deliverable                                | Done slice                                                                                                                                | Proof                        |
| ------------- | -------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| A-UI-1        | **SHIPPED**                                                          | Hotkeys                                    | —                                                                                                                                         | #337                         |
| A-UI-HONESTY  | **SHIPPED**                                                          | Empty book / error honesty                 | —                                                                                                                                         | #349                         |
| **A-UI-SUB**  | **SHIPPED** #358                                                     | Sub-accounts **selector** in shell         | Wire to existing identity list/create APIs **if present**; if money routing incomplete → UI list + disabled trade path honesty **or** §13 | PR + screenshot/golden       |
| **A-UI-A11Y** | **SHIPPED** #367                                                     | Keyboard/focus/alerts baseline on desk     | Design bar a11y                                                                                                                           | tests or axe notes           |
| **A-UI-PRO**  | **SHIPPED** craft #368/#371/#374/#377 (register residual continuous) | Density/calm polish vs STREAM-A-DESIGN-BAR | No second design system; no fake numbers                                                                                                  | PR scored against design bar |
| **A-UI-DONE** | gate                                                                 | Constitution §3.1 all true                 | Scoreboard web.terminal → DONE                                                                                                            | evidence bundle              |

### P-WS — ws.gateway

| Ship ID           | Status                     | Deliverable                                                  | Done slice                                      | Proof      |
| ----------------- | -------------------------- | ------------------------------------------------------------ | ----------------------------------------------- | ---------- |
| A-WS-1            | **SHIPPED**                | Private auth fail-closed + channel harden                    | —                                               | #336       |
| **A-WS-MOCK-E2E** | **SHIPPED** #357           | Integration test with **fixture** order/fill/position events | No invent live futures                          | tests      |
| **B-WS-2**        | BLOCKED on human M3 events | Live futures position stream E2E                             | Wait for correct events **or** leave WIP honest | —          |
| **A-WS-DONE**     | gate                       | §3.2 without lying about futures                             | DONE only if E2E real or §13 residual named     | scoreboard |

### P-TRADE-LIGHT

| Ship ID               | Status           | Deliverable                                                                | Done slice             | Proof          |
| --------------------- | ---------------- | -------------------------------------------------------------------------- | ---------------------- | -------------- |
| A-TRADE-MM-1/2        | **SHIPPED**      | Recovery + cancel/reseed                                                   | —                      | #338 #340      |
| **A-TRADE-MM-3**      | **SHIPPED** #356 | Mid **port**: config + optional venue/oracle adapter; **never invent mid** | Empty mid → skip seed  | tests          |
| **A-TRADE-MM-DONE**   | gate             | mm-bot constitution bar                                                    | DONE or residual named | scoreboard     |
| A-TRADE-SPOT-1        | **SHIPPED**      | Candle job + honest OHLCV                                                  | —                      | #345           |
| **A-TRADE-SPOT-OPS**  | **SHIPPED** #373 | Ops doc + tracker honesty; enable path documented default OFF              | —                      | docs + tracker |
| A-TRADE-VENUE-1       | **SHIPPED**      | Venue mark mount default OFF                                               | —                      | #344           |
| **A-TRADE-VENUE-OPS** | **SHIPPED** #376 | Ops enable runbook; second venue only if fabric exists                     | No invent mid          | docs/tests     |

### P-P5-LIGHT

| Ship ID             | Status           | Deliverable                                       | Done slice     | Proof      |
| ------------------- | ---------------- | ------------------------------------------------- | -------------- | ---------- |
| A-P5-CURRICULUM     | **SHIPPED**      | Thin curriculum                                   | —              | #341       |
| **A-P5-OPS**        | **SHIPPED** #360 | One real ops/admin surface improvement **or** §13 | —              | PR         |
| **A-P5-AGENTS**     | **SHIPPED** #375 | svc-agents useful path or honest ready            | —              | PR         |
| **A-P5-LIGHT-DONE** | gate             | Academy/ops/agents rows honest Done/Cut           | not bank money | scoreboard |

### P-OR

| Ship ID   | Status                              |
| --------- | ----------------------------------- |
| A-OR-1    | **DONE** #289                       |
| H-OR-JAVA | **shehzad M7** — agents never steal |

### P-TRACK (continuous)

| Ship ID          | Deliverable                                                    |
| ---------------- | -------------------------------------------------------------- |
| **A-TRACK-SYNC** | Every merge wave: scoreboard + NEXT + open PR table re-derived |
| **A-TRACK-WAVE** | Every 4 product merges: WAVE-AUDIT-LATEST                      |

---

## 3 · Dependency notes

```
A-UI-SUB ── prefers ──► H-ID-SUB APIs (shehzad); if absent → thin UI or §13
B-WS-2 ── requires ──► M3 correct position events (shehzad)
A-TRADE-MM-3 ── may use ──► venue mark fabric (already on tip) as optional mid source
A-UI-PRO ── after ──► honesty baseline (shipped)
```

Human rows **do not block** opening any unblocked agent ship above.

---

## 4 · When agent backlog is empty

If every agent ship is DONE/CUT and human rows remain OPEN:

1. Babysit shehzad PRs (merge if decision authority allows).
2. Deepen pro-trader shell polish under design bar (still P-UI).
3. Improve tests/docs/ops honesty — **not** invent product on M1–M7.
4. Keep NEXT non-empty: “babysit M1 PR X” or “wave audit”.
5. **Never** stop campaign or ask Nitro to continue.
6. Campaign COMPLETE only when **all** rows Done/Cut (includes his proof).

---

## 5 · Anti-thrash

- Max **3** merged ships on one row without Done/Cut → next must clear bar or §13 (process loops L1).
- One concern per PR.
- Local verify before push.
- PATHS_ONLY enforced in every subagent brief.
