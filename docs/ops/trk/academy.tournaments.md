# TRK-academy.tournaments — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `academy.tournaments`  
**Title:** Seasonal ladders, IFC prize pools  
**Module / phase:** `academy` · phase **5**  
**Status on tip:** `ready` · **owner:** none  
**Depends on:** `academy.lobbies` (**done**) · `trade.spot` (**done**)  
**Tip freeze:** `origin/main` @ `083ef879` (re-derive before implement)  
**Pack type:** research only — no implement swarm; no money invention; no dual-edit Denon open money PRs; no `features.mjs` edit.

---

## 1 · What “done” means (plain language)

1. Seasonal tournament **ladders** with clear rules, seasons, and standings.
2. **IFC prize pools** fund and pay via **ledger recipes** — academy never holds prize balances.
3. Feature flag gates the product honestly.
4. Paper vs live tournament modes are explicit.
5. Results auditable; no silent re-rank after prizes without clawback law.

---

## 2 · Current code state (tip)

### 2.1 Presence / residual

| Area                      | Reality                                               |
| ------------------------- | ----------------------------------------------------- |
| Config flag               | `academy.tournament` (re-verify modules)              |
| Tournament ladder product | **Not complete** as seasonal ladders + prizes         |
| Lobbies                   | Done — social venue, not prize engine                 |
| Trade.spot                | Done — possible performance source; isolate carefully |

### 2.2 Money posture

| Area                  | Reality                                       |
| --------------------- | --------------------------------------------- |
| Prize recipes         | Re-grep ledger-client at implement            |
| Academy ledger client | **None** today — prizes need careful boundary |

`academy-service` defers value-moving features; tournaments are Class M.

---

## 3 · Doctrine constraints

| Law           | Implication                                  |
| ------------- | -------------------------------------------- |
| §0.6          | Prize escrow/payout only via recipes         |
| Class M       | Self-audit + adversarial on prize automation |
| Money types   | Decimal strings / bigint                     |
| Fail closed   | Incomplete season → no auto-pay              |
| Brand         | Tournament copy vendor-clean                 |
| No double-pay | Coordinate affiliates/ambassadors            |
| No dual-edit  | Open money PRs                               |

---

## 4 · DoD sketch (checkable — staged)

### Stage 1 — ladder without money

- [ ] Season/ladder schema + standings API.
- [ ] Rules doc + anti-cheat basics.
- [ ] Flag gate.

### Stage 2 — prize pool Class M

- [ ] Fund pool recipe; payout recipe; idempotent settle.
- [ ] Freeze/clawback law.
- [ ] Operator visibility.

### Stage 3 — seasonal ops

- [ ] Calendar; i18n; shell UX.

### Tracker `done` bar

Flip only when seasonal ladder **and** prize path (or product-cut prizes) match title.

---

## 5 · Open questions

1. Paper-only v1 vs live PnL tournaments?
2. Prize funding source?
3. Ranking metric?
4. Tax/reporting?

---

## 6 · Gaps (named)

1. No ladder product.
2. No prize recipes wired.
3. Academy non-custodial — money boundary design open.
4. Anti-cheat residual.
5. Shell UX residual.

---

## 7 · Risks

| Risk                                    | Why it hurts        |
| --------------------------------------- | ------------------- |
| Invent prize balances in academy tables | Dual book           |
| Live tournament without isolation       | Real loss incidents |
| Re-rank after pay                       | Trust/legal         |
| Double-pay with ambassadors             | Margin leak         |

---

## 8 · Estimated size

| Slice                 | Size          |
| --------------------- | ------------- |
| Ladder only           | **M**         |
| Prize automation      | **L** Class M |
| Full seasonal product | **L–XL**      |

**First implement PR (when free):** **M** — ladder without money; prizes separate Class M PR.

---

## 9 · Related docs / code

- `services/svc-academy` (lobbies; non-custodial)
- `packages/ledger-client`
- `academy.ambassadors` (collision)
- Config `academy.tournament`

---

## 10 · Explicit non-goals for this pack

- No inventing prize balances.
- No live high-leverage tournament without product law.
- No `features.mjs` edit.
