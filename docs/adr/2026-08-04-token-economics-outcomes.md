# ADR: token economics — which numbers are decisions, and the one that is already wrong

**Status:** **Accepted — 2026-08-04.** Owner decision, stated and confirmed.
**Decision owner:** repo owner. **Written by:** Denon.
**Spec id:** D-S-14.
**Scope:** this ADR **decides no economic number.** It decides which numbers are the owner's, what must happen before any of them is published, and it names one ordering defect that needs fixing regardless of what the numbers turn out to be.

---

## The decision

> **Every economic parameter has exactly one authority, and `token_params` is it. A number in source is a seed, never a commitment, and the two must be proven to agree.**
>
> **No economic figure may be published to a user until the owner has set it.** Not a supply, not a burn total, not a "% of fees to buyback", not an APY.

This is settled. Agents and engineers implement it; they do not re-litigate it.

---

## Why this needed saying: two economies exist, and the one in code is not the one that runs

`svc-token` boots with `loadParamsFromDb: true`. The exported constants in `economics/*.ts` are **seed only**. They disagree with the seeded row on **every** emission and buyback number:

| Parameter             | Code constant | Live seeded row | Drift guard |
| --------------------- | ------------- | --------------- | ----------- |
| `initialEpochReward`  | `'136000'`    | `"2500"`        | **none**    |
| supply cap            | `'400000000'` | `1000000000`    | **none**    |
| `buybackBps`          | `5_000`       | `2000`          | **none**    |
| `burnSplitBps`        | `6_000`       | `5000`          | **none**    |
| fee discount schedule | `staking.ts`  | migration       | **yes**     |

The fee ladder is the **only** family with a code↔migration agreement test — and the comment above it records exactly why it exists: the two copies _"drifted — every non-zero step disagreed — and the service shipped for as long as it took someone to read both files side by side."_

**That bug is still live for emission and buyback.** The fix was applied to one family of three.

The consequence is that a comment in `emission.ts` justifies the design with arithmetic that is false of the running system. It argues the curve converges below the cap — 397,120,000 against 400,000,000. On the live row the cap **is** the total supply (1e9) and the live curve's geometric limit is `2 × 2500 × 1460 = 7,300,000` — **0.73% of the cap**. The test pins the constant that never runs.

The "40% mining allocation / 60% governance-allocated" distribution that comment relies on **exists nowhere else in the repo.** Not in doctrine, not in the migration, not in a doc. It is a sentence in a code comment, and it is currently the only written description of how the supply is divided.

---

## The defect to fix regardless of any number

**The irreversible leg posts before the guard, and the guard is on a different key than the leg.** `recordBuyback` (`token-service.ts:758-805`):

1. Burn posts at `:771-775`, keyed `token.burn:${runId}`.
2. `INSERT … ON CONFLICT (id) DO NOTHING` at `:777`.
3. The guarding index is `buyback_runs_window_idx ON (revenue_window_from, revenue_window_to)`.

**A new `runId` over an identical window burns for real, then violates the window index.** `ON CONFLICT (id)` does not cover it; the `23505` is neither a `TokenError` nor a `LedgerError`, so it falls through to an opaque `INTERNAL_SERVER_ERROR`. Net result: **tokens irreversibly in the burn account, no run row, no event, and a 500 that says nothing.**

The migration comment claims the opposite — _"A revenue window is spent exactly once."_ It prevents the **row**, not the **burn**.

**And overlapping windows are entirely unguarded.** The unique index matches only exact equality of both timestamps. Windows one second apart, nested windows, or windows overlapping by a day all insert and burn cleanly. There is no "last settled window" pointer and no half-open `[from, to)` rule.

**The fix needs no economic decision:** claim the window first, then post the burn — the exact `claim → post → activate` order `stake` already uses in the same file. Do that before any number is chosen.

**Reproduced 2026-08-04, with the money moving.** Against real Postgres, pre-fix:

```
REPRO A · burn account after run 1 = 600
REPRO A · threw            = PostgresError code=23505   (is TokenError = false)
REPRO A · burn after run 2 = 1200          ← doubled
REPRO A · buyback_runs rows= 1   buybackExecuted events = 1
REPRO B · burn after July window   = 600
REPRO B · burn after NESTED window = 1200  (same revenue burned twice)
```

600 → 1200 against **one** row and **one** event. And REPRO B is the worse case: a nested window burned the same revenue twice and **raised no error at all** — the unique index never fired, because it matches only exact equality of both timestamps.

