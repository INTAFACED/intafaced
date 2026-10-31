# svc-protocol

**The Protocol Plane's smart account layer (§17.4, §17.5).** Self-custody ERC-4337 accounts, deterministic addresses, and scoped session keys — the foundation the AMM, the lending markets, the sovereign escrow, the Lane A merchant contracts and the sovereign card all sit on.

**This service is non-custodial, and that is a structural fact rather than a policy.** It holds no key, posts no ledger transaction, and has no function anywhere in it that can move a user's funds. `pnpm scan:custody` asserts it on every build (Doctrine §16.10), and `src/sovereignty.test.ts` asserts it again from inside the service.

> **What, structurally, prevents the platform from moving a user's funds here?**
>
> 1. **We hold no key that the account recognises.** `SmartAccount` accepts exactly one unrestricted signer, `owner`, set at deployment to the user's key. There is no admin role, no operator, no pause, no guardian.
> 2. **The account cannot be upgraded.** It is an EIP-1167 clone: the implementation address is hard-coded in its own runtime bytecode. There is no beacon and no registry to re-point. We could not swap in code that moves funds even with every key we possess.
> 3. **The one thing we do hold — a session key — is refused transfer power at grant time.** `SessionKeyLib.assertGrantable` reverts on any selector that moves a token or hands out an allowance, and refuses the account itself as a target, so a session can never widen itself.
> 4. **There is no signing key in the service at all.** `src/env.ts` declares none, `src/chain/client.ts` creates only a `PublicClient`, and a test fails the build if either changes. The service builds calldata and forwards operations the user already signed; `SessionRelay.verify` re-derives the operation hash and refuses anything whose signature is not the owner's or a live session key's.
> 5. **Nothing here is load-bearing for the user.** The registry is a read model. If this service, this database and this company all vanished, every user would still reach their funds from any wallet, at an address derived from their own key, on a chain we do not run.

---

## API

Internal tRPC (`createProtocolRouter`). Read the guards, not just the procedures.

Almost everything is `publicJurisdictionProcedure('protocol', 'protocol')` — **no login, no KYC tier, no account gate.** That is §22 as code: `MODULES.protocol` is `custodial: false` on the `protocol` plane, so `checkAccess` returns `allowed.permissionless`. There is nothing to verify because there is nothing held.

| Procedure                | Guard           | Input                                              | Output                                                                                                                                                                                                                                                                         |
| ------------------------ | --------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `health`                 | —               | —                                                  | `{ ok, service, relayEnabled, factoryConfigured, chain: { status: 'unprobed', observedChainId: null } }` — liveness, not a custody claim                                                                                                                                       |
| `auditStatus`            | —               | —                                                  | `{ kind: 'internal', artifactHash, signedBy, audited: false }`                                                                                                                                                                                                                 |
| `auditRegistry`          | —               | —                                                  | packages + suite `sourceHash`; `anyAudited: false` until a Nitro-paid firm row in `src/audit/external-claims.json`                                                                                                                                                             |
| `predictAddress`         | permissionless  | `{ owner, userSalt? }`                             | `{ address, chainId, factory, implementation, deployed }`                                                                                                                                                                                                                      |
| `buildDeployment`        | permissionless  | `{ owner, userSalt? }`                             | unsigned call + `predictedAddress`                                                                                                                                                                                                                                             |
| `buildSessionGrant`      | permissionless  | `{ account, spec }`                                | unsigned call + `specHash`, `validUntil`                                                                                                                                                                                                                                       |
| `buildSessionRevoke`     | permissionless  | `{ account, sessionKey }`                          | unsigned call                                                                                                                                                                                                                                                                  |
| `buildRevokeAllSessions` | permissionless  | `{ account }`                                      | unsigned call                                                                                                                                                                                                                                                                  |
| `sessionStatus`          | permissionless  | `{ account, sessionKey }`                          | on-chain record: expiry, `spentWei`, `revoked`, `live`                                                                                                                                                                                                                         |
| `checkSessionCall`       | permissionless  | `{ account, spec, target, value, data, spentWei }` | `{ allowed, code, reason, spentAfterWei }`                                                                                                                                                                                                                                     |
| `sessionSpecHash`        | permissionless  | `{ account, spec }`                                | `{ specHash }`                                                                                                                                                                                                                                                                 |
| `relayUserOperation`     | permissionless  | `{ account, userOp }`                              | `{ userOpHash, authority: 'owner' \| 'session' }`                                                                                                                                                                                                                              |
| `bindingMessage`         | `protocol:read` | `{ address }`                                      | `{ message }`                                                                                                                                                                                                                                                                  |
| `claimAccount`           | `protocol:read` | `{ owner, address, userSalt?, signature }`         | `{ id, address, owner, deployed }`                                                                                                                                                                                                                                             |
| `myAccounts`             | `protocol:read` | —                                                  | `AccountRecord[]`                                                                                                                                                                                                                                                              |
| `gasPrice`               | permissionless  | —                                                  | `eth_gasPrice` plus owner-percentile `eth_feeHistory`. Blank percentiles refuse `protocol.gas_percentiles_unset`. No base fee → gas price only.                                                                                                                                |
| `representation.status`  | permissionless  | `{ address }`                                      | `{ version, text, message, accepted, acceptedAt }` for the published representation. Blank text or version refuses `compliance.representation_unset`.                                                                                                                          |
| `representation.accept`  | permissionless  | `{ address, version, signature }`                  | Stores `(chain, address, version, message, signature, accepted_at)` once, only when the address signed `status.message`; else `compliance.representation_signature_not_owner`. An old version is `compliance.representation_version_stale`. A consent record, not a screening. |

