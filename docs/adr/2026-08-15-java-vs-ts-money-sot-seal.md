# ADR: Java vs TypeScript money source of truth — sealed forever

**Status:** **Accepted — 2026-08-15.** Language seal only. Does not re-open D-S-17.
**Decision owner:** repo owner. **Written by:** Denon.
**Board:** `DENON-HARD-PARALLEL-BOARD-2026-08-09.md` (removed) **D26-P4-07**.
**Depends on (unchanged):** [`2026-08-02-adopt-vendored-product-keep-our-ledger.md`](2026-08-02-adopt-vendored-product-keep-our-ledger.md) (“Yes for the product. No for the book.”) · [`2026-08-04-java-dual-book-residual.md`](2026-08-04-java-dual-book-residual.md) (D-S-17 residual grades, jars, scans).
**Not this ADR:** the door-by-door inventory — sibling **D26-P2-02** owns that map. Do not treat this file as that map.

---

## The decision

> **Money source of truth is TypeScript forever: `packages/ledger-client` (posted by `svc-ledger`). Java must not grow a second book. Vendor UI and wallet RPC may remain as shell / chain RPC. Java money modules that once wrote `member_wallet` stay frozen.**

This is settled. Agents implement adapters and residual D-S-17 work; they do not pick a new book.

---

## Forever split (the seal)

### 1 · The only book — TypeScript, forever

`packages/ledger-client` is the only place balances live. Decimal strings on the wire, scaled bigint in memory. Doctrine §0.6. `DIRECTION` §4 Option B. No Java table, no Java mutator, no second reconcile.

### 2 · Java that may remain — shell and RPC, not a book

These may stay in-tree as product **shape**, not as money truth:

| Stay                 | Path                                                                        | Role forever                                                                                                                                                                 |
| -------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trader shell         | `vendor/upstream-exchange/05_Web_Front`                                     | Sole product UI (Vue). Screens call our services; they do not own balances.                                                                                                  |
| Staff console        | `vendor/upstream-exchange/04_Web_Admin`                                     | Operator workflows. Same rule.                                                                                                                                               |
| Non-money Java shape | `00_framework` chat / cloud / job (and other modules with no value surface) | Workflow / ops shape only.                                                                                                                                                   |
| Wallet RPC           | `vendor/upstream-exchange/01_wallet_rpc`                                    | Chain custody **RPC** after owner security review and Class X for real value. Keys and sends are not a ledger. A daemon that moves coin still posts through `ledger-client`. |

**ADOPT AS-IS** from the adoption ADR still holds for screens and non-balance workflows. Stop rebuilding them.

### 3 · Java that stays frozen — must not grow a second book

| Frozen                                                                                                                                              | Why                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `member_wallet` / `MemberWallet*` / the four DAO mutators                                                                                           | The second book. Read-only projection at most; never a write SoT.                                                                                                        |
| `00_framework` money apps (`admin`, `ucenter-api`, `otc-api`, `exchange-api`, `exchange` / `exchange-core`, `market`, `wallet`, `core` money paths) | Controllers and jobs may keep workflow **shape**. Balance writes stay disabled, deleted, or redirected to `ledger-client`. **No new Java mint, debit, freeze, or thaw.** |
| New Java money modules                                                                                                                              | Forbidden. A new Maven module that holds a balance is a doctrine break, not an adoption.                                                                                 |

**ADOPT AND ADAPT** still holds: keep the controller; redirect only the write. That queue lives in D-S-17. This seal does not change grades, jar truth, or scan evidence rules.

### 4 · What “frozen” is not

Frozen is not “the Java book is closed at runtime.” D-S-17 already forbids that sentence. Frozen means **do not grow it** and **do not treat it as SoT**. Runtime residual, jar rebuild, and door inventory stay on D-S-17 and D26-P2-02.

---

## What this ADR does not decide

- Door-by-door remaining writes (D26-P2-02).
- Wallet RPC secret handling (`OWNER-ACTIONS-WALLET-RPC-SECRETS`).
- Threat-model content (D26-P3-02).
- Whether to rebuild vendor jars in CI, or to run `01_wallet_rpc` against real value (still owner / Class X).
- Fiat matching SoT (already TypeScript `svc-matching`) or Protocol Plane / INTACHAIN (Shehzad).

---

## What would reopen this

Only an owner decision that `ledger.*` is no longer the single book. A convenience Java `balance` column, a “temporary” wallet table, or adopting a third-party ledger as SoT is a reopen — refuse it and cite this file.

---

## Leverage

Phase A **IN**: adoption ADR + D-S-17 residual ADR + existing `vendor-java-money-scan` / `dual-book-door-scan`. No new book, no new SPA, no Maven change in this seal.