Two smaller ones alongside it: `recordBuyback` is the only money method in the service **not** wrapped in `withMoneySpan`, so it is untraced; and `revenueTotal` is a `z.record(z.string())` written straight to jsonb and validated nowhere.

---

## What "buyback" currently means, stated plainly

The service already says it, and this ADR endorses the statement rather than softening it:

> "NOTHING IS BOUGHT BACK HERE… `tokensBought` is a figure the caller types. No market-buy is executed by this service or any other, so the platform acquires no IFC and creates no buy pressure."

Worse for honesty: the burn debits `rewardsEngine`, which is funded from **two indistinguishable sources** — swept fees, and freshly minted emission. **A "burn" can today be funded entirely by newly minted supply**, and nothing in the ledger or the run row distinguishes them.

`buybackBudget()` — the function that would size a spend from actual revenue — is dead code, called by nothing and tested anyway.

**Rule: a burn funded by mint is not a buyback and may never be described as one.** Until the funding source is provably fee revenue, the tracker row stays `socket` and no surface reports a burn total as a buyback outcome.

---

## Governance: the outcome does not exist, and that is correctly recorded

There is **no `UPDATE token.proposals` statement anywhere in the repo.** No quorum, no pass threshold, no close job, no executor. `draft` and `open` are both terminal.

The refusal to close it cheaply is already written and is the precedent this ADR generalises:

> "A mutation that flipped the status column would read to a caller as the outcome being enacted while nothing outside this table changed, **which is a worse lie than the current silence**."

And on the tally: _"The tally is a REPORT, not a decision… a proposal whose `forWeight` dwarfs its `againstWeight` stays `open` forever. Anything rendering this must say so; a bare 'for vs against' bar reads as an outcome."_

**A circularity the owner should see before deciding quorum:** `ACCESS_TIERS` is **code, not `token_params`** — so it is unreachable by governance — and it sets `PROPOSAL_MIN_STAKE`, which decides who may propose. **The electorate's own ladder is not governable.** Deciding what a majority means without deciding that leaves the question half-answered.

One latent bug for the refuse-cases: the tally loop **assigns** rather than accumulates weight, correct only because `GROUP BY choice` guarantees one row per choice — while `voterCount` in the same loop accumulates. Two idioms, one loop, one schema change from silently dropping weight.

---

## The numbers that are the owner's

`DIRECTION` §8 covers these **by class** — fee and revenue recipes, listing policy, anything described as guaranteed, every fee-share rate — but **names no token number explicitly.** That gap is why this list exists. Enumerated:

**Emission:** initial epoch reward · supply cap · halving interval · the mining-vs-governance allocation split (currently only a code comment).

**Buyback:** `buyback_bps` · `burn_split_bps` · **window length, cadence and contiguity** · **the §20 published fee→buyback percentage**, which currently has three different values in the repo — 2000 bps live, 5000 bps in source, "dominant share" in doctrine — and has never been chosen.

> **Corrected 2026-08-04** — this line first read "window semantics (half-open vs closed, contiguity, overlap policy)", which contradicted this ADR's own done bar and refuse table, both of which require overlap to be defined and enforced. An implementer caught the tension.
>
> The split is: **the overlap RULE is a refusal and is not an economic number** — no two windows may overlap, and boundaries are half-open `[from, to)`. That is not a choice so much as a derivation: under closed bounds a contiguous series is unsettleable, because `[Jul, Aug]` and `[Aug, Sep]` collide on their shared instant. **How long a window is, how often one runs, and whether the series must be gapless remain the owner's.**

**Staking:** the `ACCESS_TIERS` decade ladder · lock multipliers · fee-discount steps · **and the open divergence the code refuses to resolve**: §4.3 keys the discount on the payer's _balance_, the code and the seeded row key on _staked_. The comment is right that "picking one re-prices every discount in the economy, so it is a governance decision and not a refactor."

**Governance:** quorum · pass threshold · voting period · whether a proposal bond exists at all (today nothing is escrowed and nothing is slashable) · and how each proposal kind executes. `grant` moves value, so it is a ledger recipe and a `DIRECTION` §3 carve-out twice over.

---

## Emissions: the honest sentence

