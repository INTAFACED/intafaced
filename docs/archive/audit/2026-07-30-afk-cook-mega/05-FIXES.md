# 05-FIXES

| finding | attempt | change                                         | affected L0 re-run  | PR        |
| ------- | ------- | ---------------------------------------------- | ------------------- | --------- |
| BRAND-1 | 1       | Scrub model-provider name from overlay docs    | brand=0             | (this PR) |
| FMT-1   | 1       | prettier --write offenders                     | format:check=0      |           |
| M1      | 1       | `0002_display_name_backfill.sql` + down        | db:check=0 (24 mig) |           |
| R5      | 1       | fail-closed `trade.sub_account_ungated`        | trade tests 122p/1s |           |
| R6      | 1       | cost from price ?? protectionPrice + unit test | trade tests         |           |
| WS-JWT  | 1       | compose JWT\_\* + env audience default         | ws tests 64p        |           |
| R7      | 1       | fossil-label free-mountains scoreboards        | n/a docs            |           |

## Local proof (pre-merge)

```
$ pnpm scan:brand
✓ brand-scan clean — 586 files
exit=0

$ pnpm format:check
All matched files use Prettier code style!
exit=0

$ pnpm db:check
✓ migration-check clean — 24 migration(s) across 12 service(s), all reversible
exit=0

$ pnpm --filter @intafaced/svc-trade test
Tests  122 passed | 1 skipped (123)
exit=0

$ pnpm --filter @intafaced/svc-ws test
Tests  64 passed
exit=0

$ pnpm scan:custody / vendor-shell / workspace / tracker:check
all exit=0
```

Money suite `trade-service.test.ts` still **SKIPPED** (no Postgres) — not claimed verified.
