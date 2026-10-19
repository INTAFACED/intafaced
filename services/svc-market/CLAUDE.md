# @intafaced/svc-market

Vendor lifecycle for `market.vendors` (§8.7) plus listings and one-time purchase Read `README.md` before editing.

- Tests: `*.test.*` files under `scripts/`, `src/`. Run `pnpm --filter @intafaced/svc-market test`.
- Root rules that matter most here: One service per PR; services never read each other's tables; cross-service changes are two PRs (contracts or events first). Money rules apply: move value only through `packages/ledger-client` recipes.
- Env, ports and required settings: `docs/SERVICES.md` (generated). All other rules: root `AGENTS.md`.
