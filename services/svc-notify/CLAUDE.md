# @intafaced/svc-notify

Event-driven notification fan-out for the in-app inbox. Read `README.md` before editing.

- Tests: `*.test.*` files under `scripts/`, `src/`. Run `pnpm --filter @intafaced/svc-notify test`.
- Root rules that matter most here: Non-custodial: holds no balance (`packages/config/src/modules.ts`). One service per PR; no reading other services' tables; cross-service changes are two PRs (contracts or events first), except that a slice's contracts, one service and its screen land as one PR.
- Env, ports and required settings: `docs/SERVICES.md` (generated). All other rules: root `AGENTS.md`.
