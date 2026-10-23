# Claim pay.subscriptions

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** claimed
**tracker:** pay.subscriptions
**board:** D26-P1-P6 residual — real pre-charge notify attempt
**branch:** feat/pay-subscriptions-precharge-notify
**owner:** nitro-agents
**started:** 2026-08-16
**paths:**

- services/svc-pay/src/subscriptions/**
- services/svc-pay/src/subscription-router.ts (subscription procedures only)
- services/svc-pay/drizzle/0015_pay_subscription_precharge_notify.sql
- docs/ops/claims/pay.subscriptions.md

## Done bar

- [x] Before capture/invoice, record pre-charge notify attempt on the execution
- [x] Unwired port → `notifyStatus: skipped_unwired` + `pay.subscription_notify_unwired` (never silent notified)
- [x] Wired port → `attempted`; throw → `failed`; `notified` stays false
- [x] No invent dunning / no invent card pull (`pay.mandate_rail_absent` stays)
- [ ] pnpm verify
- [ ] PR link

## Law

- Do not hand-edit docs/LIVE-LANES.md
- Do not invent pull-from-card. Crypto remains invoice-and-watch
- No compose YAML. No promise-falsify public-doors files
- Avoid fraud/**, plugins/**, decideKyb* / merchant-kyb-money-gate*
