# @intafaced/svc-execution

Bounded execution foundations: sealed house-tenancy controls plus partial OMS/SOR/EMS, external arbitrage and external market-making doors. Read `README.md` before editing.

- Tests: `*.test.*` files under `src/`. Run `pnpm --filter @intafaced/svc-execution test`.
- Root rules that matter most here: Non-custodial: holds no balance (`packages/config/src/modules.ts`). One PR may carry one whole journey across services, contracts and events; ledger-client money recipes and the security services and packages go in their own PR; no reading other services' tables. Protected money/security package: a red test here blocks merge even if main shares it (AGENTS.md).
- Env, ports and required settings: `docs/SERVICES.md` (generated). All other rules: root `AGENTS.md`.
