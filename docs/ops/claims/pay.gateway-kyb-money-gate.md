# Claim pay.gateway (KYB money-gate IN slice)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** claimed
**tracker:** `pay.gateway` (stays **ready** — card acquiring / `socket.psp-partners` is still the socket; not mountain-done)
**branch:** `feat/pay-gateway-kyb-money-gate`
**class:** M
**owner:** Phantom-X-007 (Denon agent)

Wire existing `merchants.kybStatus` into money doors. `rejected` never transacts like approved. `live-only` requires approved KYB (`pay.kyb_required`). No invented KYB vendor, card rails, PSP, or Hyperswitch. `PAY_REGISTER_CARD_SANDBOX` stays off in ship postures.

## Leverage

Phase A IN: existing svc-pay checkout/payment/merchant KYB fields from #346/#800. Horizon `pay.gateway` = IN+X — this slice is IN only. Class X = card acquiring.

## Non-goals

- Dual-edit #1841 svc-agents, #1842 svc-bank, #1843 packages/venue-adapter, svc-academy, svc-ws
- Enable card sandbox in staging/prod
- Mark tracker `done`
