# TRK-market.commerce — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `market.commerce`  
**Title:** Listings, subscriptions, purchases, house commission  
**Module / phase:** `market` · phase 5 · plane **F**  
**Status on tip (re-derive):** vendors **`done`**; commerce often **`wip`** while C1+C2 land (e.g. PR #1189).  
**Depends on:** `market.vendors` — **done** on main (Stages 1–3).  
**Service:** `services/svc-market` **exists**. Do **not** invent a second service.  
**Tip freeze:** re-derive `origin/main` before implement.  
**Pack type:** research + DoD. Fiat Plane marketplace — **not** Shehzad M1–M7. Money paths **Class M**.  
**Falsified 2026-08-09:** earlier pack claimed “no svc-market / vendors not built” — **false on tip**.

---

## 1 · What “done” means (plain language)

1. A vetted vendor’s **listing** can be sold as one-time purchase (subscription = Stage 3 residual until product law).
2. Settlement is **ledger recipes** with a disclosed **house commission**.
3. Scopes `market:read` / `market:write` authorize market APIs (real on tip).
4. No balances in `svc-market`; no money-as-`number`; no “success” without a posted recipe.
5. Fail closed: vendor suspended, stake dropped, commission config missing, listing without live slot → refuse sale.

---

## 2 · Current code state (tip — falsified 2026-08-09)

### 2.1 Service exists; commerce C1+C2 in flight / land via PR

| Fact                   | Tip                                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------- |
| `services/svc-market/` | **Exists** (vendors Stages 1–3 on main)                                                               |
| Config                 | `market` → `svc-market`, fiat, phase 5, custodial: true                                               |
| Auth scopes            | `market:read` / `market:write` real on session; `market:ops` staff                                    |
| Edge                   | `/api/market` kill-switchable                                                                         |
| Listings schema        | On commerce branch / after merge: `market.listings` + `market.purchases` (`0002_market_commerce.sql`) |
| Commission recipes     | `packages/ledger-client/src/recipes/market.ts` — `marketPurchase` (C1+C2)                             |

### 2.2 Upstream vendors (hard dep — **met**)

| Piece                    | Tip                                                                            |
| ------------------------ | ------------------------------------------------------------------------------ |
| `market.vendors`         | **done** — apply → vet → stake slots → public eligibility                      |
| Stake-gated vendor slots | Live `vendorSlots` from svc-token `/internal/stake/:userId`                    |
| Vendor lifecycle code    | `services/svc-market/src/vendor-service.ts` + slot-access + listingEligibility |

Create listing gates on **approved + claimSlot** (not already-listed). Catalogue/purchase re-read eligibility + live slot `ref = listingId`.

### 2.3 Adjacent money surfaces (do not overload)

| Surface              | Relation                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `svc-pay`            | Explicitly excludes commerce plugins / subscriptions as **separate** tracker features (`services/svc-pay/src/index.ts`, README) |
| `svc-p2p`            | P2P merchants are a different mountain (`p2p.merchants`)                                                                        |
| `ops.admin` listings | Staff market enable — not vendor marketplace catalog                                                                            |
| Pay commerce plugins | Out of scope for this row’s Fiat marketplace design unless product unifies later                                                |

### 2.4 Doctrine taxonomy (product prioritisation needed)

Coverage matrix: **eight vendor categories** (bots, DeFi, compliance, payment ext., security/custody, data, advisory, partner integrations) — `INTAFACED_DEFINITIVE_BUILD.md` marketplace rows. Owner prioritises which ship first; agents do not invent taxonomy scope.

---

## 3 · Doctrine constraints

| Law           | Implication                                                                      |
| ------------- | -------------------------------------------------------------------------------- |
| §8.7          | Vendor lifecycle + listings/subs/purchases via ledger recipes + house commission |
| §0.6          | No balances in market service; recipes only                                      |
| Decimal money | Wire strings / scaled bigint                                                     |
| Stake truth   | Re-check vendor eligibility + slots on purchase if stake-gated                   |
| Scopes        | Real api_keys scopes when service exists                                         |
| Class M       | Purchase/subscription/commission = money self-audit + failure tests              |
| Events        | NATS versioned payloads in `packages/events` if cross-service                    |

---

## 4 · Order of operations (must not invert)

1. **`market.vendors`** — apply, vet, stake-gated slots, list eligibility (no commerce money).
2. **`market.commerce`** — listings + purchase recipe with commission split + tests.
3. **Subscriptions** — second PR (recurring recipe, cancel, failed renewal).

Research pack does not start code.

---

## 5 · DoD sketch (checkable — staged)

### Stage 0 — vendors green

- [x] Vendor lifecycle Stage 1–3 complete enough to attach listings (**tip**).

### Stage 1 — listing catalog (no money)

- [x] Listing schema (vendor_id, offer type, price asset, status) — **#1189 / tip after merge**.
- [x] Create/archive under `market:write`; public catalogue (public procedure); myListings under `market:read`.
- [x] Suspended vendor cannot create listings.

### Stage 2 — one-time purchase (Class M)

- [x] Ledger recipe: buyer → vendor (net) + house commission; idempotent keys — **#1189**.
- [x] Failure tests: vendor suspended, stake dropped, commission config missing, insufficient funds, double-purchase replay, listing without live slot.
- [x] No number money; no balance table in market.

### Stage 3 — subscriptions

- [ ] Period billing recipe; cancel path; past-due policy (**product law — Nitro**).
- [ ] Tests for renewal failure without silent free access.

### Stage 4 — product polish

- [ ] Premium placement if stake-gated (**ranking DIRECTION §8 — Nitro**).
- [ ] Admin/ops views — via contracts or admin BFF, not market holding funds.

**Tracker `done`:** Stage 2 minimum for title words listings/purchases/commission; subscriptions may stay residual if title split later. Mark `done` only after #1189 (or successor) is green + Class M audit on tip.

---

## 6 · Gaps (remaining after C1+C2)

1. ~~Entire `svc-market`.~~ **Closed.**
2. ~~Vendors mountain unfinished.~~ **Closed.**
3. Commission **rate value** still Nitro (`MARKET_HOUSE_COMMISSION_BPS` refuse-closed until set).
4. ~~No ledger recipes for market.~~ **Closed for one-time** (`marketPurchase`).
5. No events catalog entries for market purchases (optional).
6. Product: which of 8 categories first; **subscription legal / past-due law**; ranking law.

---

## 7 · Risks

| Risk                                     | Notes                                       |
| ---------------------------------------- | ------------------------------------------- |
| Build commerce before vendors            | Orphan listings / no stake gate             |
| Commission without recipe                | §0.6 violation                              |
| Soft-fail on missing commission config   | Must refuse                                 |
| Conflating with pay plugins              | Split tracker features by design            |
| On-chain-only listing under this Fiat id | Out of scope unless product redefines plane |
| Class M skip                             | Merge gate fail                             |

---

## 8 · Estimated size

| Slice                         | Size           | Notes                  |
| ----------------------------- | -------------- | ---------------------- |
| Research (this)               | **XS** Class N |                        |
| Vendors dep                   | **M–L**        | Separate mountain      |
| Listings schema + API         | **M**          | After vendors          |
| Purchase + commission recipes | **M** Class M  | Failure tests required |
| Subscriptions                 | **M**          | Second PR              |
| Full 8-category marketplace   | **XL**         | Program                |

**First commerce PR must include** failure tests (vendor suspended, stake dropped, commission config missing → refuse). No implement from research alone.

---

## 9 · Related docs / code

- `INTAFACED_DEFINITIVE_BUILD.md` §8.7 + vendor taxonomy rows
- `docs/ops/trk/market.vendors.md` (vendors **done**)
- `services/svc-market/README.md` — stage matrix + Class M path
- `packages/auth/src/scopes.ts` — market scopes **real**
- `services/svc-token/src/economics/staking.ts` — `vendorSlots`
- `packages/ledger-client/src/recipes/market.ts` — `marketPurchase`
- `docs/DIRECTION-2026-07-31.md` §8 — ranking / listing policy owner-only

---

## 10 · Explicit non-goals

- No invent commission bps.
- No Shehzad M1–M7 implement under market.
- No balances or custody of vendor payouts outside ledger.
- No R07/R01 stamp content.
- No pay.plugin scope creep without tracker mountain event.
