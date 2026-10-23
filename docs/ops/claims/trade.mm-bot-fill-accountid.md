# Claim — trade.mm-bot orderFilled accountId recovery

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** pr-open
**proof:** https://github.com/Phantom-X-007/intafaced/pull/1852
**owner:** denon-agent
**class:** M
**mountain:** trade.mm-bot
**branch:** feat/trade-mm-fill-accountid
**paths:** `services/svc-trade/src/mm/fill-account.ts`, `services/svc-trade/src/spot/trade-service.ts`, `services/svc-trade/src/events.ts`
**updated:** 2026-08-14

## Done bar

| Criterion                        | Proof                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------- |
| Seeded MM fill has accountId     | `recoverMatchingAccountId` → `house:market-maker`; tests fail on empty / HOUSE_MM_USER_UUID |
| Not an anonymous customer fill   | `looksLikeAnonymousCustomerFill` true for empty + bookkeeping UUID; false after recovery    |
| Kill still kills placeOrder seed | `TRADE_MM_SEED_ENABLED` / `seedPlaceEnabled` + `mmSeedJobsArmed(false)` unchanged           |
| No invented mids                 | Recovery is identity only — no mid / depth / price path                                     |
| Tracker stays ready              | `trade.mm-bot` remains `ready` — production mid ops residual                                |

## Leverage

Phase A IN: existing `services/svc-trade/src/mm` + `settleFillEvent` house-MM limb. Extend recovery; do not rebuild MM or invent mids.
