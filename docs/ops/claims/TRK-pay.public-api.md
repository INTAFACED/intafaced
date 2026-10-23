# Claim TRK-pay.public-api

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** merged
**proof:** #1006 · #1014 merged 2026-08-07 — merchant outbound webhooks (step 3), then sandbox API keys (step 4)
**updated:** 2026-08-07 (claim closed against merged main)
**owner:** cursor-swarm-pay-w3
**started:** 2026-08-07T11:20:00.000Z
**heartbeat:** 2026-08-07T11:20:00.000Z
**title:** Public REST + webhooks + sandbox (§9) — step 3 outbound webhooks
**track:** TRACKER
**paths:**

- docs/ops/trk/pay.public-api.md
- services/svc-pay/src/merchant-webhooks.ts
- services/svc-pay/src/public-rest.ts
- services/svc-pay/drizzle/0008_pay_merchant_webhooks.sql

## Done bar

- [ ] Implemented
- [ ] claim:check clean or residual-owned
- [ ] pnpm verify (or FE-VERIFY when available)
- [ ] Proof: fleet OR proof_missing: fleet-blocked (NO-FLEET)
- [ ] PR link

## Law

- Do not hand-edit docs/LIVE-LANES.md mid-wave (inside Denon open PRs).
- Do not invent money/depth. No Shehzad implement. No dual-edit Denon open files.
- No Class X PSP/card go-live. Step 3 = signed outbound webhooks + retry + failure dashboard only.

> Closed by the claim-board honesty pass. The code merged; the claim was never closed, so
> `swarm:freeze` kept reporting this mountain as owned by a session that no longer exists.
> Residual noted above (if any) is unchanged and still real — closing the claim closes the
> SLICE, not the mountain. Mountain state lives in `tooling/tracker/features.mjs`.
