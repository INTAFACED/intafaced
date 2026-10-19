# ADR: leverage / margin / liquidation params — §1 defaults frozen

**Status:** **Accepted — 2026-08-13 (D26-P0-07 sealed).**  
**Decision owner:** repo owner (Denon). **Written by:** Denon.  
**Board:** D26-P0-07 — Leverage / margin / liq params beyond §1 defaults.  
**Packet:** `OWNER-DECISION-PACKET-PART-TWO-2026-08-09.md` (removed) §P0-07.  
**Builds on:** `DIRECTION-2026-07-31.md` (removed) §1 (isolated v1, 10×, partial-before-full, ladder by depth, insurance, ADL last-resort).  
**Does not invent:** a raise above 10×, a maintenance-margin bps table, market-level overrides, or liquidation-ladder rungs (D3).

---

## The decision

> **DIRECTION §1 is the live table until an owner publishes a replacement.** Max leverage v1 is **10×** (`DEFAULT_MAX_LEVERAGE = '10'`). Isolated margin only. Partial liquidation before full close. Maintenance must reference actual depth, not a silent constant. Those are not placeholders waiting for an agent to “finish” the product.
>
> **Anything beyond that table — a raise, a per-market cap, a new rung, a cross-margin flag — is owner law. Silent constant edits are doctrine crime. There is no agent-sized 20× and no agent-sized D3 ladder.**
>
> **Refuse is already on the path:** `trade.leverage_invalid` / `trade.leverage_too_high`. Do not add a second cap that disagrees with `DEFAULT_MAX_LEVERAGE`.

This is settled. The freeze _is_ the ruling. An owner table later may thaw a cell. Agents do not thaw it.

---

## Why this ADR exists

`DEFAULT_MAX_LEVERAGE` is already DIRECTION §1. The open row was **everything past that**: silent raises, market overrides, liq params. Leaving it “open” invited a PR that changed `'10'` to `'20'` because a test wanted a rounder number.

P0-07’s done bar is **this freeze**, not a fabricated owner spreadsheet.

---

## What is sealed (in force now)

| Param                        | Law now                                                                  |
| ---------------------------- | ------------------------------------------------------------------------ |
| Max leverage                 | `'10'` — `checkLeverage` / `maxLeverage()`                               |
| Margin mode v1               | Isolated only. Cross is a v2 ADR, not a flag flip                        |
| Liquidation order            | Partial first; full close is failure, not policy                         |
| Maintenance vs book          | Must reference actual depth when a ladder exists — **no invented rungs** |
| Per-market leverage override | Frozen off until an owner table names the market and the cap             |

`maxLeverage(configured)` may take a caller cap **only if it is ≤ 10×**. A configured value above 10× is a raise and is forbidden until the owner table exists. (Tip already treats configured as a substitute — agents must not pass 20 through that door to dodge this ADR.)

---

## What remains owner-open

- Any raise above 10×, with liquidation-latency evidence as DIRECTION §1 required.
- D3 maintenance-ladder _numbers_.
- Market-level overrides.
- Cross-margin (needs its own ADR; not a silent `CROSS=1`).

---

## What agents must not do

- Edit `DEFAULT_MAX_LEVERAGE` in `initial-margin.ts`.
- Add env `TRADE_MAX_LEVERAGE=20` as a “config authority.”
- Invent D3 rungs so the ladder “looks complete.”
- Mark `trade.futures` Done because this freeze landed.

---

## Proof on tip (already; this ADR does not dual-edit trade)

- `services/svc-trade/src/futures/initial-margin.ts` — `DEFAULT_MAX_LEVERAGE = '10'`
- Tests: `initial-margin.test.ts`, `orderable-path.test.ts` (`toBe('10')`)
