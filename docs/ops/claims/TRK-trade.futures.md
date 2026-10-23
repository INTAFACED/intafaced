# Claim TRK-trade.futures

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** merged
**proof:** #995 merged 2026-08-07 — freeze voluntary futures exits when the mark feed is dark
**owner:** cursor-swarm-futures
**class:** M
**scope:** D-S-01 / D-S-07 decided halves — exit-when-dark `closing` state (ADR 2026-08-07); no invent of mark/funding/mid; no owner-gated profit-account choice
**branch:** feat/futures-denon-residual
**updated:** 2026-08-07 (claim closed against merged main)

## Human blockers (blank L1 — do not invent)

- Dark-feed horizon / operator alert when `closing` never settles (`DIRECTION` §8).
- Which account funds realised profit / capitalisation (`DIRECTION` §8 item 6) — mechanism already refuses when unconfigured/underfunded.
- Operator adjudicated settlement of never-returning feeds — **no until decided**.

## Shipping

Exit-when-dark done bar: freeze on dark voluntary close, skip liq/funding, idempotent retry, settle at mark return through ordinary bound + armed breaker, honest `closing` render.

> Closed by the claim-board honesty pass. The code merged; the claim was never closed, so
> `swarm:freeze` kept reporting this mountain as owned by a session that no longer exists.
> Residual noted above (if any) is unchanged and still real — closing the claim closes the
> SLICE, not the mountain. Mountain state lives in `tooling/tracker/features.mjs`.
