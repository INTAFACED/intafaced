# TRK-market.vendors — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `market.vendors`  
**Title:** Vendor lifecycle — apply, vet, list, stake-gated slots  
**Module / phase:** `market` · phase **5** · plane **F**  
**Status on tip:** **`done`** (Stages 1–3 on main — #1109 / #1115 / #1126). Re-derive tracker before claiming otherwise.  
**Depends on:** `token.staking` (**done**)  
**Service:** `services/svc-market` **exists** — scopes `market:read` / `market:write` / `market:ops` real; edge `/api/market`.  
**Tip freeze:** re-derive `origin/main` before any residual work.  
**Pack type:** research **archive** for shipped vendors law. Do **not** re-build Stages 1–3. Commerce money is `market.commerce` (separate pack / open PR).

---

## 1 · What “done” means (plain language)

1. A user can **apply** to be a vendor, ops can **vet**, and approved vendors can **list** within **stake-gated slots** enforced by live svc-token tier `vendorSlots` (fail closed), not a checkbox.
2. Slot capacity cannot be oversold under concurrency (vendor row `FOR UPDATE` + count + insert).
3. No commerce money movement in this mountain alone — that is `market.commerce`; vendors mountain stops at lifecycle + listing **eligibility**.
4. Scopes `market:read` / `market:write` / `market:ops` are real (not stubs).
5. Suspended / under-staked vendors cannot present as listed (eligibility **computed**, no `is_listed`).

---

## 2 · Current code state (tip — falsified 2026-08-09)

### 2.1 Service **shipped** — not greenfield

| Fact            | Tip                                                                             |
| --------------- | ------------------------------------------------------------------------------- |
| `svc-market`    | **Exists** — `services/svc-market` (vendors + slots + public list)              |
| Config module   | `packages/config` — `market` → `svc-market`, fiat, phase 5, **custodial: true** |
| Auth scopes     | `market:read` / `market:write` issued on session; `market:ops` withheld (staff) |
| Edge            | `/api/market` in svc-edge UPSTREAMS (kill-switchable)                           |
| Vendor schema   | `market.vendors` + `market.vendor_status_events` + `market.vendor_slots`        |
| Apply / vet API | tRPC `applyAsVendor` / `vet` / `history` / `mine` / `listApplications`          |
| market.commerce | Separate mountain — listings/purchase on open PR path; see `market.commerce.md` |

### 2.2 Stake substrate (done — usable for gates)

| Piece                | Path / fact                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `token.staking`      | **done** — stake locks + tier table                                                                                            |
| Tier `vendorSlots`   | `services/svc-token/src/economics/staking.ts` — Base **0**, Initiate **1**, Operator **3**, Architect **10**, Sovereign **50** |
| Monotonic tiers test | `economics.test.ts` asserts vendorSlots non-decreasing across tiers                                                            |
| `stakeOf`            | Available for fail-closed gate once market service calls token (via contracts/events — **not** SQL into token schema)          |

**Honest residual:** stake **data** exists; **no consumer** applies it to vendor slots yet.

### 2.3 Adjacent surfaces (do not overload)

| Surface       | Relation                                                                  |
| ------------- | ------------------------------------------------------------------------- |
| Commerce      | Purchases, subscriptions, house commission = `market.commerce`            |
| P2P merchants | Different programme (`p2p.merchants`) — badges/limits, not this lifecycle |
| Pay           | `svc-pay` explicitly excludes commerce plugins as separate features       |
| Admin         | Vendor vet UI may eventually sit on ops.admin / vendor admin — SoT TBD    |

---

## 3 · Doctrine constraints

| Law            | Implication                                          |
| -------------- | ---------------------------------------------------- |
| §8.7 market    | Vendor model, stake-gated slots                      |
| Stake truth    | `token.stakeOf` / tier table — fail closed           |
| §0.6           | No vendor balances in market service                 |
| §2             | No SQL into token or identity tables from market     |
| Commerce split | Purchases/commissions = market.commerce only         |
| Custodial flag | Config marks market custodial — design carefully     |
| Money          | Decimal strings / scaled bigint if any money appears |

---

## 4 · Dependency honesty

- **`token.staking` done** — gate substrate ready; market must not invent parallel stake numbers.
- **`market.commerce` blocked** on this mountain for honest product sequencing.
- **Not Shehzad M1–M7** — Fiat Plane market; free residual for research and later service craft under Class matrix (Class M when money lands in commerce, not necessarily vendors-only).

---

## 5 · DoD sketch (checkable — staged)

### Stage 1 — apply + vet + schema

- [ ] `svc-market` skeleton + migrations (vendors table + state machine).
- [ ] Apply (self) + vet (operator scope) APIs; no public list yet.
- [ ] Scopes unstubbed when service boots.

### Stage 2 — stake-gated slots

- [ ] Slot claim under lock; threshold / slot count from stake tier (`vendorSlots`).
- [ ] Release on unstake / offence / suspension.
- [ ] Concurrent claims cannot oversell slots (serializable proof test).

### Stage 3 — list eligibility

- [ ] Public vendor profile read for eligible vendors.
- [ ] Feeds `market.commerce` listing create — refuse if not listed/eligible.

**Tracker `done`:** apply→vet→slot→list eligibility without commerce money settlement.

---

## 6 · Gaps (named)

1. Entire `svc-market` tree.
2. Vendor state machine + ops vet product law (human only vs automated KYC hooks).
3. Wire from stake tier to slot capacity (events vs query contract).
4. Auth scope unstub.
5. Admin vet surface SoT.

---

## 7 · Risks

| Risk                               | Why it hurts                     |
| ---------------------------------- | -------------------------------- |
| Checkbox “vendor” without stake    | Title lie; free marketplace spam |
| Oversell slots under race          | Capacity honesty fail            |
| Commerce without vendors lifecycle | Orphan listings / refund chaos   |
| Holding vendor deposit in market   | §0.6 dual-book failure           |
| SQL into token schema              | §2 doctrine fail                 |

---

## 8 · Estimated size

| Slice                           | Size  | Notes               |
| ------------------------------- | ----- | ------------------- |
| svc-market skeleton + apply/vet | **M** | New service; one PR |
| Stake slots + concurrency tests | **M** | Contracts to token  |
| List eligibility + public read  | **S** | After slots         |
| Full program + admin vet UX     | **L** | Multi-PR            |

**First implement PR:** **M** — new service skeleton + apply/vet only (one service per PR law). No commerce money.  
**Human blockers:** product law for vet criteria; stake threshold schedule if not 1:1 with tier table; not blocked by Shehzad.

---

## 9 · Related docs / code

- Doctrine §8.7
- `services/svc-token/src/economics/staking.ts` (`vendorSlots`)
- `packages/auth` market scopes stub
- `packages/config` market module
- Downstream: `docs/ops/trk/market.commerce.md`
- Sister long-form: `TRK-market.vendors.md`

---

## 10 · Explicit non-goals for this pack

- No commerce settlement / house commission under this mountain.
- No invent stake amounts or parallel stakeOf.
- No features.mjs `done`.
- No building p2p.merchants under this id.
- No Class M money paths until commerce design is explicit (separate pack).
