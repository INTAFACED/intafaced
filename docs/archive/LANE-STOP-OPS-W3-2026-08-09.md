# LANE STOP — OPS wave 3 — 2026-08-09

```
LANE: OPS wave 3
shipped:
  #1179 — support tickets survive restarts; two operators cannot both claim the same one
  #1180 — affiliate attribute cycle lock + self-only myAccruals (on #1133 rate law)
  #1184 — unknown region is distinguishable; optional fail-closed (default OFF)
  #1185 — warehouse lag cannot claim "live" from a typed env number forever
  #1187 — stuck notify pending reaped; register/verify rate-limited; consent footer
  #1188 — admin Operator tools page wires already-mounted edge APIs (honest not-wired)
  #1200 — tracker mountain notes + ops.notifications ghost owner cleared
in flight: none (OPS mechanism queue drained for agent-doable O1–O3)
parked:
  · customer Vue support form (vendor shell skill / i18n) — product surface residual
  · affiliate Class M payout automation — needs DIRECTION §8 published rates + ledger recipe
  · notify out-of-app delivery — Class X gateway credentials
  · analytics ETL watermark + real pg lag probe pool + cube job callers
  · geo header resolution (socket.geo-region-resolution) + VPN/Tor feed — Nitro/counsel
  · admin SSO / network ACL on :3100 — Class X
  · ledger reconcile full 3-service mount — left simulated (honest); or full stack later
Nitro must decide:
  · affiliate fee-share rates (DIRECTION §8)
  · notify email/push/SMS gateway credentials
  · sanctions list content + whether to set INTAFACED_REGION_FAIL_CLOSED=true in prod
  · admin production exposure (SSO / ACL / who holds admin:treasury)
  · geo resolution trusted upstream
SAFE TO CLOSE: yes — agent O1–O3 mechanism queue shipped; Class X/owner only remain
tip: re-derive origin/main (stop-time included #1200)
```

## Unit cards (what shipped, plain)

| Unit                | Promise break fixed                                                       | Class |
| ------------------- | ------------------------------------------------------------------------- | ----- |
| Support durability  | Maps → Postgres; multi-replica claim atomic; KB search/get on router      | N     |
| Affiliates residual | Concurrent mutual referral cycle; earnings self-view without invent rates | N     |
| Admin wire-existing | Operator tools for mounted APIs; missing env = not-wired                  | N/P   |
| Analytics lag       | Env lag alone cannot paint live; role assert when URL present             | N     |
| Notify residual     | Stuck pending reaped; verify/register rate limits; footer                 | N     |
| Compliance region   | regionResolved + optional fail-closed; XX comment lie fixed               | N     |

## Engine B (sample)

- Rate invent at accrual already fixed #1133 (not re-done).
- Claim TOCTOU, lag live-lie, stuck-pending forever, unknown-region silence, green-theatre admin tools — each got a RED-path test or honest refuse.

## Not flipped to tracker `done`

All six mountains stay `ready` (or residual Class X). Done bars need deploy credentials, owner rates, SSO, or product UI the agent must not invent.
