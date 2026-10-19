# @intafaced/svc-protocol

The Protocol Plane's smart account layer (§17.4, §17.5). Read `README.md` before editing.

- Tests: `*.test.*` files under `scripts/`, `src/`. Run `pnpm --filter @intafaced/svc-protocol test`.
- Root rules that matter most here: One service per PR; services never read each other's tables; cross-service changes are two PRs (contracts or events first). Money rules apply if this touches value.
- Env, ports and required settings: `docs/SERVICES.md` (generated). All other rules: root `AGENTS.md`.
