# P0 Sepolia implementation plan

> **For agentic workers:** Execute with INTA law, not Superpowers `git worktree add`. `pnpm wt`. One service per PR. Isolation=none. Ledger = [`P0-SEPOLIA-STATUS.md`](P0-SEPOLIA-STATUS.md). Spec = [`docs/PROTOCOL-P0-FULL-SPEC-2026-09-18.md`](../../PROTOCOL-P0-FULL-SPEC-2026-09-18.md). Do not wait for CI. Do not wait for Shehzad.

**Goal:** Publish the existing Protocol suite on **Base Sepolia 84532**, prove a smart account can `deposit`/`place`/`withdraw` on **SovereignVenue** with **Circle native USDC**, point the indexer at that venue, keep every label testnet / not INTACHAIN / `audited:false`.

**Architecture:** `deploy-dev.ts` is anvil-only and must stay that way (`assertDisposableChain`). A **new** `deploy-sepolia.ts` signs with `PROTOCOL_DEPLOYER_KEY` (never in git), writes `deployments/base-sepolia.json`, never defaults chain 31337/8453/5042. Indexer today treats **every** non-zero venue as a fixture (`clobHonesty` always `live: false`) — that is a bug once SovereignVenue is public; fix it in `svc-indexer` **after** the registry exists. Venue book is 18-dec internally; USDC is **6-dec** — scale at token transfer or the book is a lie.

**Tech stack:** Foundry artefacts in `contracts/out/`, viem, vitest, Basescan verify, Pimlico optional (plain tx fallback is the needle if no API key).

## Global Constraints

