# Protocol P0 full spec — Base rail, not our L1

**Status:** Binding spec for the later **plan**. Not the plan. Not a deploy.  
**Date:** 2026-09-18  
**Tip at write:** `origin/main` `80e66c177`  
**Owner this wave:** this program (Shehzad wait cancelled).  
**Parents:** [`PROTOCOL-P0-TAKEOVER-CALIBRATION-2026-09-18.md`](PROTOCOL-P0-TAKEOVER-CALIBRATION-2026-09-18.md) · [`PROTOCOL-P0-EXECUTION-SPLIT-2026-09-18.md`](PROTOCOL-P0-EXECUTION-SPLIT-2026-09-18.md) · park ADR 2026-09-03 · P0 rails 2026-08-08.

**One sentence:** Put the **already-written** self-custody suite on **Base Sepolia (84532)**, prove a stranger can use a smart account to trade **SovereignVenue** and the other rooms **without us holding tokens**, label it testnet / not INTACHAIN / `audited:false`. Do **not** build an L1. Do **not** rebuild the house book.

---

## 0 · Unspoken needs (tests for this spec)

| Need                           | Failure if ignored                                |
| ------------------------------ | ------------------------------------------------- |
| Don’t wait on a silent partner | Any Shehzad gate                                  |
| Don’t spend L1 money           | `svc-chain`, genesis, Arc-as-home                 |
| Don’t fake HFT                 | Solidity matching sold as Hyperliquid             |
| Don’t fake a chain             | INTACHAIN / `audited:true` on Sepolia             |
| Don’t thin-spec                | A room exists on `main` but has no Sepolia needle |
| Don’t mash OMS                 | Rebuild Fiat `svc-execution` to “fill” our venue  |
| Don’t dual-deploy              | Second rail “just in case”                        |
| He can’t read diffs            | Needles in English + explorer                     |
| Vue isn’t this program         | Protocol Done claimed from `:8090`                |
| Tokens exist to spec deep      | Rooms named, not “etc.”                           |

---

## 1 · What the product is (two planes)

INTAFACED is **one product, two shops**.

| Plane              | User gets                                       | Finality       | This spec                         |
| ------------------ | ----------------------------------------------- | -------------- | --------------------------------- |
| **House (Fiat)**   | CEX speed: matching, bank, pay, cards-as-ledger | Ledger post    | **Out.** Already running.         |
| **Protocol (P0)**  | Self-custody: keys, contracts on **Base**       | Chain tx       | **In.**                           |
| **INTACHAIN (P1)** | Own L1 + in-validator book + IFC gas            | Chain finality | **Parked.** Specs exist. No code. |

A user may hold **both**. Mixing a house fill into a protocol blotter without labelling the plane is a lie.

---

## 2 · Competitive landscape (2026-09-18) — what we copy vs refuse

Live Base (DefiLlama): ~**$5.6B** TVL, ~**$5B** stables (~~85% USDC), DEX volume is **AMMs**, order-book _category_ on Base is **rounding error** (~~$0.8M). Morpho >> Aave. Hyperliquid is the perps volume winner on a **custom L1**, not Solidity.

