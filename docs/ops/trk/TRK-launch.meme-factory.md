# TRK-launch.meme-factory — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `launch.meme-factory`  
**Title:** One-click meme launch + instant market + LP  
**Module / phase:** `launch` · phase 5 · plane P  
**Status on tip:** ready · **owner:** none (depends Shehzad AMM; product law heavy)  
**Depends on:** `launch.token-factory` (ready, not done — audit), `protocol.amm` (Shehzad M2)  
**Requires:** future svc-launch product surface; protocol launch + AMM  
**Tip freeze:** `origin/main` @ `04f9b1f2` (re-derive before implement)  
**Pack type:** research only — no implement swarm; no money invention; **no** `features.mjs` edit from this pack.

---

## 1 · What “done” means (plain language)

1. A creator can **one-click** deploy a meme token from the audited/factory path, create an **instant market**, and seed **LP** without the platform holding the LP keys or inventing pool state.
2. Every step either lands on chain with predicted addresses **or** refuses with typed errors — never “success” with fictional token address (zero factory lesson from token-factory).
3. Launch fee, if any, is a **Fiat ledger recipe** (§0.6), not value trapped in an un-audited fee sink on the factory.
4. Instant market listing in trade/CLOB or AMM is real config + liquidity — not a UI row over empty books.
5. Templates remain `audited: false` until a real audit; UI must not claim audited.

---

## 2 · Current code state (tip)

### 2.1 Token factory half exists; product glue does not

| Piece                         | Tip                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------- |
| TokenFactory + SovereignToken | `services/svc-protocol/contracts/launch` — CREATE2, fixed supply, no mint/owner/pause |
| Protocol tRPC launch.*        | predict / build / tokenInfo / status — **unsigned calldata only**                     |
| AMM                           | `contracts/amm` compiles; factory deploy + audit open; **Shehzad M2**                 |
| Instant market in svc-trade   | **Not built** for meme launches                                                       |
| svc-launch product service    | **Not built** (§8.4 launchpad/meme/NFT product module)                                |
| UI one-click                  | **Not built**                                                                         |

### 2.2 Dependency honesty

`protocol.amm` owner **shehzad002**. Meme factory that “fakes” LP or internal book depth is forbidden. Token-factory itself is **not** tracker-done (audit + chain decision).

---

## 3 · Doctrine constraints

| Law              | Implication                              |
| ---------------- | ---------------------------------------- |
| §8.4             | Launch product surfaces                  |
| §0.6             | Launch fee = ledger recipe on Fiat plane |
| Protocol custody | Service never holds launch or LP keys    |
| Audit honesty    | status.audited false until real audit    |
| Shehzad          | AMM / SA adjacency                       |

---

## 4 · DoD sketch (checkable — staged)

### Stage 1 — depends green

- [ ] token-factory audit story + factory configured on a real chain decision
- [ ] protocol.amm deployable + quote/swap honest

### Stage 2 — glue

- [ ] Orchestrated flow: deploy token → create pool → seed LP calldata bundle
- [ ] Optional trade market create via contracts/events — not SQL into trade tables from protocol

### Stage 3 — product

- [ ] One-click UI; fee recipe; refuse paths golden-tested

**Tracker `done`:** end-to-end on non-dev-only chain story + no key custody + honest audited flag.

---

## 5 · Open questions

1. Bonding curve vs constant-product first LP — product law?
2. Who lists the spot market — auto vs operator?
3. Anti-sniper / tax features — doctrine may forbid token taxes on SovereignToken template?
4. Meme UI copy brand law?

---

## 6 · Estimated size

| Slice             | Size   | Notes         |
| ----------------- | ------ | ------------- |
| Orchestration API | **L**  | After AMM     |
| UI one-click      | **M**  | After API     |
| Full program      | **XL** | Multi-service |

**First implement PR:** blocked on AMM + product law. Research only now.

**Human blockers:** protocol.amm; token-factory audit/chain; Product law.

---

## 7 · Related docs / code

- `services/svc-protocol` launch + amm
- tracker `launch.token-factory` note
- Shehzad M2 AMM

---

## 8 · Explicit non-goals for this pack

- No fake LP or invented market depth.
- No payable fee in factory without ledger recipe design.
- No implement AMM under this claim.
- No features.mjs done.
