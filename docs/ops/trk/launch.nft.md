# TRK-launch.nft — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `launch.nft`  
**Title:** NFT mint / list / auction, on-chain royalties  
**Module / phase:** `launch` · phase **5** · plane **P**  
**Status on tip:** `ready` · **owner:** none  
**Depends on:** `launch.token-factory` (shared launch plane discipline; NFT is a **separate** template family)  
**Requires:** future NFT contracts + product surface — **none on tip**  
**Tip freeze:** `origin/main` @ `d9e517bd` (re-derive before implement)  
**Pack type:** research only — no implement swarm; no money invention; no Shehzad implement; no `features.mjs` edit.

---

## 1 · What “done” means (plain language)

1. Creators can **mint** NFTs from platform templates, **list** and **auction** with **on-chain royalties** that actually pay — not off-chain honor-system only.
2. Platform does not custody NFT keys or sale proceeds outside ledger/contract design; unsigned calldata / smart-account patterns preferred (§22 permissionless + product gates at API).
3. Royalty accounting is enforceable on-chain (or explicitly limited with honest UX if marketplace enforces only).
4. No “listed” state in our DB without chain/listing SoT agreement.
5. Brand-safe metadata; **no PII** in tokenURI by default (§19 adjacency).
6. Tracker `done` only when mint **+** list **+** auction **+** royalty path is proven — not mint-only theatre.

---

## 2 · Current code state (tip)

### 2.1 Greenfield relative to token factory

| Fact                  | Tip                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------- |
| NFT contracts         | **None** under `services/svc-protocol/contracts` (tree has launch ERC-20, AMM, SA, not NFT)                   |
| Marketplace / auction | **None**                                                                                                      |
| Royalties standard    | **Not chosen** (EIP-2981 vs custom receiver vs marketplace-enforced)                                          |
| Indexer NFT models    | **None** — svc-indexer projects books/fills/positions for CLOB venue events, not ERC-721/1155                 |
| Product service       | `svc-launch` named in `packages/config` — **not built**; launch factory lives in svc-protocol                 |
| Depends token-factory | Shared “launch plane” honesty (unsigned calldata, audited flag, refuse zero factory) — **not** an NFT factory |

### 2.2 What exists as reference (adjacent, not this mountain)

| Area                   | Path / fact                                                                         | Relevance                                              |
| ---------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------ |
| ERC-20 token factory   | `contracts/launch/TokenFactory.sol`, `SovereignToken.sol`                           | CREATE2 + no mint/owner/pause discipline to **mirror** |
| Launch tRPC            | `predictTokenAddress` / `buildTokenDeployment` / `launch.status` (`audited: false`) | Pattern for unsigned deploy + honesty flags            |
| Shehzad board          | S-A7 launch factory honesty; launchpad/NFT called out as runway after factory       | Implement babysit if protocol contracts                |
| Blueprint share “card” | `svc-blueprint` SVG card — **not** an NFT; do not conflate                          | Different product                                      |

### 2.3 Tracker honesty

- Row has **no** long note — default `ready`, no owner.
- Entire feature is **product + protocol greenfield**.
- Do not mark done from UI mock or DB-only catalogue.

---

## 3 · Doctrine constraints

| Law     | Implication                                                          |
| ------- | -------------------------------------------------------------------- |
| §8.4    | NFT under launch module product surfaces                             |
| §17.5   | Protocol contracts in svc-protocol; product shell may be svc-launch  |
| §22     | Permissionless on-chain; product gates at API                        |
| §0.6    | Fiat fees / proceeds settlement via ledger recipes if platform takes |
| §0.7    | Metadata / collection branding — no partner vendor names             |
| §35     | Launch trust layer — no rug vectors in default templates             |
| Custody | No silent custody of NFT sale proceeds                               |
| Money   | Amounts as decimal strings / scaled bigint — never `number`          |

---

## 4 · Dependency honesty

- **`launch.token-factory`:** protocol code strong; tracker still `ready` because title word **audited** + production factory chain decision. NFT must not wait on “token-factory done” as a fake gate for research, but implement of shared launch UX should not invent a second honesty model.
- **Indexer:** if marketplace UI needs listings by chain events, either extend indexer or build listing read path with same reorg/idempotency bar — no confident empty books.
- **Not Shehzad M1–M7 hard lane by default**, but protocol contract work often lands on Shehzad runway (S-A7 adjacent). Nitro agents: **babysit** contract invent; free craft only for Class N research / non-protocol shell after law exists.

---

## 5 · DoD sketch (checkable — staged)

### Stage 0 — product law (required before code)

- [ ] Choose royalty standard + marketplace scope (in-house vs external aggregation).
- [ ] Template audit plan; collection ownership model (creator SA vs platform).
- [ ] Metadata storage policy (content-addressed / gateway; no PII).

### Stage 1 — mint template + list

- [ ] Contracts + unsigned mint/list calldata (or SA userops).
- [ ] CREATE2/predict where applicable; refuse unconfigured factory/zero address.
- [ ] Indexer or listing projection if UI needs it — fail closed when chain unreachable.

### Stage 2 — auction + royalties e2e

- [ ] Auction settlement tests on real chain fixture (not Memory-only sole proof).
- [ ] Royalty payout proof on sale path.
- [ ] Honest UX when marketplace ignores EIP-2981 (if external).

**Tracker `done`:** mint+list+auction+royalty path proven on non-dev-only story; not mint-only.

---

## 6 · Gaps (named)

1. Zero NFT contracts / ABIs / artefacts.
2. Zero marketplace DB or chain SoT.
3. Royalty standard undecided.
4. No svc-launch product shell.
5. No indexer NFT event ABI.
6. No audit package for any future NFT template.

---

## 7 · Risks

| Risk                                    | Why it hurts                          |
| --------------------------------------- | ------------------------------------- |
| DB-only “NFT catalogue”                 | Users think on-chain ownership exists |
| Honor-system royalties sold as on-chain | Creator loss / support load           |
| PII in tokenURI                         | Privacy + §19 adjacency fail          |
| Platform custody of sale proceeds       | §0.6 / custody scan failure           |
| Scope creep into token-factory PR       | Merges unaudited dual product         |

---

## 8 · Estimated size

| Slice                    | Size   | Notes             |
| ------------------------ | ------ | ----------------- |
| Spec + standard choice   | **S**  | Class N / product |
| Mint template contracts  | **L**  | Protocol          |
| List + auction suite     | **XL** | Multi-PR          |
| Full marketplace product | **XL** | + UI + ops        |

**First implement PR:** **S docs** until standard chosen; then mint template only (one service / contracts PR law).  
**Human blockers:** product law (royalty + marketplace scope); audit; chain decision for production.

---

## 9 · Related docs / code

- Doctrine §8.4 launch · §17.5 protocol services · §35 launch trust
- `services/svc-protocol/contracts/launch/*` — ERC-20 reference discipline
- `docs/ops/trk/launch.token-factory.md` (deepened pack)
- `docs/SHEHZAD-BLOCKCHAIN-TASK-BOARD-2026-08-03.md` S-A7 / launchpad-NFT runway
- Sister long-form: `TRK-launch.nft.md`

---

## 10 · Explicit non-goals for this pack

- No DB-only NFT catalogue pretending on-chain.
- No implement under token-factory PR scope creep.
- No features.mjs `done`.
- No invent royalty numbers or marketplace fees without product law.
- No Shehzad protocol implement from this research pack.