`EMISSIONS_ENABLED` defaults **true**, and that reads alarming. It is a **gate, not a scheduler**. All three mint paths need a caller: the auto-tick requires `EMISSIONS_AUTO_TICK`, which defaults **false**; the internal route requires an HMAC and **nothing in the repo calls it**; the tRPC path requires `admin:treasury`, i.e. a human.

So: **the switch defaults open, the faucet defaults off, and no scheduler exists.** That is defensible — but note the safety rests on **the absence of a cron**, which is not a control anyone can audit, and `EMISSIONS_ENABLED` is not set in compose at all, so nobody has ever affirmed it.

One latent bug: the mint destination is hardcoded `rewardsEngine('IFC')` while `TOKEN_ASSET_ID` is configurable — a deployment with its own symbol would mint that symbol into an `IFC` account.

---

## Refuse cases

| Situation                                                        | Correct answer                                                                           |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `token_params` row missing or unreadable                         | **Fail.** Never fall back to the source constant — the precedent is already in the file. |
| A **new** disagreement appears, or an existing one changes value | **Fail the build.** Extend the fee-ladder agreement test to emission and buyback.        |
| The **four existing** disagreements                              | **Pinned, surfaced, and impossible to resolve silently** — see the correction below.     |
| Buyback window overlaps a settled one                            | **Refuse before burning.** Claim the window, then post.                                  |
| Burn funded from a source that includes mint                     | **Refuse.** A burn funded by mint is not a buyback.                                      |
| A proposal reaches its deadline                                  | **Nothing happens, and the surface says so.** No status flip without an executor.        |
| Any surface asked for supply, burn total, APY, or fee-%          | **Say it is not set.** Never a zero, never a dash, never a plausible figure.             |
| An agent needs an economic number to proceed                     | **Stop and ask.** This is the invent ban at its sharpest.                                |

### Correction — 2026-08-04, same day

This ADR first said, flatly, _"Code constant disagrees with the live row → **Fail the build**."_ Applied to the **four disagreements that already exist**, that lands an unconditionally-red test on `main` and keeps it red until an owner decides four numbers that have been undecided for weeks — blocking every unrelated merge in the repo while the swarm is landing several PRs an hour.

That is the failure mode this ADR is supposed to prevent, arriving from the other side: **a red everyone must route around is a red that gets deleted**, and it would take the honest part with it.

The rule as it stands:

- **A new disagreement, or a change to an existing one, fails the build.** That is what "fail the build" was always for.
- **The four existing ones are pinned by a hand-written inventory** that is derived from nothing and so cannot go green on its own. Editing either copy — including "fixing" the drift by copying one value over the other — forces a human to come and edit an expectation by hand, in a file whose comments say these numbers are the owner's. **That closes the silent-resolution hole in both directions**, which was the actual requirement; an unconditional red was only ever a blunt way of reaching it.

The disagreement stays visible in normal test output. It cannot be shipped further, resolved quietly, or forgotten.

---

## Done bar

1. `token_params` is the only authority. Every source constant is labelled a seed and proven to agree with the live row by test.
2. The buyback claims its window **before** posting the burn, and overlap policy is defined and enforced.
3. `recordBuyback` is traced like every other money method.
4. No user-visible surface carries an economic figure the owner has not set.
5. `token.emissions` is re-examined — it is `done` while its live parameters are undecided seeds with no drift guard.
6. Governance keeps no path that flips a status without an executor.
7. Burn funding source is provable from the ledger, or the row stays `socket`.

---

## What agents may implement without asking again

- **The window-before-burn reordering.** It fixes an irreversible-value bug and decides no number.
- Extending the code↔migration agreement test to emission and buyback — it forces the two copies to agree with _whatever_ is decided.
- `withMoneySpan` on `recordBuyback`; validating `revenueTotal`; the `rewardsEngine(this.assetId)` fix.
- The tally accumulate-vs-assign fix.
- Any refusal or disclosure above.

## What still needs the owner

- **Every number in the enumerated list.** Bring the shape; do not invent it.
- Whether `ACCESS_TIERS` becomes governable, which gates the quorum question.
- The §4.3 balance-vs-staked divergence.
- Any published economic figure — `DIRECTION` §8 item 9 applies in full.

---

## A note on where these belong

`docs/BOARD-CLEAR-HUMAN-BLOCKERS.md` (removed) contains **zero token rows.** No token number has ever been queued to the owner inbox, despite four `token.*` rows sitting at `socket` for exactly that reason. The enumerated list above should be filed there, or it will keep being rediscovered.
