# @intafaced/svc-notify

Event-driven notification fan-out for `ops.notifications`. Read `README.md` before editing.

- Tests: `*.test.*` files under `scripts/`, `src/`. Run `pnpm --filter @intafaced/svc-notify test`.
- Root rules that matter most here: One service per PR; services never read each other's tables; cross-service changes are two PRs (contracts or events first). Money rules apply if this touches value.
- Env, ports and required settings: `docs/SERVICES.md` (generated). All other rules: root `AGENTS.md`.
