# Claim ops.support-sla-not-promise

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** claimed
**owner:** cursor-denon
**slice:** queue score is not an SLA / timed promise
**tracker:** ops.support
**branch:** feat/ops-support-sla-not-promise
**updated:** 2026-08-14
**Class:** N
**Board-Delta:** ops.support queue timing is score_not_promise, never an SLA.

## Goal

Priority stays a score. Wire payloads must not invent eta / dueAt / slaMinutes. Owner ruling still required before any user-facing support timing.

## Done-bar

Tests fail if a queue row looks like a timed SLA; `timingKind: score_not_promise` and `sla: false` on every entry; tracker stays ready (compose observe + Vue HUMAN remain).

## Leverage

Phase A IN: existing `services/svc-support` operator queue. Horizon `ops.support` = IN. No Vue. No invented SLA magnitudes.

## Do not touch

- #1853/#1851 svc-pay · #1855 svc-ws · #1859 svc-agents
- Shehzad chain · invent SLA minutes · nitro-frontend-all
- tracker stays `ready`
