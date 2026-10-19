# ADR: mark dust floor — keep shipped `DEFAULT_MIN_BEST_LEVEL_*`

**Status:** **Accepted — 2026-08-13 (D26-P0-14 sealed).**  
**Decision owner:** repo owner (Denon). **Written by:** Denon.  
**Board:** D26-P0-14 — `DEFAULT_MIN_BEST_LEVEL_NOTIONAL` + mark dust floor.  
**Packet:** `OWNER-DECISION-PACKET-2026-08-09.md` (removed) §4 · part two §P0-14.  
**Builds on:** P0-01 Q3 hard mark exclusion ([`2026-08-08-house-desk-and-market-making-fairness.md`](2026-08-08-house-desk-and-market-making-fairness.md)); `mark-from-depth.ts` dual floor.  
**Does not invent:** a third percentage, a raised absolute floor “to be safer,” or a cap that lets internal quotes into the mark.

---

## The decision

> **Keep both shipped floors until a real market lists with observed depth.**  
> `DEFAULT_MIN_BEST_LEVEL_NOTIONAL = '100'` (quote units at the best level).  
> `DEFAULT_MIN_BEST_LEVEL_BPS_OF_NOTIONAL = 100` (1% of the position this mark is pricing).
>
> **The defect was never “100 is too small.”** An absolute floor alone let ~120 quote units price a 1,000,000 notional close. The relative floor is the shape. Raising 100 does not fix that arithmetic; it strands honest books on the way past.
>
> **Refuse is null, not a new error code.** A side below either floor is absent; a one-sided book is not a payout-grade mark. Internal quotes stay **hard-excluded** from mark derivation (P0-01 Q3). No second % cap.

This is settled. The shipped pair _is_ the ruling until observed books exist.

---

## Why this ADR exists

Both numbers landed as placeholders. Unlike 10× leverage they are §8 item 8 — they gate whether a mark may move money. Leaving them “awaiting a ruling” invited an agent to pick 500 or 5% because a test looked nicer.

P0-14’s done bar is **keep shipped + dual-floor shape + Q3 exclusion**, not a new constant.

---

## What is sealed

1. **Both floors, together.** Absolute without relative is the 190k extract. Relative without absolute still lets femto-dust mint a mid on a tiny position. Tip already applies both (`bestLevelIsQuotable`).
2. **Null, not degrade.** Do not relabel dust as `last`. Do not walk the book to invent a “real” best.
3. **Q3.** Platform / internal quotes are never mark inputs. Do not invent an N% “internal influence” allowance.
4. **No third number.** `mid-source.ts` reuses these constants on purpose.

---

## What remains owner-open

- Retuning either number **from observed depth on a listed market** — not from judgement in a PR.
- A later owner table that raises the relative bps for large positions only.

Until a market is actually listed with real depth, **do not touch the constants.**

---

## What agents must not do

- Change `'100'` or `100` in `mark-from-depth.ts` to “tighten” the gate.
- Add `DEFAULT_MIN_BEST_LEVEL_INTERNAL_BPS`.
- Count seeded / house / internal size toward quotability.
- Mark `trade.futures` Done because this ADR landed.

---

## Proof on tip (already; this ADR does not dual-edit trade)

- `services/svc-trade/src/futures/mark-from-depth.ts`
- `orderable-path.test.ts` expects `100` / `'100'`
- House-desk ADR Q3