- Chain **84532** only. Refuse 5042 (Arc), 31337 as “live”, 8453 (mainnet).
- Quote token **must** be `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (Circle USDC Base Sepolia, 6 decimals). [developers.circle.com](https://developers.circle.com/stablecoins/usdc-contract-addresses). Refuse USDbC. Refuse any token named IFC.
- Base token = `MockERC20` we deploy, symbol **TEST**, 18 decimals, **not** IFC.
- `takerFeeBps = 0` on Sepolia (constructor allows `feeRecipient = address(0)` when bps is 0). Do not invent a fee.
- `marketId = keccak256("TEST/USDC")`.
- EntryPoint = canonical v0.7 `0x0000000071727De22E5E9d8BAf0edAc6f37da032` set **explicitly** in env/registry (not invented by blank default).
- Protocol never writes ledger-client. No platform holds user tokens to “execute.”
- `deploy-dev.ts` / `assertDisposableChain` **untouched** except if a test would break — do not teach it Sepolia.
- Bundler: `PROTOCOL_BUNDLER_URL` optional. Default policy already falls back to user submit (`bundler-policy.ts`). Needle = UserOp **or** plain SA tx. Do not block on a Pimlico key.
- Vue out. INTACHAIN out. Do not rebuild `svc-execution`.
- One service per PR. `pnpm wt feat/svc-protocol-sepolia-deploy` then `pnpm wt feat/svc-indexer-sepolia-venue`.
- Labels: testnet, not INTACHAIN, `audited: false` on registry rows (`verified` may be true after explorer verify).
- `GRAPHIFY_MAX_WORKERS=1 graphify update .` after service edits.

## File map

| Path                                                       | Role                                                             |
| ---------------------------------------------------------- | ---------------------------------------------------------------- |
| `services/svc-protocol/scripts/deploy-sepolia.ts`          | **Create.** Real deploy. Key from env. Writes registry.          |
| `services/svc-protocol/scripts/sepolia-journey.ts`         | **Create.** Cast/viem journeys against registry.                 |
| `services/svc-protocol/deployments/base-sepolia.json`      | **Create.** S-A13 artefact.                                      |
| `services/svc-protocol/src/deployments/registry.ts`        | Schema already exists; tests for 84532 file.                     |
| `services/svc-protocol/contracts/venue/SovereignVenue.sol` | Decimals scale 6↔18 at deposit/withdraw.                         |
| `services/svc-protocol/contracts/amm/IERC20Minimal.sol`    | Add `decimals()`.                                                |
| `services/svc-protocol/test/` or `src/**/*.test.ts`        | Anvil 6-dec mock + 18-dec mock; sepolia registry parse.          |
| `services/svc-indexer/src/clob-honesty.ts`                 | Distinguish unset / DevVenue fixture / published SovereignVenue. |
| `services/svc-indexer/src/env.ts`                          | Still refuse-closed blank; compose still no invented address.    |
| `docs/ops/boom/P0-SEPOLIA-STATUS.md`                       | Checkboxes after each merge.                                     |

## Spec coverage (inventory → task)

| Spec #                                             | Room                                                | Task   |
| -------------------------------------------------- | --------------------------------------------------- | ------ |
| 1,6                                                | SA factory + registry                               | T2, T3 |
| 2 passkey                                          | T7 skip-honest unless RIP-7212 proven               |
| 3 recovery                                         | T7 skip-honest or one heartbeat tx                  |
| 4 paymaster                                        | T2 deploy; unfunded refuse stays                    |
| 5 bundler                                          | T3 env comment + fallback already coded             |
| 7–9 venue+indexer+reorg                            | T1, T2, T4, T5                                      |
| 10 AMM                                             | T2 PoolFactory + T5 mint/swap                       |
| 11 router                                          | T5 quote refuse if no pool                          |
| 12 lending                                         | T2 deploy + T7 refuse-closed borrow (no dummy mark) |
| 13 escrow                                          | T7 prove or skip-honest                             |
| 14 launch factory                                  | T2 TokenFactory CREATE2                             |
| 15–23 trust/nft/rwa/merchant/stealth/vaults/attest | T7 skip-honest unless cheap prove                   |
| 24 CardPull                                        | T7 do not deploy a fake issuer                      |
| 25 audit honesty                                   | T3 `audited` never true                             |
| 26 indexer WS                                      | Nice, not this plan                                 |
| 27–31                                              | Out / socket                                        |

---

### Task 1 — Venue 6-dec USDC scale (svc-protocol)

**Why:** Book is 18-dec. Circle USDC is 6-dec. Depositing 1e6 as 18-dec would be a dust lie; transferring 1e18 USDC would drain 1e12 times too much.

**Files:**

- Modify: `services/svc-protocol/contracts/amm/IERC20Minimal.sol` — add `function decimals() external view returns (uint8);`
- Modify: `services/svc-protocol/contracts/venue/SovereignVenue.sol` — `deposit`/`withdraw` pull/push **wallet** amounts via `toWallet(amount, token)` / `toInternal(walletAmt, token)`.
- Test: Foundry or existing on-chain venue test (grep `SovereignVenue` under `services/svc-protocol`). Add `MockERC20SixDec` if missing.

**Rules:**

- Internal `amount` stays 18-dec WAD.
- `decimals() == 18` → transfer `amount`.
- `decimals() == 6` → transfer `amount / 10**12`; require `amount % 10**12 == 0`.
- Any other decimals → revert `BadDecimals()`.
- Matching/place/cancel **unchanged** (still WAD).

**Tests:**

- 18-dec mock: deposit 1e18, `quoteBal` 1e18, token wallet −1e18.
- 6-dec mock: deposit 1e18 internal, wallet −1e6, withdraw restores.
- 8-dec mock: revert.
- Unaligned 6-dec (amount not divisible by 1e12): revert.

**PR:** `feat/svc-protocol-venue-usdc-scale` — **this PR first**, anvil only. No Sepolia key.

---

### Task 2 — `deploy-sepolia.ts` + registry (svc-protocol)

**Do not** extend `deploy-dev.ts`.

**Create:** `services/svc-protocol/scripts/deploy-sepolia.ts`

**Env (all required except bundler):**

| Key                           | Value                                                                                   |
| ----------------------------- | --------------------------------------------------------------------------------------- |
| `PROTOCOL_CHAIN_ID`           | `84532` or refuse                                                                       |
| `PROTOCOL_RPC_URL`            | `https://sepolia.base.org` or a WS-capable provider                                     |
| `PROTOCOL_DEPLOYER_KEY`       | 32-byte hex, **never logged, never written to registry**                                |
| `PROTOCOL_ENTRYPOINT_ADDRESS` | `0x0000000071727De22E5E9d8BAf0edAc6f37da032`                                            |
| `PROTOCOL_USDC_ADDRESS`       | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` — `decimals()` must be 6 on-chain or abort |

**Deploy order (nonce-stable, append only):**

1. `MockERC20` name `TEST` symbol `TEST` 18-dec (base).
2. `SmartAccount` implementation + `AccountFactory` (same as `deployAccountSuite`, but **not** anvil account #0).
3. `TokenFactory`
4. `PoolFactory`
5. `SovereignVenue(keccak256("TEST/USDC"), testToken, usdc, 0, address(0))`
6. `FailClosedOracle`
7. `IsolatedLendingMarket` wired to that oracle (borrow must refuse if marks unset — do not seed a dummy price).
8. `ScopedPaymaster` (unfunded).
9. `SovereignEscrow` if ctor is parameterless/safe.
10. Optional same PR if cheap: `StealthAnnouncer`, `RwaRegistry`, `LaunchLpLock`/`TokenFactory` already covers launch CREATE2.

**Abort if:** `eth_chainId !== 0x14a34` (84532). `getCode(USDC)` empty. `USDC.decimals() !== 6`. Deployer ETH == 0.

**Write:** `services/svc-protocol/deployments/base-sepolia.json`

```json
{
  "chainId": 84532,
  "chainName": "base-sepolia",
  "rpcNote": "Base Sepolia testnet. Not INTACHAIN. audited:false.",
  "deployedAt": "<ISO>",
  "contracts": [
    {
      "name": "SovereignVenue",
      "address": "0x...",
      "sourceHash": "<from loadArtifact('SovereignVenue').sourceHash>",
      "suite": "venue",
      "explorerUrl": "https://sepolia.basescan.org/address/0x...",
      "verified": false
    }
  ]
}
```

Every row `verified: false` until Basescan verify in Task 3. **Never** a field `audited: true`.

**Tests (offline, no key):**

- `deploy-sepolia` unit: refuses chainId 5042, 31337, 8453; refuses missing key; refuses USDC address ≠ Circle.
- `parseDeploymentRegistry` accepts the JSON shape; rejects chainId 5042.

**Verify on chain (with key):** `cast call` venue `quoteToken()` == USDC; `baseToken()` == TEST; `takerFeeBps()` == 0.

**Human/ops:** faucet Sepolia ETH to the deployer. Circle faucet for USDC if journeys need it. Key stays in the runner env.

**PR:** `feat/svc-protocol-sepolia-deploy`

---

### Task 3 — Explorer verify + labels + bundler comment (svc-protocol)

- Foundry `forge verify-contract` (or Basescan API) for factory, venue, pool factory, TEST token. Flip `verified: true` only when the explorer page shows source.
- README / registry `rpcNote` must contain: `testnet`, `not INTACHAIN`, `audited:false`.
- `.env.example`: `PROTOCOL_BUNDLER_URL=` empty with comment `optional Pimlico https://api.pimlico.io/v2/84532/rpc?apikey=… ; unset = user submits`.
- Do **not** put a real API key in git.
- Test: grep registry JSON for `audited` must be empty or false.