| 2026 fact                                    | We do                                                                                   | We do not                                                      |
| -------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Native **USDC** is Base’s dollar             | Venue quote + gas story uses **Circle native USDC** on Sepolia. Never USDbC. Never IFC. | Deploy a house dollar                                          |
| Uniswap / Aerodrome **are** Base’s book      | Prove **our** AMM that already exists. Uni/Aero as _external liquidity_ is later.       | Rewrite AMM to chase Aero                                      |
| Morpho is Base lending                       | Prove **our** isolated market + fail-closed oracle that already exist                   | Fork Morpho                                                    |
| ERC-4337 + Pimlico/Alchemy live on **84532** | Default bundler **Pimlico**. Paymaster contract already refuses unfunded.               | Wait for native AA (vibenet-only, no fork date)                |
| Coinbase Smart Wallet / EIP-7702             | **Accept** as senders if they can call our contracts. Don’t rebuild CBSW.               | Block P0 on 7702                                               |
| Flashblocks 200ms preconf                    | **Nice** for receipts. Venue must work on ordinary 2s blocks.                           | Claim 200ms matching                                           |
| On-chain CLOB on generic EVM (Clober/Hanji)  | **Honest thin book** — proof of self-custody trade, not volume                          | “Beat Hyperliquid”                                             |
| Vertex/Nado/Aevo hybrid                      | —                                                                                       | Off-chain matcher advertised as on-chain                       |
| HIP-3                                        | —                                                                                       | List on HyperCore (tenant of HL)                               |
| Arc (Circle L1, 16 Sep 2026)                 | Watch                                                                                   | Home rail                                                      |
| CoW / UniswapX intents                       | Later leftover router                                                                   | P0 solver network                                              |
| Loopring-shaped own zk/L1 book               | —                                                                                       | INTACHAIN parked; they shut down 2026 and broke trustless exit |
| Stealth / RWA / launchpads                   | **Prove rooms we already shipped**                                                      | New launchpad product as P0 must                               |

**Honest one-liner:** keys (4337) → native USDC in a contract the user can exit → fills only from that contract’s matching → our other rooms as already written → house CLOB stays the fast book.

---

## 3 · Complete inventory (every 3P room)

Nothing in this table is “etc.” Planning that drops a **Must** row is incomplete. **Prove** = Sepolia needle. **Skip-honest** = leave anvil-only with a written residual, not silent.

| #   | Room                                         | On `main` already                   | This-wave bar                                            | Competitive class                |
| --- | -------------------------------------------- | ----------------------------------- | -------------------------------------------------------- | -------------------------------- |
| 1   | Smart account + factory + session keys       | Yes                                 | **Must prove** on 84532                                  | Must                             |
| 2   | Passkey (P-256 / RIP-7212)                   | Yes                                 | **Prove** or honest anvil-only residual                  | Must-adjacent                    |
| 3   | User-elected recovery (no platform guardian) | Yes                                 | **Prove** or honest residual                             | Must-adjacent                    |
| 4   | Paymaster contract                           | Yes (unfunded refuse)               | **Must** keep refuse; float is you                       | Must                             |
| 5   | Bundler                                      | Env optional today                  | **Must** pick Pimlico on 84532 + down-path               | Must                             |
| 6   | Deployment registry + explorer verify        | Format exists, rows empty           | **Must** non-zero Sepolia rows                           | Must                             |
| 7   | SovereignVenue CLOB                          | Yes                                 | **Must** deposit/place/cancel/withdraw + indexer         | Must (honest venue)              |
| 8   | Indexer on published venue                   | DevVenue fixture                    | **Must** `INDEXER_VENUE_ADDRESS` = registry              | Must                             |
| 9   | Reorg-safe events                            | Tests exist                         | **Must** stay true on Sepolia                            | Must                             |
| 10  | AMM (our ConstantProductPool)                | Yes                                 | **Must** mint+swap on published pool                     | Must (our pool, not Uni rewrite) |
| 11  | Router                                       | Yes                                 | **Prove** quotes without invent; no venue = refuse       | Must-adjacent                    |
| 12  | Lending + fail-closed oracle                 | Yes                                 | **Prove** supply/borrow or refuse-closed on unset oracle | Nice-prove (we have it)          |
| 13  | Escrow                                       | Yes                                 | **Prove** lock→release/refund                            | Nice-prove                       |
| 14  | Launch token factory                         | Yes                                 | **Prove** CREATE2, `audited:false`                       | Later-prove                      |
| 15  | Launch trust (LP lock, vesting, reputation)  | Yes                                 | **Prove** or honest skip                                 | Later-prove                      |
| 16  | NFT royalty                                  | Yes                                 | Honest skip allowed                                      | Later                            |
| 17  | RWA registry                                 | Yes (zero-hash refuse)              | **Prove** refuse; licence content is you                 | Later                            |
| 18  | Merchant accept                              | Yes                                 | **Prove** or honest skip                                 | Later-prove                      |
| 19  | Stealth announcer + scan                     | Yes                                 | **Prove** announce; wallet scan is later                 | Later                            |
| 20  | Crew vault                                   | Yes                                 | **Prove** or honest skip                                 | Later                            |
| 21  | Legacy vault                                 | Yes                                 | **Prove** or honest skip                                 | Later                            |
| 22  | Treasury yield vault                         | Yes (licence refuse)                | **Prove** refuse; licence is you                         | Later                            |
| 23  | Rank attestations (zero PII)                 | Yes                                 | Honest skip allowed                                      | Later                            |
| 24  | CardPull seam                                | Yes                                 | **Must not** grow a live issuer                          | Socket                           |
| 25  | Audit pipeline (S-J1)                        | Yes                                 | **Must** keep `audited:true` fake-refuse                 | Must                             |
| 26  | Indexer WS tape                              | Unowned socket                      | **Nice**; pull path is enough for P0                     | Nice                             |
| 27  | External DEX venues / execute                | Fiat OMS exists; `submit()` refuses | **Socket** until you name venues                         | Trap if mashed with 7            |
| 28  | IFC on-chain / cashback mint / bridge        | None                                | **Out**                                                  | Parked                           |
| 29  | Predict                                      | Resolution specced                  | **Out** until INTACORE                                   | Parked                           |
| 30  | MPC custody                                  | Socket                              | **Out**                                                  | Owner                            |
| 31  | Vue desk                                     | Codex                               | **Out** of this spec                                     | After addresses                  |

