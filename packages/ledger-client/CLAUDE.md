# @intafaced/ledger-client

The only way a service touches balances; money-move recipes live in `src/recipes` (see `RECIPES.md`). No README; read `docs/ARCHITECTURE.md` and `src/` before editing.

- Tests: `*.test.*` files under `src/`. Run `pnpm --filter @intafaced/ledger-client test`.
- Root rules that matter most here: Services and events rules apply to anything that crosses a service. Protected money/security package: a red test here blocks merge even if main shares it (AGENTS.md).
- Env, ports and required settings: `docs/SERVICES.md` (generated). All other rules: root `AGENTS.md`.
