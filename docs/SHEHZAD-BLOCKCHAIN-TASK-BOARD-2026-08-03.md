# Shehzad — Blockchain / Protocol Plane task board

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Date:** 2026-08-03 · **Ownership sole-lock:** 2026-08-04 · **Delta:** 2026-09-06  
**Audience:** `@shehzad002` (Shehzad / Shizu) + his agents  
**GitHub tip:** re-derive `origin/main` every session  
**Status:** BINDING — **sole human ownership** of Protocol Plane + INTACHAIN (not shell, not custodial pay/bank/futures)

> ### 2026-09-06 delta — P0-on-Base mega (Nitro)
>
> Live phases: [`PROTOCOL-P0-BASE-MEGA-2026-09-06.md`](PROTOCOL-P0-BASE-MEGA-2026-09-06.md). **Before Sepolia:** three lines on [#4199](https://github.com/Phantom-X-007/intafaced/issues/4199) ([`SHEHZAD-P0-BASE-AUDIT.md`](SHEHZAD-P0-BASE-AUDIT.md)). Then ship. P1 parked. **#2473 merged.**
>
> ### 2026-09-03 delta — INTACHAIN P1 parked (Nitro)
>
> Binding: [`adr/2026-09-03-protocol-rails-until-intachain.md`](adr/2026-09-03-protocol-rails-until-intachain.md). **Do not start `svc-chain` / S-D4.** House book stays `svc-matching`. Protocol P0 on **Base** (anvil = CI). 23 Aug “start P1 now” is **overruled**. You still own the L1 path; implement waits on Nitro GO. `audited:true` stays false.
>
> ### 2026-09-03 earlier — S-E3 CardIssuer on-chain interface (this PR · closes #2473)
>
> **No keys in this repo.** `ICardPull` is the Protocol Plane seam a live issuer may drive. `CardPull is ICardPull`. TypeScript `issuer-adapter` builds `pullExact`/`kill` calldata and refuses issuer secret env keys. Custodial `CardIssuerAdapter` in svc-bank is a different port. Live rail stays `socket.live-issuer`.
>
> ### 2026-08-23 delta — INTACHAIN GO (Nitro) — **OVERRULED 2026-09-03**
>
> Historical. Live law is the 2026-09-03 park ADR. Do not start P1 from this delta.
>
> ### 2026-08-23 earlier — last MVP wave (superseded for INTACHAIN)
>
> The same-day overlay first parked INTACHAIN. **Nitro overruled: GO.** Keep venue contract; do not treat INTACHAIN as parked.
>
> ### 2026-08-20 delta — sitting items are not coding gates
>
> §0.5 does not pause the board. Do not ping Nitro to flip `audited:true`. Keep shipping with an honest `audited: false`.
>
> ### 2026-08-19 delta — S-J1 audit pipeline (#2472)
>
> **Status + hash + signer, never a fake badge.** `src/audit/pipeline.ts` + public `auditStatus`. The committed smart-accounts package is `kind: internal`, `audited: false`. `audited:true` only exists as a pure-function path for a future external package whose pinned hash matches. `socket.contract-audit` stays a socket (Nitro budget). **Do not ping Nitro to flip it — keep shipping.**
>
> ### 2026-08-19 delta — S-J3 protocol incident runbook (#2471)
>
> **No pause, no upgrade, no platform guardian.** `docs/ops/INCIDENT-PROTOCOL-RUNBOOK.md` — contain is edge kill of module `protocol` (or `PROTOCOL_RELAY_ENABLED=false`). That stops _our_ relay. Recovery is user-elected. Do not collide with Denon's money-path runbook.
>
> ### 2026-08-19 delta — S-E1 JIT CardPull (#2470)
>
> **On-chain half:** `CardPull` — owner is the user's SmartAccount. `pullExact` is `transferFrom(owner, settlement, amount)` so this contract never holds tokens. `kill` is owner-only and strands zero. Session keys may be granted `pullExact` (not an outbound ERC-20 transfer). No issuer key. Unaudited.
>
> ### 2026-08-19 delta — S-G4 RWA registry (#2469)
>
> **Licence-gated honesty:** `RwaRegistry` refuses `register`/`unlist` while `licenceHash` is `bytes32(0)`. Hash is immutable. Issuer is `msg.sender`; the platform cannot unlist. Licence _content_ stays Class X. Unaudited.
>
> ### 2026-08-19 delta — S-A10 paymaster contract (#2468)
>
> **Contract half:** `ScopedPaymaster` holds a native float, allowlist + selector + maxCost, refuses `validatePaymasterUserOp` when unfunded. Operator can only withdraw this contract's leftover ETH — never a user account. Nitro still funds the float. Unaudited.
>
> ### 2026-08-19 delta — S-A1 recovery as possible SmartAccount owner (#2467)
>
> **Wiring proof, not a factory default:** `test/forge/RecoveryOwner.t.sol` — `createAccount(recovery)` sets `SmartAccount.owner` to `UserElectedRecovery`, ERC-1271 forwards to the sitting recovery-owner EOA, a non-owner signature is refused, the EOA cannot `execute` directly, and a second `createAccount(eoa)` still belongs to that EOA. Factory is unchanged. Unaudited.
>
> ### 2026-08-19 delta — S-A8 session-key forge (#2466)
>
> **Session-key richness:** `test/forge/SessionKey.t.sol` — self-target / outbound-selector refused at grant (fuzz), spend-limit counted before `_call` so re-entrancy cannot double-spend, `validateUserOp` refuses a session op whose selector is not `executeWithSession`. Clones via AccountFactory (implementation stays locked). No forge-std. Residual: external audit.
>
> ### 2026-08-19 delta — S-C2 venue reorg (#2465)
>
> **Solidity tip replace:** `sovereign-venue-reorg.onchain.test.ts` snapshots, places (BookLevel), mines 5 blocks, reverts — orphaned block hash is gone. Indexer projection unwind stays on 8546. No `evm_increaseTime`.
>
> ### 2026-08-19 delta — S-A8 forge fuzz (#2464)
>
> **Fuzzer, not compiler:** `test/forge` + `pnpm test:forge` in CI via foundry:v1.5.1. solc-js still writes `contracts/out/`. CrewVault share-sum fuzz + StealthAnnouncer gas ceiling. Session-key richness is #2466. Residual: external audit.
>
> ### 2026-08-19 delta — S-L3 ECDH scanner (#2463)
>
> **Stealth receive half:** `src/stealth/scan.ts` is ERC-5564 scheme-1 (secp256k1 + view tags). Recipients scan `StealthAnnouncer` logs with a viewing key the service never holds. Keccak `presentationAddress` stays a separate P0 helper — not an ECDH match. Unaudited.
>
> ### 2026-08-18 delta — S-I3
>
> **S-I3 dex fees:** CLOB knobs no longer default to 0 / `'0'`. Set both from the venue or omit both — omitted means `intachain-clob` is not quoted. Quote path still uses projections, never `eth_call`. Internal-book 20bps remains a configured guess. Tracker `socket.dex-fee-source` → **ready**.
> **#2364 merged** (S-C1 SovereignVenue + S-L4 trust). Venue publishes `takerFeeBps` + `settlementCostQuote()=0`; this PR makes svc-dex refuse silent zeros instead of quoting from them.
>
> ### 2026-08-08 delta — P0 wave (tip)
>
> **Merged:** #1153 S-D0/D1 · #1154 S-A9 PasskeyOwner · #1155 S-A3 escrow · #1160 oracle/lending-seed/router/merchant/A10–A13/K7/L1/L4 · #1176 S-A1 **internal** audit package · #1178 S-A2 AMM invariant suite · #1177 S-A4 lending cascade/flash done-bar · #2362 S-L2 LegacyVault · #2363 S-L6/L3/L5.
> **Nitro rail ruling 2026-08-08:** Base Sepolia → Base is P0 default; HyperEVM later; anvil stays CI. No Class X / mainnet go-live from that ruling.
>
> Still open / Nitro-gated: S-A1 **external** audit budget · S-A1/S-A9 live configured-env proof · S-I4 OMS · S-D2–D9 INTACHAIN · paymaster **funding** · public registry rows · Venue Vault HSM/durable store · treasury licence content (Class X).
>
> ### 2026-08-07 delta — read this before anything else
>
> **Ownership is unchanged.** What changed is the accounting around it, and one part of that was expensive:
>
> 1. **§1.5 is new — work on this board that is already merged.** Tier A read as eight greenfield items; four of them were substantially built before the sole-lock. Do not rebuild them.
> 2. **Nine outcomes were added** (S-A9…S-A13, S-I3, S-I4) — real chain work that existed in the tracker or in the code and appeared on no list. S-A9, the passkey verifier contract, is arguably the highest-value unbuilt item in the whole protocol suite.
> 3. **The guardian/recovery contradiction is resolved** — see S-A1. Doctrine wins.
> 4. **§0.5 is new — what is blocking you that is NOT yours to solve.** Route around these; do not sit on them.
> 5. **#346 is closed as a question** — it merged 2026-08-06 with your source landing unmodified. Nothing is owed. Old §7 struck.
> 6. **Tracker rows that said "free" while this board said they were yours now carry `owner: shehzad002`** — an agent doing the correct check could legitimately have started them.
>
> 7. **Tier L is new — six capabilities the LAW names that this board never did.** They were counted as gaps in `tooling/coverage.yaml`, which meant the repo knew they were missing and no engineer could see them. Crew vaults, legacy vaults, stealth handles, launch trust, treasury yield, Venue Vault.
>
> Evidence and reasoning: [`SHIZU-BOARD-AUDIT-2026-08-07.md`](SHIZU-BOARD-AUDIT-2026-08-07.md).

**Law:** [`GITHUB-OWNERSHIP-SHEHZAD.md`](GITHUB-OWNERSHIP-SHEHZAD.md) · [`THREE-WAY-DISTRIBUTION-2026-08-04.md`](THREE-WAY-DISTRIBUTION-2026-08-04.md) · definitive build **§16–§25 / §17**

**Why this board exists:** Nitro agents own shell + reclaimed custodial residual. Denon owns platform integrity + open money PR pile + product-law invent. **You** own the entire on-chain / self-custody / L1 runway — plan freely, communicate large plans before execute, ship with proof.

**Master law (read first):**

- [`INTAFACED_DEFINITIVE_BUILD.md`](../INTAFACED_DEFINITIVE_BUILD.md) — especially **§16–§25** (two planes, INTACHAIN, smart accounts, sovereign banking/rails, coverage matrix) and **§0 doctrine** (ledger only for custodial plane; no invent money)
- [`docs/SHEHZAD-HARD-OWNERSHIP-2026-08-01.md`](SHEHZAD-HARD-OWNERSHIP-2026-08-01.md) — historical mountain detail (protocol suite)
- Tracker: `tooling/tracker/features.mjs` · `protocol.*` · `launch.*` · `chain.*` · `bridge.*` · `token.*` on-chain residuals
- Live collision: `gh pr list` · never dual-edit open Denon/Nitro PR file sets

**You design PR DAGs.** Rows below are **outcomes + Done bars**, not micro-tickets. Spec freely, plan completely, ship with proof.

---

## 0 · Collision wall (do not touch)

| Owned by others right now                                                                  | Why                                                                                                         |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| **Vendor shell `:8090` / shell craft** (Index, Exchange honesty, AFK residual, RP1–RP5 UI) | Nitro swarm — dual-build destroys free parallel                                                             |
| **Denon open integrity PRs** (file sets live on `gh pr list`)                              | Dual-edit ban                                                                                               |
| **Platform WS depth path** (#727/#737 landed)                                              | Shell client = Nitro; you do not dual-build nginx/ws unless chain events                                    |
| **Custodial pay card / #346**                                                              | **Settled — #346 merged 2026-08-06, nothing owed.** No further pay expand. On-chain pay leg = **S-B1** only |
| **apps/web product resurrection**                                                          | Retired surface                                                                                             |
| **Class X** (prod keys, mainnet go-live yes, sanctions content)                            | Nitro human                                                                                                 |

**You may:** open new branches from tip · own `services/svc-protocol/**` contracts · forge/scripts · audit packages · indexer **venue contract** side · launch factory · on-chain escrow · research ADRs on tip.

---

## 0.5 · Sitting with Nitro — not coding gates

These rows cost money, keys, or a live vendor. **They do not pause your board.**
Do not message Nitro to start the next `S-*`. Do not ping Nitro to flip `audited:true`.

`audited:true` is a sale/UI flag. It stays false until Nitro pays an external firm
and the package hash+signer match (`src/audit/pipeline.ts`). Internal packages and
green CI are not an audit. Your Done-bar is an honest `audited: false` plus the
pipeline that refuses a fake badge (S-J1 shipped).

| Sitting with                                   | Whose call         | What it gates                                                                       | Status                                                              |
| ---------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **Which venue this platform quotes**           | **Nitro**          | `socket.dex-venue-set` — svc-dex and the indexer both stay honestly dead until then | Sitting — keep shipping                                             |
| **Money for an external contract audit**       | **Nitro**          | S-J1 / `socket.contract-audit` — `audited:true` is unreachable without it           | Sitting — keep shipping. Do not ping Nitro                          |
| **Testnet / mainnet funding, RPC access**      | **Nitro**          | Anything past a local dev chain, incl. S-A13 deployment registry                    | Sitting — keep shipping                                             |
| **Which EVM chain P0 deploys to**              | Nitro, on your ADR | S-D1, and every deployed-address item                                               | **Ruled 2026-08-08: Base Sepolia → Base; HyperEVM later; anvil=CI** |
| **Class X — mainnet keys, go-live, sanctions** | **Nitro human**    | Any live-money posture                                                              | Standing law, unchanged                                             |
| **Gas sponsorship funding** (if we sponsor)    | **Nitro**          | S-A10 paymaster — the contract is yours, the funded account is not                  | Sitting — keep shipping                                             |

---

## 1 · Mental model (so you don’t rebuild the wrong plane)

| Plane                       | What it is                                                                               | Your focus                                                                                   |
| --------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **Fiat / custodial**        | Trade, bank ledger, pay gateway, cards that hold balances                                | **Not primary** — Nitro/Denon residual; you only touch **adapters that move value on-chain** |
| **Protocol / self-custody** | Smart accounts, AMM, lending, escrow, merchant contracts, launch factory, INTACHAIN path | **Primary — this board**                                                                     |
| **Shell**                   | Vendor Vue shell                                                                         | Nitro wires UI after your APIs/events                                                        |

Definitive build promise: **sovereignty by architecture** — non-custodial plane never pretends to be custodial. Hyperliquid-class **honest sequencing**: contracts on proven EVM rails first, native chain later.

---

## 1.5 · ALREADY ON MAIN — do not rebuild (added 2026-08-07)

This board was written on 2026-08-03 against a picture that was already out of date, and the tracker rows it points at carried ownership stamps instead of state. The result: **four Tier A items read as greenfield and are substantially built.** Re-deriving any of this is our error, not yours.

| Board item                       | Already merged                                                                                                                                                                                        | What is actually left                                                                                                                                                            |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **S-A2 AMM**                     | Compile fix — private `_swap`, external ABI unchanged (**#228, yours**). PoolFactory on the dev chain (**#264**). **mint + swapExactIn proven on a real chain** (**#288**). Pure maths module tested. | **Invariants + LP suite shipped** (`src/amm/invariants.test.ts`) · oracle must NOT read AMM (S-A12) · `audited` stays false                                                      |
| **S-A7 Launch / token factory**  | Fixed-supply ERC-20 + CREATE2 factory, own pinned suite, **proven end to end on the dev chain**, refuses a zero factory before any arithmetic, `audited:false` deliberate (**#217**)                  | The audit itself · launch fee (Fiat Plane) · meme/vesting/NFT surfaces (Tier G)                                                                                                  |
| **S-A8 Toolchain pin**           | solc 0.8.28 pinned, artefacts committed with a re-derived source hash, contracts run against anvil in CI (`REQUIRE_EVM_CHAIN=1`), one `EXPECTED_SOLC` shared with the indexer                         | **Forge fuzz + gas ceilings in CI** (`test/forge`), including session-key escalation / re-entrancy / validateUserOp. Residual: external audit. solc-js still compiles artefacts. |
| **S-A1 Smart accounts (partly)** | SmartAccount / AccountFactory / SessionKeyLib compile and run; **31 contract tests incl. the CREATE2 cross-check** (**#210**); typed refusals on every chain path (**#193**); userop hashing built    | **The adversarial audit package** · S-A9 verifier · S-A11 differential check · gas ownership (S-A10/S-A11)                                                                       |

**Your genuinely greenfield Tier A front is four items: S-A3 escrow · S-A4 lending · S-A5 router · S-A6 merchant contracts.**

---

## 2 · Insane task matrix (blockchain / crypto)

### Tier A — Protocol P0 (ship value in weeks, tip already has seeds)

| ID        | Outcome                                           | What’s already on tip (lead)                                                                                                                   | Done bar (proof)                                                                                                                                                                                                      | Spec freely                                                                                                                    |
| --------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **S-A1**  | **Smart accounts production-ready**               | `SmartAccount.sol`, `AccountFactory`, session keys, CREATE2 tests, registry                                                                    | Deploy path documented · adversarial **audit package** (threat model + findings + fix or residual) · passkey/session flows proven on **configured** env (not “code exists”)                                           | Session key policy, factory upgrades. **Recovery: see the doctrine note below — this row no longer invites a guardian design** |
| **S-A2**  | **AMM suite honest**                              | `PoolFactory`, `ConstantProductPool`, mint/swap onchain tests                                                                                  | Compile clean · mint/swapExactIn proof on dev chain · invariants tests · `audited` flag path honest (no fake audited:true)                                                                                            | Fee tiers, LP accounting, oracle coupling later                                                                                |
| **S-A3**  | **On-chain P2P escrow**                           | `SovereignEscrow.sol` (+ MockERC20 test token) under `contracts/escrow/` · ADR `2026-08-08-sovereign-p2p-escrow`                               | lock → release / refund / dispute → keeper timeout · no platform key · deal amount zeroes on exit                                                                                                                     | Multi-asset, fee-split richness, service wiring                                                                                |
| **S-A4**  | **Lending markets P0**                            | `protocol.lending` tracker residual · SPEC-LENDING                                                                                             | Collateral in **contracts** not ledger · LTV from oracle marks · permissionless liquidation keepers · refuse invent rates                                                                                             | Isolation modes, IFC collateral                                                                                                |
| **S-A5**  | **Sovereign router**                              | `protocol.router`                                                                                                                              | Best of book vs pool **without invent prices** · quote proof · fail closed                                                                                                                                            | Split routes, MEV notes                                                                                                        |
| **S-A6**  | **Merchant contracts (zero-KYB architecture)**    | §24 sovereign rails                                                                                                                            | Merchant deploys to **their** smart account · accept address · auto-split · optional convert via router · platform never in flow of funds                                                                             | Sub-merchant trees, invoice metadata                                                                                           |
| **S-A7**  | **Launch / token factory honest**                 | `TokenFactory`, `SovereignToken`, launch.status honesty notes                                                                                  | CREATE2 deploy proof · refuse zero factory · **audited:false until real audit** · no sell of unaudited as live                                                                                                        | Meme factory, vesting, staked allocation tiers                                                                                 |
| **S-A8**  | **Contract compile + pin toolchain**              | solc pin shared with indexer                                                                                                                   | One EXPECTED_SOLC · CI green · no “works on my laptop” solc                                                                                                                                                           | Foundry/hardhat policy if you upgrade                                                                                          |
| **S-A9**  | **Passkey (P-256) verifier contract**             | `PasskeyOwner` + `P256` (RIP-7212) under `contracts/passkey/` · ERC-1271 for SmartAccount                                                      | On-chain WebAuthn-bound verify · gas via RIP-7212 (~3.5k verify when present) · bridge tests vs identity assertions · audit package skeleton in `docs/audits/`                                                        | Origin/rpId on-chain allowlist · EntryPoint differential · external audit                                                      |
| **S-A10** | **Who pays gas — paymaster + sponsorship policy** | `socket.paymaster-policy` · every paymaster field already exists in `src/chain/userop.ts`, nothing decides who pays                            | A funded path from "user has zero native token" to "operation executes" · sponsorship rules · abuse refusal · **the funding account is a Nitro decision, the contract is yours**                                      | Sponsorship tiers, session-key-scoped sponsorship                                                                              |
| **S-A11** | **Bundler dependency — public or self-hosted**    | `socket.bundler-policy` · `PROTOCOL_BUNDLER_URL` optional with no decision behind it                                                           | Choice stated with its failure mode (a public bundler can censor or reorder a user's operation) · fallback path when it is down · **plus** the live-EntryPoint differential check (`socket.userop-differential-test`) | Self-hosting plan, redundancy                                                                                                  |
| **S-A12** | **Price oracle for marks and liquidations** 🔴    | `socket.price-oracle` · **S-A4 lending cannot ship without it**; existed only as an ADR line                                                   | Source set · staleness bound · disagreement rule between sources · **fail closed (refuse to liquidate), never a fallback price**                                                                                      | TWAP vs feed, own-pool oracles, IFC marks                                                                                      |
| **S-A13** | **Deployment registry + explorer verification**   | `socket.deployment-registry` · every address in `env.ts` defaults to zero; bytecode-vs-template proof already solved (immutable ranges masked) | A tracked artefact: these addresses, this chain, this source hash, verified on this explorer · reproducible by a third party                                                                                          | Multi-chain topology (S-K4), upgrade records                                                                                   |

> **Doctrine note on recovery (resolved 2026-08-07).** This board previously invited a guardian / multi-sig recovery design, while `socket.social-recovery` in the tracker forbids one: _"a guardian is a second party who can take the account, and the platform must never be one."_ **The tracker wins.** What you may design: guardians the **user** elects and can revoke, where no platform-controlled key is ever eligible and no platform quorum can move funds. If that cannot be built without the platform becoming a party, the honest answer is that it stays a socket — say so rather than shipping it. **Permitted shape shipped:** `UserElectedRecovery` (user elect/revoke, delay, no platform key). **This PR proves** a SmartAccount may take it as owner. Residual: still not the factory default.

🔴 = named nowhere before 2026-08-07 and blocking something that is already on this board.

### Tier B — Crypto rails that stay on-chain / adapter-isolated

| ID       | Outcome                                         | Done bar                                                                                                                          | Collision note                                                          |
| -------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **S-B1** | **Crypto-native pay acceptance (on-chain leg)** | Deposit address / watch / confirm policy for USDT/USDC/BTC/ETH-class assets · **adapter interface** only · no partner names in UI | Coordinate with pay residual owners — don’t rewrite open #346 files     |
| **S-B2** | **Hot-wallet / mnemonic perimeter**             | Runbooks + tests for env posture · secrets never in repo · align `docs/A1.4-WALLET-SECRETS-PERIMETER`                             | Class X prod keys still Nitro human                                     |
| **S-B3** | **IFC on-chain representation**                 | §17.3 path: how IFC appears on EVM rails without double-mint vs ledger token                                                      | Spec ADR first if ambiguous                                             |
| **S-B4** | **Buyback/burn on-chain observability**         | If buyback posts to chain, events indexer can project                                                                             | Custodial buyback stays token service — you own **chain events** if any |
| **S-B5** | **Bridge design (canonical IFC)**               | `bridge.canonical` research + threat model + phased build                                                                         | Don’t invent bridge security theater                                    |

### Tier C — Indexer / venue contracts (chain → read models)

| ID       | Outcome                                 | Done bar                                                                                                                                                                               | Collision                                               |
| -------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **S-C1** | **Real venue contracts (not DevVenue)** | **Shipped this PR.** `SovereignVenue` — matching CLOB, same BookLevel/Fill/Position as the indexer. Residual: external audit + public deploy address.                                  | Indexer adapter exists; DevVenue stays a fixture        |
| **S-C2** | **Reorg-safe event surface**            | **Shipped this PR.** Tip replace + 5-block history discard on SovereignVenue BookLevel (`sovereign-venue-reorg.onchain.test.ts`). Indexer unwind remains `reorg.live.test.ts` on 8546. | Pair with indexer; do not share 8545 with indexer reorg |
| **S-C3** | **Permissionless position/fill events** | Event matrix is the three events on `SovereignVenue` (same as indexer ABI). Don’t invent futures mids.                                                                                 | WS transport is `socket.indexer-stream` (unowned)       |

### Tier D — INTACHAIN L1 epic (honest sequencing · §17 — YOU OWN THIS)

This is the **own-the-chain** mountain. Freedom to design the full PR DAG. **Communication gate:** before P1 implement, land an **ADR/plan PR** on tip (Nitro + Denon can see), then ship.

| ID       | Outcome                                  | Done bar                                                                                                                                                                                                                                         |
| -------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **S-D0** | **Plan-first handshake**                 | ADR/plan PR: attack order, stack choice, risks, what is P0 vs P1 — **before** large P1 code · **Proposed 2026-08-08:** [`docs/adr/2026-08-08-protocol-plane-p0-handshake-and-rails.md`](adr/2026-08-08-protocol-plane-p0-handshake-and-rails.md) |
| **S-D1** | **P0 rails ADR**                         | Which EVM L2 / HyperEVM / anvil for contract suite v1 · no fantasy “mainnet next week” · **Proposed same ADR:** anvil CI kept; Base Sepolia → Base mainnet proposed; HyperEVM optional later; **Nitro rules** (§0.5)                             |
| **S-D2** | **INTACORE module map**                  | Spec: on-chain CLOB, margin, one-block finality SLOs (§20) until P0 contracts live                                                                                                                                                               |
| **S-D3** | **Validator / staking architecture**     | IFC staking secures validators · honest vs ledger `stakeOf`                                                                                                                                                                                      |
| **S-D4** | **P1 own chain (CometBFT / Cosmos SDK)** | `chain.mainnet` phased milestones · native CLOB module (dYdX v4-class) · not vapor `done`                                                                                                                                                        |
| **S-D5** | **INTAEVM**                              | EVM module sharing validator set / state with INTACORE                                                                                                                                                                                           |
| **S-D6** | **svc-chain**                            | Node ops, validator tooling, chain config (§17.5)                                                                                                                                                                                                |
| **S-D7** | **svc-bridge**                           | Fiat↔Protocol canonical IFC bridge + attestations (§17.3 / §17.5)                                                                                                                                                                                |
| **S-D8** | **P2 rust CLOB core**                    | Shared matching-spec target with Fiat Plane engine · throughput SLOs                                                                                                                                                                             |
| **S-D9** | **P3 progressive decentralisation**      | Validator open schedule · IFC governance parameter control                                                                                                                                                                                       |

**Tracker gravity:** `chain.mainnet` · `chain.evm` · `chain.validators` · `chain.governance` · `chain.rust-core` · `bridge.canonical` · owner `shehzad002`.

### Tier E — Sovereign card / JIT (contract half)

| ID       | Outcome                   | Done bar                                                                                                                                                                                             |
| -------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **S-E1** | **JIT funding contract**  | **Shipped #2470.** `CardPull` — exact `transferFrom` owner SA → user settlement; kill strands zero; session may call `pullExact`. Live issuer rail is still Nitro (`socket.live-issuer`). Unaudited. |
| **S-E2** | **IFC cashback on-chain** | Cashback mint/transfer policy + events                                                                                                                                                               |
| **S-E3** | **Adapter boundary**      | **Shipped this PR.** `ICardPull` + `issuer-adapter.ts` calldata. No issuer key, mnemonic, or PAN. Live rail is still Nitro (`socket.live-issuer`). Unaudited.                                        |

### Tier F — Web4 / attestations (on-chain standing, zero PII)

| ID       | Outcome                            | Done bar                                                             |
| -------- | ---------------------------------- | -------------------------------------------------------------------- |
| **S-F1** | **Rank/reputation attestations**   | On-chain attestations, zero PII · verify without identity disclosure |
| **S-F2** | **Blueprint attestation issuance** | Phase 4 hook: proof packages                                         |
| **S-F3** | **Portable crew/perk claims**      | Spec + minimal verifier                                              |

### Tier G — Launchpad / NFT / RWA (crypto surfaces)

| ID       | Outcome                                | Done bar                                                                                                                                  |
| -------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **S-G1** | **Meme factory + instant market + LP** | Depends AMM honesty                                                                                                                       |
| **S-G2** | **Presale / fair launch / vesting**    | Staked allocation tiers via stakeOf **read**, no invent                                                                                   |
| **S-G3** | **NFT mint/list/auction + royalty**    | On-chain royalty enforcement                                                                                                              |
| **S-G4** | **RWA registry**                       | **Shipped #2469 (contract half).** `RwaRegistry` refuse-closed on `bytes32(0)` licenceHash. Licence _content_ remains Class X. Unaudited. |

### Tier H — Mining / MatMul PoW interface (crypto)

| ID       | Outcome                                   | Done bar                                            |
| -------- | ----------------------------------------- | --------------------------------------------------- |
| **S-H1** | **Share protocol + epoch allocation API** | svc-token remains only minter; pool requests epochs |
| **S-H2** | **Difficulty / epoch proofs**             | From token paper — no invent emission               |

### Tier I — DEX self-custody surface (`svc-dex`)

| ID       | Outcome                                        | Done bar                                                                                                                                                                                                                                                                                                                                                         |
| -------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **S-I1** | **Pool interface + self-custody flows**        | Contract-held liquidity · no platform custody masquerade                                                                                                                                                                                                                                                                                                         |
| **S-I2** | **Quote integrity**                            | Fail closed without invent. **Already true on main** — `dex.quote-router` sources live prices, enforces a staleness bound against its own read, has no cache and no fallback, and refuses 503 naming every dead venue. What it lacks is a venue that answers, and that is Nitro's decision (§0.5)                                                                |
| **S-I3** | **Authoritative venue fees + settlement cost** | **Shipped this PR (dex).** CLOB no silent 0: both knobs from the venue or omit both. Residual: internal-book 20bps still configured; quote path does not `eth_call`.                                                                                                                                                                                             |
| **S-I4** | **Execution against a quoted venue** 🔴        | `socket.dex-execution` — and note the size the one-line title hides: this needs a **Venue Vault** (§27) and an **OMS service that does not exist** (§28, `services/svc-execution`). Today every adapter declares quote-only and `submit()` throws loudly rather than returning a plausible rejection. Keep the refusal loud until the vault and the OMS are real |

### Tier J — Security / audit factory (your senior edge)

| ID       | Outcome                            | Done bar                                                                                                                                                                                                                 |
| -------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **S-J1** | **Audit pipeline in svc-protocol** | **Shipped #2472.** `src/audit/pipeline.ts` + `auditStatus` — artefact hash, who signed. Internal package cannot set `audited:true`. External firm still Nitro (`socket.contract-audit`). **Not a reason to ping Nitro.** |
| **S-J2** | **Adversarial suites**             | Reentrancy, oracle manipulation, session key theft, factory griefing                                                                                                                                                     |
| **S-J3** | **Incident runbooks**              | **Shipped #2471.** `docs/ops/INCIDENT-PROTOCOL-RUNBOOK.md` — relay kill only; no pause/upgrade; recovery is user-elected. Money-path incidents stay on Denon's runbook.                                                  |

### Tier K — Spec / ADR factory (plan completeness — you write freely)

| ID       | Topic                                                                                                           |
| -------- | --------------------------------------------------------------------------------------------------------------- |
| **S-K1** | Market-id on **protocol plane** vs edge/matching (coordinate Denon — don’t silently redefine custodial markets) |
| **S-K2** | Oracle policy for lending/liquidation (sources, refuse-not-invent)                                              |
| **S-K3** | Upgradeability vs immutable factories                                                                           |
| **S-K4** | Multi-chain deployment topology                                                                                 |
| **S-K5** | Testnet faucet / mint policy for IFC-on-EVM                                                                     |
| **S-K6** | Cross-plane identity: rank travels without PII                                                                  |
| **S-K7** | **Inheritance vs the never-a-guardian rule** — settles S-L2 (see below). Write this one before any vault code   |

### Tier L — Vaults, privacy and trust (added 2026-08-07)

Every row here was a **counted gap** in `tooling/coverage.yaml`: the law named the capability, no task carried it, and the ratchet held the number so it could not quietly grow. **Counted is not assigned** — a chain engineer reading this board could not see any of them, so the previous handover was not the complete scope it claimed to be. All six now exist as tracker rows with an owner, and the gap entries are closed.

| ID       | Outcome                         | Why it was not visible                                                                                                                   | Done bar                                                                                                                                                                                                                                      |
| -------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **S-L1** | **Crew vaults** (§33)           | Crews are `done` as a social object; a shared treasury for one is a contract and had no row in any form                                  | Member shares · M-of-N spend threshold · **a defined split on exit, designed before anyone deposits** · money-path invariant tests                                                                                                            |
| **S-L2** | **Legacy vaults** (§34)         | **Arrived with a contradiction.** §34 describes guardian M-of-N recovery; `socket.social-recovery` forbids the platform being a guardian | **Shipped #2362.** S-K7 ADR then LegacyVault: user-set/revocable heirs, inactivity + challenge-window abort via heartbeat, staged tranche claim. No platform key, no guardian role. Residuals: multi-asset, attestation claims, public deploy |
| **S-L3** | **Stealth handles** (§26)       | `blueprint.attestations` covered the zero-PII half; the receiving half had no row                                                        | **Shipped #2363 + scanner this PR.** Two ephemerals → two unlinkable presentations; StealthAnnouncer has no user id; ERC-5564 scheme-1 ECDH scan of logs. Residual: unaudited. keccak P0 presentations are not ECDH matches.                  |
| **S-L4** | **Launch trust layer** (§35)    | The law calls trust the moat in meme season; the anti-rug architecture was missing without being recorded as missing                     | **Shipped this PR.** LaunchLpLock + LaunchVesting (no admin unlock) + DeployerReputation counts. Empty history cannot render as a clean badge.                                                                                                |
| **S-L5** | **Treasury yield vaults** (§36) | `launch.rwa` recorded the licence blocker for one half of the pair and nothing recorded the other                                        | **Shipped #2363 (contract half).** TreasuryYieldVault refuse-closed on bytes32(0) licenceHash. Licence _content_ remains Class X                                                                                                              |
| **S-L6** | **Venue Vault** (§27)           | `venue.aggregation` has admitted "Venue Vault absent" in its own note since 2026-08-02 with no row behind it                             | **Shipped #2363.** Per-user AES-256-GCM vault; withdrawal/internal-transfer refused at register. Residuals: HSM KEK, durable store, svc-trade/OMS wiring. Still the hard blocker under S-I4 until those residuals + OMS exist                 |

**Yours because it is key custody, not because it is protocol plane** — S-L6 holds credentials to _custodial_ venues. The split: the vault design, key handling and refusal are yours; wiring svc-trade to a vault that exists is agent work.

**Three more gaps closed and deliberately NOT given to you**, so the boundary stays where the ownership law puts it:

- `ops.custody` — how the platform holds its own funds. The multi-sig contract and hot-wallet perimeter are yours (already S-B2); the tiering policy and approval console are agent work; real keys are Class X.
- `launch.fundraising` and `launch.structured` — fiat-plane product surfaces. Their on-chain legs (milestone escrow, vesting, wrappers) are yours under S-L4 and S-G2.

**Still open and not chain work:** 30 counted gaps remain — trading engines, quant, mobile apps, CRM, tax, B2B infra. That is a product-scope question for Nitro and Denon, not a hole in this board.

---

## 3 · Suggested attack order (reorder when deps force)

**Reordered 2026-08-07** — the old order opened on S-A2 (AMM), which is already proven on a chain (§1.5), and it did not contain S-A9/S-A12 at all even though S-A1 and S-A4 depend on them.

1. **S-D0** plan PR + **S-D1** rails ADR — unchanged, still first
2. **S-A1** smart-accounts **audit package** + **S-A9** passkey verifier — the verifier is what makes the row's own title true on-chain
3. **S-A3** escrow + **S-A6** merchant contracts — the sovereign-rails story, and the largest genuinely greenfield value
4. **S-A12** oracle → then **S-A4** lending + **S-A5** router — lending without the oracle is not startable
5. **S-C1** real venue contracts — closes `socket.clob-contracts` and makes both svc-indexer and svc-dex honest at once
6. **S-A10 / S-A11** gas ownership + bundler decision + **S-A13** deployment registry — before anything leaves the dev chain
7. **S-A2 residual** (invariants, LP accounting) + **S-A7 residual** (audit) + **S-G\*** as oxygen
8. **S-E\*** sovereign card contract half when SA is solid
9. **S-D2–D4** INTACHAIN long path (spec-heavy, no vapor done)
10. **S-J\*** continuous audit factory, running alongside from step 2

Parallel: 2–4 worktrees inside **protocol/contracts only** is fine.

---

## 4 · Rules (same bar as rest of monorepo)

1. Tip worktree · one concern per PR · CI green
2. **Never invent** prices, funding rates, oracles, factory addresses, “audited:true”
3. Custodial value still only via `packages/ledger-client` when you touch fiat plane
4. Partner names in adapters only, not user-facing copy
5. Sandbox/dev proof OK; **Class X** (mainnet live money posture) needs Nitro
6. Tracker/scoreboard moves only with **proof**
7. Prefer **honest §13 socket** over fake Done
8. When blocked: research pack on tip → thinner real vertical → residual owned

---

## 5 · Implicit requirements (Nitro unspoken → your mandate)

| Unspoken need                                | Your job                                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Insane parallel without stealing shell swarm | This board only                                                                                         |
| Blockchain senior not micro-managed          | You spec PR DAGs                                                                                        |
| Plan complete, no silent gaps                | Tiers A–K named; expand freely inside crypto plane                                                      |
| Denon not dual-built                         | Collision wall §0                                                                                       |
| Vendor shell is UI, not “skip chain”         | Protocol plane still full product                                                                       |
| Quality of elite chain engineer              | Audit packages, fail closed, no vapor                                                                   |
| **Never sent at merged work**                | §1.5 exists for this. If a row here disagrees with `main`, `main` wins and this board is wrong — say so |
| **Owner-gated walls are visibly Nitro's**    | §0.5. Naming a blocker is progress; sitting on one silently is not                                      |

---

## 6 · Cold start for your agents

```
git fetch origin main
Read: INTAFACED_DEFINITIVE_BUILD.md §16–§25 (especially §17 INTACHAIN)
Read: docs/GITHUB-OWNERSHIP-SHEHZAD.md
Read: docs/THREE-WAY-DISTRIBUTION-2026-08-04.md
Read: docs/SHEHZAD-BLOCKCHAIN-TASK-BOARD-2026-08-03.md (this file) — §1.5 FIRST: four Tier A items are already merged
gh pr list — do not touch open Denon paths or vendor shell
Claim: LIVE-LANES shehzad-protocol-chain
Worktree from tip · svc-protocol contracts first (P0) · plan PR before P1 L1
Ship: PR with proof (forge/anvil tests, audit package path, ADR link)
```

---

## 7 · #346 pay handoff — CLOSED 2026-08-06

**Nothing is owed here.** #346 **merged on 2026-08-06**, and the merge comment on the PR records that his source landed unmodified — every line of `payment-service.ts`, `router.ts`, `schema.ts`, the migrations, the tests and `card-sandbox-e2e.mjs` as written; only board files were touched. Custodial pay is reclaimed for Nitro agents from tip.

This section previously asked him to "finish or hand off #346". That instruction is dead and is struck rather than deleted, because a task that vanishes reads as a task nobody ever set.

**Standing:** do not open new pay product PRs.

---

## 8 · One-breath message (paste to Shehzad)

```
Shehzad — blockchain / Protocol Plane board is yours. Board delta landed 2026-08-07.

FIRST: §1.5 of the board — four Tier A items are ALREADY MERGED and must not be rebuilt.
AMM compiles and mint/swapExactIn is proven on a real chain (#228 yours, #264, #288).
Token factory proven end to end (#217). Toolchain pinned + contracts running in CI (#210).
Smart-account contracts land, run and cross-check CREATE2 — what is missing there is the
AUDIT PACKAGE, not the contracts.

Your greenfield front: escrow (S-A3), lending (S-A4), router (S-A5), merchant contracts (S-A6).
Newly named and yours: S-A9 passkey P-256 verifier contract (the one that makes "passkey smart
accounts" true on-chain), S-A10 who pays gas / paymaster, S-A11 bundler decision, S-A12 price
oracle (S-A4 cannot start without it), S-A13 deployment + verification registry, S-I3 venue fees,
S-I4 execution (Venue Vault §27 + an OMS service that does not exist yet).

NEW TIER L — six capabilities the LAW names and this board never did. They were counted as gaps
in tooling/coverage.yaml, so the repo knew and no engineer could see them: S-L1 crew vaults
(shared multi-sig treasuries), S-L2 legacy vaults (inheritance), S-L3 stealth handles (receive
on-chain unlinkably), S-L4 launch trust layer (enforced LP locks + vesting — the law calls trust
the moat in meme season), S-L5 tokenised treasury-yield vaults, S-L6 Venue Vault (external venue
API keys — the hard blocker under S-I4, and venue.aggregation has admitted it was absent since
2026-08-02 with no row behind it).

Recovery / inheritance: doctrine wins — the platform is NEVER a guardian. S-K7 ADR
accepted; S-L2 LegacyVault (this PR) is user-elected heirs + time locks only — no
platform key ever eligible. Multi-asset / attestation claims stay residual.

#346 is merged (2026-08-06), your source landed unmodified. Nothing owed. No pay expand.

Blocked-on-me and not on you (board §0.5): which venue we quote, audit budget, testnet/RPC
funding, which EVM chain P0 targets (you propose in S-D1), Class X, gas sponsorship funding.
Hit one of these — say so and move on, do not sit on it.

Unchanged: sole mountain Protocol Plane + INTACHAIN · you design PR DAGs · ADR/plan PR before
large P1 · proof in the PR body · honest §13 socket over fake Done.

Law on tip: docs/SHEHZAD-BLOCKCHAIN-TASK-BOARD-2026-08-03.md · docs/GITHUB-OWNERSHIP-SHEHZAD.md
· docs/THREE-WAY-DISTRIBUTION-2026-08-04.md · INTAFACED_DEFINITIVE_BUILD.md §16–25.
Confirm + first chain step (or S-D0 ADR link) when you start.
```
