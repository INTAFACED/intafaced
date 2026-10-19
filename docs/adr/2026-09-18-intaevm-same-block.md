# ADR: S-D5 — INTACORE ↔ INTAEVM, same block; desync is halt

**Status:** **Proposed (spec).** Implement of P1 / INTAEVM stays **parked**.  
**Decision owner:** Nitro. **Written by:** Grok (agents).  
**Spec id:** S-D5 (Shehzad board) · feeds `chain.evm`.  
**Parent:** [`2026-09-18-intacore-module-map.md`](2026-09-18-intacore-module-map.md) §3 (desync named, not testable).  
**Does not start:** Cosmos EVM module, precompile ABI, `svc-chain`, Base relabel.  
**Does not invent:** the read mechanism (precompile vs shared store vs other). That is Shehzad / product law at implement time. This file binds the **observable contract**.

**Ground truth on tip:** There is no INTACHAIN. `svc-protocol` talks to an **external** JSON-RPC (Base / anvil / configured RPC). That guest client is **not** INTAEVM. P0 contracts on Base stay P0.

---

## Decision

> **INTAEVM is the EVM execution domain secured by the same validator set as INTACORE, in the same block.** A contract must not observe a fill, position, or book level that the INTACORE clob/margin module has not **included in that block**.
>
> If the EVM view and the INTACORE module store disagree: **refuse the EVM read, and halt the node.** Do not return the friendlier copy. Do not return last-good. Do not keep producing blocks on a split brain.
>
> Pointing `RPC_URL` at Base, HyperEVM, or anvil is **not** this. The name INTAEVM is reserved until the shared-validator environment exists.

S-D2 §3 already said this in four bullets. This file is the halt/read contract a chain engineer can fail a test against.

---

## 1 · Same validators, same block

| Rule          | Meaning                                                                                                                                               | Not this                                                         |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Same set      | The operators who sign INTACORE blocks sign INTAEVM execution for **that** block.                                                                     | A sidechain with a “fast” committee. HyperEVM-as-home. Extra L2. |
| Same height   | EVM state transition for height `H` may read INTACORE module state **as committed at `H`**.                                                           | Reading `H+1` fills at height `H`. Reading a mempool match.      |
| Same app hash | One block’s app hash covers **both** domains (or an explicit pair that is checked as one). A node that can commit one without the other is mis-built. | Two hashes the operator “usually” checks.                        |

Block production that advances EVM while skipping the clob module (or the reverse) is **desync**, not a performance trick.

---

## 2 · What an EVM contract may see

A Solidity call in block `H` that asks “what is the INTACORE book / position / fill?” may see **only**:

- clob rests and fills the INTACORE module **wrote as included in `H`** (or an earlier committed height, if the call is a historical read of that height);
- margin accounts the margin module wrote in that same committed state;
- never: a match the engine computed but did not commit; never: a pending proposal; never: Fiat `svc-matching` journal; never: Base `SovereignVenue` logs.

**Fill visibility rule:** if INTACORE has not finalized the fill in this block, the EVM answer is **absent**, not “pending” dressed as a fill. (User-facing “pending” is a product surface. The precompile/store does not invent a fill.)

Historical reads: a call at height `H` asking about height `H-k` must return the state committed at `H-k`, or refuse. It must not “upgrade” that read to current.

---

## 3 · Desync: refuse-read vs halt

Two layers. Do not collapse them.

### 3.1 Query path — refuse the read

If a single EVM call’s INTACORE view does not match the module store for the height being read:

- Revert / error the call (`intaevm_desync` or equivalent).
- Do **not** substitute last-good, AMM TWAP, Fiat mid, or the other domain’s copy.
- Do **not** succeed with empty books as if the market were vacant (vacant and unreadable are different — same honesty as Connect “absent, never empty”).

### 3.2 Consensus path — halt the node

If a node **cannot** produce a block in which both domains commit a consistent pair (module store hash vs EVM-visible INTACORE view):

- **Stop producing / committing further blocks** on that node.
- Do not keep a “degraded EVM” that still answers RPC.
- Recovery is an **operator** procedure (Class X). This file does not invent a fork-choice that prefers EVM or prefers clob.

