# Wave D doctrine scans — 2026-07-30

**Why this file:** `docs/audit/WAVE-D-2026-07-30.md` already exists on tip (product-batch narrative). This file is the **re-run gate log** with real exit codes from this worktree.

| Field          | Value                                                                  |
| -------------- | ---------------------------------------------------------------------- |
| Tip            | `5c291b5` (`origin/main` at run — Wave D grind loop high-water #151)   |
| Worktree       | `.worktrees/docs-audit-wave-d-run` · branch `docs/audit-wave-d-run`    |
| When (UTC)     | 2026-07-30T01:53:51Z                                                   |
| Runner         | `node tooling/ci/*` and `node tooling/scripts/tracker.mjs` (no invent) |
| GitHub Actions | still **billing-blocked** — local gates only; not a CI green claim     |

## Verdict

| Gate                           | Result           | Exit | Last line / note                                                                                                                                                             |
| ------------------------------ | ---------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm scan:brand`              | **GREEN**        | 0    | `✓ brand-scan clean — 568 files, 0 forbidden names (Doctrine §0.7)`                                                                                                          |
| `pnpm scan:custody`            | **GREEN**        | 0    | `✓ custody-scan clean — 67 files across 3 Protocol Plane service(s)`                                                                                                         |
| `pnpm scan:vendor-shell`       | **GREEN**        | 0    | `✓ vendor-shell-scan clean — 1107 vendor file(s), 7 hazard pattern(s)`                                                                                                       |
| `pnpm scan:workspace`          | **GREEN**        | 0    | `✓ workspace-sync clean — 16 service(s) reach both the image and the fleet`                                                                                                  |
| `pnpm tracker:check`           | **RED**          | 1    | `✖ stale: docs/TRACKER.md` · fix: run `pnpm tracker` and commit                                                                                                              |
| `pnpm scan:i18n`               | **GREEN** (warn) | 0    | 1 possible hardcoded string: `apps/web/src/components/app-shell.tsx:41` `aria-label="Modules"`                                                                               |
| migration-check                | **GREEN**        | 0    | `✓ migration-check clean — 22 migration(s) across 12 service(s), all reversible`                                                                                             |
| `node tooling/ci/dod-gate.mjs` | **RED**          | 1    | DoD gate failed: `svc-notify` — no OpenTelemetry instrumentation (§14). 15 other services clean. Manual sign-offs still open (e2e CI, i18n, Grafana SLO panel, kill-switch). |

**Doctrine scans (brand / custody / vendor-shell / workspace): all green.**  
**Honest reds:** tracker markdown stale; DoD gate red on `svc-notify` OTEL only (pre-existing, not introduced by docs).

## Commands that were run (verbatim)

```bash
node tooling/ci/brand-scan.mjs
node tooling/ci/custody-scan.mjs
node tooling/ci/vendor-shell-scan.mjs
node tooling/ci/workspace-sync.mjs
node tooling/scripts/tracker.mjs --check
node tooling/ci/i18n-scan.mjs
node tooling/ci/migration-check.mjs
node tooling/ci/dod-gate.mjs
```

Full `pnpm verify` (turbo build/typecheck/test) was **not** run this pass — no install in this worktree; scans above are pure Node and need no `node_modules` for these scripts.

## Not claimed

- GitHub Actions green
- Full monorepo test suite
- Tracker regenerated (out of scope for this scan log; separate hygiene PR)
- `svc-notify` OTEL fix

## Operator next

1. `pnpm tracker` + commit when ready (clears tracker:check red)
2. Human: GitHub Actions billing
3. Optional later: OTEL on `svc-notify` so DoD gate can go green
