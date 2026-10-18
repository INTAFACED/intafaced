# TRK-trade.forex — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `trade.forex`  
**Title:** Fiat pairs on the same engine  
**Module / phase:** `trade` · phase 2 · plane F  
**Status on tip:** ready (instrument/hours done; product listing not) · **owner:** none  
**Depends on:** `trade.spot` (done), `pay.rails` (done as adapter — not full fiat settlement story)  
**Requires:** `services/svc-trade` + fiat settlement rails honesty  
**Tip freeze:** `origin/main` @ `04f9b1f2` (re-derive before implement)  
**Pack type:** research only — no implement swarm; no money invention; **no** `features.mjs` edit from this pack.

---

## 1 · What “done” means (plain language)

1. Users can trade **fiat pairs** (e.g. EUR/USD) on the **same spot engine** as crypto with correct schedules, pips, and refuse-when-closed behavior.
2. **Fiat settlement** is real (pay rails / banking path) — not a crypto ledger balance labeled “USD” without redeemability story.
3. Weekend/holiday closes take **no hold** and write **no intent** (already proven for hours machinery).
4. Production listing is intentional; seed rows in migrations are not “go-live forex” by themselves.
5. No money-as-number; pip math stays decimal/scaled bigint.

---

## 2 · Current code state (tip)

### 2.1 Engine readiness vs product readiness

| Piece                    | Tip                                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------- |
| Instrument model         | `asset_class` crypto/commodity/forex; schedules; pip_size — migrations + `packages/contracts` instruments |
| Seed forex rows          | EUR/USD, GBP/USD, etc. in trade migrations / instrument helpers                                           |
| assertMarketOpen         | Order-create refuses `trade.market_closed` before hold when venue closed                                  |
| Schedule fail-safe       | Unrecognised schedule refuses (not throw)                                                                 |
| CME/globex + Chicago DST | Covered in hours tests                                                                                    |
| Production listing       | Tracker: **no forex market listed in production** as product                                              |
| Settlement               | **Still missing** honest fiat settlement rails for redeemable fiat PnL                                    |

`pay.rails` is tracker-done for **adapter + live crypto path**, not “all fiat banking complete.” Forex product needs an explicit settlement story (stablecoin-settled FX vs true fiat rails) — product law.

---

## 3 · Doctrine constraints

| Law                | Implication                                    |
| ------------------ | ---------------------------------------------- |
| §5.2               | Forex = same engine, kind spot with fiat quote |
| Hours              | Closed venue must not take funds               |
| §0.6               | Settlement via ledger + pay recipes            |
| Class M            | Money path changes need audit                  |
| pay.rails residual | Live crypto ≠ complete fiat omnibus            |

---

## 4 · DoD sketch (checkable — staged)

### Stage 1 — settlement law (product)

- [ ] Decide stablecoin-margined FX vs fiat omnibus vs hybrid
- [ ] Map to pay + bank rails honestly

### Stage 2 — list markets in non-prod

- [ ] Enable forex instruments under flag; hours e2e already green
- [ ] Matching + fees config

### Stage 3 — production

- [ ] Settlement proven; jurisdiction gates; kill switches

**Tracker `done`:** listed + settleable + hours — not seed SQL alone.

---

## 5 · Open questions

1. Settlement asset for EUR/USD PnL — product/Denon?
2. Which pairs at launch?
3. Retail KYC tier required?

---

## 6 · Estimated size

| Slice                      | Size       | Notes                |
| -------------------------- | ---------- | -------------------- |
| Settlement design          | **S** docs | Blocks code honesty  |
| Flag-gated listing + tests | **M**      | After settlement law |
| Full fiat rails            | **L–XL**   | pay/bank adjacency   |

**First implement PR:** **blocked on settlement product law**. Optional S: docs decision record only.

**Human blockers:** Fiat settlement law; pay/bank rails; Not blocked.

---

## 7 · Related docs / code

- `packages/contracts/src/instruments.ts`
- svc-trade multi-asset migration + hours tests
- pay.rails tracker note
- tracker trade.forex note

---

## 8 · Explicit non-goals for this pack

- No production claim from seed rows alone.
- No invent fiat balances.
- No features.mjs done.
