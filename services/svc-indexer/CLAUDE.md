# @intafaced/svc-indexer

Chain to Postgres read models: books, fills and positions. Read `README.md` before editing.

- Tests: `*.test.*` files under `scripts/`, `src/`. Run `pnpm --filter @intafaced/svc-indexer test`.
- Root rules that matter most here: Protocol Plane: never import ledger write recipes (`pnpm scan:custody`). One service per PR; no reading other services' tables; cross-service changes are two PRs (contracts or events first), except that a slice's contracts, one service and its screen land as one PR. Protected money/security package: a red test here blocks merge even if main shares it (AGENTS.md).
- Env, ports and required settings: `docs/SERVICES.md` (generated). All other rules: root `AGENTS.md`.
