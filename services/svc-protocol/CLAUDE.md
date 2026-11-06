# @intafaced/svc-protocol

The Protocol Plane smart account layer. Read `README.md` before editing.

- Tests: `*.test.*` files under `scripts/`, `src/`. Run `pnpm --filter @intafaced/svc-protocol test`.
- Root rules that matter most here: Protocol Plane: never import ledger write recipes (`pnpm scan:custody`). This is a security service: its changes go in their own PR, not in a journey PR; no reading other services' tables. Protected money/security package: a red test here blocks merge even if main shares it (AGENTS.md).
- Env, ports and required settings: `docs/SERVICES.md` (generated). All other rules: root `AGENTS.md`.
