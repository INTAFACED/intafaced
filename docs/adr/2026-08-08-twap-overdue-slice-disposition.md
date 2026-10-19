# ADR: what a TWAP does with overdue slices — the interval is the promise

**Status:** **Accepted — 2026-08-08.** This is the ruling `docs/BUILD-STOP-TRADE-2026-08-08.md` (removed) §4 asked for. It unblocks defect 1 of the three that made the adversarial pass return **DO NOT MOUNT** on the TWAP scheduler.
**Decision owner:** repo owner. **Written by:** Denon.
**Spec:** the algo half of **D-S-04**, extending [`adr/2026-08-04-algo-execution-law.md`](2026-08-04-algo-execution-law.md) (TWAP only, icebergs out). That ADR stands unchanged.
**Lane:** `services/svc-trade/src/algo/**` is claimed live by `nitro-money-trade-algo`. **This is law only — the craft is theirs.** No code in this PR.

---

## The defect this rules on

`services/svc-trade/src/algo/twap-engine.ts:226`:

```ts
const dueAt = parent.startedAt.getTime() + parent.nextSliceIndex * parent.sliceIntervalMs;
if (now.getTime() < dueAt) {
  /* not yet */
}
```

The due time of every slice is derived from **`startedAt`**, so it is fixed at creation. Resume does not re-space — the file's own header at line 14 says so: _"Pause disposition (pinned): emit no further children; resume does not…"_.

Consequence, measured against the real engine: **a 10-slice, one-per-minute TWAP paused 20 minutes and resumed placed 9 slices in 8 seconds.**

Two ways in, and the second needs nobody:

- a trader calls `algo.resume` after any pause;
- **the tick host is simply down for a while.** No user action at all. Every parent that was mid-flight bursts on recovery.

This has never fired in production because `tickAllAlgos()` has zero callers. **That is the only reason.** It is not a control, and mounting the scheduler without this ruling converts a dormant bug into a live one across every in-flight algo simultaneously.

---

## The decision

> **The interval is the promise. A TWAP never places more than one slice per `sliceIntervalMs`, however overdue it is.**
>
> Overdue slices are neither forfeited nor compressed. **They extend the schedule.** Slice due times are re-derived from the resume instant, not from `startedAt`.

A time-weighted average price order is a promise about _spacing_, not about a set of timestamps. Executing nine slices in eight seconds is not a late TWAP; it is a market order wearing a TWAP's name, and it produces exactly the market impact the trader paid the algo to avoid. **Of all the available outcomes, the burst is the only one that is definitionally wrong.**

### Why not the alternatives

**Skip the overdue slices.** Rejected. It silently reduces the quantity the trader asked to execute. The trader submitted a size, not a suggestion, and a control that quietly fills less than requested is the mirror of one that quietly fills more. If the trader wants less, they cancel.

**Catch up at the tick cadence** — the current behaviour. Rejected as above.

**Refuse to resume at all after any pause.** Rejected as disproportionate: a two-second tick hiccup would strand every algo in the system and require manual intervention, which is its own outage.

---

## What changes for the trader, stated honestly

**Re-spacing means the algo ends later than originally planned.** That is a real change to what the trader specified, and it must not be silent:

1. **A resume reports the new projected end time.** Not the original one. A trader who paused for lunch needs to know their order now runs into the close.
2. **A resume that would more than double the original duration is refused**, with a code and the projected end time, and the trader may cancel-and-recreate. Beyond that point it is not the order they placed — it is a different order at different prices in different conditions.
   - **This threshold is a ratio, deliberately, not a new constant.** `2×` is derived from the order's own stated duration rather than invented, so it adds no parameter awaiting an owner ruling. This repo already carries one such number (`DEFAULT_MIN_BEST_LEVEL_NOTIONAL = '100'`) and two governing the same subsystem would be drift.
3. **A tick outage is recorded on the parent**, distinguishable from a user pause. They have identical mechanics and completely different explanations, and the trader is owed the difference. The precedent is already law: funding skips are recorded as skips and are distinguishable from zero-rate periods ([`adr/2026-08-05-futures-risk-and-mark-law.md`](2026-08-05-futures-risk-and-mark-law.md) §Funding).

---

## The other two defects — not ruled here, and not blocked on me

`BUILD-STOP-TRADE-2026-08-08.md` (removed) §4 lists three. Two are **engineering defects with no product question in them**, and the algo lane may fix them without asking:

- **A failed child cancel leaves the parent active** — the status update sits after the per-child cancel loop, so one throw and the algo keeps placing. The correct shape is already law elsewhere in this repo: a state transition that must hold across several writes belongs in the transaction that makes them, which is what `#950` established for `close()` with `SELECT … FOR UPDATE` spanning the posts and the status write.
- **Cancel silently no-ops after a restart** — the parent flips to `cancelled` while children stay live on the book, holding funds and still filling. **A cancel that does not cancel is worse than a refused cancel**, because the trader stops watching. This is the honesty doctrine applied to a state word.

`docs/TRADE-LANE-HARVEST-2026-08-08.md (removed):76` is right that these must land in the same change as the mount: _"This must be fixed in the same change as the scheduler, or mounting it is worse than leaving it dead."_ This ADR removes the product blocker; it does not lower that bar.

---

## Done bar

1. **No two child orders for the same parent are ever placed less than `sliceIntervalMs` apart.** Proven by resuming a parent that is many intervals overdue and asserting the spacing — the earlier measurement was 9 slices in 8 seconds, so this test must fail on the unfixed engine.
2. Overdue slices are **executed, not dropped**: the total quantity placed across the algo's life equals the requested quantity. Asserted on **ledger balances and placed quantity**, not on status codes.
3. A resume returns the **new projected end time**, and a test asserts it differs from the original after a pause.
4. A resume exceeding **2× the original duration** is refused with its own code, and the parent remains resumable-by-recreation rather than stranded.
5. **A tick outage is distinguishable from a user pause** on the parent record. Tested by driving a gap with no user call.
6. Re-derivation is from the **resume instant**, and a test asserts `startedAt` is no longer the basis — this is the specific line (`twap-engine.ts:226`) that caused the defect, so a revert of it must turn something red.

**Item 6 exists because this repo has now produced six guards that were correct in isolation and unreachable in place.** Do not assert the new spacing rule in a comment; assert it in a test that exercises the public resume path.

---

## What still needs the owner

- **Nothing to unblock the mount.** Defect 1's product question is answered above; defects 2 and 3 are engineering.
- **Whether a tick outage should notify the trader**, not merely be recorded. That is a notification-policy decision and `v22.alerts` is not built. Recording is required now; telling is a separate ruling.
- Any algo beyond TWAP. D-S-04 keeps icebergs out and that is unchanged.
