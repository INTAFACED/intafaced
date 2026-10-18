# TRK-market.vendors — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `market.vendors`  
**Title:** Vendor lifecycle — apply, vet, list, stake-gated slots  
**Module / phase:** `market` · phase 5 · plane F  
**Status on tip:** ready · **owner:** none (Denon product direction)  
**Depends on:** `token.staking` (done)  
**Requires:** future `svc-market` — **not built**; scopes stubbed  
**Tip freeze:** `origin/main` @ `04f9b1f2` (re-derive before implement)  
**Pack type:** research only — no implement swarm; no money invention; **no** `features.mjs` edit from this pack.

---

## 1 · What “done” means (plain language)

1. A user can **apply** to be a vendor, ops can **vet**, and approved vendors can **list** within **stake-gated slots** enforced by real `token.stakeOf` (fail closed), not a checkbox.
2. Slot capacity cannot be oversold under concurrency (serializable / lock pattern as academy seats).
3. No commerce money movement in this mountain alone — that is `market.commerce`; vendors mountain stops at lifecycle + listing eligibility.
4. Scopes `market:read` / `market:write` become real when service exists (today stub comments in auth package).

---

## 2 · Current code state (tip)

### 2.1 Service missing

| Fact            | Tip                                                                     |
| --------------- | ----------------------------------------------------------------------- |
| `svc-market`    | **Not in services/**                                                    |
| config module   | `packages/config` declares market module → svc-market custodial phase 5 |
| auth scopes     | `market:read` / `market:write`: **'svc-market not built'**              |
| token.staking   | **done** — stakeOf usable for gates                                     |
| market.commerce | depends on this row; also free                                          |

Greenfield lifecycle service.

---

## 3 · Doctrine constraints

| Law            | Implication                             |
| -------------- | --------------------------------------- |
| §8.7 market    | Vendor model, stake-gated slots         |
| Stake truth    | token.stakeOf fail closed               |
| §0.6           | No vendor balances in market service    |
| Commerce split | Purchases/commissions = market.commerce |

---

## 4 · DoD sketch (checkable — staged)

### Stage 1 — apply + vet + schema

- [ ] vendors table + state machine + operator vet API
- [ ] No public list yet

### Stage 2 — stake-gated slots

- [ ] slot claim under lock; stake threshold from config
- [ ] release on unstake / offence

### Stage 3 — list eligibility

- [ ] public vendor profile read; feeds commerce later

**Tracker `done`:** apply→vet→slot→list eligibility without commerce money.

---

## 5 · Open questions

1. Stake threshold schedule?
2. Vet is human ops only or automated checks?
3. One vendor org vs per-user?

---

## 6 · Estimated size

| Slice                           | Size  | Notes       |
| ------------------------------- | ----- | ----------- |
| svc-market skeleton + apply/vet | **M** | New service |
| Stake slots                     | **M** |             |
| Full                            | **L** |             |

**First implement PR:** **M** new service skeleton + apply/vet only (one service per PR law).

**Human blockers:** svc-market; Product law; Not blocked.

---

## 7 · Related docs / code

- Doctrine §8.7
- `token.staking` / stakeOf
- `packages/auth` market scopes stub
- `market.commerce` dependent row

---

## 8 · Explicit non-goals for this pack

- No commerce settlement in this mountain.
- No invent stake.
- No features.mjs done.
