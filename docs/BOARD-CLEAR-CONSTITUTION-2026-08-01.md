# Board Clear Constitution — 2026-08-01

**Status:** BINDING for the Board Clear campaign  
**Scoreboard to change:** the residual “all No” product table (web.terminal … Phase 5)  
**Git floor:** re-check `git log origin/main -1` every session (do not trust a frozen SHA)  
**Owner of this doc:** any orchestrator agent; Nitro is not in the loop  
**Preflight:** `docs/BOARD-CLEAR-PREFLIGHT-AUDIT-2026-08-01.md` (blockers hunted 2026-08-01)

---

## 0. Why this exists

Prior residual cook optimized for **honest partials** and correctly never marked product Done.  
Nitro’s real goal is **finish the board**. This constitution re-aims the campaign:

> **Clear every board row to honest Done (or explicit cut with §13 socket).**  
> Run **autonomously until finished.** Nitro is not a decision bottleneck.

Compaction rule: if chat memory dies, **this file + EXECUTION PLAN + AUTONOMOUS RUN** are the full mandate. Do not invent a softer goal.

---

## 1. Nitro decisions (locked 2026-08-01)

| #   | Fork              | Choice                                     | Agent interpretation under full autonomy                                                                                                                                                                                                                                                          |
| --- | ----------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Protocol Done bar | **B — audit + deploy required**            | Deploy to configured env (anvil + any staged chain credentials already on machine). **Audit** = full adversarial self-audit package + automated scanners + doctrine gates green. External audit firm is **not** a chat blocker; produce `docs/audit/` package ready for firm if one exists later. |
| 2   | Trade scope       | **B — all trade mountains**                | futures, mm-bot, otc, copy, algo, venue/ccxt-layer, spot completeness — each has a Done bar in §3                                                                                                                                                                                                 |
| 3   | Pay card          | **B — card required for pay.gateway Done** | Full card acquiring path; sandbox E2E is sufficient proof if prod PSP keys absent. Never invent captures.                                                                                                                                                                                         |
| 4   | Phase 5           | **B — include**                            | bank earn/cards/ramps, academy, ops, agents — Done bars in §3; cut only with §13 socket + tracker honesty                                                                                                                                                                                         |
| 5   | #289 order-route  | **B — claim**                              | Order-route program is **in campaign**. Rebase/restack/finish or absorb residual; do not leave orphan forever                                                                                                                                                                                     |

If a later chat “softens” these without Nitro, **this table wins**.

---

## 2. Unspoken needs (inferred — treat as requirements)

1. **Screenshot must change** — rows go Done or Cut, not eternal “ready/partial.”
2. **Zero Nitro loop** — no “should I…?”, no git homework, no multi-choice tech forks.
3. **Spec/plan first** — execution without a Done bar and PR DAG is failure.
4. **Compaction-safe** — durable docs updated same turn as reality changes.
5. **Parallel max** — independent programs in separate worktrees; ownership map prevents collisions.
6. **Quality bar** — elite engineer standard; doctrine money paths; `pnpm verify` / CI; Class M self-audit.
7. **Going all out ≠ invent** — mid/rates/depth/balances/candles/fees never invented.
8. **Secrets** — read existing agent-auth / env; if missing, sandbox/dev path to Done + §13 for prod-only, **do not stop the whole campaign**.
9. **Denon coexist** — don’t force-push his branches; don’t block his merges; one service per PR.
10. **Feel progress weekly-equivalent** — continuous merges to main, scoreboard refresh every merge wave.

---

## 3. Board rows — Done bars (the only definition of finished)

### 3.1 `web.terminal`

**Product surface:** vendored exchange shell at **http://localhost:8090** (`vendor/**/05_Web_Front` per FRONTEND-STATE-OF-TRUTH). **`apps/web` is not the product.**

**Done when all true:**

