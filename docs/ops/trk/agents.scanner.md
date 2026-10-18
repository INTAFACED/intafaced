# TRK-agents.scanner — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `agents.scanner`  
**Title:** Market Scanner — ranked signals by tier  
**Module / phase:** `agents` · phase **5**  
**Status on tip:** `ready` · **owner:** none  
**Depends on:** `agents.gateway` (**done**) · `trade.spot` (**done**)  
**Tip freeze:** `origin/main` @ `083ef879` (re-derive before implement)  
**Pack type:** research only — no invent prices/pay rates; no ledger posts from agents; no `features.mjs` edit.

---

## 1 · What “done” means (plain language)

1. Scanner agent runs with task `scanner.rank`.
2. Signals are **ranked by tier** honestly — no invent prices or fabricated market data.
3. Grounded on allowlisted market data tools (spot book/ticker/etc.) with typed refusals when data missing.
4. Guardrails bound tools; no order placement from scanner unless product law explicitly adds it later (default: read-only).
5. Brand-safe signal copy.

---

## 2 · Current code state (tip)

### Shared gateway spine (`agents.gateway` **done**)

| Area       | Path / fact                                                           |
| ---------- | --------------------------------------------------------------------- |
| Service    | `services/svc-agents`                                                 |
| Routing    | `src/gateway/routing.ts` — task → provider alias + price + capability |
| Guardrails | `src/fleet/guardrails.ts` (+ tests)                                   |
| Brand copy | `src/copy.ts` + `copy.test.ts` ban third-party names                  |
| Metering   | `src/metering/` — rates travel with route (decimal strings)           |
| Providers  | Model-agnostic; aliases never vendor names in user copy               |
| Readiness  | `readiness.ts` / `useful-path.ts` prove mock runnable paths           |

**Law:** Routing row ≠ full product. Agents name a **task**, never a model. Agents never `ledger.post`.

### Scanner-specific

| Area                       | Reality                                      |
| -------------------------- | -------------------------------------------- |
| Task                       | `scanner.rank` in default routing            |
| Guardrail tests            | Reference `scanner.rank` in guardrails tests |
| Full ranked-signal product | **Residual**                                 |
| Price honesty              | Must use trade/public data — never invent    |
| Tier gating                | Product law residual                         |

---

## 3 · Doctrine constraints

| Law                  | Implication                                |
| -------------------- | ------------------------------------------ |
| No fabricated prices | Refuse > invent (same spirit as dex quote) |
| §0.7 brand           | No vendor names in signal copy             |
| §0.6                 | No ledger posts                            |
| Guardrails           | Default read-only tools                    |
| No dual-edit         | Open trade/agents PRs                      |

---

## 4 · DoD sketch (checkable — staged)

### Stage 1 — rank on fixtures

- [ ] Task + tests with fixture market data.
- [ ] Explicit empty/unavailable signals.
- [ ] Copy catalogue.

### Stage 2 — live data tools

- [ ] Tools to spot public endpoints / indexer as product allows.
- [ ] Max-age / stale handling.
- [ ] Tier-gated signal depth.

### Stage 3 — product surface

- [ ] Shell scanner UX; rate limits; metering.

### Tracker `done` bar

Flip only when ranked signals use real allowlisted data in env — mock rank alone is not done.

---

## 5 · Open questions

1. ~~Signal types v1~~ — **closed by D26-P0-11** [`docs/adr/2026-08-12-scanner-signal-inputs-law.md`](../../adr/2026-08-12-scanner-signal-inputs-law.md): v1 ranks `abs_change_x_log_volume` on `last` / `volume24h` / `change24hBps` only; refuse when missing.
2. Can scanner ever place orders?
3. Tier map (rank perks)?
4. Latency SLO?

---

## 6 · Gaps (named)

1. No production signal pipeline.
2. No tier product matrix.
3. Shell residual.
4. Stale-data policy residual.
5. Correlation with dex quote residual.

---

## 7 · Risks

| Risk                    | Why it hurts              |
| ----------------------- | ------------------------- |
| Invent prices           | Trading harm / doctrine   |
| Auto-trade from scanner | Unexpected money movement |
| Vendor names            | Brand gate                |
| Stale as live           | Bad decisions             |

---

## 8 · Estimated size

| Slice                 | Size    |
| --------------------- | ------- |
| Fixture rank path     | **S–M** |
| Live grounded product | **M–L** |

**First implement PR (when free):** **S–M** — fixture rank + refuse-on-missing-data tests.

---

## 9 · Related docs / code

- `gateway/routing.ts` `scanner.rank`
- `fleet/guardrails.ts`
- `trade.spot` / public REST
- `dex.quote-router` honesty cousin

---

## 10 · Explicit non-goals for this pack

- No inventing prices.
- No silent auto-trade.
- No `features.mjs` edit.
