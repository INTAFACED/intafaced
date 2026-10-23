# Claim ops.notifications (agent action refused inbox)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** LIVE this session
**tracker:** `ops.notifications` (stays **ready** — OOA still Class X credentials; digest still unwired by product law)
**branch:** `feat/notify-agent-action-rejected`
**class:** N

Durable consumer `notify-agent-action-rejected` on existing `agentActionRejected` (svc-agents publisher). Inbox on guardrail refusal. Closes the Class A missing-subscriber socket because a live consumer now exists. No invented publisher. No digest wire. No `agentActionCompleted` (high-frequency; table already serves the log).

## Leverage

Phase A IN: existing `svc-notify` attach + `packages/events` catalog + `@intafaced/i18n`. Horizon row `ops.notifications` = IN.

## Non-goals

- Dual-edit #1831/#1832 svc-trade `index.ts` / public-rest
- Wire digest into dispatch (`digest-not-wired.test.ts` stands)
- Class X email/push/sms credentials
- Notify on every `agentActionCompleted`
