# TRK-launch.meme-factory — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `launch.meme-factory`  
**Title:** One-click meme launch + instant market + LP  
**Module / phase:** `launch` · phase **5** · plane **P**  
**Status on tip:** `ready` · **owner:** none (depends Shehzad AMM; product law heavy)  
**Depends on:** `launch.token-factory` (ready, not done — audit), `protocol.amm` (**owner shehzad002** / hard adjacency)  
**Requires:** future svc-launch product surface; protocol launch + AMM  
**Tip freeze:** `origin/main` @ `d9e517bd` (re-derive before implement)  
**Pack type:** research only — no implement swarm; no fake LP; no Shehzad implement; no `features.mjs` edit.

---

## 1 · What “done” means (plain language)

1. A creator can **one-click** deploy a meme token from the factory path, create an **instant market**, and seed **LP** without the platform holding the LP keys or inventing pool state.
2. Every step either lands on chain with predicted addresses **or** refuses with typed errors — never “success” with fictional token address (zero factory lesson from token-factory).
3. Launch fee, if any, is a **Fiat ledger recipe** (§0.6), not value trapped in an un-audited fee sink on the factory.
4. Instant market listing in trade/CLOB or AMM is real config + liquidity — not a UI row over empty books.
5. Templates remain `audited: false` until a real audit; UI must not claim audited.
6. Rug vectors (hidden mint, tax, pause) absent from default templates; anti-rug disclosures honest.

---

## 2 · Current code state (tip)

### 2.1 Token factory half exists; product glue does not

| Piece                         | Tip                                                                                                            |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------- |
| TokenFactory + SovereignToken | `services/svc-protocol/contracts/launch` — CREATE2, fixed supply, no mint/owner/pause                          |
| Protocol tRPC launch.*        | predict / build / tokenInfo / status — **unsigned calldata only**                                              |
| `launch.status.audited`       | **false** deliberate until real audit package                                                                  |
| AMM                           | `contracts/amm` (PoolFactory, ConstantProductPool) — compiles; mint/swap proofs partial; **Shehzad M2 / S-A2** |
| Instant market in svc-trade   | **Not built** for meme launches                                                                                |
| svc-launch product service    | **Not built** (§8.4 launchpad/meme/NFT product module; config names `svc-launch`)                              |
| UI one-click                  | **Not built**                                                                                                  |
| LP key custody                | N/A — must never land in service                                                                               |

### 2.2 Dependency honesty

| Dep                    | Tip honesty                                                                                                      |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `launch.token-factory` | Strong code; tracker **not done** (audit + chain decision)                                                       |
| `protocol.amm`         | Owner **shehzad002** — human hard lane; agents babysit only                                                      |
| Bonding curve vs CPAMM | **Product law** not chosen                                                                                       |
| SA dep for factory     | Removed for token-factory (tests with zero SA factory still launch) — meme orchestration may still use SA for UX |

Meme factory that “fakes” LP or internal book depth is **forbidden**.

### 2.3 Tracker honesty

Row has no long note — default ready. Title is a full product program, not a single PR.

---

## 3 · Doctrine constraints

| Law              | Implication                                              |
| ---------------- | -------------------------------------------------------- |
| §8.4             | Launch product surfaces                                  |
| §17.5            | Protocol owns contracts; product shell may be svc-launch |
| §0.6             | Launch fee = ledger recipe on Fiat plane                 |
| §22              | Permissionless on-chain; product gates at API            |
| §35              | Launch trust — no rug vectors in default templates       |
| Protocol custody | Service never holds launch or LP keys                    |
| Audit honesty    | `status.audited` false until real audit                  |
| Shehzad          | AMM / SA adjacency — babysit implement                   |
| Money            | Decimal strings / scaled bigint                          |

---

## 4 · DoD sketch (checkable — staged)

### Stage 1 — depends green

- [ ] token-factory audit story + factory configured on a real chain decision (S-D1 / product)
- [ ] protocol.amm deployable + quote/swap honest; `audited` path not faked
- [ ] ADR: custody, fee, LP ownership, bonding vs constant-product

### Stage 2 — glue (protocol + orchestration)

- [ ] Orchestrated flow: deploy token → create pool → seed LP **calldata bundle** (unsigned)
- [ ] Predicted addresses agree pre/post broadcast
- [ ] Refuse unconfigured factory / zero pool / missing AMM
- [ ] Optional trade market create via contracts/events — **not** SQL into trade tables from protocol

### Stage 3 — product

- [ ] One-click UI; fee recipe; refuse paths golden-tested
- [ ] Instant market shows real depth or honest empty + refuse trade
- [ ] No “audited” marketing while flag false

**Tracker `done`:** end-to-end on non-dev-only chain story + no key custody + honest audited flag + real market/LP.

---

## 5 · Open questions

1. Bonding curve vs constant-product first LP — product law?
2. Who lists the spot market — auto vs operator?
3. Anti-sniper / tax features — doctrine may forbid token taxes on SovereignToken template?
4. LP ownership / rug disclosure — creator-owned LP forever vs lock contract?
5. Meme UI copy brand law?
6. Launch fee amount / schedule — Class M when implemented.

---

## 6 · Gaps (named)

1. No orchestration API bundling token + pool + LP.
2. No svc-launch product shell / one-click UI.
3. AMM not tracker-done; Shehzad hard lane.
4. Token-factory not audited; production factory address undecided.
5. No trade market create path for meme launches.
6. No launch fee ledger recipe.

---

## 7 · Risks

| Risk                                  | Why it hurts                       |
| ------------------------------------- | ---------------------------------- |
| Fake LP / invented depth              | User trades empty / lied liquidity |
| Platform holds LP keys                | Custody disaster                   |
| Payable fee in factory without recipe | §0.6 dual-book fail                |
| “Audited” while false                 | Trust / §35 fail                   |
| Implement AMM under this claim        | Ownership law / dual-edit Shehzad  |
| Sniper/tax rug in “meme” template     | Launch trust collapse              |

---

## 8 · Estimated size

| Slice             | Size    | Notes                  |
| ----------------- | ------- | ---------------------- |
| ADR + refusals    | **S–M** | Class N + product      |
| Orchestration API | **L**   | After AMM honest       |
| UI one-click      | **M**   | After API              |
| Full program      | **XL**  | Multi-service multi-PR |

**First implement PR:** blocked on AMM + product law. Research only now.  
**Human blockers:** protocol.amm (Shehzad); token-factory audit/chain; product law (bonding, LP ownership).

---

## 9 · Related docs / code

- `services/svc-protocol/contracts/launch/*` · `contracts/amm/*`
- `docs/ops/trk/launch.token-factory.md` (deepened)
- `docs/SHEHZAD-BLOCKCHAIN-TASK-BOARD-2026-08-03.md` S-A2 / S-A7
- Tracker `protocol.amm` · `launch.token-factory`
- Sister long-form: `TRK-launch.meme-factory.md`

---

## 10 · Explicit non-goals for this pack

- No fake LP or invented market depth.
- No payable fee in factory without ledger recipe design.
- No implement AMM under this claim.
- No features.mjs `done`.
- No Shehzad protocol implement from this research pack.
- No unaudited “safe” marketing copy.