- Authenticated pro trade shell: markets, orderbook, place/cancel, open/closed orders, balances, positions, trades tape, charts/equity **wired and honest**
- Hotkeys for primary trade actions
- Sub-accounts UI **or** §13 socket + tracker note if identity API incomplete — prefer ship
- Empty states honest (no fake depth/PnL)
- A11y baseline (keyboard, focus, alerts)
- CI green; visual smoke documented (screenshot path or playwright/Orca if present)

### 3.2 `ws.gateway`

**Done when all true:**

- Private stream delivers order lifecycle + fills + positions for real rows
- Fan-out from trade/futures events E2E (not stub-only)
- Auth fail-closed; reconnect does not double-apply money
- Integration test or compose probe proves events land

### 3.3 `pay.gateway`

**Done when all true:**

- Live crypto rails remain correct
- **Card acquiring path** implemented end-to-end on sandbox (auth/capture/settle/refund recipes)
- Merchant onboarding minimum path (create + KYB stub **or** real if contracts exist)
- Durable payment status path (no silent drop)
- Money only via ledger recipes; failure tests for hold/capture/refund

### 3.4 `protocol.smart-accounts`

**Done when all true:**

- CREATE2 / session / relay paths proven on anvil
- Deploy script succeeds on configured target
- Adversarial audit package written under `docs/audit/smart-accounts-…` (threats, trust boundaries, residual risks)
- Tracker `done` only after deploy proof + audit package + tests green

### 3.5 `protocol.amm`

**Done when all true:**

- Factory + mint + swap proven on same deploy target as smart-accounts allows
- Pool create address prediction matches on-chain
- Audit package for AMM money/invariant surface
- Unblocked from smart-accounts dependency honestly (if still blocked, finish SA first)

### 3.6 Trade mountains (each sub-row)

| Sub-row               | Done bar                                                                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **trade.spot**        | Private REST money path solid; OHLCV either real candle job or honest empty + job shipped; no 502-on-empty                                          |
| **trade.futures**     | Positions open/close; funding + liq jobs **enableable**; mark path non-inventing; live index **or** multi-source mark with explicit config; ops doc |
| **trade.mm-bot**      | Seed job ops path; mid from oracle port or config; settleFill MM; cancel/reseed; event recovery with accountId; empty-book seed proven              |
| **trade.otc**         | Minimum viable OTC RFQ or desk path per doctrine **or** §13 cut if law says later — prefer ship thin honest                                         |
| **trade.copy**        | Copy-trade skeleton with ledger-safe follows **or** §13 with research proof of “not now”                                                            |
| **trade.algo**        | Algo order types or job host for TWAP/slice **or** §13                                                                                              |
| **venue.aggregation** | At least one venue public data mounted in a service **or** fabric consumed by mark/index path                                                       |

### 3.7 Order-route (#289 claimed)

**Done when:** #289 rebased onto main (was CONFLICTING/dirty at preflight), CI green, merged **or** split and absorbed with tracker honesty. **No orphan open forever.** First-class P-OR ship on GO.

### 3.8 Phase 5

| Area                 | Done bar (campaign)                                                            |
| -------------------- | ------------------------------------------------------------------------------ |
| **bank earn**        | At least one earn product path ledger-safe + API **or** §13                    |
| **bank cards/ramps** | Spec + one rail path **or** §13 tied to pay                                    |
| **academy**          | Content shell + one lesson flow **or** §13                                     |
| **ops**              | Operator-critical controls documented + one real admin/ops surface improvement |
| **agents**           | svc-agents useful path or honest ready with DoD                                |

Phase 5 may finish as **thin vertical slices**, not full commercial bank. Tracker must not say Done for fantasy scope.

---

## 4. Hard bans (never waive without Nitro)

1. Invent mid / depth / rates / balances / candles / partner names in UI
2. Money outside `packages/ledger-client`; money as `number`
3. SQL into another service’s tables
4. Work in main checkout; push to main; force-push shared history
5. Fake Done / tracker lies
6. Parallel agents on same branch/files without ownership
7. Stop the campaign to ask Nitro a tech question
8. Claim protocol Done without deploy proof + audit package
9. Claim pay Done without card path (sandbox OK)

