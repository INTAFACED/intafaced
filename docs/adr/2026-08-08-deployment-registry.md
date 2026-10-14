# ADR — Deployment registry (S-A13)

**Status:** accepted  
**Status note:** Accepted (artefact format)  
**Date:** 2026-08-08  
**Board:** S-A13 · `socket.deployment-registry`

## Decision

Every non-local deployment is recorded as JSON under `services/svc-protocol/deployments/`:

- `chainId` / `chainName`
- per contract: `name`, `address`, `suite`, `sourceHash` (from compile suite), optional `explorerUrl`, `verified`

Schema + parse live in `src/deployments/registry.ts`. Example: `deployments/dev-anvil.example.json` (placeholder addresses — **not** a claim of public deploy).

## Consequences

- Env defaults may remain zero until a real row exists.
- Explorer verification and persistent testnet entries wait on **Nitro RPC funding**.
- Third parties reproduce by matching `sourceHash` to committed `contracts/out` artefacts.
