# TRK-mining.pool — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `mining.pool`  
**Title:** Stratum share protocol, PPLNS payouts  
**Module / phase:** `mining-pool` · phase 5 · plane F  
**Status on tip:** ready · **owner:** none (Denon product direction historically)  
**Depends on:** `token.emissions` (done)  
**Requires:** future mining-pool service — **none on tip**  
**Tip freeze:** `origin/main` @ `04f9b1f2` (re-derive before implement)  
**Pack type:** research only — no implement swarm; no money invention; **no** `features.mjs` edit from this pack.

---

## 1 · What “done” means (plain language)

1. Miners can connect via **Stratum** (or stated successor), submit shares, and see **live** accepted/rejected honesty — no fabricated hashrate dashboards.
2. Payouts use **PPLNS** (or published scheme) as **ledger recipes** to miner accounts — pool fee 1–3% to house per doctrine, never balances held outside ledger.
3. Solo + pooled modes if product requires; dashboards read ledger + share DB, not invent IFC.
4. Emissions mint authority remains single-minter guarantee from token.emissions — pool does not grow a second minter.
5. Kill-switch / halt mining credits when emissions or ledger frozen.

---

## 2 · Current code state (tip)

### 2.1 Greenfield product; emissions exist

| Fact                | Tip                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------- |
| Mining pool service | **None** (`svc-market`/`mining` not present)                                          |
| token.emissions     | **done** — mintEpoch + kill-switch on svc-token                                       |
| Vendored overlap    | Legacy mining order controllers exist under vendor — **quarantine**, not monorepo SoT |
| Stratum             | Not implemented in monorepo                                                           |

Depends is green for emissions; **entire pool stack is new**.

---

## 3 · Doctrine constraints

| Law                 | Implication                                               |
| ------------------- | --------------------------------------------------------- |
| § mining            | Solo + pooled, PPLNS, 1–3% house fee                      |
| §0.6                | Payouts only ledger recipes                               |
| token single-minter | Pool must not mint IFC itself                             |
| Brand               | No partner pool software names in user copy if restricted |

---

## 4 · DoD sketch (checkable — staged)

### Stage 1 — share accounting

- [ ] Share DB + accept/reject rules + tests
- [ ] No payout yet

### Stage 2 — PPLNS recipe

- [ ] ledger-client recipe + fee to house
- [ ] Idempotent window payouts

### Stage 3 — Stratum gateway

- [ ] Network protocol + auth to identity
- [ ] Live dashboard

**Tracker `done`:** shares + PPLNS payout path + stratum or explicit “API-only mining” product cut.

---

## 5 · Open questions

1. What is being mined — IFC emission epochs vs external coin?
2. Stratum required for v1 or API submit shares?
3. Fee exact bps and stake tiers?

---

## 6 · Estimated size

| Slice            | Size          | Notes           |
| ---------------- | ------------- | --------------- |
| Share accounting | **M**         |                 |
| PPLNS + ledger   | **M** Class M | Money           |
| Stratum          | **L**         | Network service |

**First implement PR:** **M** share accounting **without** money; Class M later for PPLNS.

**Human blockers:** Product law; Class M; Service.

---

## 7 · Related docs / code

- Doctrine mining section
- `services/svc-token` emissions
- VENDORED-OVERLAP mining notes

---

## 8 · Explicit non-goals for this pack

- No second minter.
- No balances outside ledger.
- No port of quarantined vendor mint jobs.
- No features.mjs done.
