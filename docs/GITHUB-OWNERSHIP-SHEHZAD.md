# GitHub ownership lock — `@shehzad002` (Shehzad / “Shizu”)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Status:** BINDING on `main` · cold agents must obey  
**Supersedes:** M1–M7 hard spine lock (2026-08-01) for **who may code**  
**Historical detail (superseded for scope):** [`SHEHZAD-HARD-OWNERSHIP-2026-08-01.md`](SHEHZAD-HARD-OWNERSHIP-2026-08-01.md)  
**Task board (sole runway):** [`SHEHZAD-BLOCKCHAIN-TASK-BOARD-2026-08-03.md`](SHEHZAD-BLOCKCHAIN-TASK-BOARD-2026-08-03.md)  
**Last MVP overlay (2026-08-23):** [`LAST-MVP-BOARDS-2026-08-23.md`](LAST-MVP-BOARDS-2026-08-23.md) — leftover only. **P0 live queue:** [`PROTOCOL-P0-BASE-MEGA-2026-09-06.md`](PROTOCOL-P0-BASE-MEGA-2026-09-06.md). **#2473 merged.** **INTACHAIN P1 implement parked 2026-09-03** ([`adr/2026-09-03-protocol-rails-until-intachain.md`](adr/2026-09-03-protocol-rails-until-intachain.md)) — he still owns the path; he does **not** start `svc-chain` until Nitro GO.  
**Three-way split:** [`THREE-WAY-DISTRIBUTION-2026-08-04.md`](THREE-WAY-DISTRIBUTION-2026-08-04.md)  
**Live claims:** [`LIVE-LANES.md`](LIVE-LANES.md)

---

## Decision (2026-08-04)

Shehzad owns **Protocol Plane + INTACHAIN only** (definitive build §16–§25, especially §17).

He does **not** own custodial Pay OS, bank fiat money products, futures/OTC/copy/algo risk engines, identity money-routing residual, or vendor shell. Those are **reclaimed** for Nitro agents (Class M rigor) and Denon product law where invent is required.

| Who              | Owns                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------- |
| **Shehzad**      | On-chain / self-custody / contracts / L1 path — see mountains below                    |
| **Nitro agents** | Shell, reclaimed pay/bank/identity residual, trade-light, research→implement-from-spec |
| **Denon**        | Direction + his open integrity/money PR pile + true product-law invent                 |
| **Nitro human**  | Class X (secrets, prod go-live, licence, sanctions content)                            |

---

## What “ownership on GitHub” means here

| Layer                                              | What it does                                                                                                                                   |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **This file + blockchain task board + LIVE-LANES** | Law for agents: do not implement his chain mountains                                                                                           |
| **`AGENTS.md` + START-HERE**                       | Cold chat entry chain                                                                                                                          |
| **Tracker `owner: shehzad002`**                    | Only on protocol/chain/bridge/launch/dex self-custody rows                                                                                     |
| **`.github/CODEOWNERS`**                           | Review request on `svc-protocol`, `svc-dex`, `svc-indexer` and the future `svc-chain` / `svc-bridge` (+ chain docs) — **not** blanket pay/bank |
| **Open PRs by him**                                | Live WIP — babysit only; #346 pay is **handoff residual** (not new pay expand)                                                                 |

If layers disagree: **this file + LIVE-LANES win** for “who may code.”

---

## His mountains (never agent-implement)

| ID             | Mountain                        | Paths / tracker (gravity)                                                                                           |
| -------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **S-PROT**     | Protocol suite                  | `services/svc-protocol/**` · `protocol.*` (SA, AMM, lending, escrow, router, merchant)                              |
| **S-CHAIN**    | INTACHAIN L1 path (§17)         | `chain.mainnet` · `chain.evm` · `chain.validators` · `chain.governance` · `chain.rust-core` · future `svc-chain/**` |
| **S-BRIDGE**   | Canonical IFC bridge            | `bridge.canonical` · future `svc-bridge/**` (chain side)                                                            |
| **S-LAUNCH**   | On-chain launch factories       | `launch.*` contract honesty                                                                                         |
| **S-DEX**      | Self-custody DEX surface        | `services/svc-dex/**` · `dex.*` residual on-chain                                                                   |
| **S-INDEX-CT** | Venue **contracts** (not shell) | Real venue ABI vs DevVenue; indexer adapter may be agent residual                                                   |
| **S-AUDIT**    | Audit factory / no fake audited | docs/audit packages + protocol audit pipeline                                                                       |

**Sequencing law (no fantasy mainnet week-1):**

1. **P0** — contracts on proven EVM rails (L2 / HyperEVM)
2. **P1** — own CometBFT/Cosmos chain + native CLOB + INTAEVM + IFC gas/staking + bridge
3. **P2–P3** — rust core, validator open, governance schedule

**Freedom:** he designs PR DAGs.  
**Communication gate:** before large implement (especially P1 L1), he lands an **ADR/plan PR** on tip for Nitro + Denon visibility, then ships.

**Agents may:** comment/CI babysit on his PRs; **never** open competing implement PRs on the paths above unless he comments `agents free on <path>`.

---

## Reclaimed (agents may implement — Class M where money)

| Former M-id | Area                        | Notes                                                                           |
| ----------- | --------------------------- | ------------------------------------------------------------------------------- |
| M1          | Pay OS / `svc-pay`          | **Handoff complete — #346 merged 2026-08-06.** Agents own pay residual from tip |
| M3–M4       | Futures / OTC / copy / algo | Implement only from tip law or honest thin §13 — never invent mids/rates        |
| M5          | Identity money graph        | Agents + leak tests                                                             |
| M6          | Bank money / `svc-bank`     | Thin ledger-true verticals; Class X issuer keys still Nitro human               |
| M7          | Java dual-book residual     | After path-clear vs Denon open custody PRs                                      |

---

## #346 disposition — SETTLED 2026-08-06

**#346 merged.** The handoff asserted on 2026-08-04 is complete; the PR's merge comment records that his source landed **unmodified** — payment service, router, schema, migrations, tests and the card sandbox e2e as written, with only board files touched. Branch `feat/pay-os-m1-gateway` is gone from the remote.

- **Nothing is owed by Shehzad here.** Any instruction to "finish or close #346" is stale as of 2026-08-06 and must not be re-sent.
- Shehzad **stops** pay expand; sole mountain = Protocol Plane + INTACHAIN. Unchanged.
- Pay residual proceeds from tip under Nitro agents (Class M).

## Cold-agent checklist

```
1) git fetch && gh pr list --state open
2) Read docs/LIVE-LANES.md + docs/THREE-WAY-DISTRIBUTION-2026-08-04.md
3) If path is protocol/chain/bridge/launch/dex self-custody → babysit only
4) pay/bank/identity money residual → agent Class M OK (handoff complete, #346 merged 2026-08-06)
5) Never mark tracker done on shehzad002 rows without his proof
6) Never dual-edit Denon open PR file sets
```

---

## Nitro unspoken needs (hardened)

1. One ownership story — no M1–M7 vs blockchain dual narrative.
2. Chat memory is not ownership — **main tip is**.
3. Insane chain runway for Shehzad without shell thrash.
4. Agents not blocked forever on pay/bank they reclaimed.
5. L1 freedom + plan-before-build gate.

_Update this file only with a PR that also updates LIVE-LANES / CODEOWNERS / tracker mountain owners when claims change._
