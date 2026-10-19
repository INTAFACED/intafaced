# ADR: instrument enum authority — a schedule nobody defined must refuse, not throw

**Status:** **Accepted — 2026-08-04.** Owner decision, stated and confirmed.
**Decision owner:** repo owner. **Written by:** Denon.
**Spec id:** D-S-05, **completing** it.
**Builds on:** `DIRECTION-2026-07-31.md` (removed) §2, which decided the instrument model and the listing rule. Both stand. This adds the **enum authority** the board's column asked for, and corrects one instruction in §2 that has gone stale.

---

## The decision

> **An instrument declares `asset_class`, quote convention, tick, lot, settlement and trading schedule. That is the whole model — and every one of those fields has exactly one authority that defines its permitted values.**
>
> **A value outside its enum is a refusal, never a throw, and never a default.**

`DIRECTION` §2 already states the merge bar: "A schedule enum added without a `TRADING_SCHEDULES` entry must **refuse**, not throw." This generalises it to every enumerated field, and says who owns each list.

This is settled. Agents and engineers implement it; they do not re-litigate it.

---

## Why refuse rather than throw, restated because it keeps being got wrong

A throw is an error: it says _something went wrong_. A refusal is an answer: it says _this is not available, and here is which thing and why_.

The difference is load-bearing at the venue boundary. A market whose schedule is unknown is **not** a broken market — it is a market the platform cannot currently say is open. Throwing turns that into a 500 and an on-call page. Refusing turns it into a closed venue and a user who understands.

And the failure directions are asymmetric. A throw that gets caught somewhere upstream and coerced into a default is how a market with no defined hours becomes a market that trades continuously. **A refusal cannot be accidentally softened into permission.**

---

## The authority per field

| Field                | Authority                                                                                      | Adding a value                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `asset_class`        | The instrument model in `packages/contracts`                                                   | Additive, agent-implementable                                                                    |
| **trading schedule** | `TRADING_SCHEDULES`                                                                            | **Requires the schedule to be defined in the same change.** A name without a definition refuses. |
| quote convention     | The instrument model                                                                           | Additive                                                                                         |
| tick / lot           | Per-instrument values, not an enum                                                             | Data, not law                                                                                    |
| **settlement**       | **Requires a rail that can actually settle it**                                                | See the listing rule below                                                                       |
| market id            | `trade.markets` — see [`2026-08-04-market-id-authority.md`](2026-08-04-market-id-authority.md) | Not an enum; opaque UUIDs                                                                        |

**One list, one home, and the enum is the authority — not a mirror of one.** The custody-scan lesson applies directly: a hardcoded array whose comment claims it "mirrors" another file is a mirror nobody checks, and it drifts silently in the direction that reports clean. Derive, or be the single source. Never mirror.

---

## The listing rule stands unchanged

`DIRECTION` §2:

> "**Forex and commodities do not list in production until fiat settlement rails exist.** The instrument model and venue-hours enforcement can and should land first — they are honest on their own. **Listing a forex pair we cannot settle is the lie; modelling one is not.**"

That distinction is the whole product law here and it generalises: **modelling an instrument is always honest; listing one you cannot settle never is.** An instrument may exist in the model, be visible in an admin surface, and be absent from every user-facing market list, all at once, with no dishonesty anywhere.

---

## Correction: §2's "resume `feat/multi-asset-instruments`" is now stale

`DIRECTION` §2 says: "**resume `feat/multi-asset-instruments`** … Do **not** greenfield." That was right on 2026-07-31. It is wrong now, and following it would do damage.

Verified 2026-08-04 against `origin/main`:

- `packages/contracts/src/instruments.ts` and `svc-trade/drizzle/0001_multi_asset_instruments.sql` **already landed**, via #102 ("feat(trade): refuse orders into a closed venue") and #167.
- Diffing the branch against main across all eighteen files it touches, **the only branch-unique content is Prettier line-wrapping.** The `add/add` merge conflicts are simply the same files existing on both sides.
- **Merging it is actively dangerous.** #167 was "backfill display_name before constraining it — migration takes the fleet down." Main's migration carries that `UPDATE ... WHERE length(display_name) = 0` backfill; **the branch's does not**. A resolver who takes "ours" on the `add/add` `.sql` conflict reintroduces a fleet-down migration.

**So: PR #734 is to be closed, not merged.** The work it carries is on main. This ADR supersedes §2's resume instruction on that one point only; everything else in §2 stands.

This is the second stale instruction found in a live law document today — the first being §4's direction to extend `custody-scan` to Java. **Both were correct when written and became wrong when the code moved underneath them.** The lesson is in the housekeeping note below.

---

## Refuse cases

| Situation                                          | Correct answer                                                                   |
| -------------------------------------------------- | -------------------------------------------------------------------------------- |
| Schedule name with no `TRADING_SCHEDULES` entry    | **Refuse**, naming the schedule. Never throw, never assume 24/7.                 |
| Unknown `asset_class`                              | **Refuse**, naming the value and the permitted set.                              |
| Instrument modelled but not settleable             | **Model it. Do not list it.** Absent from every user-facing market list.         |
| Order into a closed venue                          | **Refuse** — `assertMarketOpen`, already on main.                                |
| Enum value present in one place, absent in another | **Fail the build.** This is the drift class; it must not be a runtime discovery. |

---

## Done bar

1. Every enumerated field has exactly one authority, and no mirror of it exists anywhere.
2. An undefined enum value refuses with a named reason. Tested for each field.
3. The instrument model is **additive** — every existing spot market behaves identically before and after, proven by the existing spot suite passing unchanged. (`DIRECTION` §2's merge bar, unchanged.)
4. No instrument appears in a user-facing market list unless its settlement path exists.
5. Adding an enum value and defining it happen in the same change, or the build fails.

---

## What agents may implement without asking again

- New `asset_class` and quote-convention values, additively.
- A trading schedule, provided its definition lands in the same change.
- Refusal paths and their tests for every field above.
- Closing #734.

## What still needs the owner

- Listing any forex or commodity instrument — blocked on fiat settlement rails, which is `socket.psp-partners` territory.
- Any change to the six-field model itself. `DIRECTION` §2: "resist adding per-class special cases into the engine."

---

## Housekeeping: stale instructions in live law documents

Two have now been found in `DIRECTION-2026-07-31.md` (removed) — §2's resume instruction and §4's custody-scan instruction. Both were accurate when written. Both would cause real damage if followed today, and **an agent reading the law document rather than the code would follow them in good faith.**

The fix is not to stop writing instructions into law documents. It is that **a law document naming a specific branch, file or gate is making a claim about the code, and that claim ages.** Where this ADR series finds one, it says so at the point of correction rather than quietly working around it.
