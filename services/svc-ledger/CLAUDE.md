# @intafaced/svc-ledger

The single wallet graph for the whole platform; every value movement is a double-entry transaction here. Read `README.md` before editing.

- Tests: `*.test.*` files under `scripts/`, `src/`. Run `pnpm --filter @intafaced/svc-ledger test`.
- Root rules that matter most here: Custodial: move value only through `packages/ledger-client` recipes. One PR may carry one whole journey across services, contracts and events; ledger-client money recipes and the security services and packages go in their own PR; no reading other services' tables. Protected money/security package: a red test here blocks merge even if main shares it (AGENTS.md).
- Env, ports and required settings: `docs/SERVICES.md` (generated). All other rules: root `AGENTS.md`.
