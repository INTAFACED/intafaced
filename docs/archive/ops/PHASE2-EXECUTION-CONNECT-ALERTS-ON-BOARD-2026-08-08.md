# Three Phase-2 law modules had zero board presence. They are rows now.

**Type:** board change. **No product code.** Tracker rows + coverage mapping only.
**Finding:** [`docs/audit/BUILD-COVERAGE-AUDIT-2026-08-03.md`](../audit/BUILD-COVERAGE-AUDIT-2026-08-03.md) §A1.b, §A1.c.
**Gate:** `node tooling/ci/coverage-check.mjs` — **gaps 30 → 23**, ratchet clean both directions.
**Board:** tracker rows **148 → 155**, shippable **109 → 116**, blocked **29 → 36**. Nothing else moved.

---

## What was wrong

`INTAFACED_DEFINITIVE_BUILD.md` §30:793 phases **Connect** and **Execution** at **Phase 2** — the phase
being worked now. §31:809 phases the **alerts core** at **Phase 2** as well. All three were recorded as
`gap` in `tooling/coverage.yaml`: counted, named, and on nobody's board. The swarm could not claim them
because there was no row to claim.

Counted is not assigned. That is the same failure #955 fixed for the nine chain capabilities, in a
different chapter.

## What is on the board now — seven rows, all `blocked`, none `done`

| id                        | Law     | Blocked by                                                 |
| ------------------------- | ------- | ---------------------------------------------------------- |
| `connect.latency-grading` | §27:760 | `venue.aggregation`                                        |
| `connect.data-lake`       | §27:762 | `venue.aggregation`                                        |
| `execution.sor`           | §28:770 | `venue.aggregation`, `connect.latency-grading`             |
| `execution.arbitrage`     | §28:772 | `execution.sor`                                            |
| `execution.market-making` | §28:773 | `execution.sor`, `trade.mm-bot`                            |
| `execution.house-tenant`  | §28:777 | `execution.sor` — **and an owner ADR no edge can express** |
| `v22.alerts`              | §31:809 | `ops.notifications`                                        |

**`blocked` is computed, not declared.** Every one of these came out blocked because its dependencies
are genuinely not `done` — no dependency was weakened to manufacture a green row, and none was invented
to manufacture a red one.

## So what is actually claimable

**Directly: nothing new.** That is the honest answer, and it is the useful one.

What the board now shows that it did not show yesterday is that **`venue.aggregation` is the hinge**.
It previously unblocked exactly one row (`connect.venue-vault`) and did not appear in
`docs/TRACKER.md` → Highest leverage at all; it now enters that table at **7 transitive unblocks**, and
it is `ready` today. Six of the seven rows above sit behind it, directly or through `execution.sor`. Its own
note has said since 2026-08-02 what it needs: a second real `MarketDataAdapter`, the trading half
(credentials currently `throw not_ready`), and the Venue Vault. Finishing it is now visibly the
highest-value trade work available, rather than one row among many.

Two slices remain claimable **today** without any of these rows, and were already permitted:

- **Latency measurement plumbing** — [`docs/adr/2026-08-04-predict-quant-connect-law.md`](../adr/2026-08-04-predict-quant-connect-law.md)
  (D-S-18, Accepted) lists it under "what agents may implement without asking again". Measurement only.
  An unmeasured adapter gets **no score**, never a default one, and no routing weight.
- **Craft under `venue.aggregation`** — ordinary work under an existing row, no `features.mjs` edit
  required (`COORDINATION-TRUTH-LAYERS.md`).

## What still needs an owner ruling — three, and they are named on the rows

1. **`execution.house-tenant` — needs an ADR before any code.** §28:777 puts the house desk on the same
   rails as customers as a sealed private tenant. Whether a house desk may trade alongside customers,
   what it may see of customer flow, and whether it may quote markets customers trade are
   conflict-of-interest and fairness questions, not engineering ones. **The row flags it and designs
   nothing.** No isolation test is proposed, because proposing one would imply the answer.

2. **`execution.market-making` — the self-dealing tension is real and already measured.** §28:773 wants
   one engine that "seeds our books and works the street", while
   [`docs/adr/2026-08-05-futures-risk-and-mark-law.md`](../adr/2026-08-05-futures-risk-and-mark-law.md)
   governs with **"A price that moves money is never supplied by the party it pays."**
   `services/svc-trade/src/futures/mark-from-depth.ts` records the measured version: two dust orders
   minted a payout-grade mid and paid 2,000 USDT out of the profit pot. The row's line is that internal
   quotes may seed liquidity and may **not** become a mark, an index, or any input that pays the house.
   Whether the house may quote a market whose marks it also supplies is the owner's call.

3. **Economic magnitudes stay owner numbers.** Spread, skew and inventory bands (`market-making`),
   inventory policy and exposure caps (`arbitrage`) — [D-S-14](../adr/2026-08-04-token-economics-outcomes.md)
   applies unchanged.

## What was deliberately not done

- **No second ranking rule.** `packages/venue-adapter/src/router.ts` already ranks on effective price
  through one interface the internal book also implements, with a single bounded, disclosed, tested
  **5 bps** internal preference at ranking time only (`internalPreferenceBps`, default 5;
  `docs/TERMINAL.md` §4). The README states why: the router "cannot favour us structurally".
  `execution.sor` **extends that cost model** with the §28:770 terms it lacks — expected impact,
  latency grade, transfer cost between venues — and the row says a second thumb on the scale, or a
  preference above 5 bps, is a product change for the owner.
- **No service scaffolding.** There is no `services/svc-execution` and this change does not create one.
  Implementation follows a claim.
- **The other 23 gaps.** Quant, mobile, CRM/marketing, tax, auto-invest, business banking, Predict,
  B2B infra and the rest are later-phase. Leaving them recorded as gaps is the correct state; the
  ratchet keeps them counted.
- **No other `features.mjs` row was touched.** The diff is 49 lines, all insertions, zero deletions.

## How you know

```
node tooling/ci/coverage-check.mjs   → clean · gaps 23/23 · orphans 1/1
node tooling/scripts/tracker.mjs     → 45 shipped of 116 · 36 blocked
node tooling/ci/gates.mjs            → all 27 doctrine gates passed
```

The `coverage` ratchet is two-way: the seven ids are gone from `baseline.gaps` in the same change that
gave them rows, so a stale baseline cannot sit above the truth.
