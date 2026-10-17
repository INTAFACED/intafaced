# L0 machine pass notes — Audit V2

**Date:** 2026-07-29  
**Claim tags:** `[VERIFIED 2026-07-29]` brand-scan this session · PG money tests require docker (local unavailable)

| Check                                     | Result                                                         |
| ----------------------------------------- | -------------------------------------------------------------- |
| `node tooling/ci/brand-scan.mjs`          | **clean** (after scrubbing model-vendor names from audit docs) |
| `pnpm scan:custody`                       | run in CI / when docker up                                     |
| svc-pay / token / bank unit tests (no PG) | **pass** (router, rails, economics, mount)                     |
| svc-pay / token / bank money-path tests   | **skipped** without Postgres on port 5433 — CI must run them   |
| Typecheck pay/token/bank                  | **pass** this session                                          |

## Greps / doctrine hard-bans (spot)

Money movement in production services continues via `recipes.*` + `ledger.post` in the fixed paths. Residual dual-book (L1-2/L1-3) still parked P2.

## V2 code proof (when PG available)

```bash
pnpm --filter @intafaced/svc-pay test
pnpm --filter @intafaced/svc-token test
pnpm --filter @intafaced/svc-bank test
```
