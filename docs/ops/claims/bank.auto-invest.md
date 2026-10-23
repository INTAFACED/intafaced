# Claim bank.auto-invest (ConvertPort → trade.convert)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** LIVE this session
**tracker:** `bank.auto-invest` (stays **wip** on features.mjs — this slice does not flip the mountain)
**branch:** `feat/bank-auto-invest-convert-port`
**class:** M (convert is the rate counterparty; no second book)

Production-wire existing `ConvertPort` so DCA can call live `trade.convert` (quote+execute). `index.ts` passes `autoInvest.convert` when `TRADE_URL` is usable — same missing-wiring shape as cards/ramps. Convert failure still refuses `bank.auto_invest_rate_unset`; bank invents no §8 mid.

## Leverage

Phase A IN: `svc-bank` ConvertPort + `TRADE_URL` (already used by loan/card ticker reads) + existing `trade.convert` on svc-trade. Horizon path IN. No new ledger recipe. No compose restamp (#2194). No Vue/shell.

## Non-goals

- docker-compose / loan quote-asset compose
- `features.mjs` / LIVE-LANES
- Shehzad chain, Vue, `apps/web`, `apps/admin`, `packages/ui`
- Invent mids inside bank
