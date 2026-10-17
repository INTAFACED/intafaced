# CX-8 assembled proof — Spec + Plan (B-layer)

**Date:** 2026-08-02  
**Status:** BUILD · agent residual (not P-OR re-open)  
**Denon bar link:** real-money readiness needs A (code) + **B (assembled)** + C (Human X)  
**A-layer:** #289 · #359 · #365 on main  
**This ship:** B-layer proof in **CI** (not local Docker dependency)

---

## 0 · Collision wall (PATHS_ONLY)

| Touch                                  | Never touch                           |
| -------------------------------------- | ------------------------------------- |
| `tooling/scripts/order-path-*.mjs`     | `vendor/**` Java (M7 shehzad)         |
| `.github/workflows/order-path-cx8.yml` | `vendor/**/05_Web_Front/**` (UI #367) |
| order-route docs scoreboard            | `services/svc-pay/**` (#346)          |
| optional thin seed SQL helper          | invent balances / go-live             |

---

## 1 · Spec REQs

| ID           | Requirement                                                       | Acceptance                                              |
| ------------ | ----------------------------------------------------------------- | ------------------------------------------------------- |
| **CX8-CI-1** | Health plane: trade + matching + ledger `/health` up              | CI job STRICT smoke L1 green                            |
| **CX8-CI-2** | Auth place + cancel over HTTP with **edge-signed** test principal | L2 green when stack seeded (not Bearer theater)         |
| **CX8-CI-3** | Deposit funding via ledger S2S recipes (not invent balances)      | Real `recipes.deposit` post                             |
| **CX8-CI-4** | Market listed before place                                        | SQL/listMarket seed in boot script                      |
| **CX8-CI-5** | Never invent fills; two-user fill + ledger delta when L3 on       | Path C agent-max: L3 STRICT in boot; see PROD-CLAIM doc |
| **CX8-CI-6** | Path filter: not every PR needs full matrix                       | path filter + workflow_dispatch                         |
| **CX8-CI-7** | Scoreboard honesty                                                | CEX assembled → **CI proof** or residual with why       |

---

## 2 · Architect pick

| Seam               | Options                                                                    | Pick                                         |
| ------------------ | -------------------------------------------------------------------------- | -------------------------------------------- |
| Where stack runs   | Local Docker · full platform:up · **GH Actions services + node processes** | **CI processes** (host has no Docker)        |
| Auth               | Bearer JWT · **EDGE_PRINCIPAL signed headers**                             | **Edge** (matches production mount boundary) |
| Identity for perks | Skip place · stub · **boot svc-identity**                                  | **Boot identity** (fail-closed perks)        |

---

## 3 · Plan (ships)

1. Spec/Plan this file
2. `order-path-smoke.mjs` L2 edge principal + deposit/seed helpers
3. `order-path-cx8-ci-boot.mjs` — migrate, start processes, seed, run smoke STRICT
4. `.github/workflows/order-path-cx8.yml`
5. Scoreboard update

---

## 4 · Not claimed

- Human X go-live
- Seeder Mongo thumbs
- Shehzad M7 Java controller PEACE
- DEX execute product

**Not stable-for-real-money.** B-layer CI green ≠ production.
