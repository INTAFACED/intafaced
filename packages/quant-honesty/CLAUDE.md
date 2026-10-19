# @intafaced/quant-honesty

Refuse-first contracts for §29 Quant backtest surfaces. Read `README.md` before editing.

- Tests: `*.test.*` files under `src/`. Run `pnpm --filter @intafaced/quant-honesty test`.
- Root rules that matter most here: Services and events rules apply to anything that crosses a service. Money rules apply if this touches value.
- Env, ports and required settings: `docs/SERVICES.md` (generated). All other rules: root `AGENTS.md`.
