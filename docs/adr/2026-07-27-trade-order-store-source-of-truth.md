# ADR: Trade order store is source of truth for fills

| Field       | Value                                                              |
| ----------- | ------------------------------------------------------------------ |
| **Status**  | accepted                                                           |
| **Date**    | 2026-07-27                                                         |
| **Closes**  | P0-2 (`order.filled` → `tradeFill` shape gap)                      |
| **Related** | svc-matching events · svc-trade · `packages/ledger-client` recipes |

---

## Context

Matching emits `order.filled` (sequence, price, qty, order/market ids). The ledger money path for a fill is the `tradeFill` recipe, which needs users, assets, notional, side, and a stable `fillId`.

Those two shapes do not match 1:1. Treating the fill **event** as self-describing for money posts invites drift: wrong party, wrong asset, or non-idempotent fill keys if agents “complete” the event ad hoc.

svc-trade (#31) already closed the operational risk in code: it does not trust the event for money dimensions.

## Decision

**`svc-trade`’s order store is the source of truth for fill posting.**

1. The matching **event** carries identity of the match only: sequence, price, qty, and related ids. It is not a complete money document.
2. **svc-trade** loads its own order (and market) state and derives users, assets, notional, side, and hold linkage from that store.
3. **`fillId` is derived** as a function of `(marketId, engineSequence)` (stable, engine-aligned), not invented from event payload fields that may later change shape.
4. Ledger posts for fills go only through approved recipes (`tradeFill` / hold release paths), with inputs assembled by trade from (2)+(3).

## Consequences

- **Do not** treat `order.filled` as sufficient input to post money without the trade order store.
- **Do not** require enriching the matching event with full trade/ledger fields for correctness; enrichment later is optional (ops, analytics, debugging), not a correctness prerequisite.
- New consumers of fill events must either call through trade’s model or re-derive with the same SoT rule — not invent a second money interpretation.
- P0-2 is **accepted** as this contract. Implementation already matches; this ADR freezes the intent.

## Out of scope

- Purpose-keyed holds (P0-3) — separate decision.
- Router mounting (P0-1) — separate work.
