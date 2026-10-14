# ADR: Sovereign (Protocol Plane) P2P escrow — S-A3

**Status:** accepted  
**Status note:** Accepted for implementation — 2026-08-08.  
**Board id:** S-A3 · tracker `protocol.escrow`.  
**Owner:** `@shehzad002`.

## Decision

Sovereign escrow is a **different product** from custodial P2P escrow (`docs/adr/2026-08-04-p2p-escrow-and-dispute-law.md`). The platform never holds the asset; `SovereignEscrow.sol` does. There is no migration or "handoff" from ledger escrow.

## Dispute timeout (why this does not contradict the custodial ADR)

Custodial law: the timer never adjudicates; a human moderator does.

Sovereign law here: there is **no platform moderator**. At `open`, parties fix an immutable `TimeoutDisposition` (`RefundSeller` or `ReleaseBuyer`). After dispute + window, **anyone** may call `settleTimeout`, which executes that disposition only. Optional `arbiter` is a **user-elected** address (may be zero); the platform is never eligible by construction.

## Done bar covered by the first PR

- lock → release · lock → refund · dispute → keeper timeout
- keeper-safe (`settleTimeout` has no role check)
- no stranded deal amounts (terminal paths zero `deal.amount`)

Residuals: multi-asset batches, fee-split complexity, service/router wiring, indexer events.
