# Scorecard LIVE — re-measure log

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Not a requirements doc.** Living map: [`FRONTEND-REMAINING-SOT-2026-08-25.md`](FRONTEND-REMAINING-SOT-2026-08-25.md). Append-only evidence. No “better” claim without a new row.

**Law:** methodology §2 — no “improved” claim without a row here.  
**Baseline:** `FRONTEND-BASELINE-SCORECARD-A0-2026-07-31.md`  
**Method:** Gates 4/11/12/18/19 pass|fail; other dims 0–3. Prefer non-implementer eyes.

## How to add a row

1. Boot `:8090` · Orca open
2. Score `/exchange`, MoneyIndex, Withdraw (and `/dex` if plane changed)
3. Append table below with tip SHA + date + agent role (implementer|certifier)
4. Attach Orca paths under `docs/styleboard/shots/scorecard-<date>/`

---

## Row: A0 baseline (historical)

See A0 file. **Stale relative to tip after B craft.**

---

## Row: PROOF-1 (2026-08-02) — first post–B-batch re-score

| Field   | Value                                                     |
| ------- | --------------------------------------------------------- |
| Date    | 2026-08-02                                                |
| Tip SHA | `5f2f8fe` (origin/main at measure; AOS #362)              |
| Role    | implementer (PROOF-1 go sequence)                         |
| Eyes    | Orca embedded browser + PNG pack                          |
| Shell   | http://127.0.0.1:8090 · Node 18 ui:boot · root/app.js 200 |

### Gate / dim scores

| Surface        | G4 Honesty | G11 Feed truth | G12 Irreversible                     | G18 Recovery | G19 Numeric | Dim1 trust/clarity | Dim6 density | Dim8 calm | Dim23 plane | Notes                                                                                                     |
| -------------- | ---------- | -------------- | ------------------------------------ | ------------ | ----------- | ------------------ | ------------ | --------- | ----------- | --------------------------------------------------------------------------------------------------------- |
| / (index)      | **pass**   | **pass**       | n/a                                  | **pass**     | **pass**    | 2                  | 1            | 2         | 2           | “Market list unavailable — not empty”; no fake tickers                                                    |
| /exchange desk | **pass**   | **pass\***     | **pass** (code+UI path)              | **pass**     | **pass**    | 2                  | **1**        | 2         | 2           | Book/fee honesty visible; chart center often pure black (empty copy low-contrast / under widget — B13 P0) |
| Login          | **pass**   | n/a            | n/a                                  | n/a          | n/a         | 2                  | 1            | 2         | 2           | P21 teal CTA; generic form craft (not desk bar)                                                           |
| MoneyIndex     | **pass†**  | n/a            | n/a                                  | n/a          | n/a†        | —                  | —            | —         | —           | Unauth → login (honest; **no fake balances**). Logged-in surface **not** re-Orca’d this run               |
| Withdraw       | **pass†**  | n/a            | **code 3** (A2 receipt+lock on main) | n/a          | **code 3**  | —                  | —            | —         | —           | Unauth → login. Receipt/lock not re-shot logged-in                                                        |

\*G11: book + fee paths correctly labeled unavailable / not free. Chart pane often shows silent black without a readable empty line in the crop — scored pass on book/ticket, **flag for B13** on chart overlay visibility.  
†Money/Withdraw: gate pass means “did not lie”; full craft dims deferred until auth session Orca (never seed fixture money as proof).

### Delta vs A0 (required)

| Area                  | A0                   | PROOF-1                                                                 | Better?                                      |
| --------------------- | -------------------- | ----------------------------------------------------------------------- | -------------------------------------------- |
| Exchange honesty copy | target 3 after #267  | **pass** — “not empty”, fee “not free”, sign-in for balances            | **Holds** Wave A; not a craft win            |
| Withdraw / G12        | 3 after A2′          | unauth redirect; code path still on tip                                 | **Holds** — not re-certified eyes-on receipt |
| Density Dim6          | not re-scored post B | **1** — large dead black chart/footer; watchlist thin when markets down | **Not better** — B2 still open               |
| P21 palette           | provisional          | teal accent on login + nav active                                       | **Holds** COLOR lock; taste open for Nitro   |

**Claim allowed:** honesty moat still true on public desk/index; **no claim** that craft/density is world-class. Density and chart empty-overlay are residual, not green.

### Orca shots

`docs/styleboard/shots/scorecard-2026-08-02/`

| File                 | Surface                                                        |
| -------------------- | -------------------------------------------------------------- |
| `01-index.png`       | Home / market list honesty                                     |
| `02-exchange.png`    | Desk: watchlist, chart void, book unavailable, ticket, blotter |
| `03-login.png`       | Auth card P21                                                  |
| `04-uc-money.png`    | Unauth → login (money gated)                                   |
| `05-uc-withdraw.png` | Unauth → login (withdraw gated)                                |

Refs: `docs/refs/proof-1/` (gap-audit · steal-lines · critique).

### Outstanding after this row

- [x] Fill first LIVE row after go
- [ ] Auth’d MoneyIndex + Withdraw Orca (fleet session; **never seed money**)
- [ ] B13: chart empty overlay contrast/z-index; density critique
- [ ] `pnpm ui:proof` hard re-run (P0.4)
- [ ] Never seed fixture money

---

## Row: _TEMPLATE (copy)_

| Field   | Value                   |
| ------- | ----------------------- |
| Date    |                         |
| Tip SHA |                         |
| Role    | implementer / certifier |
| Eyes    | Orca                    |

| Surface    | G4  | G11 | G12 | G18 | G19 | Dim1 | Dim6 | Dim8 | Dim23 | Notes |
| ---------- | --- | --- | --- | --- | --- | ---- | ---- | ---- | ----- | ----- |
| /exchange  |     |     |     |     |     |      |      |      |       |       |
| MoneyIndex |     | n/a |     |     |     |      |      |      |       |       |
| Withdraw   |     | n/a |     |     |     |      |      |      |       |       |

**Delta vs A0 (required if claiming better):**

**Orca shots:**

---

## Row note: B13 chart empty (same day as PROOF-1)

| Field | Value                                           |
| ----- | ----------------------------------------------- |
| Date  | 2026-08-02                                      |
| Tip   | feat/app-proof-scorecard + chart overlay commit |
| Role  | implementer                                     |
| Eyes  | Orca                                            |

**Change:** G11 chart empty status readable (`No market feed — chart has no live history to show`). Dim6 still **1**.  
**Shot:** `docs/styleboard/shots/b13-chart-empty-2026-08-02/02-exchange.png`  
**Refs:** `docs/refs/b13-chart-empty/`

---

## Row note: B2 density (2026-08-02)

| Field | Value                                                            |
| ----- | ---------------------------------------------------------------- |
| Tip   | feat/app-b2-density                                              |
| Eyes  | Orca                                                             |
| Dim6  | **1 → ~2** (footer gone; columns fill viewport) — not claiming 3 |

**Orca:** `docs/styleboard/shots/b2-density-2026-08-02/02-exchange.png` · exchange a11y no marketing Copyright; home still has footer.

---

## Row: post-craft tip (2026-08-02) — after B2–B5 / CMDK / shells

| Field   | Value                                                   |
| ------- | ------------------------------------------------------- |
| Date    | 2026-08-02                                              |
| Tip SHA | `26289f3` (re-derive; craft pass #381 and predecessors) |
| Role    | implementer                                             |
| Eyes    | Orca + residual (not full auth money re-score)          |

| Surface                           | G4    | G11  | G12         | Dim6    | Notes                                                                 |
| --------------------------------- | ----- | ---- | ----------- | ------- | --------------------------------------------------------------------- |
| /exchange                         | pass  | pass | pass (code) | **~2**  | Density footer gone; solid panels; fee help; ⌘K; chart empty readable |
| Money / Withdraw / Safe / Account | pass† | n/a  | code holds  | craft ↑ | Desk shells; unauth still login-gated                                 |
| Login                             | pass  | n/a  | n/a         | 1–2     | Honesty pass; marketing DNA residual B12                              |

† No fixture-seeded money. Auth Orca still open for LIVE money eyes.

**Delta vs PROOF-1:** Dim6 improved (viewport + no footer); chart empty P0 fixed; CMDK shipped. **Not** claiming world-class density 3.

**Orca packs (examples):** scorecard-2026-08-02 · b13-chart-empty · b2-density · b-cmdk · b3-safe-b9 · b4-account-glass

---

## Row: frontend finish set (2026-08-26)

| Field   | Value                                                             |
| ------- | ----------------------------------------------------------------- |
| Date    | 2026-08-26                                                        |
| Tip SHA | `feat/frontend-finish-20260826` PR tip                            |
| Role    | implementer                                                       |
| Eyes    | Orca embedded browser · exact-worktree member dist + `apps/admin` |

| Surface                     | G4   | G11  | G12  | G18  | G19  | Dim1 | Dim6 | Dim8 | Dim23 | Notes                                                                                                                               |
| --------------------------- | ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- | ----- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `/exchange/btc_usdt`        | pass | pass | pass | pass | pass | 2    | 2    | 3    | 3     | LWC 5.2.1 loads; RSI/MACD controls are armed but the crop honestly shows no indicator values while the candle feed is unavailable.  |
| Auth MoneyIndex             | pass | n/a  | n/a  | pass | pass | 3    | 2    | 3    | 3     | Identity-only proof session; ledger response is unknown, never zero.                                                                |
| Auth Withdraw               | pass | n/a  | n/a  | pass | pass | 3    | 2    | 3    | 3     | `CustodyNotBuilt`; no chain-custody control or invented balance.                                                                    |
| `/p2p` + auth `/otc`        | pass | pass | n/a  | pass | pass | 3    | 2    | 3    | 3     | One OS family; legacy `/ctc` resolves to `/p2p` in one hop; OTC labels the shared ledger book.                                      |
| Admin kill / ledger / tools | pass | n/a  | pass | pass | pass | 3    | 3    | 2    | 3     | Typed consequence phrase, immediate lock, delivery-vs-attempt receipt; missing withdrawal approval procedure is explicit and inert. |

**Delta vs post-craft tip:** Wave C is executable rather than deferred; OTC/C2C no longer mount standalone chrome; admin consequence handling and daily queues are now crop-true at 1440 and 390. No claim of live RSI/MACD values without accepted candle rows.

**Orca shots:** `.artifacts/frontend-finish-sweep-20260826/` · `.artifacts/frontend-finish-auth-money-20260826/` · `.artifacts/frontend-finish-final-20260826/` · `.artifacts/frontend-finish-admin-20260826/final/`

### Residual crop correction (2026-08-26)

| Surface                     | Gate / dim                | Evidence-backed delta                                                                                                                                |
| --------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/exchange/btc_usdt`        | G4/G11 hold · Dim1/Dim6 ↑ | 11px keyboard map renders; RSI/MACD toggles are inside the 390 crop; staged reprice uses the existing amend path and never submits from the chart.   |
| Auth MoneyIndex             | G4/G19 hold · Dim6 ↑      | Removed the false 240px mobile flex gap; ledger refusal follows search immediately and remains unknown, never zero.                                  |
| Admin kill / ledger / tools | G12/G18 ↑                 | Query responses say answered, not applied; unfreeze and module state changes require exact phrases, synchronous locks, and service-derived receipts. |

**Orca shots:** `.artifacts/frontend-residuals-20260826/`
