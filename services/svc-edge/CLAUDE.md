# @intafaced/svc-edge

Turns a bearer token into the signed principal every mounted service requires, and refuses to carry anything else a caller tried to smuggle in. Read `README.md` before editing.

- Tests: `*.test.*` files under `src/`. Run `pnpm --filter @intafaced/svc-edge test`.
- Root rules that matter most here: Non-custodial: holds no balance (`packages/config/src/modules.ts`). This is a security service: its changes go in their own PR, not in a journey PR; no reading other services' tables. Protected money/security package: a red test here blocks merge even if main shares it (AGENTS.md).
- Env, ports and required settings: `docs/SERVICES.md` (generated). All other rules: root `AGENTS.md`.