---

## 4 · Cross-cutting rails (apply to every Must)

### 4.1 Chain

- **84532** Base Sepolia. RPC owner-set (`PROTOCOL_RPC_URL`). Public HTTP `https://sepolia.base.org` is fine for deploy; indexer needs a **WS-capable** provider (public HTTP has no WS).
- `PROTOCOL_CHAIN_ID` refuse-closed when blank. Never default 31337, 8453, or **5042**.
- Labels on every public surface: **testnet**, **not INTACHAIN**, **`audited: false`**.

### 4.2 Money

- Protocol **never** writes `packages/ledger-client`.
- Amounts: decimal **strings** off-chain; `uint256` 18-dec on venue (already).
- **Quote asset = Circle native USDC on Base Sepolia** (Circle’s published USDC address for 84532). Refuse USDbC. Refuse a token named IFC. Base token for the first venue: a test ERC-20 we deploy, or ETH wrapped only if USDC pair is the quote — first market is **TEST/USDC** (test base, native USDC quote).
- Paymaster float (ETH or USDC sponsorship) is **you**. Unfunded = refuse. That is Done, not a sit.

### 4.3 4337

- EntryPoint: canonical v0.7 (already in-repo hash/differential). Do not deploy a private EntryPoint as “ours.”
- Bundler: **Pimlico** `base-sepolia` unless the implementer names another **live** 84532 bundler in the plan.
- Down-path: bundler unavailable → user can still send a plain tx from an EOA/CBSW if they have gas. Never a silent drop.
- Native AA / Cobalt / EIP-8130: **out**. Vibenet only.

### 4.4 Registry

- JSON under `services/svc-protocol/deployments/` per S-A13: `chainId` 84532, `chainName` `base-sepolia`, per contract `name/address/suite/sourceHash/explorerUrl/verified`.
- Env defaults stay **zero** until that file exists.
- Third party can match `sourceHash` to committed `contracts/out`.

### 4.5 Indexer

