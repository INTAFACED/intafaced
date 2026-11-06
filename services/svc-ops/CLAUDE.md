# @intafaced/svc-ops

Thin operator surfaces for CRM, team directory, warehouse revenue, projects and custody tiers. Read `README.md` before editing.

- Tests: `*.test.*` files under `src/`. Run `pnpm --filter @intafaced/svc-ops test`.
- Root rules that matter most here: Non-custodial: holds no balance (`packages/config/src/modules.ts`). This is a security service: its changes go in their own PR, not in a journey PR; no reading other services' tables. Protected money/security package: a red test here blocks merge even if main shares it (AGENTS.md).
- Env, ports and required settings: `docs/SERVICES.md` (generated). All other rules: root `AGENTS.md`.
