# ADR: Protocol rails until INTACHAIN — house book + Base; P1 parked

**Status:** **Accepted — 2026-09-03.** Nitro human decision.  
**Decision owner:** Nitro.  
**Does not replace:** `INTAFACED_DEFINITIVE_BUILD.md` §16–§17 (end-state still own L1).  
**Supersedes for _timing_ only:** `docs/LAST-MVP-BOARDS-2026-08-23.md` (removed) §4 “INTACHAIN GO / start P1 now” and the 2026-08-23 GO delta on the Shehzad board.  
**Companion:** P0 rails [`2026-08-08-protocol-plane-p0-handshake-and-rails.md`](2026-08-08-protocol-plane-p0-handshake-and-rails.md) (Base Sepolia → Base; anvil = CI). Matching dual-target [`2026-08-04-matching-dual-target.md`](2026-08-04-matching-dual-target.md).

---

## Decision

Until Nitro says **GO** again on P1:

1. **Fiat exchange** stays the **house book** (`svc-matching` → ledger post is final). Do not move matching onto Base, HyperEVM, HIP-3, or a new L1/L2/L3.
2. **Protocol Plane P0** stays **contracts on Base** (CI: anvil). Honest labels: not INTACHAIN, `audited: false` until a paid firm.
3. **INTACHAIN P1 implement is parked.** No `svc-chain`, no genesis, no Cosmos/CometBFT binary, no `chain.mainnet` Done. End-state in §17 is **not** cut — only this wave’s start.
4. **Banned until a new Nitro GO:** HIP-3 (rent Hyperliquid), HyperEVM as the protocol home, Base Appchain / extra L3, a second L2 “just in case,” calling any Base deploy “our chain.”

Unpark: Nitro writes **GO** on this ADR (or a successor) **and** an S-D2 module map exists **and** any testnet is labelled **not mainnet**.

S-D2 spec (2026-09-18): [`2026-09-18-intacore-module-map.md`](2026-09-18-intacore-module-map.md). Predict resolution spec: [`2026-09-18-predict-resolution-stack.md`](2026-09-18-predict-resolution-stack.md). Later unpark specs (still not implement): S-D3 [`2026-09-18-validator-stake-vs-stakeof.md`](2026-09-18-validator-stake-vs-stakeof.md) · S-D5 [`2026-09-18-intaevm-same-block.md`](2026-09-18-intaevm-same-block.md) · reconciler [`2026-09-18-cross-plane-reconciler.md`](2026-09-18-cross-plane-reconciler.md) · mark port [`2026-09-18-intacore-mark-port.md`](2026-09-18-intacore-mark-port.md) · matching rows [`2026-09-18-matching-shared-conformance.md`](2026-09-18-matching-shared-conformance.md) · English leftovers [`2026-09-18-intachain-unpark-index.md`](2026-09-18-intachain-unpark-index.md). **Implement still parked** until GO.

---

## Why (one line each)

- House book already is the CEX. Hyperliquid-class L1 is a later product yes, not a size trigger.
- 2026: no kit copies HyperCore; P0 on Base was already ruled; rivals that grew did not win by shipping a fake L1.
- 23 Aug GO is overruled so partners and agents stop treating P1 as this week’s work.

---

## Who does what now

| Who              | Does                                                                                       | Does not                                    |
| ---------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------- |
| **Shehzad**      | Protocol P0 on Base/anvil: deploy honesty, #2473 residual, venue contract `audited: false` | `svc-chain`, S-D4, INTACHAIN mainnet stamps |
| **Nitro agents** | Shell, house matching/trade/bank/pay                                                       | Dual-build chain; second CLOB               |
| **Nitro human**  | Future P1 GO · audit budget · RPC/gas float · venues · HIP-3 if ever (Class X)             | —                                           |

---

## Named leftovers this parks (not deleted)

`chain.mainnet` · `chain.evm` · `bridge.canonical` (canonical _INTACHAIN_ bridge) · `chain.validators` · `chain.governance` · `predict.markets` as INTACORE type · `chain.rust-core`. Ledger↔Base IFC, if ever, is a **separate** bounded-window posting (`2026-08-04-cross-plane-bridge-accounting.md`) — not a substitute P1.

---

## Conflict rule

If a dated board or tracker “ready” line says start INTACHAIN P1 **now**, **this ADR wins** until Nitro GOs. Doctrine §17 still wins on _what P1 is_ when it starts.

---

## 2026-10-13 — P1 decision: NO-GO, with a re-decide trigger (Nitro human decision)

**INTACHAIN P1 stays parked.** This is a recorded NO-GO, not silence. Everything in "Decision" above stays in force.

**Re-decide when** the Protocol DEX on Base quotes and completes a testnet swap end to end, from a self-custody account with real evidence. That needs at least:

1. A healthy indexer head yields a quotable, finalized book (the indexer/DEX finality issue closed).
2. A session key cannot route ERC20 swap output to a foreign recipient (session-scope issue closed, TypeScript and Solidity).
3. Authority, quote/finality, signing, nonce, allowance, submit and recovery proven on Base Sepolia.

At that point Nitro writes GO or NO-GO again on this ADR. Agents may raise the re-decision; they do not start P1 work before it.

**Why:** securing a second chain while the first DEX cannot yet show a price would split effort away from the one finish line both founders agree comes first (Protocol DEX, no-KYC, on Base).

**Venue (`socket.dex-venue-set`, issue #935):** the DEX quotes **INTAFACED's own pools on Base first**, through the indexer quote path. External Base liquidity is a later addition, not a substitute. Seed liquidity for those pools is a separate spending decision for Nitro; until then pools may run on testnet with labelled test funds.

Phantom's "GO INTACHAIN P1" chat line is not a GO under this ADR (Phantom agreed, 2026-10-13).

---

## 2026-10-13 (later) — P1 GO: INTACHAIN is unparked for Shehzad (Nitro human decision)

**This supersedes the NO-GO entry above.** Nitro lifted the three-condition re-decide trigger the same day: Shehzad may start INTACHAIN P1 whenever he chooses and is not held back on anything related to the chain. Nobody has to wait for the Protocol DEX swap proof first.

**Now allowed (Shehzad):** `svc-chain`, Cosmos/CometBFT, native CLOB, INTAEVM, IFC gas/stake, INTACORE, and Predict as an INTACORE market type (`svc-predict`, the Predict app as a Protocol package). The Predict resolution ADR still decides the lifecycle before code.

**Still true (honesty, not limits):** a testnet is labelled **not mainnet**; Base is never called "our chain"; `audited: false` until a paid firm; the house book (`svc-matching`) and the ledger stay Fiat-only, with no second ledger and no Predict balances through `packages/ledger-client`.

**Still Nitro's, because they spend money or hold keys:** every economic number (fees, bonds, slash, Predict windows), Class X (mainnet keys, validator operators, sanctions-list content, go-live), the paid audit budget, RPC/gas float and pool seed liquidity.

**Not decided here:** the banned alternatives in "Decision" item 4 (HIP-3, HyperEVM as protocol home, extra L3) stay banned until Nitro names them.

**Path rule:** one PR owner per path. Nitro's lane keeps the customer shell, so Predict routes and nav are mounted by Nitro's lane from a contract Shehzad supplies.
