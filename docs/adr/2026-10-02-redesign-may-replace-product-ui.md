# ADR: This redesign may replace the product UI and the unsettled color lock

**Status:** Accepted
**Date:** 2026-10-02
**Decision owner:** Nitro

## Decision

On 2 October 2026 Nitro decided that this redesign may replace the product UI and the unsettled color lock.

These stay:

- Money moves only through `packages/ledger-client`. There is no second money book.
- Amounts stay exact. The product never invents a live price or a balance.
- The chart license stays. Licensed TradingView only after owner access. Until then, the chart already in the product. Never copy TradingView into public git.
- No second matching engine. npm `ccxt` stays uninstalled. FIX, SBE, and Greeks stay adapters.
- The parked chain stays parked until Nitro writes GO.

This ADR does not choose the new colors, the type, or the way a balance is written.

## Consequences

- Agents may replace the served product UI. An older line that said never build a new site does not keep the old site.
- `AGENTS.md` and `docs/INTERNET-LEVERAGE-LAW.md` point here for the product UI. The money rows stay as they were.
