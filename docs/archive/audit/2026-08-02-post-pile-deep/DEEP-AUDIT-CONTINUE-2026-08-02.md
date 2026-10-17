# Deep audit continue wave — residual close (agent-legal)

**Date:** 2026-08-02  
**Parent:** `DEEP-AUDIT-FINDINGS.md` §2  
**Tip base:** `863f80f` (#391)

## Closed this wave

| Residual                       | Fix                                                                                           |
| ------------------------------ | --------------------------------------------------------------------------------------------- |
| Account bind / SMS silent fail | Account `postBind` catch + lock; Withdraw `sendCode` catch; MoneyIndex match/reset catch      |
| Marketing overclaims           | en.js: Cayman / largest / 101 years / FAANG / 25 min / 80% filter → honest copy               |
| Kill non-edge modules cosmetic | Board chip **Edge perimeter** vs **Not edge-enforced**; runbook + control-plane panel honesty |
| MM seed process-memory lastRun | `TRADE_MM_SEED_STATE_PATH` durable JSON; load on start; save after track/cancel               |
| Admin BFF residual             | Runbook + control-plane panel: **no SSO**, do not expose without ACL                          |

## Still open (not this wave)

| Item                             | Owner         |
| -------------------------------- | ------------- |
| Admin BFF true SSO / mTLS        | Ops · Human X |
| Kill durable multi-replica store | §13           |
| svc-pay S2S v2                   | shehzad #346  |
| Entity wallet save M7            | shehzad       |
| JVM 410 smoke                    | Docker host   |
| Human X go-live                  | Nitro         |
| M1–M7 product mountains          | shehzad       |

**Not go-live. Not BOARD-COMPLETE.**
