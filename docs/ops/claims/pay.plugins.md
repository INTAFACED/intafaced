# Claim pay.plugins

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** pr-open
**proof:** https://github.com/Phantom-X-007/intafaced/pull/2205
**owner:** nitro-agents
**started:** 2026-08-16T12:53:00.000Z
**heartbeat:** 2026-08-16T13:10:00.000Z
**branch:** feat/pay-plugins-woocommerce
**title:** WooCommerce CMS adapter on pay.public-api + reference-client
**track:** TRACKER
**paths:**

- plugins/woocommerce-intafaced-pay/
- services/svc-pay/src/plugins/woocommerce-contract.test.ts
- services/svc-pay/src/plugins/cms-unwired.ts
- services/svc-pay/src/plugins/cms-unwired.test.ts
- docs/ops/claims/pay.plugins.md

## Done bar

- [x] Implemented
- [x] claim:check clean or residual-owned
- [ ] pnpm verify (local NATS/Postgres isolation red; plugins suite green)
- [x] PR link: https://github.com/Phantom-X-007/intafaced/pull/2205

## Law

- Do not hand-edit docs/LIVE-LANES.md (parallel agents).
- Stay out of #2117 fraud / settlement / rails (read plugins/reference-client + webhook-vectors only).
- Leverage: GF CMS adapter on Phase A `pay.public-api` + reference-client — not a second pay stack.
