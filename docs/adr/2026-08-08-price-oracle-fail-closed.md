# ADR — Fail-closed price oracle (S-A12)

**Status:** accepted  
**Date:** 2026-08-08  
**Board:** S-A12 · tracker `socket.price-oracle`  
**Blocks:** S-A4 lending

## Decision

Marks for lending LTV and liquidation come from `FailClosedOracle`: **two independent push reporters**, a **staleness bound**, and a **max disagreement bps**. The returned mark is the **minimum** of the two fresh agreeing prices.

## Consequences

- Stale or disagreeing feeds **revert**. There is no average, no last-good fallback, and **no read of our AMM** (SPEC-LENDING §1.1).
- Lending `borrow` / `liquidate` inherit refuse-closed behaviour via `IPriceOracle.getMark`.
- Own-pool TWAP and IFC marks remain residual; they must not be wired as a silent substitute for this path.
