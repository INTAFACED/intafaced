# Grind plan — continuous ship (2026-07-30)

## Audit policy (decided)

| Cadence                    | What                                                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------------- |
| **Every PR**               | typecheck/build of touched packages · relevant unit tests · `pnpm scan:brand` when docs/UI touched |
| **Every ~3–4 product PRs** | wave audit: brand/custody/vendor-shell/tracker + money greps on tip                                |
| **Not** only-at-end        | End-only misses failures that block the whole repo (e.g. brand-scan red)                           |

## Wave A (this block) — parallel

1. **svc-notify** in-app inbox + 3 event consumers (fillSettled, p2pEscrowLocked, kycApproved)
2. **protocol factory honesty** — refuse zero factory predict/build; health.factoryConfigured
3. **trade.cancelAll** — sequential cancel of open orders

## Wave B (next if A lands)

- Public REST slice of trade.ccxt-api (markets + ticker only) if still free
- Mid-wave full local doctrine scan
- Scoreboard update

## Explicitly not this wave

- Real chain deploy for smart-accounts
- Push/email/SMS notifications
- Futures positions
- GitHub Actions billing (human)