---

## 5. Autonomy protocol (Nitro not in the loop)

### When blocked on secrets / env

1. Search agent-auth, `.env.example`, compose, existing CI secrets patterns
2. Prefer sandbox/dev proof for Done
3. Write §13 socket for **prod-only** gap
4. Continue other rows — **never halt the campaign**

### When ambiguous product taste

- Prefer **ship the thinner honest product** that clears Done bar
- Prefer **pro trader** density over marketing polish
- Prefer **ledger-correct** over feature count

### When two agents conflict

- Ownership map in EXECUTION PLAN wins
- Contracts/events PR first if cross-service
- Rebase force-with-lease only on own feature branches

### Stop conditions (campaign finished)

Every board row is **Done** or **Cut+§13** in tracker + high-water scoreboard.  
Open PRs for this campaign are merged or closed with reason.  
`docs/BOARD-CLEAR-SCOREBOARD.md` shows all green/cut.

### Never stop for

- “continue?”
- Compaction (re-read this constitution)
- Low-level design uncertainty (research + pick + document)
- Single flaky CI (fix and re-run)

---

## 6. Quality bar

- Worktree per branch; one service/concern per PR
- `pnpm verify` / package tests + CI green before merge
- Class M self-audit on money PRs (in PR body)
- Prettier/docs CI clean
- Update scoreboard same turn as merge that moves a campaign row; update tracker on **mountain events** (claim / handoff / done/cut / wave note) — not every craft PR ([`COORDINATION-TRUTH-LAYERS.md`](COORDINATION-TRUTH-LAYERS.md))
- Re-index graphify corpus if docs graph exists and you changed docs there

---

## 7. Doc homes (one fact one place)

| Fact                       | Home                                                     |
| -------------------------- | -------------------------------------------------------- |
| Campaign law / Done bars   | **This file**                                            |
| Unspoken needs             | `docs/BOARD-CLEAR-UNSPOKEN-NEEDS.md`                     |
| Process loops              | `docs/BOARD-CLEAR-PROCESS-LOOPS.md`                      |
| PR DAG / waves / owners    | `docs/BOARD-CLEAR-EXECUTION-PLAN-2026-08-01.md`          |
| Paste / forever-run prompt | `docs/BOARD-CLEAR-AUTONOMOUS-RUN.md`                     |
| GO readiness               | `docs/BOARD-CLEAR-GO-READINESS.md`                       |
| Live scoreboard            | `docs/BOARD-CLEAR-SCOREBOARD.md`                         |
| Exact next action          | `docs/BOARD-CLEAR-NEXT.md`                               |
| Engineering standard       | `docs/BOARD-CLEAR-ENGINEERING-STANDARD.md`               |
| Subagent protocol          | `docs/BOARD-CLEAR-SUBAGENT-PROTOCOL.md`                  |
| Decision log               | `docs/BOARD-CLEAR-DECISION-LOG.md`                       |
| Mega audit                 | `docs/BOARD-CLEAR-MEGA-AUDIT-2026-08-01.md`              |
| Wave audit latest          | `docs/BOARD-CLEAR-WAVE-AUDIT-LATEST.md`                  |
| Feature status             | `tooling/tracker/features.mjs` + `docs/TRACKER.md`       |
| Which file answers what    | `docs/COORDINATION-TRUTH-LAYERS.md`                      |
| Law                        | `INTAFACED_DEFINITIVE_BUILD.md`                          |
| Agent rules                | `AGENTS.md` + `tooling/agent-protocol/AGENT_PROTOCOL.md` |

---

## 8. Success = Nitro’s screenshot table changes

If main has more residual partials but the table is still all “No” with no cuts, **the campaign has not succeeded** — keep going.
