# Claim TRK-trade.copy

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** merged
**proof:** #1009 merged 2026-08-07 — copy Stage refuse-closed blank DIRECTION §8 rates
**owner:** cursor-swarm-copy
**class:** M
**scope:** D-S-03 / SPEC-SOVEREIGN-ROUTING-AND-COPY Stage — follow/unfollow + envelope mirror; refuse blank DIRECTION §8 leader_share_bps + jurisdiction; ledger-client fee-share when published
**branch:** feat/trade-copy-stage
**updated:** 2026-08-07 (claim closed against merged main)

## Non-goals

- Invent `leader_share_bps` / jurisdiction allowlist (DIRECTION §8)
- Touch `futures/**` · `otc/**` · `algo/**`
- P&L-linked fees · returns-ranked leaderboards · pooling
- On-chain session-key scope (SPEC §7.1 — residual)

## Shipping

Refuse-closed default in `services/svc-trade/src/copy/**`; tests prove blank-law refuse + envelope caps + ledger fee-share when published.

> Closed by the claim-board honesty pass. The code merged; the claim was never closed, so
> `swarm:freeze` kept reporting this mountain as owned by a session that no longer exists.
> Residual noted above (if any) is unchanged and still real — closing the claim closes the
> SLICE, not the mountain. Mountain state lives in `tooling/tracker/features.mjs`.