- `INDEXER_VENUE_ADDRESS` = SovereignVenue in the registry. Empty default stays refuse/fixture.
- DevVenue is a **decoder fixture only**.
- Event surface is already the ABI: `BookLevel` (absolute qty), `Fill`, `Position`. Do not invent a second surface.
- `socket.indexer-stream` (WS tape) is **Nice**, not a Phase 1 blocker.

### 4.6 Custody

- User tokens for AMM/venue/lending/escrow sit in **those contracts**.
- Platform key is never a guardian, never a pause, never a destination of user funds (CardPull is owner-SA → user, not the reverse into us).
- If a fill path requires us to hold tokens, it is **out of this spec**.

---

## 5 · Per-room spec (Must and Prove)

### 5.1 Accounts (1–3)

**Already:** `SmartAccount`, `AccountFactory`, session keys, `PasskeyOwner`, user-elected recovery. CREATE2 tests. No platform guardian.

**Sepolia needle:** a factory-created account on 84532; one session-key spend **or** one owner spend; explorer link in the registry.

**Refuse:** guardian as recovery; “we’ll add a company key.”

**Residual:** passkey on-chain verify depends on RIP-7212 presence on Base Sepolia — if the precompile is missing, honest residual + EOA/session path still ships.

### 5.2 Paymaster + bundler (4–5)

**Already:** `ScopedPaymaster` refuses unfunded.

**Needle:** a UserOp for **our** implementation lands on 84532 (Pimlico or named live bundler). If paymaster unfunded, UserOp still works as user-pays-gas **or** the refuse is the named error on chain, not a hang.

**Class X:** depositing the sponsorship float.

### 5.3 SovereignVenue (7–9) — the product proof

**Already:** real book, deposit/place, fills only from match, no `recordFill`, no pause, 18-dec, taker bps from quote, indexer ABI.

**Needle (all required):**

1. Registry address, verified on Basescan/Blockscout 84532.
2. Indexer reads that address (not DevVenue).
3. User SA: `deposit` USDC + test base → `place` → rest or fill → `withdraw` leftover.
4. A stranger can see BookLevel/Fill on the explorer.
5. Latency story in words: **not** Hyperliquid; Flashblocks optional for receipt.

**Quote:** native USDC. **Base:** test token we deploy (not IFC).

**Refuse:** platform operator matching; stuffing fills; calling this INTACHAIN or the CEX.

**Parallel:** UserOp `place` against **anvil** may be written while deploy runs. **Live** stamp waits on (1)+(2)+(3).

### 5.4 AMM (10)

**Already:** `PoolFactory`, constant-product, mint/swap proofs on anvil, invariants tests.

**Needle:** published pool on 84532; mint + `swapExactIn` from the SA; `audited:false`.

**Refuse:** oracle reading the AMM for lending marks (S-A12 already fail-closed).

**Not this wave:** wrapping Uniswap/Aerodrome as _our_ AMM.

### 5.5 Router (11)

**Already:** best-of without invent; fail closed.

**Needle:** quote against published pool/venue; no venue → named refuse, not a mid.

### 5.6 Lending + oracle (12)

**Already:** `IsolatedLendingMarket`, `FailClosedOracle`.

**Needle:** oracle unset/stale → **no liquidation**, no invented price. If a Sepolia feed is not wired, **do not** ship a live borrow that can liquidate on a dummy. Honest residual: market deployed, borrow refused until a real mark source.

**Refuse:** AMM TWAP as the only mark without a disagreement rule.

### 5.7 Escrow (13)

**Already:** lock → release/refund/dispute → keeper timeout; no platform key.

**Needle:** one full round-trip on 84532 **or** honest skip listed in the plan.

### 5.8 Launch / trust / NFT / RWA (14–17)

**Already:** factory, LP lock, vesting, reputation, NFT royalty, RWA zero-hash refuse.

**Needle:** factory CREATE2 + `audited:false` **must**. Trust/NFT/RWA: prove refuse/lock **or** skip-honest. Licence **content** is you.

