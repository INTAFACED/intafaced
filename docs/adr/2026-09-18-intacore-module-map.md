# ADR: S-D2 — INTACORE module map (house book vs chain book)

**Status:** **Accepted — 2026-09-18** as **spec**. Implement of P1 stays **parked**.  
**Decision owner:** Nitro. **Written by:** Grok (agents).  
**Spec id:** S-D2 (Shehzad board).  
**Does not replace:** [`2026-09-03-protocol-rails-until-intachain.md`](2026-09-03-protocol-rails-until-intachain.md) (timing) · [`2026-08-04-matching-dual-target.md`](2026-08-04-matching-dual-target.md) (D-S-06) · doctrine §16–§17.  
**Companions (spec, still not implement):** S-D3 [`2026-09-18-validator-stake-vs-stakeof.md`](2026-09-18-validator-stake-vs-stakeof.md) · S-D5 [`2026-09-18-intaevm-same-block.md`](2026-09-18-intaevm-same-block.md) · reconciler [`2026-09-18-cross-plane-reconciler.md`](2026-09-18-cross-plane-reconciler.md) · mark port [`2026-09-18-intacore-mark-port.md`](2026-09-18-intacore-mark-port.md) · shared matching rows [`2026-09-18-matching-shared-conformance.md`](2026-09-18-matching-shared-conformance.md) · index [`2026-09-18-intachain-unpark-index.md`](2026-09-18-intachain-unpark-index.md).  
**Does not start:** `services/svc-chain`, genesis, CometBFT binary, `chain.mainnet` Done.

**Ground truth on tip:** Fiat matching runs (`svc-matching` → ledger post is final). INTACORE does not exist. `SovereignVenue` is a P0 EVM contract CLOB on configured RPC/anvil — **not** INTACORE, **not** mainnet, `audited: false`.

---

## Decision

INTACHAIN, when Nitro GOs P1, is **one chain / two execution domains** (doctrine §17.1). The domains are not a second house book and not a relabel of Base.

| Domain       | What it is                                                                                                                                 | What it is not                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| **INTACORE** | Native (in-validator) financial engine: price-time CLOB, protocol margin, on-chain liquidations, Predict as a **market type** on that book | `svc-matching`, ledger recipes, `SovereignVenue.sol`, an AMM sold as our CLOB |
| **INTAEVM**  | EVM **secured by the same validators**, reading INTACORE state in the same block                                                           | Base, HyperEVM, an extra L2, “RPC points somewhere”                           |

**Fiat Plane stays the house book until that GO.** Matching, trade, bank, pay, ledger do not move onto the chain. Two planes, two authorities, two words for “final” (D-S-06).

---

## 1 · Module map (INTACORE)

Names are responsibilities. They are not a Cosmos SDK import list and not permission to add `svc-chain` today.

| Module                 | Job                                                                                                              | Reads                                                     | Writes                                              | Authority of “final”                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------- |
| **clob**               | Price-time book. Tick/lot, TIF, self-trade, STP: **same spec as Fiat** (D-S-06 shared rows). Runtime **forked**. | User smart-account session keys; INTACORE balances/margin | Resting orders, matches, cancels                    | Chain finality (one-block **target**, §20 — not a live measurement)          |
| **margin**             | Protocol IM/MM, isolated/cross as chain state                                                                    | clob positions, oracle marks **once a source exists**     | Margin accounts, liquidation candidates             | Chain finality. **Not** `packages/ledger-client`                             |
| **liquidation**        | Protocol-level liquidations against clob                                                                         | margin + marks                                            | Forced reduces on clob                              | Chain finality. House ADL/insurance stay Fiat                                |
| **predict-resolution** | Resolution stack for Predict markets (companion ADR)                                                             | Frozen outcome set + oracle/reporter                      | Resolved outcome; clob settles outcome shares       | Chain finality **after** resolution, never before listing                    |
| **staking**            | IFC as gas + validator security                                                                                  | Owner-set params when published                           | Bonds, slash **when magnitudes exist**              | Consensus. **S-D3** owns validator architecture. This map only names the job |
| **evm**                | INTAEVM: contracts see INTACORE books/positions in-consensus                                                     | INTACORE state root / module store                        | EVM state; **must not** be a second matching engine | Same block as clob. Desync is a halt, not a display bug                      |

**Not INTACORE modules** (wrong mountain if built “as chain”):

| Thing                                | Home                                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| House matching / OMS / FIX / WS L3   | `svc-matching`, `svc-trade`, `svc-execution`, `svc-fix`, `svc-ws`            |
| Custodial balances, bank, pay, cards | ledger-client + `svc-ledger` / `svc-bank` / `svc-pay`                        |
| Canonical IFC supply join            | `bridge.canonical` + `svc-bridge` — **S-D7**, not a clob module              |
| P0 AMM / lending / escrow / launch   | `svc-protocol` on **Base/anvil** until a later migrate                       |
| `SovereignVenue`                     | P0 toy/on-chain EVM book. Keep `audited: false`. Never stamp `chain.mainnet` |

---

## 2 · vs Fiat `svc-matching` / `svc-trade`

D-S-06 stands. This table is the S-D2 restatement so a chain engineer cannot “share a database” by accident.