### `walletSession.*` and `addressBook.*` — the wallet address book and wallet groups (D-portfolio-wallet-03)

A book belongs to a wallet address and the visitor may be signed out, so ownership is proved the way the representation proves it: the address signs a message this service wrote (`src/address-book/session.ts`). `walletSession.challenge({ address, origin })` writes an EIP-4361 message for an owner-listed origin with a nonce and a five-minute expiry, sealed with an HMAC of `PROTOCOL_WALLET_SESSION_SECRET`; nothing is stored. `walletSession.open({ challenge, signature })` checks the seal, rebuilds the message and recovers the signer (viem `verifyMessage`, externally owned wallets only), then returns a session token (address, chain, expiry; a second derived key) that lives `PROTOCOL_WALLET_SESSION_TTL_SECONDS`. Every `addressBook.*` call takes `{ session }` and reads the owner from it, never from a named address; a row of another owner reads as not found. All are mutations, reads too, so the token never sits in a URL.

| Procedure                   | Input                         | Output / refusals                                                                                                                                                                         |
| --------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `addressBook.list`          | `{ session }`                 | `{ owner, contacts, groups }`                                                                                                                                                             |
| `addressBook.addContact`    | `{ session, label, address }` | contact; `contact_address_invalid`, `contact_label_invalid`, `contact_self`, `contact_duplicate`, `address_book_full`, `address_book_max_contacts_unset`                                  |
| `addressBook.removeContact` | `{ session, id }`             | also leaves the owner's groups; `contact_not_found`                                                                                                                                       |
| `addressBook.createGroup`   | `{ session, name, members }`  | members are the owner and its contacts only: `group_member_unknown`, `group_members_empty`, `group_name_invalid`, `group_name_duplicate`, `wallet_groups_full`, `wallet_groups_max_unset` |
| `addressBook.group`         | `{ session, id }`             | group with labelled members; `group_not_found`                                                                                                                                            |
| `addressBook.removeGroup`   | `{ session, id }`             | `group_not_found`                                                                                                                                                                         |

Session refusals: `protocol.wallet_session_unset` (secret, lifetime or origins blank), `wallet_session_origin_unlisted`, `wallet_challenge_invalid`, `wallet_signature_not_owner`, `wallet_session_invalid`. Tables: `wallet_contacts`, `wallet_groups`, `wallet_group_members` (20261029050900); each write locks its owner, so the maximum holds under concurrent adds. Group activity needs the indexer's wallet-activity reader and is not served here.

### `launch.*` — ERC-20 deploy from an in-repo template (`launch.token-factory`, §8.4)

