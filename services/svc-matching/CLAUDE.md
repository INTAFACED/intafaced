# @intafaced/svc-matching

The engine: orderbooks and matching. Read `README.md` before editing.

- Tests: `*.test.*` files under `src/`. Run `pnpm --filter @intafaced/svc-matching test`.
- Root rules that matter most here: Non-custodial: holds no balance (`packages/config/src/modules.ts`). One service per PR; no reading other services' tables; cross-service changes are two PRs (contracts or events first). Protected money/security package: a red test here blocks merge even if main shares it (AGENTS.md).
- Env, ports and required settings: `docs/SERVICES.md` (generated). All other rules: root `AGENTS.md`.