**Refuse:** selling unaudited launch as “live mainnet.”

### 5.9 Merchant, stealth, vaults, attestations (18–23)

**Already:** contracts on `main`.

**Needle:** one path each **or** skip-honest. Stealth: announce on 84532 is enough; wallet scan UX is later.

**Refuse:** platform in merchant funds flow; stealth announcer storing user ids.

### 5.10 CardPull (24)

**Already:** exact pull owner SA → user; `ICardPull` seam; no keys in repo.

**Needle:** none this wave except **do not** call a simulator a live issuer.

**Socket:** `socket.live-issuer`.

### 5.11 Audit honesty (25)

**Already:** pipeline hashes package; fake badge refuse.

**Needle:** Sepolia pages and registry cannot say `audited:true`.

---

## 6 · Journeys (what “done” feels like without Vue)

Each is a **script or Foundry/cast** against 84532 plus an explorer URL. Codex may later wrap the same addresses. Protocol Done **does not** wait on Vue.

| Journey                                               | Must?                 |
| ----------------------------------------------------- | --------------------- |
| Create SA via factory                                 | Must                  |
| UserOp (or plain tx) succeeds on our account          | Must                  |
| TEST/USDC: deposit, place, cancel or fill, withdraw   | Must                  |
| AMM mint + swap                                       | Must                  |
| Registry JSON in git matches explorer                 | Must                  |
| Lending borrow **or** explicit refuse-closed residual | Must (one of the two) |
| Escrow round-trip                                     | Prove or skip-honest  |
| Launch CREATE2                                        | Must                  |
| Passkey verify                                        | Prove or skip-honest  |
| Recovery heartbeat / heir                             | Prove or skip-honest  |
| Stealth announce                                      | Prove or skip-honest  |
| Merchant accept                                       | Prove or skip-honest  |
| Crew/legacy spend                                     | Prove or skip-honest  |

---

## 7 · Class X (not Sepolia blockers)

| Item                                            | When                                    |
| ----------------------------------------------- | --------------------------------------- |
| Paid firm → `audited:true`                      | After you pay; hash+signer match        |
| Base **mainnet** keys, gas, go-live yes         | Phase 7, after Sepolia journeys         |
| Paymaster sponsorship float                     | Optional; refuse-unfunded is valid Done |
| `JURISDICTION_MATRIX` / geo                     | Hosted FE, Codex                        |
| Live card issuer, PSP, DEX external venue names | Sockets                                 |
| INTACHAIN GO                                    | Separate, later, capital                |
| MPC custody                                     | Socket                                  |

Sepolia deployer: a **testnet** key with faucet ETH. Not in the repo. Not mainnet.

---

## 8 · Out of scope (named so they are not “missing”)

- INTACHAIN / `svc-chain` / validators / INTAEVM / rust CLOB core / canonical IFC bridge
- Predict **code** (resolution spec already exists)
- Arc as home; HIP-3; HyperEVM as home; extra L2
- Second TypeScript/Solidity matching engine for the house book
- Platform-held OMS for SovereignVenue
- CoW solver network, Morpho fork, Uniswap rewrite
- Native AA
- Vue / `:8090`
- Fiat bank/pay/ledger work

---

## 9 · Whole-wave Done bar (planning may not shrink this)

1. Registry on git for 84532 with verified explorer links.
2. SovereignVenue journeys in §6 Must rows.
3. Indexer pointed at that venue.
4. One UserOp on **our** account.
5. AMM mint+swap published.
6. Launch factory published, `audited:false`.
7. Lending live **or** refuse-closed residual written.
8. Every other in-suite room: prove **or** skip-honest named in the plan.
9. No INTACHAIN stamp. No fake audit. No IFC token. No ledger writes.
10. `submit()` on **external** dex adapters still loud-refuse until you name venues.

---

## 10 · What the later plan is allowed to do