| Procedure                     | Guard          | Input                            | Output                                                                                                             |
| ----------------------------- | -------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `launch.status`               | permissionless | —                                | `{ configured, deployed, usable, template: { sourceHash, audited: false }, limits, mintAuthorityRetained: false }` |
| `launch.predictTokenAddress`  | permissionless | `{ creator, userSalt?, params }` | `{ address, chainId, factory, scaledTotalSupply, deployed, templateSourceHash }`                                   |
| `launch.buildTokenDeployment` | permissionless | `{ creator, userSalt?, params }` | unsigned call + `predictedAddress`, `scaledTotalSupply`                                                            |
| `launch.tokenInfo`            | permissionless | `{ token }`                      | `{ name, symbol, decimals, totalSupply, initialHolder, creator, fromThisFactory, matchesTemplate }`                |

`params` is `{ name, symbol, decimals, totalSupply, recipient }`. **`totalSupply` is a decimal string of whole tokens** ("1000000", "21000000.5") and becomes a scaled `bigint` in `src/launch/params.ts` and nowhere else. It is never a JS `number` at any point — 1e21 is already past `MAX_SAFE_INTEGER`, and a rounded supply is permanent.

**The product decisions this surface makes, written down because a launch cannot be undone:**

| Question                               | Answer                                                                                                                                                |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Who may deploy?                        | Anyone. Permissionless per §22 — the platform holds nothing. It never originates the transaction either: it builds bytes the **creator** signs.       |
| Does the deployer keep mint authority? | **No. Nobody does.** The template has no `mint`, no `owner`, no `pause`, no upgrade path. No API flag can change that.                                |
| What decimals are permitted?           | 0–18. Above 18 cannot round-trip through the ledger's `numeric(38,18)`. Enforced in the contract **and** the API.                                     |
| What supply is permitted?              | Up to 10^20 − 1 whole tokens — where the amount stops being representable in `numeric(38,18)`. **API-only**; the contract allows the full `uint256`.  |
| Is the template audited?               | **No.** `launch.status` returns `audited: false`. `contracts/out/` is compiler output, not an audit report.                                           |
| Who charges the launch fee?            | Nobody, here. The factory is not payable and takes no fee — a fee is a Fiat Plane ledger recipe (§0.6), never value held by a contract on this plane. |

Every launch path **refuses** with `launch.factory_not_configured` when `PROTOCOL_TOKEN_FACTORY_ADDRESS` is the zero default. That is the check that matters most here: CREATE2 against `factory = 0x0` succeeds and returns a real, checksummed, entirely fictional token address — which a creator would then publish.

The two authenticated procedures are the registry ones, and they are authenticated for a mundane reason: attaching an address to an INTAFACED profile requires knowing whose profile it is. They confer no power over the account.

**There is no `protocol:write` scope in `packages/auth`, deliberately — the same way there is no `ledger:write`.** No user token and no platform credential may authorise anything on this plane. The only thing that authorises here is a signature from the user's own key.

HTTP: `GET /health` (process liveness — does **not** echo `PROTOCOL_CHAIN_ID` / Anvil 31337; chain is `unprobed`) · `GET /ready` — 503 when the chain is unreachable, because a service that cannot read the chain cannot answer any question a user has. `chainStatus` is the honest probe.

`src/index.ts` re-asserts §22 at boot and **refuses to start** if `checkAccess` for this module ever returns anything but `allowed.permissionless`.

---

## Events

**Publishes** — all three are observations of chain state, never records of something the platform did.

| Subject                                    | When                     | Payload                                                                 |
| ------------------------------------------ | ------------------------ | ----------------------------------------------------------------------- |
| `intafaced.protocol.account.created`       | factory `AccountCreated` | chain, account, owner, salt, tx, optional user id                       |
| `intafaced.protocol.session_key.created`   | account `SessionGranted` | account, key, spec hash, validity window, spend cap, targets, selectors |
| `intafaced.protocol.session_key.cancelled` | account `SessionRevoked` | account, key, who revoked it, tx                                        |

Note what none of them carry: no balance, no key material, no amount that moved. There is nothing of the user's for these payloads to describe.

Idempotency keys are business keys (`protocol.account:<chain>:<address>`, `protocol.session:<account>:<specHash>`), so at-least-once redelivery finds the original.

**Consumes** — nothing.

