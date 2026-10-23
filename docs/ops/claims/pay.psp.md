# Claim — pay.psp operator digital KYB (D26-P1-P1 residual)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** pr-open
**proof:** https://github.com/Phantom-X-007/intafaced/pull/2214
**branch:** feat/pay-psp-operator-kyb
**owner:** Nitro agent
**started:** 2026-08-16
**tracker:** pay.psp
**paths:**

- services/svc-pay/src/payment-service.ts
- services/svc-pay/src/payment-service.test.ts
- services/svc-pay/src/router.ts
- services/svc-pay/src/router.test.ts

## Done bar

- Operator `merchant.decideKyb` scoped `admin:compliance` (existing KYB ops scope; not merchant `pay:write`)
- Works under `valueMovement: live-only`
- Pending → approved|rejected writes `pay.merchants.kyb_status` (same table as `decideKybStub`)
- Live-only: none/pending/rejected cannot `payment.create` / checkout; approved passes KYB gate
- `decideKybStub` remains sandbox-only
- No PSP/acquirer library; no invented fee bps

## Law

- Do not edit docker-compose. Do not restamp promise-falsify public doors.
- Do not dual-edit #2117 `services/svc-pay/src/fraud/**` or `plugins/**`.
- No Class X KYC vendor webhook. No LIVE-LANES.md edit.