- Phase DAG for **this spec only** (deploy → registry → indexer → UserOp → journeys).
- One service per PR. `pnpm wt`.
- Write anvil `place` **in parallel** with Sepolia deploy.
- Pick Pimlico vs another **live** 84532 bundler.
- Name skip-honest rows.

**Not allowed:** reopen Arc, unpark L1, rebuild `svc-execution` for protocol fill, drop a Must row, wait for Shehzad, wait for audit cheque.

---

## 11 · Stale documents (do not plan from these lines)

| Text                                       | Truth                                                              |
| ------------------------------------------ | ------------------------------------------------------------------ |
| `svc-execution` does not exist             | Fiat OMS **does**. Protocol fill ≠ that service.                   |
| S-I4 needs Venue Vault to trade _our_ book | Vault is **external API keys**. Our book is `place()` from the SA. |
| Agents babysit protocol only               | Overruled 2026-09-18.                                              |
| 23 Aug “start INTACHAIN now”               | Overruled 3 Sep.                                                   |
| D-S-18 “svc-execution does not exist”      | Stale for Fiat. Predict still waits on INTACORE.                   |
| Mega Phase 4 omits SovereignVenue          | **This spec adds it as Must.**                                     |

---

## 12 · How we ship (compact-proof — stop writing more spec)

**Next chat reads only these, in order.** Ignore this conversation.

1. **This file** — law.
2. **One plan** (not written yet): `docs/ops/boom/P0-SEPOLIA-PLAN.md` — service-sized tasks, files, needles, tests. Not Superpowers 2-minute TDD novels. Not a fifth calibration.
3. **One status** (created with the plan): `docs/ops/boom/P0-SEPOLIA-STATUS.md` — what’s merged, what’s next, skip-honest rows. Compact recovery = this file, not memory.

**GitHub:** `pnpm wt` (never `git worktree add`). One service per PR. Squash-merge, delete branch, do not wait for CI. PR body = English needle. `GRAPHIFY_MAX_WORKERS=1 graphify update .` after `services/` edits.

**Parallel (max 2 live writers, path-disjoint):**

| Slot | Work                                                                   | Wait on                                    |
| ---- | ---------------------------------------------------------------------- | ------------------------------------------ |
| 1    | `svc-protocol`: Sepolia deploy + registry + anvil UserOp/`place` tests | Faucet ETH for a testnet key (not in repo) |
| 2    | Anvil journeys that don’t need a public address                        | Nothing                                    |
| 3    | `svc-indexer` point at registry address                                | Slot 1 merged                              |
| 4    | Skip-honest residuals named in STATUS                                  | After 1–3                                  |

Do **not** two writers in `svc-protocol`. Do **not** a Rhai mill. Do **not** Superpowers `using-git-worktrees` / serial-only SDD against this DAG.

**Skills for the plan chat:** writing-plans **shape** (tasks, files, tests) with INTA overrides above. Execute: coordinator + `isolation=none` writers, ledger = STATUS in git. Verify = spec §9 needles + explorer URLs, not “CI green.” Frontend = Codex after addresses.

**Do not add:** more ADRs, more calibrations, `docs/superpowers/plans/`, a workflow script. If a hole appears, patch **this** spec in one PR.

**Stale — do not open:** Shehzad S-I4 “OMS does not exist”, LAST-MVP “start INTACHAIN now”, D-S-18 `svc-execution` missing, Arc-as-home, this chat’s transcript.

---

## Sources

Law: P0 rails ADR · park ADR · execution-split · calibration · doctrine §16–17 3P vs 4P.  
Code: `services/svc-protocol/contracts/**` on tip `80e66c177`.  
Landscape: DefiLlama Base 2026-09-18 · Base Flashblocks docs · Pimlico 84532 · Circle native USDC · HL/HIP-3 public docs · Loopring shutdown 2026 · Clober/Hanji TVL vs Base AMM spine.
