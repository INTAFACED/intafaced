# ADR — Paymaster sponsorship + bundler dependency (S-A10 / S-A11)

**Status:** accepted  
**Status note:** Accepted (policy + contract); funding half open  
**Date:** 2026-08-08  
**Board:** S-A10 · S-A11  
**Tracker:** `socket.paymaster-policy` · `socket.bundler-policy`

## Decision

### S-A10 — Who pays gas

- Sponsorship is gated by an explicit **allowlist**, **permitted call selectors**, and a **per-UserOp gas cap** (`src/chain/paymaster-policy.ts`).
- The on-chain half is `ScopedPaymaster.sol` (2026-08-19): native float, same refuse when unfunded. Operator can only withdraw this contract's leftover ETH.
- If the paymaster deposit is **not funded**, every sponsorship decision is `funding_unconfigured` — refuse, do not pretend.
- **Funding the deposit account is Nitro Class X.** The contract/policy path is Protocol Plane; the ETH/native behind it is not.

### S-A11 — Bundler

- Modes: `user_submits` | `public_bundler` | `self_hosted`.
- Default safe posture until a URL is configured: **user submits**.
- Public bundler failure mode is stated: **censor / reorder** risk; always `fallbackToUserSubmit: true`.
- Live EntryPoint **differential** (`socket.userop-differential-test`) remains a residual gate before mainnet UserOps.

## Consequences

- Retail zero-native UX is blocked on Nitro funding even when policy code is green.
- `PROTOCOL_BUNDLER_URL` may stay unset; the service must not invent a bundler.
