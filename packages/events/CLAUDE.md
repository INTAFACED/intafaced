# @intafaced/events

The NATS bus and the subject catalog (`src/catalog.ts`). No README; read `docs/ARCHITECTURE.md` and `src/` before editing.

- Tests: `*.test.*` files under `src/`. Run `pnpm --filter @intafaced/events test`.
- Root rules that matter most here: Services and events rules apply to anything that crosses a service.
- Env, ports and required settings: `docs/SERVICES.md` (generated). All other rules: root `AGENTS.md`.
