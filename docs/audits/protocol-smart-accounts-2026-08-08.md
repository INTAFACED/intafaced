# Smart accounts — adversarial audit package (S-A1)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Status:** **Internal package shipped / not externally audited.** Engineering half of board S-A1 is in-repo. This is **not** permission to set `audited:true` or close `socket.contract-audit` (external firm / Nitro budget still required).
**Scope:** `SmartAccount.sol`, `AccountFactory.sol`, `SessionKeyLib.sol`, `PasskeyOwner.sol` / `P256.sol` (S-A9).
**Owner:** `@shehzad002`. External firm engagement is a **Nitro budget** decision (§0.5).
**Date opened:** 2026-08-08. **Internal matrix:** 2026-08-08 (`src/accounts/adversarial-audit.test.ts`).

---

## 1 · Threat model (what we claim the code forbids)

| Adversary                   | Goal                                     | Architectural refusal                                                                              | Internal proof                                                                                 |
| --------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Platform / operator         | Move user funds without a user signature | No admin, pause, upgrade, or guardian on `SmartAccount`; EIP-1167 clone → immutable implementation | ABI + source refuse `pause`/`onlyAdmin`/`guardian` control surface                             |
| Malicious bundler / relayer | Swap callData after signature            | ERC-4337 userOpHash binds callData; session keys cannot target the account or widen scope          | `getUserOperationHash` changes when `callData` changes                                         |
| Session key thief           | Drain beyond grant                       | Selectors/targets/spend limit enforced; epoch panic button                                         | `createSessionSpec` / `evaluateSessionCall` refuse forbidden selectors, self-target, overspend |
| Passkey assertion reuse     | Authorise a different userOp             | `PasskeyOwner` binds WebAuthn `challenge` to the digest under check                                | Covered by S-A9 hermetic + on-chain suites (not re-proven here)                                |
| Signature malleability      | Replay alternate (r,s)                   | secp256k1 half-n in SmartAccount; P-256 half-n in `P256.sol`                                       | Covered by existing account / PasskeyOwner suites                                              |
| Missing P-256 precompile    | Silent accept                            | `P256.verify` reverts / ERC-1271 returns fail — never invents success                              | Covered by S-A9 on-chain suite                                                                 |

**Out of scope for this package (named sockets):** social recovery (`socket.social-recovery` / S-K7 before S-L2), paymaster funding (S-A10), bundler policy (S-A11), EntryPoint differential (S-A11 / `socket.userop-differential-test`), deployment registry (S-A13).

---

## 2 · Findings log

| ID  | Severity | Status | Summary                                                                                                 |
| --- | -------- | ------ | ------------------------------------------------------------------------------------------------------- |
| —   | —        | —      | No external audit yet. Unit + on-chain + this adversarial matrix exist; they are not an external audit. |

When a finding lands: add a row, link the PR that fixed it or the residual that owns it, never delete history.

---

## 3 · Proof already on tip (do not rebuild)

- Smart account suite compiles (solc 0.8.28); CREATE2 TypeScript ↔ factory cross-check (#210).
- AMM mint/`swapExactIn` on a real chain (#288); token factory E2E (#217).
- **S-A9:** `PasskeyOwner` + RIP-7212 path; hermetic WebAuthn bridge tests aligned with `svc-identity`.
- **S-A1 internal matrix:** `services/svc-protocol/src/accounts/adversarial-audit.test.ts` (12 tests) maps §1 rows for platform / bundler / session-thief / SessionKeyLib↔TS lockstep.

---

## 4 · Residuals before any `audited:true`

1. External review (or explicit Nitro deferral → keep socket).
2. Fuzz / invariant suite (`socket.contract-toolchain` residual).
3. Live EntryPoint hash differential.
4. Gas snapshot on the **ruled** P0 rail (S-D1) for `PasskeyOwner.isValidSignature`.
5. Origin/rpId on-chain binding (today origin is enrolment-time off-chain only — named in PasskeyOwner NatSpec).

---

## 5 · How to close this package for `audited:true`

- Findings empty or all fixed/residual-owned.
- Artefact hash of reviewed bytecode recorded.
- Signer / firm named.
- Tracker `socket.contract-audit` moves only with that evidence — never with "tests pass."
