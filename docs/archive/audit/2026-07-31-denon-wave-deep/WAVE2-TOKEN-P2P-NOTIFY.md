# WAVE2 — token/earn · p2p/convert · notify/edge

**Tip base:** `94c0a3f`  
**Backend only.**

| Surface                 | Verdict                            | HIGH                                                            |
| ----------------------- | ---------------------------------- | --------------------------------------------------------------- |
| Token yield / bank earn | CONDITIONAL PASS                   | T-01 buyback operator-shaped · T-02 mint defaults not DB params |
| P2P + convert           | CONDITIONAL → P2P-01 fixed this PR | InsufficientFunds rehydrate                                     |
| Notify + edge           | PASS                               | —                                                               |

## Fixes this PR

- P2P-01: structured ledger insufficient_funds body + p2p client rehydrate
- B-02 honesty comment on bank reconcileReserve tautology