> **§13 socket — `indexer.readmodels`.** `src/events.ts` watches the chain itself: one factory address plus two account event topics. That belongs in `svc-indexer` and moves there when `indexer.readmodels` lands. It is here rather than deferred so smart accounts are usable now, and it is deliberately narrow so the move is a deletion.

---

## Ledger

**This service posts no ledger transactions and holds no user value. On this plane the user's keys are the only keys.**

There are no recipes to list, because there is no code path here that reaches one. `@intafaced/ledger-client` is not a dependency of this package, in any form:

| Check                                                           | Where                                                                 |
| --------------------------------------------------------------- | --------------------------------------------------------------------- |
| No ledger-client import, no `ledger.post()`                     | `tooling/ci/custody-scan.mjs`, and again in `src/sovereignty.test.ts` |
| No ledger-client entry in `package.json`                        | `src/sovereignty.test.ts`                                             |
| No `PRIVATE_KEY`-shaped environment variable                    | `src/sovereignty.test.ts`                                             |
| No `createWalletClient` / `privateKeyToAccount` in shipped code | `src/sovereignty.test.ts`                                             |
| No owner- or admin-callable path to move funds in any `.sol`    | `custody-scan`, and again in the test suite                           |
| No `selfdestruct`, no upgrade path                              | same                                                                  |

`ReadOnlyLedgerClient` is permitted on this plane and is **not used**, because nothing here needs a fiat-plane balance to answer a question about a self-custody account.

The one seam between the planes is `svc-bridge`, which is custodial by design (§17.3). It is not this service and must never become it.

---

## The contracts

`contracts/`, Solidity ^0.8.24, no external imports — every byte an INTAFACED account is built from is in this repository.

### `SmartAccount.sol`

ERC-4337 v0.7 account, deployed as an immutable clone.

| Function                                                             | Who can call it                                                   |
| -------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `initialize(owner)`                                                  | once, by the factory, at deployment                               |
| `execute` / `executeBatch`                                           | owner (directly, or via an owner-signed user operation)           |
| `executeWithSession(spec, target, value, data)`                      | the session key, or the EntryPoint after validating its signature |
| `grantSession(spec)`                                                 | owner                                                             |
| `revokeSession(key)`                                                 | owner, **or the session key retiring itself**                     |
| `bumpSessionEpoch()`                                                 | owner — kills every outstanding session in one call               |
| `proposeOwner` / `acceptOwnership`                                   | owner, then the incoming key                                      |
| `validateUserOp`                                                     | EntryPoint only                                                   |
| `isValidSignature` (ERC-1271)                                        | anyone; **valid for owner signatures only**                       |
| `owner`, `entryPoint`, `sessionEpoch`, `getSession`, `isSessionLive` | anyone, view                                                      |

There is no function on that list an INTAFACED address can call.

Four decisions worth their own line:

- **No upgradeability.** An upgradeable account is a custodial account with extra steps.
- **ERC-1271 answers for the owner only.** A session key that could produce a valid 1271 signature could sign an off-chain permit and empty the account without ever calling it.
- **`bumpSessionEpoch` is a panic button the user holds and we do not.** Every granted session records the epoch it was granted under; one owner call invalidates all of them. Ownership transfer bumps it automatically, so sessions die with the key that granted them.
- **A passkey owner works today.** If `owner` is a contract, signature validation goes through ERC-1271 — so a deployed P-256 verifier is an owner with no change to the account. The verifier contract itself is a §13 socket.

### `SessionKeyLib.sol` — how session keys are scoped

```solidity
struct SessionSpec {
    address   key;            // the delegated signer
    uint48    validAfter;     // unix seconds; 0 = immediately
    uint48    validUntil;     // MANDATORY, and ≤ 30 days out
    uint128   spendLimitWei;  // cumulative cap on native value
    address[] targets;        // exact allowlist, 1..32, never the account
    bytes4[]  selectors;      // exact allowlist, 1..32, no transfer selectors
}
```

The account stores `keccak256(abi.encode(spec))` and the full spec is re-presented on every call, so **a granted session's scope is immutable for its lifetime.** Full `abi.encode`, never packed — packed encoding of dynamic arrays is exactly the sort of thing that agrees on the happy path and diverges on the one input that matters.

