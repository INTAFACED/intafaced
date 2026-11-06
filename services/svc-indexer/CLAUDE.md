# @intafaced/svc-indexer

Chain to Postgres read models: books, fills and positions. Read `README.md` before editing.

- Tests: `*.test.*` files under `scripts/`, `src/`. Run `pnpm --filter @intafaced/svc-indexer test`.
- Root rules that matter most here: Protocol Plane: never import ledger write recipes (`pnpm scan:custody`). One PR may carry one whole journey across services, contracts and events; ledger-client money recipes and the security services and packages go in their own PR; no reading other services' tables. Protected money/security package: a red test here blocks merge even if main shares it (AGENTS.md).
- Env, ports and required settings: `docs/SERVICES.md` (generated). All other rules: root `AGENTS.md`.
