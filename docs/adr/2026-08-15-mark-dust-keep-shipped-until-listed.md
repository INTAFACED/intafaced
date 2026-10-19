# ADR: mark dust floors stay shipped until listing evidence (D26-P0-14)

**Status:** **Accepted — 2026-08-15 (D26-P0-14).** Shipped constants stay until a market lists with observed depth.  
**Decision owner:** repo owner (Denon). **Written by:** Denon.  
**Board:** D26-P0-14 — `DEFAULT_MIN_BEST_LEVEL_NOTIONAL` + mark dust floor.  
**Packet (part one item 4):** `OWNER-DECISION-PACKET-2026-08-09.md` (removed) §B · Two depth numbers on the futures mark path (removed).  
**Prior dual-floor seal:** [`2026-08-13-mark-dust-floor.md`](2026-08-13-mark-dust-floor.md).  
**P0-01 Q3:** [`2026-08-08-house-desk-and-market-making-fairness.md`](2026-08-08-house-desk-and-market-making-fairness.md) — hard exclusion; **no second % cap**.  
**Does not edit:** `services/svc-trade` (numeric defaults stay as shipped). Sibling P0-07 ADR is out of scope.

---

## The decision

> **Keep both at the shipped values until a market is actually listed with real depth**, then set them from observed book data rather than from judgement. I have no evidence for a better number and neither does anyone else yet.

That sentence is packet part one item 4. It is now the owner ruling, not a recommendation.

Shipped pair (cite only — do not change in this PR):

- `DEFAULT_MIN_BEST_LEVEL_NOTIONAL = '100'` — absolute floor, quote units per best level.
- `DEFAULT_MIN_BEST_LEVEL_BPS_OF_NOTIONAL = 100` (1%) — the best level must also carry this fraction of the position it is pricing.

**Retune trigger:** observed book on a **listed** market. Not a test that looks nicer. Not a third percentage. Not P0-01 Q3 inventing an internal-influence cap.

---

## Why listing evidence, not a new number

Packet part one item 4 already recorded the exploit: two orders worth ~120 quote units priced a 1,000,000 notional close. Raising the absolute floor does not close that arithmetic; it strands honest books on the way past. The relative floor is already the dual-floor shape. Inventing a second % cap would collide with P0-01 Q3 (internal quotes never counted in mark derivation).

Until listing evidence exists, **the shipped pair is the ruling**.

---

## What agents must not do

- Change `'100'` or `100` in `mark-from-depth.ts` (or copies) to look safer.
- Add a second percentage cap (internal influence, “young market,” or otherwise).
- Dual-edit `svc-trade` in a P0-14 law PR.
- Treat this seal as permission to mark `trade.futures` Done.
