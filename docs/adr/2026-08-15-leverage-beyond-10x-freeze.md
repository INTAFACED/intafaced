# ADR: D26-P0-07 — freeze leverage / margin / liq params beyond 10× until §1 liquidation proof

**Status:** **Accepted — 2026-08-15 (D26-P0-07 freeze bound to liquidation proof).**  
**Decision owner:** repo owner (Denon). **Written by:** Denon.  
**Board:** D26-P0-07.  
**Packet:** `OWNER-DECISION-PACKET-PART-TWO-2026-08-09.md` (removed) §P0-07.  
**Prior seal:** [`2026-08-13-leverage-defaults-frozen.md`](2026-08-13-leverage-defaults-frozen.md) (#1787) — §1 table is live. This ADR does not re-open that table.  
**Law:** `DIRECTION-2026-07-31.md` (removed) §1.  
**Does not invent:** 20×, D3 ladder rungs, dust floors (D26-P0-14), market overrides, or cross-margin.  
**Does not edit:** `services/svc-trade` — [#1946](https://github.com/Phantom-X-007/intafaced/pull/1946) publishes the sealed 10× on futures listings.

---

## The decision

> **10× remains the ceiling until §1 liquidation proof exists. There is no silent raise above 10×, and no new margin or liquidation constant without an owner table.**

`DEFAULT_MAX_LEVERAGE = 10` is already DIRECTION §1. It is **not open**. §8 item 8 reserves only parameters _beyond_ that default. This freeze is that reservation, closed.

---

## Why this ADR exists after #1787

#1787 sealed the live table (isolated, 10×, partial-first). DIRECTION §1 still conditions any _raise_ on evidence from **§1's liquidation proof** (MVP items 1–6: mark that is not last-trade, observable margin call, partial liq against a real book, insurance shortfall, gapping series, funding nets to zero). Until that proof exists as a complete bar, 10× is the ceiling — not a number an agent may bump because a listing, a test, or a bot capability matrix looks nicer at 20×.

Landing individual futures slices does not thaw this row. Thaw requires the §1 proof **and** an owner table for any cell that is not already named in §1.

---

## What is frozen (in force now)

| Cell                       | Law                                                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------------- |
| Max leverage               | **10×**. No silent raise. `TRADE_FUTURES_MAX_LEVERAGE` may only tighten (≤ 10).                       |
| New margin / liq constants | Forbidden unless an **owner table** names the param, the value, and the market (if any).              |
| Dust floors                | **D26-P0-14** — not this row. Do not retune here.                                                     |
| Code publisher of 10×      | **#1946** (`presentCcxtMarket` futures `limits.leverage.max`). This ADR does not dual-edit that path. |

Refuse on the open path stays `trade.leverage_invalid` / `trade.leverage_too_high`. Do not add a second cap that disagrees with `DEFAULT_MAX_LEVERAGE`.

---

## What agents must not do

- Raise `DEFAULT_MAX_LEVERAGE` or pass a configured cap above 10×.
- Invent maintenance-margin bps, insurance-fund _size_, ADL rates, or per-market leverage maps.
- Edit `svc-trade` “to match this ADR” — the constant and listing publisher already exist.
- Mark `trade.futures` Done because a freeze document landed.

---

## Leverage used

Phase A IN — existing DIRECTION §1 + #1787 table + `svc-trade` 10× constant. No second risk engine, no invented 20×.
