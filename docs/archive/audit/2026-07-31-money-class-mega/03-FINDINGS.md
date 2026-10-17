# 03-FINDINGS — rollup · money-class mega

**Tip:** `4b77c173cd04c1d347da53cefaecb0c8fdd42c0c`  
**Sources:** 03A · 03B · 03C · 03D (do not re-derive; open those for evidence)  
**UTC:** 2026-07-31T02:20Z

---

## Wave verdict (pre-critic / pre-L0-complete)

| Primary                | Verdict                 |
| ---------------------- | ----------------------- |
| #246 ownership S2S     | **PASS**                |
| #227 private positions | **PASS**                |
| #228 AMM + terminal    | **PASS** (P2 docs)      |
| #244 sell cost         | **PASS**                |
| #226 live EVM rail     | **PASS-WITH-RESIDUALS** |
| Tracker / brand / lock | **PASS-WITH-RESIDUALS** |

**Overall so far:** **PASS-WITH-RESIDUALS** · **not go-live** · **not money e2e**

---

## Actionable table (complete set of open findings)

| id                      | sev     | layer | claim (short)                                                               | owner                 | next                                              |
| ----------------------- | ------- | ----- | --------------------------------------------------------------------------- | --------------------- | ------------------------------------------------- |
| **M226-01**             | **P0**  | L3    | `MemoryBroadcastStore` only — crash/multi-replica double outbound on-chain  | Denon + human hold    | critic → residual PEACE; no go-live multi-replica |
| **M226-02**             | P1      | L3    | Refund chain idempotency uses process `refundSequence` not durable refundId | agent / Denon         | critic → fix if accepted                          |
| **M226-03**             | P1      | L3    | Watcher marks finalized before webhook 2xx — can drop auto-capture          | agent                 | critic → fix if accepted                          |
| **M226-04**             | P1      | L3    | First-tx-wins dust locks acceptance address                                 | Denon product + agent | critic; product call                              |
| M226-05                 | P2      | L3    | ERC-20 scan window miss after restart                                       | agent later           | residual                                          |
| M226-06                 | P2      | L3    | In-memory address book / observed                                           | human HA              | residual                                          |
| M226-07                 | P2      | L3    | live-only still allows sandbox authorize/capture (not public)               | human ops             | residual                                          |
| M226-08                 | P2      | L3    | Live EVM tests skip without anvil                                           | human/CI              | residual                                          |
| DOC-AMM-STALE           | P2      | L4/L8 | README still says pool does not compile                                     | agent Class N         | fix in close PR                                   |
| DOC-COMPILE-HDR         | P2      | L4    | compile-contracts header stale                                              | agent Class N         | fix in close PR                                   |
| TEST-GAP-CREATEPOOL-0   | P2      | L4    | missing dedicated 0x0 factory test                                          | agent later           | residual                                          |
| A246-R1                 | P2      | L2    | S2S GET v1 headers (pattern parity)                                         | none                  | residual                                          |
| A227-R1                 | P2      | L2    | WS `?access_token=` log risk                                                | ops                   | residual                                          |
| A227-R2                 | info    | L2    | hub trusts bus userId                                                       | futures publisher     | residual                                          |
| F-pay.rails human glyph | P2/info | L8    | ✅ may be misread as go-live                                                | notes + PEACE         | keep residuals                                    |

**P0 count open:** 1 (hold, not silent-fixed)  
**P1 count open:** 3

PASS controls and HOLDS: see 03A/03B/03C (do not duplicate full tables).

---

## Closed / not re-opened without regression

- #246 placeOrder ownership fail-closed before hold
- #227 JWT private positions empty-honest, no cross-user fanout
- #228 no fake equity/OHLCV/AMM reserves; dual-book labeled
- #244 cost null honesty
- Ledger-only booking on pay path (doctrine HOLDS)
- Brand scan clean; viem already monorepo dep
- Tracker doctrine: pay.rails `done` = path exists under env, not go-live

---

## Critic queue (Phase 4)

1. M226-01 — assume finding wrong AND “must fix this fire” wrong
2. M226-02
3. M226-03
4. M226-04

Critic outputs → `04-ADVERSARIAL.md`. Implementer never grades own fix.
