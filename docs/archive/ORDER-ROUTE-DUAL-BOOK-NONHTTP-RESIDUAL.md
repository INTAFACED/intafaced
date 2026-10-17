# Dual-book residual — classified setBalance (post deep-audit finish)

**Generated:** 2026-08-02 · **Re-derived W8 L07:** 2026-08-09 · tip `5ee00f24`  
**Script:** `node tooling/scripts/dual-book-setbalance-classify.mjs`  
**Tree:** `vendor/upstream-exchange/**` (brand-safe prose may say `vendor/<exchange>/…`)

## Summary (re-derived this turn · RAN-IT)

| Kind                    |     Count | Meaning                                                                                                              |
| ----------------------- | --------: | -------------------------------------------------------------------------------------------------------------------- |
| **LIVE**                |     **0** | Non-HTTP money mints                                                                                                 |
| **WALLET_INIT_ZERO**    |         6 | Register zeros — not value mint                                                                                      |
| **DEAD_THROW**          |         1 | Method body throws dual-book IllegalStateException before write                                                      |
| **RECORD_NOT_WALLET**   |         1 | HotTransferRecord log field — not MemberWallet                                                                       |
| **HTTP_DOOR_UNCOVERED** |     **0** | Would need door list or M7                                                                                           |
| **HTTP_DOOR_COVERED**   | 0 printed | Controllers with active setBalance are throw-sealed or block-comment dead; door interceptor still lists 40 fragments |

Live non-comment `setBalance`/`setFrozenBalance` walk (Engine B, same turn): 6 zero-inits + 1 HotTransferRecord only.

## Remaining (honest)

| Item                                                       | Owner                        |
| ---------------------------------------------------------- | ---------------------------- |
| Entity `MemberWalletService.save` still can write balances | M7 shehzad / product law     |
| JVM live 410 smoke                                         | Ops / Docker                 |
| Grade B ledger-adapter call sites                          | product law — not free craft |
| Human X (licence / counsel)                                | Nitro                        |

## Not go-live

Classify LIVE=0 + door scans ≠ production Java boot proof.