Five rules, each enforced on chain on every call:

1. **Expiry is mandatory.** `validUntil` must be in the future and at most `MAX_SESSION_DURATION` (30 days) away. There is no permanent grant. The window is also handed to the EntryPoint as ERC-4337 validation data, so a stale operation is rejected before it reaches the account.
2. **Targets are an exact allowlist and can never include the account itself.** This single rule closes every escalation path at once: a session that cannot call its own account cannot grant itself a wider session, rotate the owner, or revoke the user's control.
3. **Selectors are an exact allowlist, and transfer selectors are refused at grant time.** `transfer`, `transferFrom`, `approve`, `increaseAllowance`, `permit`, `setApprovalForAll`, all three `safeTransferFrom` shapes, `safeBatchTransferFrom`, Permit2 `approve`, `transferOwnership`, `upgradeTo`, `upgradeToAndCall`. Not "is not issued" — **cannot be constructed**: `assertGrantable` reverts, and so does `createSessionSpec` in TypeScript. Re-checked at execution time as well. A zero selector (raw fallback call) is refused too, as is a call with no calldata: a bare native transfer is a payment, not a scoped call.
4. **Native value is capped cumulatively**, counted before the external call so re-entrancy spends the budget once rather than once per re-entry.
5. **A session-signed user operation must route through `executeWithSession`.** `validateUserOp` refuses any other selector, which is what makes every guardrail above unavoidable rather than merely present.

What a session key is _for_: an agent (§19) calling `swap` or `placeOrder` on a venue the user allowlisted, using an allowance the **owner** set. It moves nothing itself and creates no allowance of its own. Worst case for a fully compromised session key is a bad trade on a venue the user chose, inside a spend cap the user set, until an expiry the user set — and the user can end it instantly with one call we cannot make for them.

### `AccountFactory.sol`

CREATE2 deployment of EIP-1167 clones. `getAddress(owner, userSalt)` answers before the account exists.

- **The salt commits to the owner:** `keccak256(abi.encode(owner, userSalt))`. Nobody can deploy an account they control at an address a user was shown and funded.
- **Anyone may deploy.** A relayer paying gas is doing bookkeeping, not granting itself anything.
- **The implementation is immutable and so is every clone.**

`src/accounts/address.ts` re-derives the same address in TypeScript, and its tests pin the exact byte constants against the assembly.

### `contracts/launch/` — the token factory (`launch.token-factory`, §8.4)

`SovereignToken.sol` is a **fixed-supply ERC-20**. The entire supply is minted once, in the constructor, to an address named at deployment. After that transaction there is no privileged party anywhere in the contract:

- **No `mint`.** A creator who wants more later cannot have it, ever. They deploy a different token.
- **No `owner`, no `pause`, no blacklist, no fee switch, no upgrade path, no proxy.**
- **No transfer hooks, no fee-on-transfer, no rebasing.** Every downstream consumer — the AMM's constant-product accounting, the indexer's read models, any future bridge attestation — assumes `balanceOf` after a transfer of `n` is `before + n`. A template that broke that would corrupt them all, and the corruption would look like a bug in the consumer.
- **Transfers to `address(0)` revert** rather than burning. To retire supply, send it somewhere nobody holds a key for, which is visible on chain as exactly what it is.

`TokenFactory.sol` deploys it via CREATE2. The salt is `keccak256(creator, userSalt)` and every parameter is a constructor argument, so **both halves of the CREATE2 preimage carry a commitment** — "this address, these parameters, this creator" is one claim rather than three. A single character of the name is a different address.

A repeated launch **reverts** with `TokenAlreadyDeployed`, where `AccountFactory.createAccount` returns the existing account. The asymmetry is deliberate: a second `createAccount` is the same account and nothing happened twice, but a second `createToken` cannot mint a second supply — the first call already did — so returning the existing address would let a caller believe a launch happened when none did.

The factory has no owner, holds no balance and takes no fee.

> **A deployed contract is not byte-identical to `deployedBytecode`.** Solidity `immutable` values are spliced into the runtime by the constructor; the compiler emits zero placeholders. `SovereignToken` has three (`decimals`, `totalSupply`, `initialHolder`), so the obvious equality check is **false for every correct deployment**. `deployedCodeMatches()` in `src/chain/artifacts.ts` masks exactly those ranges using the compiler's `immutableReferences` and requires byte equality everywhere else.

