# TRK-mining.pool — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `mining.pool`  
**Title:** Stratum share protocol, PPLNS payouts  
**Module / phase:** `mining-pool` · phase **5**  
**Status on tip:** `ready` · **owner:** none  
**Depends on:** `token.emissions`  
**Tip freeze:** `origin/main` @ `56696496` (re-derive before implement)  
**Pack type:** research only — greenfield service; no invent hashpower metrics; no dual-edit protocol money without claim.

---

## 1 · What “done” means (plain language)

1. A **pool** accepts miner shares under a published Stratum (or successor) protocol.
2. Payouts follow a **published** scheme (title: PPLNS) with checkable accounting — not operator-hand-waved bonuses.
3. Emissions / reward sourcing respects `token.emissions` law — pool does not mint fantasy IFC.
4. Miners can verify share acceptance and unpaid balance without trusting a forged dashboard number.
5. No balances held outside ledger when rewards are platform-money.

---

## 2 · Current code state (tip)

### 2.1 What exists

| Area                   | Reality on tip                                                 |
| ---------------------- | -------------------------------------------------------------- |
| `services/svc-mining*` | **Absent** — no mining-pool service directory                  |
| Tracker row            | `ready`, depends on `token.emissions`                          |
| Related pools metaphor | `protocol.amm` ConstantProductPool is **DEX**, not hash mining |
| Bank yield             | `bank.earn` flexible/fixed yield — **not** Stratum             |
| Academy                | tournament “prize pools” — **not** this row                    |

### 2.2 Adjacent protocol / token facts (do not conflate)

- Solidity / anvil path proves some contracts compile; AMM pool bugs are **protocol** residual (Shehzad hard board adjacency).
- Mining-pool product is **phase 5** greenfield: stratum wire + share DB + PPLNS + payout rail.

### 2.3 Honesty

Calling any existing “pool” UI or AMM a mining pool is a **title lie**. Residual starts at zero service.

---

## 3 · Doctrine constraints

| Law          | Implication                                                        |
| ------------ | ------------------------------------------------------------------ |
| Money        | Payouts via ledger recipes if platform-money; no `number` balances |
| Emissions    | Depends on `token.emissions` — do not invent emission schedule     |
| No dual-edit | Protocol plane / Shehzad M* if paths intersect — babysit implement |
| NO-FLEET     | Dashboard proofs need real fleet; do not fake hashrate             |

---

## 4 · DoD sketch (checkable — staged)

### Slice A — protocol + share accept

- [ ] Stratum (or documented subset) accept share with reject reasons
- [ ] Share difficulty / validity tests without live miners (fixtures)

### Slice B — PPLNS accounting

- [ ] Window definition published
- [ ] Deterministic unpaid balance from share log
- [ ] Operator cannot silently rewrite history without audit row

### Slice C — payout

- [ ] Ledger (or on-chain) payout recipe
- [ ] Partial payout / dust policy documented

### Tracker `done` bar

Title’s Stratum + PPLNS true in a real env with non-invented emissions link.

---

## 5 · Open questions

1. Custodial pool vs protocol-native (which plane)?
2. Which chain/work algorithm first?
3. Is this blocked on mainnet validator schedule (Shehzad Tier D)?

---

## 6 · Estimated size

| Slice                   | Size  |
| ----------------------- | ----- |
| Share accept + fixtures | **M** |
| Full PPLNS + payout     | **L** |

---

## 7 · Related docs / code

- Tracker `tooling/tracker/features.mjs` `mining.pool`
- Long-form twin: [TRK-mining.pool.md](./TRK-mining.pool.md)
- Do **not** cite AMM pools as progress on this row

---

## 8 · Explicit non-goals

- No inventing hashrate or unpaid balances for demo.
- No renaming bank.earn or academy pools into this feature.
- No implement without emissions dependency honesty.

---

## 9 · Dependency: `token.emissions`

Without a honest emissions schedule, PPLNS payouts invent reward. Before pool craft:

1. Confirm `token.emissions` status on tip (`features.mjs` + any svc-token docs).
2. Document which asset is mined vs IFC reward vs external chain work.
3. Refuse “demo hashrate” dashboards under NO-FLEET.

## 10 · First PR shape (when free)

| PR  | Scope                                                  | Out                  |
| --- | ------------------------------------------------------ | -------------------- |
| 1   | Share schema + accept/reject pure functions + fixtures | No payout            |
| 2   | PPLNS window math + property tests                     | No HTTP public       |
| 3   | Ledger recipe + operator freeze                        | No invent balance UI |

Path-disjoint from Denon matching (#433) and pay M1 (#346).