Halt is louder than a revert. A revert protects one call. Halt protects the chain from writing more lies.

### 3.3 What is **not** desync

- A contract that does not call INTACORE at all.
- P0 Base: there is no INTACORE to desync from. Guest RPC down is `svc-protocol` availability, already fail-closed on unconfigured — different mountain.
- User wallet out of gas.

---

## 4 · Read mechanism — named hole

How EVM reads INTACORE is **not** picked here:

| Candidate                             | Status                                                                                 |
| ------------------------------------- | -------------------------------------------------------------------------------------- |
| Precompile                            | Allowed later. ABI is implement-time product law. Do not invent selectors in this ADR. |
| Shared module store mapped into EVM   | Allowed later.                                                                         |
| Bridge-attested read of another chain | **Not** INTAEVM. That is a crossing (D-S-12 / S-D7).                                   |

`docs/ops/trk/chain.evm.md` (removed) Stage 2 remains: “precompile, shared store, or bridge-attested reads — product law, not agent invent.” **Bridge-attested is rejected as the INTAEVM in-block read.** Attestation is for cross-plane conservation, not for same-block book view.

---

## 5 · P0 Base is not this (reserved name)

| Thing on tip                                               | Label                                      |
| ---------------------------------------------------------- | ------------------------------------------ |
| `services/svc-protocol/src/chain/client.ts` `PublicClient` | Guest RPC. Not INTAEVM.                    |
| `SovereignVenue` / AMM / SA on anvil or Base               | P0 rails. `audited: false`. Not INTACHAIN. |
| `RPC_URL` pointing somewhere                               | Config. Never a chain id for INTAEVM.      |
| Name **INTAEVM**                                           | Reserved for the shared-validator domain.  |

Migrating P0 artifacts onto INTAEVM is a **later program** after P1 testnet (S-D2). CREATE2 smoke on Base does not tick `chain.evm`.

---

## 6 · Tests that would go red (when the module exists)

A chain engineer opens **this file**, then writes tests that fail if:

1. **Same-block fill:** INTACORE includes fill `F` in block `H`. An EVM call in `H` that reads that market sees `F`. An EVM call in `H-1` (or a call in `H` asked to read `H-1`) does **not** see `F`.
2. **Uncommitted match:** a match that exists only in memory / mempool is **not** visible to EVM.
3. **Injected desync:** if the test harness serves EVM a book hash that is not the clob module hash for `H`, the call **reverts** and the node **does not** commit `H+1` until recovered.
4. **Friendlier copy:** a test that prefers the EVM copy when hashes disagree is a **failed** test, not a fallback.
5. **Guest RPC:** a config that sets INTAEVM chain id equal to Base (8453 / 84532) without the shared-validator binary is **refused** as a label.

Until P1 exists, the pin is documentary: `chain.evm` Stage 2 points here; no `svc-chain`.

---

## Refuse cases

| Situation                                   | Correct answer                         |
| ------------------------------------------- | -------------------------------------- |
| EVM view of the book newer than clob module | **Halt / refuse read**                 |
| Last-good mark / last-good book on desync   | **No.** Same class as oracle last-good |
| INTAEVM = Base RPC                          | **Refuse the name**                    |
| HIP-3 / HyperEVM as INTAEVM                 | **Banned** until a new Nitro GO        |
| Agents invent a precompile ABI in this wave | **Stop.** Named hole                   |
| `svc-chain` because this spec exists        | **Stop.** Parked                       |
| P0 `SovereignVenue` fill shown as INTACORE  | **Mislabel**                           |

---

## Done bar (this ADR)

1. Same-block read + halt-on-desync is the law (this file), testable as §6.
2. Read mechanism is a named hole, not a fake ABI.
3. P0 guest RPC is explicitly not INTAEVM.
4. No `svc-chain` in this commit.

## What agents may do without asking again

- Keep P0 contracts honest on Base/anvil with **not INTACHAIN** labels.
- After P1 GO + not-mainnet labels: implement the EVM module against §6 tests.

## What still needs the owner / Shehzad

- Read mechanism (precompile vs shared store) at implement time.
- Halt recovery procedure (Class X).
- INTAEVM chain id (not Base’s).
- P1 GO.
- Paid audit (`audited: true`) — never this spec.
