# @intafaced/svc-dex

The Protocol Plane front door: a DEX service that never posts to the ledger. Read `README.md` before editing.

- Tests: `*.test.*` files under `src/`. Run `pnpm --filter @intafaced/svc-dex test`.
- Root rules that matter most here: Protocol Plane: never import ledger write recipes (`pnpm scan:custody`). One service per PR; no reading other services' tables; cross-service changes are two PRs (contracts or events first), except that a slice's contracts, one service and its screen land as one PR. Protected money/security package: a red test here blocks merge even if main shares it (AGENTS.md).
- Env, ports and required settings: `docs/SERVICES.md` (generated). All other rules: root `AGENTS.md`.
