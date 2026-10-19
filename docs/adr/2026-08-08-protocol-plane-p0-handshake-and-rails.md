# ADR: Protocol Plane P0 handshake + EVM rails (S-D0 / S-D1)

**Status:** **Accepted for P0 rails** — Nitro ruled **2026-08-08:** Base Sepolia → Base; anvil = CI. HyperEVM later/not home.  
**P1 timing:** parked **2026-09-03** — [`2026-09-03-protocol-rails-until-intachain.md`](2026-09-03-protocol-rails-until-intachain.md).  
**Decision owner:** `@shehzad002` (plan + proposal) · Nitro rules the named deploy chain and Class X.  
**Board ids:** S-D0 (plan-first handshake) · S-D1 (P0 rails).  
**Law:** `INTAFACED_DEFINITIVE_BUILD.md` §17 · `docs/SHEHZAD-BLOCKCHAIN-TASK-BOARD-2026-08-03.md` (removed) (delta 2026-08-07) · `docs/GITHUB-OWNERSHIP-SHEHZAD.md` (removed).

---

## Why this ADR exists

The board's attack order still starts here: **plan PR before large P1 code**, and **which EVM rail carries Protocol P0** before any address is treated as real.

This document is that handshake. It does **not** invent a mainnet date, does **not** claim `audited:true`, and does **not** rebuild work already on tip (§1.5).

---

## Confirmations (binding for this plane)

