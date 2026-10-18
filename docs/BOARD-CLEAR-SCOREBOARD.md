# Board Clear Scoreboard

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Campaign:** Board Clear 2026-08-01  
**Resume after compact:** **`docs/BOARD-CLEAR-NEXT.md` first** (agent self-serve — not Nitro)  
**AFK scope:** [`BOARD-CLEAR-AFK-CONTRACT.md`](BOARD-CLEAR-AFK-CONTRACT.md) — AGENT-COMPLETE vs BOARD-COMPLETE  
**Law:** [`BOARD-CLEAR-CONSTITUTION-2026-08-01.md`](BOARD-CLEAR-CONSTITUTION-2026-08-01.md)  
**Agent residual DAG:** [`BOARD-CLEAR-AGENT-BACKLOG-2026-08-02.md`](BOARD-CLEAR-AGENT-BACKLOG-2026-08-02.md)  
**Update rule:** same turn as every merge that moves a row.  
**Tip check:** `git log origin/main -1 --oneline`

**Campaign status:** `AGENT-COMPLETE` (human M1–M7 still OPEN)  
**Last scoreboard edit:** 2026-08-06 — **#346 M1 pay.gateway merged** (shehzad002; board-file conflicts only). Prior: 2026-08-02 tip ≥`76e60ff` — #380 CX-8 L3+L4 · #381 craft · post-pile WAVE-AUDIT sealed

**Authority:** For **campaign row progress / next ship**, **this file + NEXT** beat a lagging generated `docs/TRACKER.md`. For **product ownership / free-to-start / human lock**, `tooling/tracker/features.mjs` wins ([`COORDINATION-TRUTH-LAYERS.md`](COORDINATION-TRUTH-LAYERS.md)). Mountain events keep them aligned — not every craft PR.  
**Known dirty:** human M1–M7 open only; agent-owned rows **DONE** (ws live futures positions §13→M3). Frontend craft register continuous, not a Done-bar blocker.  
**Standards:** ENGINEERING-STANDARD + SUBAGENT-PROTOCOL + DECISION-AUTHORITY  
**Human hard owner:** **`@shehzad002`** — `docs/SHEHZAD-HARD-OWNERSHIP-2026-08-01.md` (M1–M7)

---

## Board (must all become Done or Cut)

| Row                              | Status   | Owner                    | Reality                                                                                                                                                                     | Next ship              | Proof                  |
| -------------------------------- | -------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ---------------------- |
| web.terminal                     | **DONE** | **AGENT P-UI**           | Hotkeys #337 · honesty #349 · sub #358 · a11y #367 · density/CMDK/MoneyIndex/Withdraw/Safe/B9                                                                               | craft residual reg.    | #337–#377 wave         |
| ws.gateway                       | **DONE** | **AGENT P-WS**           | Private harden #336 + mock-E2E #357; live futures positions stream **§13 → M3** (no invent)                                                                                 | babysit M3 events      | #336 #357 · §13 B-WS-2 |
| pay.gateway (+ pay.\* expand)    | **WIP**  | **HUMAN M1 shehzad002**  | #346 merged: KYB transitions · `merchant.me` · durable `payment.list` · mig `0005`. Card rail absent in staging/prod (`socket.psp-partners`); `kybStatus` gates nothing yet | wire KYB gate · Pay OS | #346 #800              |
| protocol.smart-accounts          | **OPEN** | **HUMAN M2 shehzad002**  | Deploy + audit package                                                                                                                                                      | M2                     | —                      |
| protocol.amm (+ lending/escrow…) | **OPEN** | **HUMAN M2 shehzad002**  | After SA                                                                                                                                                                    | M2                     | —                      |
| trade.spot                       | **DONE** | **AGENT P-TRADE-LIGHT**  | OHLCV fill agg #345 + candle job ops default OFF #373                                                                                                                       | deepen only            | #345 #373              |
| trade.futures                    | **OPEN** | **HUMAN M3 shehzad002**  | Risk engine                                                                                                                                                                 | M3                     | —                      |
| trade.mm-bot                     | **DONE** | **AGENT P-TRADE-LIGHT**  | Recovery #338 · reseed #340 · mid port #356 (env + optional venue; never invent)                                                                                            | prod mid ops deepen    | #338 #340 #356         |
| trade.otc                        | **OPEN** | **HUMAN M4 shehzad002**  | Real engine                                                                                                                                                                 | M4                     | —                      |
| trade.copy                       | **OPEN** | **HUMAN M4 shehzad002**  | Real engine                                                                                                                                                                 | M4                     | —                      |
| trade.algo                       | **OPEN** | **HUMAN M4 shehzad002**  | Real engine                                                                                                                                                                 | M4                     | —                      |
| venue.aggregation                | **DONE** | **AGENT P-TRADE-LIGHT**  | Mark fabric mounted #344 + ops enable #376; one public venue (`binance-spot`)                                                                                               | second venue later     | #344 #376              |
| order-route #289                 | **DONE** | **AGENT P-OR** → M7 open | A-OR-1 #289 + CX-8 L1–L4 #370/#380 (fill+ledger+stress)                                                                                                                     | M7 dual-book human     | #289 #370 #380         |
| Phase 5 bank money               | **OPEN** | **HUMAN M6 shehzad002**  | earn/cards/ramps                                                                                                                                                            | M6                     | —                      |
| Phase 5 academy/ops/agents       | **DONE** | **AGENT P-P5-LIGHT**     | Curriculum #341 · ops kill-switch board #360 · agents useful/ready #375                                                                                                     | deepen only            | #341 #360 #375         |
| identity sub-account money       | **OPEN** | **HUMAN M5 shehzad002**  | money graph                                                                                                                                                                 | M5                     | —                      |

Status vocabulary: `OPEN` | `WIP` | `DONE` | `CUT` (§13)

---

## Locked Nitro decisions (do not reopen)

1. Protocol = deploy + audit package
2. All trade mountains (HARD human / LIGHT agent)
3. Card required (sandbox OK)
4. Phase 5 included
5. #289 claimed — **DONE**

---

## Open campaign / adjacent PRs

_Live re-derive required every session. Snapshot at last scoreboard edit:_

| PR   | Program                | Status                                            |
| ---- | ---------------------- | ------------------------------------------------- |
| #346 | H-PAY M1 shehzad       | **MERGED 2026-08-06** — board-file conflicts only |
| #350 | Denon copy-spec docs   | OPEN — do not steal                               |
| #382 | ADMIN-0 / FE scorecard | OPEN docs — avoid dual-edit residual-register     |

---

## Tracker demotion

Generated `docs/TRACKER.md` may lag campaign craft. **Scoreboard + NEXT** win for campaign sequencing; **features.mjs** wins for ownership / free / human lock. On Done/Cut/claim/handoff, update tracker the same ship (mountain events — see COORDINATION-TRUTH-LAYERS).

---

## Finish gate

- **AGENT-COMPLETE:** every **agent-owned** row `DONE`/`CUT` — **met** (ws live futures positions §13 → M3)
- **BOARD-COMPLETE:** every row including human M1–M7 — **not met**
- Remaining work: babysit human PRs · optional craft register · never steal M1–M7
