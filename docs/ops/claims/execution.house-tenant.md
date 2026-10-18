# Claim execution.house-tenant

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** pr-open
**pr:** https://github.com/Phantom-X-007/intafaced/pull/2227
**owner:** Nitro agent
**class:** N
**tracker:** execution.house-tenant
**branch:** feat/execution-house-tenant-mechanism
**started:** 2026-08-16

## Goal

ADR D26-P0-01 Stage-1: tenancy **mechanism** (separate keys, namespace, audit, kill-switch, no matching-path privilege). Internal-venue half stays blocked.

## Done-bar

- `packages/execution-house-tenant` + thin `services/svc-execution` (`execution.tenant.describe` / `kill`)
- `kind: 'internal'` / `matching-book` → `internal_venue`
- Kill applies first; killed tenant cannot quote/route even external
- No svc-matching import; no queue privilege; no alpha in repo
- No second money book

## Non-goals

- SOR / OMS / EMS / arbitrage
- Internal house MM
- Compose restamp beyond the product service block + EXECUTION_URL required by workspace-sync