1. **§1.5 — do not rebuild.** Already merged and treated as foundation, not greenfield:
   - **S-A2 AMM** — compile fix (#228), PoolFactory on dev chain (#264), mint + `swapExactIn` proven on a real chain (#288).
   - **S-A7 token factory** — end-to-end proven (#217).
   - **Toolchain** — solc pinned + contracts run in CI (#210).
   - **S-A1 smart accounts (partly)** — contracts compile/run; CREATE2 cross-check lands (#210). Missing piece is the **audit package** + S-A9 verifier + gas ownership — not a rewrite of the contracts.
2. **#346 pay** — merged 2026-08-06; source landed unmodified. **Nothing owed. No pay expand** from this plane.
3. **Guardian / recovery** — doctrine wins: the platform is **never** a guardian. §34 guardian M-of-N that would make us a party stays unresolved until **S-K7** (ADR before any S-L2 code).
4. **Blocked-on-Nitro (§0.5)** — venue set, audit budget, testnet/RPC funding, Class X, gas sponsorship funding. If one blocks a PR, say so and move — do not sit.

---

## Mental model (so we don't build the wrong product)

| Plane                   | Custody                                                | This ADR                                   |
| ----------------------- | ------------------------------------------------------ | ------------------------------------------ |
| Fiat / custodial        | Platform holds value via ledger                        | Out of scope except adapter boundaries     |
| Protocol / self-custody | User (or contract the user alone controls) holds value | **In scope**                               |
| Shell                   | UI                                                     | Consumes APIs/events after contracts prove |

**Custodial P2P escrow is a different product** from **sovereign on-chain escrow** (`docs/adr/2026-08-04-p2p-escrow-and-dispute-law.md`). S-A3 is the sovereign product. No "handoff" of ledger escrow to chain.

Doctrine §17 sequencing stays: **P0 contracts on proven EVM rails → P1 own chain (CometBFT / Cosmos SDK) → P2 rust CLOB → P3 progressive decentralisation.** No fantasy "mainnet next week."

---

## Decision A — Attack order (S-D0 Done bar)

PR DAG for Protocol Plane P0, in dependency order. Parallel worktrees are fine **only** inside `services/svc-protocol/contracts` (and matching tests), one concern per PR.

| Step | IDs                                                             | Outcome                                                                                                   | Gate                                                      |
| ---- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 0    | **S-D0 + S-D1**                                                 | This ADR merged; Nitro has ruled (or deferred) deploy-chain naming                                        | This PR                                                   |
| 1    | **S-A1 audit package** + **S-A9** P-256 verifier                | Passkey can own an account **on-chain**; adversarial package exists or is an honest §13 socket with owner | No `audited:true` without package                         |
| 2    | **S-A3** escrow + **S-A6** merchant contracts                   | Lock → release → refund → dispute timer; merchant acceptance without platform custody                     | Keeper-safe + no-stranded-funds tests                     |
| 3    | **S-A12** price oracle → **S-A4** lending + **S-A5** router     | Marks/liquidations fail closed; lending unblocked                                                         | **S-A4 does not start before S-A12**                      |
| 4    | **S-C1** real venue contracts                                   | Indexer/DEX stop lying about DevVenue                                                                     | Pair with indexer owners; Solidity is ours                |
| 5    | **S-A10 / S-A11** gas + bundler + **S-A13** deployment registry | Who pays gas is named; addresses are registry-backed                                                      | Nitro funds sponsorship if any; Class X for live keys     |
| 6    | Residuals                                                       | S-A2 invariants/LP · S-A7 audit residual · S-G\* oxygen                                                   | No vapor Done                                             |
| 7    | **S-E\***                                                       | Sovereign card contract half                                                                              | After SA + verifier are honest                            |
| 8    | **S-D2–D4**                                                     | INTACHAIN P1 path (spec-heavy)                                                                            | Separate ADRs; no `chain.mainnet` Done without milestones |
| ∥    | **S-J\***                                                       | Audit factory continuous from step 1                                                                      | Always                                                    |

**Tier L (new 2026-08-07) — scheduled, not ignored:**

| ID                         | First move                                                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------------------- |
| S-L1 crew vaults           | Spec after S-A1 solid (multi-sig user keys only)                                                         |
| **S-L2 legacy vaults**     | **S-K7 ADR first** — user-elected heirs + time locks only; platform key never eligible; else stay socket |
| S-L3 stealth handles       | Spec after S-A9 (account crypto)                                                                         |
| S-L4 launch trust          | After S-A7 residual + AMM honesty                                                                        |
| S-L5 treasury-yield vaults | After S-A12 + S-A4                                                                                       |
| **S-L6 Venue Vault**       | Hard blocker under **S-I4**; needs Nitro venue decision (§0.5) — do not fake OMS                         |

**S-I3 / S-I4** stay on the board: authoritative fees before real quotes; execution stays loud-refuse until Venue Vault + `svc-execution` exist.

---

## Decision B — P0 rails proposal (S-D1 Done bar)

### What is already true on tip (not a proposal)

- Contract suite targets **EVM**, solc **0.8.28**, runs against a **real local chain in CI** (`REQUIRE_EVM_CHAIN=1`, docker `evm` / anvil).
- Dev proofs (factory, AMM mint/swap, token factory, smart-account CREATE2) are **anvil-class** proofs. They are not a deploy-chain choice.

### Proposal for Nitro to rule

| Layer                                           | Choice                                                                                        | Why                                                                                                          |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Local / CI**                                  | Keep **anvil** (current docker `evm`)                                                         | Already gates CI; no funding; deterministic                                                                  |
| **P0 public testnet (proposed)**                | **Base Sepolia** (OP-stack L2 testnet) as default integration target                          | Cheap, standard tooling, ERC-4337 ecosystem density for S-A9/S-A10/S-A11, same family as a likely mainnet L2 |
| **P0 optional liquidity tap (proposed, later)** | Evaluate **HyperEVM test/main** only after Base-path contracts are green and Nitro funds RPC  | Doctrine §17.2 explicitly allows HyperEVM for liquidity; it is **not** the first place we debug CREATE2      |
| **P0 mainnet (Class X — not this ADR)**         | Prefer **Base** mainnet for the first live contract suite; HyperEVM as optional second deploy | Nitro Class X + funding; this ADR only names the preference                                                  |

**Explicit non-choices for P0:**

- Not Cosmos / CometBFT yet — that is **P1 (S-D4)**, after P0 learns in production on someone else's rails.
- Not "deploy everywhere" — one named testnet first; multi-chain topology is **S-K4**.
- Not claiming a production RPC or funded deployer — **§0.5 Nitro**.

### What "deployed" means under this ADR

Until **S-A13** (deployment + verification registry) exists:

- Addresses in docs/PRs are **dev-chain or explicitly labelled testnet**.
- No UI or tracker row may imply a verified mainnet deployment.
- `audited` stays false without **S-J1** package + Nitro audit budget.

---

## Decision C — Stack boundaries (so PRs stay surgical)

| Concern                                 | Lives in                          | Does not                     |
| --------------------------------------- | --------------------------------- | ---------------------------- |
| Solidity suite + compile/test           | `services/svc-protocol/contracts` | Fiat services                |
| Chain client / userop / factory honesty | `services/svc-protocol/src/chain` | Invent EntryPoint behaviour  |
| Indexer read models                     | `svc-indexer` (coordinate)        | Invent mid prices            |
| Custodial pay/bank/trade                | Nitro/Denon residual              | Dual-edit their open PRs     |
| INTACHAIN node                          | `svc-chain` — **P1+**             | Fake Done on `chain.mainnet` |

---

## Risks (named, not papered over)

| Risk                           | Mitigation                                               |
| ------------------------------ | -------------------------------------------------------- |
| Rebuild merged AMM/SA/factory  | §1.5 checklist in every Protocol PR body                 |
| Lending without oracle         | S-A4 blocked on S-A12 by this ADR                        |
| Platform as recovery guardian  | S-K7 before S-L2; doctrine over §34 copy                 |
| Fake venue execution           | S-I4 stays refuse-loud until S-L6 + OMS                  |
| Premature mainnet              | Class X only; S-D1 proposes, Nitro rules                 |
| Gas sponsorship without budget | S-A10 contract can land; funded paymaster waits on Nitro |

---

## What this PR is / is not

**Is:** the S-D0 handshake + S-D1 rails **proposal** on tip, so the attack order and rail preference are reviewable before greenfield P0 code.

**Is not:** contract code, a funded deployer, an audit, a venue choice, or INTACHAIN P1.

---

## Next PR after merge (first code step)

Unless Nitro reorders:

1. **S-A9** — P-256 / WebAuthn verifier contract + gas note + cross-check against existing WebAuthn assertions in-repo (`socket.p256-verifier`), **or**
2. **S-A1 audit package** skeleton (threat model outline + honest residuals) in parallel worktree.

S-A3 escrow follows once SA ownership path is honest on-chain (verifier) or explicitly socketed.

---

## Nitro ask (one line)

**Rule on S-D1:** accept **Base Sepolia → Base mainnet** as P0 default, with HyperEVM optional later — or name a different EVM rail. Until ruled, engineering continues on **anvil CI** and does not treat any external address as canonical.
