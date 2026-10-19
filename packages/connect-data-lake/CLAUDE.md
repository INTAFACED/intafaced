# @intafaced/connect-data-lake

Stage-1 in-process capture log for §27:762 / D-S-18. Read `README.md` before editing.

- Tests: `*.test.*` files under `src/`. Run `pnpm --filter @intafaced/connect-data-lake test`.
- Root rules that matter most here: Services and events rules apply to anything that crosses a service. Money rules apply: move value only through `packages/ledger-client` recipes.
- Env, ports and required settings: `docs/SERVICES.md` (generated). All other rules: root `AGENTS.md`.