**Same PR as Task 2 if still open; else tiny follow-up same service.**

---

### Task 4 — Indexer honesty for published venue (svc-indexer)

**Blocked on:** Task 2 registry address for `SovereignVenue`.

**Bug on tip:** `clobHonesty()` returns `live: false, kind: 'fixture'` for **any** non-zero address, including a real SovereignVenue.

**Change:** `services/svc-indexer/src/clob-honesty.ts`

```ts
export type ClobKind = 'unset' | 'fixture' | 'sovereign-venue';

export function clobHonesty(
  venue?: string | null,
  opts?: { publishedVenue?: string | null },
): ClobHonesty {
  const v = (venue ?? '').trim().toLowerCase();
  if (!v || v === ZERO_VENUE_ADDRESS.toLowerCase()) {
    return { live: false, kind: 'unset', reserves: false };
  }
  if (v === DEV_VENUE_ADDRESS.toLowerCase()) {
    return { live: false, kind: 'fixture', reserves: false };
  }
  const published = (opts?.publishedVenue ?? '').trim().toLowerCase();
  if (published && v === published) {
    return { live: true, kind: 'sovereign-venue', reserves: false };
  }
  // Unknown address: not live, not our fixture
  return { live: false, kind: 'unset', reserves: false };
}
```

`live: true` means “this is our published unaudited testnet venue,” **not** `audited:true`. HTTP/ready must still not claim INTACHAIN.

**Tests:** keep `clob-honesty.test.ts` / `clob-fixture-http.honesty.test.ts`:

- DevVenue + `claimLiveClob` → still 412 `indexer.clob_fixture_not_live`
- blank → unset
- published sepolia address from a **test copy** of registry (do not hardcode until T2 merges; then pin the real address)
- random 0x1111… → not fixture, not live