---

## Tests

`pnpm --filter @intafaced/svc-protocol test` — **336 tests. No database required. 81 of them need a chain and skip without one** (255 passed / 81 skipped with the chain stopped; 336 passed with it up).

Start the chain first to run all of them:

```bash
docker compose up -d evm      # anvil, dev-only, see docker-compose.yml
```

| File                        | Covers                                                                                                                                                                                                                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accounts/address.test.ts`  | EIP-1167 creation code, CREATE2 derivation recomputed independently, a pinned address, owner/salt/implementation separation, malformed input, and the Solidity assembly constants                                                                                                         |
| `session/spec.test.ts`      | **every forbidden selector refused at construction**, self-target refused, expiry required and capped, allowlist rules, cumulative spend limits at the boundary, abi round-trip and commitment stability, plus assertions that `SessionKeyLib.sol` hard-codes the same selectors and caps |
| `chain/userop.test.ts`      | ERC-4337 v0.7 packing, hash determinism, and that the hash binds chain, entry point, calldata and nonce while excluding the signature                                                                                                                                                     |
| `accounts/registry.test.ts` | claim requires the derived address AND an owner signature; refuses impostors, cross-user replay, and profile transfer; idempotent re-claim                                                                                                                                                |
| `sovereignty.test.ts`       | **§22 from this side** — `allowed.permissionless` for every region and every tier, `denied.plane_unsupported` on the fiat plane, a custodial control that must still be gated, and the §16.10 custody assertions listed under **Ledger**                                                  |

| `chain/artifacts.test.ts` | the committed bytecode still matches the `.sol` on disk (`sourceHash`), the compiler and EVM version are pinned, and **the hand-written `abi.ts` agrees with the compiled ABI** — inputs, outputs, `stateMutability` and `indexed` flags. A wrong output type there does not throw; viem decodes the same bytes into a different value |
| `chain/refusal-without-chain.test.ts` | every chain path refuses with its typed code against a **real closed socket**, not a stub. The dev chain must never become something this service quietly needs |
| `accounts/create2-onchain.test.ts` | **needs a chain.** The TypeScript derivation against `AccountFactory.getAddress`, 25 owner/salt pairs; the account lands at the predicted address, is owned by the user rather than the relayer, and its runtime is byte-identical to the EIP-1167 proxy the init code hashes |
| `router.live-chain.test.ts` | **needs a chain.** `predictAddress`, `buildDeployment`, `sessionStatus` and `claimAccount` returning real values through the real `ProtocolChain`, including a session granted on chain and read back with a matching `specHash` |
| `launch/params.test.ts` | launch policy: supply scaling that must not round (a supply four orders past `MAX_SAFE_INTEGER` survives intact, with the number round-trip that would have destroyed it asserted alongside), byte-counted name limits, and invisible-character refusals built from code points rather than literals |
| `launch/address.test.ts` | the salt commits to the creator, every parameter is inside the init code, and the zero factory derives a perfectly well-formed **fictional** address — documented as the reason the refusal lives in the router |
| `launch/token-factory-onchain.test.ts` | **needs a chain.** The TypeScript derivation against `TokenFactory.getAddress` over 20 creator/salt pairs and 5 parameter sets; our init code against the factory's own `initCode()`; the token lands at the predicted address holding the compiled template; the full supply reaches the recipient and nothing reaches the creator; **no mint/owner/pause/upgrade selector is present in the deployed runtime**; a second launch reverts; the `TokenCreated` log decodes with the hand-written ABI |
| `launch/router-launch-live.test.ts` | **needs a chain.** The whole launch through the router: predict, build, broadcast **exactly the bytes the service returned**, and confirm the token is at the predicted address. Rules out a service that predicts one address and hands out calldata deploying to another — both halves look correct in isolation |

The Solidity/TypeScript cross-checks in the first two files date from before there was a compiler: they assert that the exact selector constants, the 30-day cap, the list caps and the EIP-1167 byte constants appear verbatim in the `.sol` sources. They are still worth having — they are cheap and they run with no chain — but they are no longer the only thing standing between the two languages. `create2-onchain.test.ts` asks the deployed factory.

### The contracts, compiled

```bash
pnpm --filter @intafaced/svc-protocol contracts:build   # solc 0.8.28, pinned
docker compose up -d evm
pnpm --filter @intafaced/svc-protocol chain:deploy      # + CREATE2 cross-check
```

`scripts/compile-contracts.mjs` compiles with `solc` from npm — the compiler itself, pinned in `pnpm-lock.yaml`, so every machine and every CI runner produce identical bytecode. Output is committed under `contracts/out/` and carries a `sourceHash` the test suite re-derives, so "committed" never means "unverified".

**AMM compile (2026-07-31):** `ConstantProductPool` previously failed because `swapExactIn` called `external swap` by name. Fixed with a private `_swap` shared by both entrypoints; the `amm` suite now `expect: 'compiles'` and artefacts are committed. Factory deploy on the dev chain and audit remain open before `protocol.amm` is `done`.

### Still not covered — §13 sockets

| Socket                            | What lands with it                                                                                                                                                                                                                                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `socket.contract-toolchain`       | **Partly closed.** solc-js compile + anvil CI remain. Forge fuzz + gas ceilings in `test/forge` (`pnpm test:forge`), including session-key escalation / spend-limit re-entrancy / `validateUserOp` session-op refusal. Still open: external audit                                                  |
| `socket.userop-differential-test` | `getUserOperationHash` checked against a live EntryPoint's `getUserOpHash`                                                                                                                                                                                                                         |
| `socket.p256-verifier`            | **CLOSED 2026-08-08 (S-A9).** `contracts/passkey/PasskeyOwner.sol` — ERC-1271 owner verifying WebAuthn assertions via RIP-7212. Residual: origin/rpId on-chain, gas snapshot on ruled rail, external audit                                                                                         |
| `socket.social-recovery`          | **CLOSED 2026-08-18 (S-A1).** `UserElectedRecovery` is a user-elected M-of-N ERC-1271 owner. Proven in `test/forge/RecoveryOwner.t.sol`: `createAccount(recovery)` sets `SmartAccount.owner` to it; factory still takes the key it is given (not default). Platform is never a guardian. Unaudited |
| `socket.paymaster-policy`         | **CLOSED 2026-08-08 policy + 2026-08-19 contract.** `ScopedPaymaster` refuses when unfunded. Operator cannot touch user accounts. Depositing the float is Nitro Class X. Unaudited                                                                                                                 |
| `socket.contract-audit`           | External audit before any mainnet deployment. Nothing in this suite has been audited                                                                                                                                                                                                               |

**Nothing in `contracts/` should be deployed to a chain holding real value until `socket.contract-toolchain` and `socket.contract-audit` are closed.** A local anvil proves these contracts compile and behave as described. It proves nothing about whether they are safe, and choosing a production chain is a separate decision nobody has made.

---

## Kill-switch

`protocol.smartAccounts` in the admin console, or `PROTOCOL_RELAY_ENABLED=false`.

**Effect when off:** `relayUserOperation` refuses. Reads, address prediction and calldata construction continue.

Operator procedure (detect / contain / what you must not pull): `docs/ops/INCIDENT-PROTOCOL-RUNBOOK.md` (removed). Ledger/trade red is a different page.

Note what a kill-switch can and cannot do on this plane. It stops _us_ relaying. It does not stop a user transacting: their account is on a public chain and the same signed operation goes to any bundler. **A kill-switch here is a switch on our convenience, never on their access.** A kill-switch that could freeze a user's funds would mean we had custody, and this document would be a lie.

---

## Running it

```bash
docker compose up -d                                  # includes `evm` — anvil, dev-only
pnpm --filter @intafaced/svc-protocol db:migrate      # runs as svc_protocol, which owns the schema
pnpm --filter @intafaced/svc-protocol chain:deploy    # factory + implementation on the dev chain
pnpm --filter @intafaced/svc-protocol test
pnpm --filter @intafaced/svc-protocol dev
```

### The dev chain

`docker-compose.yml` runs anvil as the `evm` service on 8545. It is marked `# no-deploy`, holds no volume, and is **not a decision about what chain this platform ships on**. Because it starts at genesis every time, `chain:deploy` always lands the suite at the same two addresses, which is why `docker-compose.apps.yml` can name them as defaults.

