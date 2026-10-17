# Residual pack — M226-01 broadcast journal

**Severity (updated):** multi-replica P0 **CLOSED** · send→put window **CLOSED** by D26-P1-P9 (signed raw before broadcast)  
**Tip re-check:** after #266 · D26-P1-P9 `feat/pay-durable-crypto-broadcast`

## Re-verify (code on main)

| DoD                               | Evidence                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------ |
| Durable journal migration         | `services/svc-pay/drizzle/0004_pay_crypto_broadcasts.sql` — `pay.crypto_broadcasts`  |
| Signed raw before broadcast       | migration `0012` `signed_raw` · `putSigned` · `runDurableBroadcast` · claim→`resume` |
| PostgresBroadcastStore            | `broadcast-store.ts` — INSERT ON CONFLICT claim · put never overwrites settled hash  |
| Live boot injects durable store   | `index.ts` — `new PostgresBroadcastStore(sql)` passed to `defaultChainFor`           |
| Multi-replica claim atomic        | unit tests fake SQL concurrent claimers; restart sim “rows stay”                     |
| Memory remains test/local default | `defaultChainFor` without store → MemoryBroadcastStore                               |

## Residual still open (honest)

Claim-before-`putSigned` (still signing) leaves a pending row with no resume payload until `putSigned` lands — CPU-only window, no broadcast yet. `MemoryBroadcastStore` remains non-durable across process death (Postgres is the multi-replica path). Put-before-receipt still closes wait-for-inclusion only.

**PEACE line:** multi-replica journal **CLOSED**; DIRECTION §3.1 signed-before-broadcast **CLOSED** (D26-P1-P9).

## Collision

#266 merged. Do not re-implement a second store.