**Compose:** `INDEXER_VENUE_ADDRESS` still no default. Operator sets it to registry SovereignVenue after merge. `INDEXER_CHAIN_ID=84532`. `INDEXER_RPC_URL` must be **WS-capable** (not `sepolia.base.org` HTTP-only). Document in STATUS.

**PR:** `feat/svc-indexer-sepolia-venue` — **do not** edit `svc-protocol` in this PR.

---

### Task 5 — Journeys (svc-protocol scripts)

**Create:** `services/svc-protocol/scripts/sepolia-journey.ts`

Reads `deployments/base-sepolia.json`. Uses a **journey key** env `PROTOCOL_JOURNEY_KEY` (can be the deployer on testnet).

**Must (fail the script if any fail):**

1. `AccountFactory` CREATE2 predict == on-chain `getAddress`.
2. Deploy SA if missing; one owner tx **or** UserOp if `PROTOCOL_BUNDLER_URL` set.
3. Mint/get TEST; get USDC (faucet — if USDC balance 0, skip fill but still `approve`+`deposit` of TEST and document USDC faucet in STATUS).
4. `deposit` / `place` (buy 1 tick if book empty, or cancel after) / `withdraw`.
5. AMM: `PoolFactory` create TEST/USDC pool if needed; `mint` + `swapExactIn` on the SA.
6. TokenFactory CREATE2 predict for a throwaway symbol ≠ IFC.

Print explorer URLs. Exit 1 on INTACHAIN/audited string in stdout by mistake.

**Anvil parallel (same service, can land in T1 or T2 tests):** `place`/`deposit`/`withdraw` against local venue with 6-dec mock — does **not** wait for Sepolia.

---

### Task 6 — Lending residual (svc-protocol)

If `FailClosedOracle` has no Sepolia mark source: **do not** post a dummy price.

- Deploy market (T2).
- Test: `borrow` reverts / typed refuse when mark unset.
- STATUS: `lending: refuse-closed residual` — satisfies spec “Must (one of the two).”

Do not invent Chainlink addresses.

---

### Task 7 — Skip-honest list (STATUS only, unless a prove is one tx)

Record in STATUS, do not pretend Done:

| Room                                                                                               | Disposition                                                     |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Passkey on-chain                                                                                   | Skip-honest unless RIP-7212 precompile returns success on 84532 |
| Recovery                                                                                           | Skip-honest or one `heartbeat` tx if already wired              |
| Escrow round-trip                                                                                  | Prove if ctor is free; else skip-honest                         |
| Launch trust / NFT / RWA content / merchant / stealth scan / crew / legacy / treasury yield / rank | Skip-honest                                                     |
| CardPull                                                                                           | **Do not** deploy a live issuer. Seam stays.                    |
| Indexer WS tape                                                                                    | Nice, skip                                                      |
| External dex execute                                                                               | Socket                                                          |
| Paymaster float                                                                                    | Class X; unfunded refuse is Done                                |

---

## Parallel DAG

```
T1 venue scale ──► T2 sepolia deploy+registry ──► T3 verify
                         │                         │
                         │                         ▼
                         │                    T4 indexer honesty
                         │                         │
                         └─ anvil 6-dec journeys ──┘
                                              T5 sepolia-journey (needs USDC faucet)
                                              T6 lending residual (with T2)
                                              T7 STATUS skip-honest
```

Max two live writers: **never** two on `svc-protocol`. T4 waits T2 address.

## Done (spec §9)

- [ ] `deployments/base-sepolia.json` on `main`, chainId 84532, explorer links
- [ ] SovereignVenue Must journeys (or USDC faucet named if deposit quote skipped — **not** allowed to skip `place` on TEST once quote is funded)
- [ ] Indexer `kind: sovereign-venue` for that address; DevVenue still fixture
- [ ] One SA tx on 84532
- [ ] AMM mint+swap
- [ ] Launch factory CREATE2
- [ ] Lending refuse-closed residual **or** real borrow
- [ ] T7 rows named in STATUS
- [ ] No INTACHAIN, no `audited:true`, no IFC, no ledger writes, dex `submit()` still throws

## Execution

Writers: `isolation=none`, `pnpm wt feat/svc-protocol-…` then indexer. Coordinator updates STATUS after each squash-merge. Compact recovery = spec + this plan + STATUS, not chat.