Stop it and svc-protocol behaves exactly as it did before it existed: every chain-dependent path refuses with `protocol.chain_unreachable`, a typed 503. Naming an address in config does not make the service claim the contract is there — `chainStatus.suiteDeployed` is an `eth_getCode` read, kept separate from `suiteConfigured`.

What the dev chain does **not** give you: no ERC-4337 EntryPoint (a public singleton we do not own) and no bundler, so `relayUserOperation` still refuses locally with `relay.bundler_unavailable`.

Configuration lives in `src/env.ts`: chain id, RPC, EntryPoint, factory, implementation, and an optional bundler URL. A missing bundler degrades convenience, never access — the user submits the operation themselves. There is no key to configure, and there never should be.

## AMM (`protocol.amm`)

Constant-product pools under `contracts/amm/`. Permissionless tRPC: `amm.quoteExactIn`, `amm.buildCreatePool`, `amm.buildSwapExactIn`, `amm.buildMintLiquidity`, `amm.checkApproval` (allowance read at a named block; exact `approve`, a reset pair for tokens that need one), `amm.buildApprove` (exact amount; unlimited only with `unlimited: true`), `amm.buildRevoke`, `amm.allowances` (the owner's live allowances for the listed tokens: every listed pool plus each spender in the owner's Approval logs of the last `APPROVAL_LOG_BLOCKS` = 10,000 blocks, a read bound; kept only when `allowance()` read at one block is above zero), `amm.feeLevels` (Slow, Normal, Fast: the next base fee × 2, the EIP-1559 six-block bound, plus the owner percentiles of the last blocks' priority fees; fee cap `PROTOCOL_SWAP_MAX_FEE_PER_GAS_WEI`, blank refuses `protocol.swap_fee_cap_unset`; no fee market refuses `protocol.fee_market_unread`). Platform never holds LP keys and never signs an approval. Factory address: `PROTOCOL_AMM_FACTORY_ADDRESS`.

**`ConstantProductPool` compiles** (see AMM compile note above; artefacts under `contracts/out/`). Factory deploy on the dev chain and external audit remain open, so `PROTOCOL_AMM_FACTORY_ADDRESS` still defaults to zero and every AMM **chain** read refuses until an operator deploys and configures a real factory.

### Networks, deployments and capabilities

`networks.list` serves the owner-published registry in `deployments/networks.json`: a network is `testnet`, `local` or `unconfirmed`, and every field the owner has not published is null (a registry that names `mainnet` or `intachain` refuses to load with `protocol.network_kind_forbidden`). `deployments.list({chainId})` serves `deployments/base-sepolia.json` plus the router versions in `deployments/router-versions.json` (owner-set `sunsetAt`, null = none); a chain with no record is `NOT_FOUND`. `capabilities({chainId})` probes the configured chain's node for the pending tag and the bundler (`PROTOCOL_BUNDLER_URL` within `PROTOCOL_PEER_TIMEOUT_MS`; unset means not probed) and never reports preconfirmations as offered. There is no faucet drip: this plane holds no key.

## Protocol ops desk reads (`protocol.ops`)

Founder and compliance reads for the Protocol ops desk (D-order-controls-04): `ops.metrics` (`admin:read`) and `ops.labels` (`admin:compliance`).

The hide, delist and restore WRITES are not here. This plane holds no platform credential, so it cannot consume `svc-identity`'s four-eyes approval; those actions live in `svc-ops`, and this service and `svc-dex` read the resulting hide list read-only.

Metrics: quote counts, refusal counts by code and distinct quote wallets are svc-dex's to count and read `could_not_load` (`protocol.ops_source_unavailable`) until svc-dex publishes them; a source that fails is never shown as zero. `PROTOCOL_OPS_WINDOW_SECONDS` is the window when the caller names none; blank refuses `owner.decision`. `ops.labels` covers what this service serves (network names and kinds, the configured chain label, the audited flag); the admin app adds the customer and admin copy and runs the same `labelVerdict`.
