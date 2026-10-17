# pay.gateway residual — research brief (2026-07-31)

## Law

Doctrine §0.6 ledger only · no invent payment success · rail posture honesty.

## On main now

- Hosted checkout + payment links
- Live crypto rail (`EvmLiveChain`) when env configured; sandbox refused in staging/prod without live
- Postgres broadcast journal (#266) + refundId durability
- `merchant.create` **exists** under `pay:write` (scoped to principal userId) — tracker “blocked on pay:write” is partially stale
- Fee bps required at onboarding (no free processing invent)

## Gaps that still block tracker `done` / go-live

1. **Card acquiring** — commercial §13 socket; not agent-inventable
2. **Multi-replica broadcast** — Postgres journal exists; confirm all prod deploy paths inject it
3. **Crash after send before put** — residual double-send window (named in rails notes)
4. **Production RPC/custody** — human X (secrets, mnemonic, hot wallet)
5. **Merchant KYB product** — kyb_status field exists; full digital KYB is `pay.psp` mountain
6. **Public API plugins / routing / fraud** — separate tracker rows

## DoD for next agent-safe ships

| Ship                  | Proof                                                               |
| --------------------- | ------------------------------------------------------------------- |
| Tracker honesty       | `pay.gateway` note matches mounted merchant.create + residuals list |
| Broadcast inject      | index.ts always uses PostgresBroadcastStore when DATABASE_URL set   |
| Crash-window research | design brief only until ledger/rail pattern chosen                  |
| Card                  | human commercial decision only                                      |

## First PR (this fire)

Tracker note honesty for pay.gateway + residual research pack (this file).

## Collision

Leave #289 order-route alone. Futures residual stack is separate.
