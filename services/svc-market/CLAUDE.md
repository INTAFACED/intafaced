# @intafaced/svc-market

Vendor lifecycle plus listings and one-time purchases. Read `README.md` before editing.

- Tests: `*.test.*` files under `scripts/`, `src/`. Run `pnpm --filter @intafaced/svc-market test`.
- Root rules that matter most here: Custodial: move value only through `packages/ledger-client` recipes. One service per PR; no reading other services' tables; cross-service changes are two PRs (contracts or events first). Protected money/security package: a red test here blocks merge even if main shares it (AGENTS.md).
- Env, ports and required settings: `docs/SERVICES.md` (generated). All other rules: root `AGENTS.md`.
