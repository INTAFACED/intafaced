# Claim TRK-bank.ramps

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** merged
**proof:** #997 merged 2026-08-07 — crypto ledger half for bank.ramps (D-S-09)
**owner:** cursor-swarm-bank
**branch:** feat/bank-denon-residual
**updated:** 2026-08-07 (claim closed against merged main)

## Scope

D-S-09 / ADR `docs/adr/2026-08-04-bank-vertical-law.md` — **crypto ledger half** of `bank.ramps`.

- Buildable: router + ledger recipes (`deposit` / `withdrawHold` / `withdrawSettle`) into bank spaces.
- Fiat leg remains **§13** `socket.psp-partners` — refuse-closed, never invented.
- No earn APY invention. No card BIN commercial truth.

## Do not touch

`services/svc-pay/**` · pay/trade/agents · invent live PSP / BIN.

> Closed by the claim-board honesty pass. The code merged; the claim was never closed, so
> `swarm:freeze` kept reporting this mountain as owned by a session that no longer exists.
> Residual noted above (if any) is unchanged and still real — closing the claim closes the
> SLICE, not the mountain. Mountain state lives in `tooling/tracker/features.mjs`.
