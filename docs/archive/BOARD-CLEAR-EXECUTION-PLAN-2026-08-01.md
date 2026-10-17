# Board Clear Execution Plan — 2026-08-01

**Binding with:** [`BOARD-CLEAR-CONSTITUTION-2026-08-01.md`](BOARD-CLEAR-CONSTITUTION-2026-08-01.md)  
**Agent residual (canonical after Wave A):** [`BOARD-CLEAR-AGENT-BACKLOG-2026-08-02.md`](BOARD-CLEAR-AGENT-BACKLOG-2026-08-02.md)  
**Decisions:** [`BOARD-CLEAR-DECISION-AUTHORITY.md`](BOARD-CLEAR-DECISION-AUTHORITY.md)  
**Purpose:** Spec + decompose so orchestrators execute without Nitro.  
**Rule:** No code for a row until its slice has a Done-linked ship list (agent backlog or below). Prefer agent backlog when Wave A ships are marked SHIPPED.

---

## 0. Programs (parallel ownership)

**Human hard lock (2026-08-01):** `@shehzad002` — full ship list in [`SHEHZAD-HARD-OWNERSHIP-2026-08-01.md`](SHEHZAD-HARD-OWNERSHIP-2026-08-01.md). Agents **babysit only** on H-\* programs.

| Program ID        | Board rows                         | Owner          | Worktree prefix                                   | Collision ban                          |
| ----------------- | ---------------------------------- | -------------- | ------------------------------------------------- | -------------------------------------- |
| **P-UI**          | web.terminal                       | **AGENT**      | `feat/ui-` `feat/app-`                            | **vendor/** shell :8090 — not apps/web |
| **P-WS**          | ws.gateway                         | **AGENT**      | `feat/ws-`                                        | invent futures events                  |
| **H-PAY**         | pay.gateway (card)                 | **shehzad002** | `feat/pay-`                                       | agent card/merchant money PRs          |
| **H-PROT**        | smart-accounts, amm                | **shehzad002** | `feat/protocol-`                                  | agent SA/AMM Done ships                |
| **P-TRADE-LIGHT** | spot OHLCV, mm residual, venue     | **AGENT**      | `feat/trade-mm-` `feat/trade-spot-` `feat/venue-` | futures risk / otc / copy / algo       |
| **H-TRADE-HARD**  | futures risk, otc, copy, algo      | **shehzad002** | `feat/trade-fut-` `feat/trade-otc-` …             | agent product invent                   |
| **P-OR**          | order-route #289 rebase            | **AGENT**      | `feat/order-route-`                               | leave orphan; dual-edit human          |
| **H-OR-JAVA**     | dual-book residual after #289      | **shehzad002** | after A-OR-1                                      | start before #289 closed               |
| **H-P5-MONEY**    | bank earn/cards/ramps              | **shehzad002** | `feat/bank-`                                      | agent bank money                       |
| **P-P5-LIGHT**    | academy, ops, agents               | **AGENT**      | `feat/academy-` `feat/ops-` `feat/agents-`        | bank money                             |
| **H-ID-SUB**      | identity sub-account money routing | **shehzad002** | `feat/identity-sub-`                              | agent invent money routing             |
| **P-TRACK**       | scoreboard/tracker                 | **AGENT**      | `chore/tracker-` `docs/board-`                    | lie on Done                            |

Orchestrator may run **one agent per AGENT program** (or more if non-overlapping). **Never** spawn implementers for H-\* while HUMAN-CLAIMED.

---

## 1. Dependency graph (hard)

```
H-PROT smart-accounts (shehzad) ──► H-PROT amm (shehzad)
H-TRADE-HARD futures events (shehzad) ──► P-WS E2E (agent)
P-TRADE-LIGHT / spot money ──► P-UI trade actions truth (agent)
H-PAY card (shehzad) ──► optional P-UI pay surfaces (agent, after APIs)
P-OR #289 (agent) ──► H-OR-JAVA residual (shehzad)
```

Agent Wave A parallel on AGENT programs only. Human runs H-\* on his schedule.

---

## 2. Wave plan

### Wave 0 — Constitution live

- [x] Constitution + plan + GO + loops + unspoken needs
- [x] Scoreboard + NEXT
- [x] START-HERE + session prompt pointers
- [x] Preflight audit + LIVE-LANES Board Clear rewrite

### Wave A — fan-out (historical; many SHIPPED on main)

| Ship ID          | Program       | Deliverable                                                             | Status (2026-08-02) |
| ---------------- | ------------- | ----------------------------------------------------------------------- | ------------------- |
| A-UI-1           | P-UI          | Hotkeys + order ticket keyboard path                                    | **SHIPPED** #337    |
| A-UI-2 / SUB     | P-UI          | Sub-accounts selector wired or §13                                      | **OPEN** (A-UI-SUB) |
| A-UI-3 / HONESTY | P-UI          | Honesty pass: empty book, errors, envelope                              | **SHIPPED** #349    |
| A-TRADE-MM-1     | P-TRADE-LIGHT | orderFilled makerAccountId + MM recovery                                | **SHIPPED** #338    |
| A-TRADE-MM-2     | P-TRADE-LIGHT | Cancel/reseed lifecycle                                                 | **SHIPPED** #340    |
| A-TRADE-MM-3     | P-TRADE-LIGHT | Mid oracle port (config + optional venue)                               | **OPEN**            |
| A-TRADE-SPOT-1   | P-TRADE-LIGHT | Candle aggregation job or honest pipeline                               | **SHIPPED** #345    |
| A-TRADE-VENUE-1  | P-TRADE-LIGHT | Mount venue fabric into mark or public path                             | **SHIPPED** #344    |
| A-OR-1           | P-OR          | **#289 rebase onto main** then merge/absorb                             | **DONE** #289       |
| A-P5-2           | P-P5-LIGHT    | Academy thin slice or §13                                               | **SHIPPED** #341    |
| A-P5-3           | P-P5-LIGHT    | Ops surface (A-P5-OPS) + agents usefulness or §13                       | **OPS SHIPPING**    |
| A-WS-1           | P-WS          | Harden private channels + tests (may mock until B)                      | **SHIPPED** #336    |
| —                | **H-\***      | **All PAY / PROT / FUT risk / OTC / COPY / ALGO / BANK money / ID-SUB** | **shehzad002 only** |

**Canonical residual list:** [`BOARD-CLEAR-AGENT-BACKLOG-2026-08-02.md`](BOARD-CLEAR-AGENT-BACKLOG-2026-08-02.md) (Wave A2). Prefer backlog over this table when they disagree.

### Wave B — integrate

| Ship ID  | Depends                   | Deliverable                                         |
| -------- | ------------------------- | --------------------------------------------------- |
| B-WS-2   | shehzad FUT events + A-WS | Real futures position stream E2E (agent fan-out)    |
| B-UI-4   | A-UI + A-WS               | Terminal consumes live WS where available           |
| B-PROT-4 | **shehzad** PROT-\*       | AMM Done — human only                               |
| B-PAY-5  | **shehzad** PAY-\*        | pay.gateway Done — human only                       |
| B-OR-2   | A-OR-1                    | Order-route #289 closed (agent); ORJ optional human |
| B-SCORE  | all                       | Tracker Done/Cut; human rows need his proof         |

### Wave C — closeout

- Full board scoreboard green/cut
- High-water “BOARD CLEAR” verdict
- Close campaign autonomous run
- No open campaign PRs

---

## 3. Per-program detailed specs (minimum)

### 3.1 P-UI (web.terminal)

**Research first:** `docs/FRONTEND-STATE-OF-TRUTH-*.md`, brand locks, stream A claim; tree under **vendor shell :8090**.  
**Do not** build `apps/web` as product. Do not redesign whole app if shell works — finish gaps.  
**Ships:** hotkeys, sub-accounts, order form honesty, empty book honesty, a11y.  
**Done proof:** PR list + Orca/playwright/screenshot; tracker web.terminal → done.

### 3.2 P-WS

**Research:** existing private stream routes, event catalog `orderUpdated` `fillSettled` `positionUpdated`.  
**Ships:** subscription auth, backfill policy, position fan-out E2E.  
**Done proof:** integration test with trade publishing events.

### 3.3 H-PAY (**shehzad002 only**)

**Full ship list:** `SHEHZAD-HARD-OWNERSHIP` PAY-01…11.  
**Agents:** babysit PRs only — do not implement card recipes.

### 3.4 H-PROT (**shehzad002 only**)

**Full ship list:** PROT-01…09.  
**Agents:** babysit only.

### 3.5 Trade split

**P-TRADE-LIGHT (agent):** mm-bot recovery/reseed/mid residual; spot OHLCV; venue mount.  
**H-TRADE-HARD (shehzad002):** futures **risk** FUT-01…08; real OTC/copy/algo engines.  
**Agents must not** “thin stub” OTC/copy/algo to mark Done if human owns real engines — leave OPEN until he ships or §13.

### 3.6 P-OR (agent) then H-OR-JAVA (shehzad)

**Agent:** rebase/merge #289.  
**Human after:** Java dual-book residual ORJ-\*.

### 3.7 Phase 5 split

**H-P5-MONEY (shehzad):** bank earn/cards/ramps.  
**P-P5-LIGHT (agent):** academy / ops / agents thin or §13.

---

## 4. Execution loop (orchestrator forever)

```
loop until scoreboard all Done|Cut:
  1. Read CONSTITUTION + this PLAN + SCOREBOARD + origin/main tip
  2. List open campaign PRs → babysit red CI → merge green Class M/N/P
  3. Pick highest-priority unblocked ship from Wave A then B
  4. Spawn worktree + implement + verify + PR + babysit + merge
  5. Update SCOREBOARD + tracker same turn
  6. If ship needs research, spend research then ship same wave (no research-only forever)
  7. Never wait for Nitro
```

### Priority when overloaded (agent orchestrator)

1. Sync scoreboard/NEXT to tip; babysit open PRs
2. web.terminal residual (A-UI-SUB / A11Y / PRO) — visible product
3. A-TRADE-MM-3 mid port (P-TRADE-LIGHT)
4. P-P5-LIGHT ops/agents
5. P-WS mock-E2E (live B-WS-2 waits M3)
6. Spot/venue ops honesty
7. Babysit shehzad Class M PRs
8. **Never** “help” by coding H-PAY/H-PROT/H-TRADE-HARD
9. **Never** re-primary-ship A-OR-1 / shipped Wave A IDs

---

## 5. PR standards

- Title: `type(scope): …`
- Body: what / why / how I know / money self-audit if Class M
- One service/concern
- CI green before merge
- Squash-merge; delete remote branch

---

## 6. Replan triggers (update this file)

- Main tip moves with Denon conflicts
- A Done bar proves impossible without invent → rewrite bar + §13, don’t invent
- #289 scope explosion → split ships, keep claimed
- Secret class truly absent → sandbox Done + §13 prod

---

## 7. Completeness checklist (orchestrator self-check)

Before claiming campaign finished:

- [ ] Every §3 constitution row Done or Cut+§13
- [ ] Tracker matches scoreboard
- [ ] No open Board Clear PRs red
- [ ] #289 not orphan
- [ ] Protocol has deploy proof + audit package
- [ ] Pay has card path proof
- [ ] Trade mountains each addressed
- [ ] Phase 5 each addressed
- [ ] START-HERE points here
- [ ] Autonomous run doc still accurate

If any box unchecked → **not finished — continue loop**.
