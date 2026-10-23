# TRK-launch.nft — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `launch.nft`  
**Title:** NFT mint / list / auction, on-chain royalties  
**Module / phase:** `launch` · phase 5 · plane P  
**Status on tip:** ready · **owner:** none  
**Depends on:** `launch.token-factory` (shared launch plane; NFT is separate template family)  
**Requires:** future NFT contracts + product service — **none on tip**  
**Tip freeze:** `origin/main` @ `04f9b1f2` (re-derive before implement)  
**Pack type:** research only — no implement swarm; no money invention; **no** `features.mjs` edit from this pack.

---

## 1 · What “done” means (plain language)

1. Creators can **mint** NFTs from platform templates, **list** and **auction** with **on-chain royalties** that actually pay — not off-chain honor-system only.
2. Platform does not custody NFT keys or sale proceeds outside ledger/contract design; unsigned calldata / SA patterns preferred.
3. Royalty accounting is enforceable on-chain (or explicitly limited with honest UX if marketplace enforces only).
4. No “listed” state in our DB without chain/listing SoT agreement.
5. Brand-safe metadata; no PII in tokenURI by default.

---

## 2 · Current code state (tip)

### 2.1 Greenfield

| Fact                  | Tip                                                                        |
| --------------------- | -------------------------------------------------------------------------- |
| NFT contracts         | **None** under svc-protocol/contracts (only launch ERC-20 + AMM + SA)      |
| Marketplace           | **None**                                                                   |
| Royalties standard    | Not chosen (EIP-2981 vs custom)                                            |
| Depends token-factory | Shared “launch plane” discipline; ERC-20 factory is **not** an NFT factory |

Entire feature is **product + protocol greenfield**.

---

## 3 · Doctrine constraints

| Law      | Implication                                       |
| -------- | ------------------------------------------------- |
| §8.4     | NFT under launch module                           |
| Custody  | No silent custody of NFT sale proceeds            |
| Money    | Fiat settlement of fees via ledger recipes if any |
| Metadata | Brand §0.7; no PII leakage                        |

---

## 4 · DoD sketch (checkable — staged)

### Stage 0 — product law

- [ ] Choose royalty standard + marketplace scope (ours vs external)
- [ ] Template audit plan

### Stage 1 — mint template + list

- [ ] Contracts + unsigned mint/list
- [ ] Indexer projection if needed for UI

### Stage 2 — auction + royalties e2e

- [ ] Auction settlement tests on real chain fixture
- [ ] Royalty payout proof

**Tracker `done`:** mint+list+auction+royalty path proven; not mint-only.

---

## 5 · Open questions

1. In-house marketplace vs aggregate external — product?
2. Royalty enforcement marketplaces often ignore — UX honesty?
3. Lazy mint vs eager — gas sponsor?

---

## 6 · Estimated size

| Slice                  | Size   | Notes     |
| ---------------------- | ------ | --------- |
| Spec + standard choice | **S**  | Now       |
| Mint template          | **L**  | Contracts |
| Full marketplace       | **XL** | Multi-PR  |

**First implement PR:** **S docs** until standard chosen; then mint template only.

**Human blockers:** Product law; Contracts; token-factory.

---

## 7 · Related docs / code

- Doctrine §8.4 launch
- svc-protocol launch discipline (ERC-20 reference)
- indexer if NFT reads needed

---

## 8 · Explicit non-goals for this pack

- No DB-only NFT catalogue pretending on-chain.
- No implement under token-factory PR scope creep.
- No features.mjs done.