| Layer                                       | Shared                 | Forked                                                                                           |
| ------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------ |
| Order semantics (types, TIF, tick/lot, STP) | **Yes — one spec**     | —                                                                                                |
| Price-time algebra                          | **Yes**                | —                                                                                                |
| Determinism (replay → identical book)       | **Yes, as a property** | Implementation                                                                                   |
| Engine process                              | —                      | Service vs in-validator module                                                                   |
| Journal / storage                           | —                      | Matching journal / Postgres vs chain state                                                       |
| **Finality**                                | —                      | **Ledger post** vs **chain finality**                                                            |
| **Custody**                                 | —                      | Platform holds Fiat; Protocol never holds                                                        |
| Market identity                             | —                      | **Different ids by default.** `BTC/USD` Fiat ≠ `BTC/USD` INTACORE until an owner ADR merges them |
| Liquidity                                   | —                      | **Not shared.** Unifying books is a later ADR, not a silent pool                                 |

**Match is a proposal on both planes.** Fiat: pending until ledger posts. Protocol: pending until chain finality depth. A blotter that mixes planes labels the plane per fill.

**Conformance home:** [`2026-09-18-matching-shared-conformance.md`](2026-09-18-matching-shared-conformance.md) — one spec plus Fiat pins both runtimes must pass. Do not invent a third matching package. INTACORE imports that **spec**, not `book.ts`.

---

## 3 · INTACORE ↔ INTAEVM (the desync rule)

`chain.evm` cannot be “an RPC we added.”

1. Same validator set. Same block. EVM reads INTACORE clob/margin **in that block**.
2. A contract must not be told a fill that the clob module has not finalized.
3. If module store and EVM view disagree: **refuse the EVM read / halt the node** — never pick the friendlier copy.
4. P0 contracts on Base are **not** this. Migrating them onto INTAEVM is a later program after P1 testnet. Until then the name INTAEVM is reserved.

---

## 4 · IFC, bridge, card, agents

| Job                      | Rule                                                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Gas + stake on INTACHAIN | IFC. Magnitudes owner-only (D-S-14). Do not invent slash/bond                                                           |
| Ledger IFC vs chain IFC  | One supply **only** via canonical bridge + attestations. Until `svc-bridge` exists they are **not** the same balance    |
| Ledger↔Base IFC          | Separate bounded-window posting ADR — **not** a substitute P1                                                           |
| Sovereign card           | Smart-account JIT on Protocol; issuer socket stays Class X. Same wallet **may** trade INTACORE; it does not merge books |
| Navigator                | Session keys on INTACORE under §8.2. No ledger write from Protocol agents (`custody-scan`)                              |

---

## 5 · SLO targets (not live)

Doctrine §20, copied as **targets** so nobody stamps them as measured:

- P1 CLOB throughput target: **10k orders/s** (CometBFT class) → P2 **100k+/s** (Rust core, `chain.rust-core`, parked)
- Finality target: **≤ 1 block** on INTACHAIN
- Fiat internal match target stays on `svc-matching` (< 5ms p99) and is **not** an INTACORE claim

No testnet, no measurement, no dashboard may say these numbers are achieved until they are measured on a binary labelled **not mainnet**, then mainnet.

---

## 6 · Unpark (unchanged timing law)

P1 **code** starts only when **all** are true:

1. Nitro writes **GO** on the 2026-09-03 rails ADR (or a successor).
2. **This S-D2 file exists** (it does, as of this commit).
3. Any chain binary / public RPC is labelled **not mainnet** until Stage 3 of `docs/ops/trk/chain.mainnet.md` (removed).

First engineering PR after GO: `svc-chain` skeleton + **testnet** genesis with that label (S-D4). Not a tracker `done`. Not HIP-3. Not Base Appchain.

---

## Refuse cases

| Situation                                                            | Correct answer                                |
| -------------------------------------------------------------------- | --------------------------------------------- |
| Agent adds `services/svc-chain` without Nitro GO                     | **Stop.** Parked                              |
| Base / anvil / `SovereignVenue` sold as INTACHAIN or `chain.mainnet` | **Refuse the stamp**                          |
| Fiat fill shown as chain-final, or the reverse                       | **Mislabel.** Two finalities                  |
| Market id from one plane used on the other                           | **Refuse** (D-S-06 default)                   |
| EVM view of the book newer than clob module                          | **Halt / refuse read**                        |
| Invented slash, bond, fee, haircut, throughput “we hit 10k”          | **Owner / measurement only**                  |
| HIP-3 / HyperEVM / extra L3 as INTACHAIN                             | **Banned** until a new Nitro GO               |
| Predict listed with no resolution source                             | **Do not list** (companion ADR)               |
| Second TypeScript matching engine “for the chain”                    | **No.** Spec is shared; runtime is the module |

---

## Done bar (this ADR)

1. Module responsibilities vs Fiat matching/trade are named (this file).
2. INTACORE ↔ INTAEVM same-block read is named; desync is halt, not display. Halt contract: [`2026-09-18-intaevm-same-block.md`](2026-09-18-intaevm-same-block.md).
3. Bridge / staking magnitudes / validator set remain **other rows** (S-D3 [`2026-09-18-validator-stake-vs-stakeof.md`](2026-09-18-validator-stake-vs-stakeof.md), S-D7 / reconciler [`2026-09-18-cross-plane-reconciler.md`](2026-09-18-cross-plane-reconciler.md), Class X).
4. No `svc-chain` in this commit.
5. `chain.mainnet` Stage 0 checkbox for S-D2 points here.

---

## What agents may do without asking again

- Keep shipping Fiat house book, FIX, bank, pay.
- Write conformance tests for **shared** order semantics on the Fiat engine.
- After Nitro GO: S-D4 testnet skeleton labelled not-mainnet, against this map.

## What still needs the owner

- P1 **GO** (timing).
- Whether INTACORE market ids ever equal Fiat ids (default: no).
- Whether planes ever share liquidity.
- Every economic number (D-S-14).
- Paid contract audit (`audited: true`).
- Validator genesis set, operator geo, keys (Class X / S-D3).
