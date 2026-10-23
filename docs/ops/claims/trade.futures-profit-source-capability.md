# Claim trade.futures (profit source unnamed on capabilities)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** LIVE this session
**tracker:** `trade.futures` (stays **wip** — N1 pot still unnamed; no mountain-done)
**owner session:** Denon agent
**class:** N
**branch:** `feat/futures-profit-source-capability`
**scope:** `GET /api/v1/capabilities` `notes.futures.profitSourceConfigured`

Opens refuse `trade.futures_unconfigured` when `TRADE_FUTURES_PROFIT_SOURCE` is empty. Capabilities now say that out loud. Does not name an account.

## Leverage

Phase A IN: existing `optionalProfitSourceFromConfig` + capabilities note. Horizon `trade.futures` = IN.

## Non-goals

- Invent / default the profit-source account
- Enable futures orders
- Dual-edit Shehzad chain
