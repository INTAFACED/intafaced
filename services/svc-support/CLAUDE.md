# @intafaced/svc-support

Support desk: tickets, knowledge base and operator queue. Read `README.md` before editing.

- Tests: `*.test.*` files under `scripts/`, `src/`. Run `pnpm --filter @intafaced/svc-support test`.
- Root rules that matter most here: Non-custodial: holds no balance (`packages/config/src/modules.ts`). One PR may carry one whole journey across services, contracts and events; ledger-client money recipes and the security services and packages go in their own PR; no reading other services' tables.
- Env, ports and required settings: `docs/SERVICES.md` (generated). All other rules: root `AGENTS.md`.
