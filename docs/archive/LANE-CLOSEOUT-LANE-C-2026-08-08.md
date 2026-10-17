# Lane C closeout — 2026-08-08

Lane C: `services/svc-bank` · `services/svc-blueprint` · `services/svc-token`
Tip at writing: `f29ddf69`
Session window: 02:25 → 05:00 UTC.

Method throughout: read each service's own written promises — README sentences
with _must / never / always / cannot / guarantees_, load-bearing comments,
database CHECK constraints, the error catalogue — and try to falsify each one
against a state the platform can actually reach. Every fix landed as a RED test
first, on its own commit, so CI recorded the failure before the fix.

---

## Shipped

Eight PRs, all merged, all green in CI.

| PR        | What a user or operator can now do                                                                                                                                                                                                                                                                                        |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **#1083** | Hold IFC knowing the supply cap is real. Retuning the emission curve down after minting under a generous one used to mint straight past `total_supply` — the ceiling compared the CURVE's own cumulative against a cap living in the same editable row. It now measures against the book: what has actually been emitted. |
| **#1076** | Re-run a yield window without paying it twice. A settled window used to pay any staker who joined afterwards — out of another window's undistributed revenue — and report the ledger's no-ops as a fresh payout. The recipient list is now frozen when the window is first distributed.                                   |
| **#1094** | Trust three refusals that no test had ever executed: `token.params_missing` (the refusal that stops a deployment charging a discount, or minting against a curve, that its own database does not hold) and `token.proposal_not_found`.                                                                                    |
| **#1092** | Read the svc-token README without being warned about a money bug that was fixed months of merges ago. The buyback ordering was closed by #767 / migration `0002`; the doc still said it was not, and still listed an index that migration drops.                                                                          |
| **#1073** | Cut a worktree that starts from `origin/main`. `pnpm wt` looked only for a LOCAL `main` and, finding none, silently branched off whatever the main checkout was parked on — 296 commits behind. Adds `pnpm wt:base` so the base is checkable before a branch exists.                                                      |
| **#1080** | Read what svc-token, svc-bank and svc-blueprint actually promise, and which promises have been tested against a reachable failure.                                                                                                                                                                                        |
| **#1089** | Same, updated for the mint ceiling and the untested-refusal sweep.                                                                                                                                                                                                                                                        |
| **#1095** | Same, final: nothing left parked in svc-token.                                                                                                                                                                                                                                                                            |

Closed for another lane, as wave-closer duty: merged **#1069** (lane A, svc-p2p
— a completed trade could pay out and then tell nobody, losing the release event
and both parties' XP). Green and stalled past twenty minutes; its diff was
reviewed personally rather than relayed, because it is a money path.

## Left open, and why

**None.** No PR of this lane is open, drafted or red. Everything started this
session is merged.

One branch is deliberately parked with **no PR**, which is not the same as left
open:

- **`fix/bank-idempotency-conflict-parked`** — a finished, typechecked patch with
  five tests for the svc-bank finding below. It is rebased on tip and has no PR
  **because `services/svc-bank` is owner-locked and an agent must not implement
  there.** Take it or drop it; do not treat it as unfinished work. The same work
  also sits on origin under a second, agent-prefixed branch name;
  `git branch -r | grep bank-idempotency` finds both. That second name is
  described rather than spelled because writing it out names a model provider,
  which Doctrine §0.7 forbids in any doc — it turned the brand-scan gate red on
  main for all four lanes when this note first landed.

## Not started

The section that matters most. Named so nobody reads silence as coverage.

### `services/svc-bank` — ~28 of ~37 promises never attacked

Nine were checked (four broken, all written up in
`docs/audit/2026-08-08-svc-bank.md`); the rest were never reached, because the
claim gate closed the service partway through the session.

Never opened at all:

- **Cards, the whole ledger half** — issuer adapter, authorisation, capture,
  reversal, cashback, and the `bank.no_card_issuer` refusal.
- **Ramps, both halves** — the crypto ledger leg that landed on 2026-08-07, and
  the fiat leg that must refuse `bank.fiat_ramp_socket` honestly.
- **Spend analytics** and the `ledger.history` §13 socket, which is written to
  fail loudly rather than report a false zero.
- **The loan liquidation ladder and the price-mark guards** — staleness window,
  deviation breaker, `bank.no_liquidation_counterparty`, `bank.bad_debt_uncovered`.
- **The freeze cascade against an in-flight transfer**, beyond the head-of-line
  finding already written up.
- **Cross-service honesty** — where bank claims a downstream behaviour it does
  not control ("funds settle instantly", "the card is issued"), does the claim
  survive that service being dark?

To pick these up, read: `services/svc-bank/README.md` (the promises, in prose,
with the Done bar embedded in each section) and
`docs/adr/2026-08-04-bank-vertical-law.md` (the vertical's law, and the test the
ADR sets: _"could this platform produce it with no third party's signature?"_).
The tracker rows are `bank.cards`, `bank.ramps` and `bank.sovereign-card` in
`tooling/tracker/features.mjs`. **Check the claim gate first** — see below.

### `services/svc-blueprint` — 13 of ~21 promises never attacked

Eight were checked and all eight held. The thirteen never attacked are listed by
name in `docs/audit/2026-08-08-svc-blueprint.md`; the ones that would cost most
if wrong:

- "A user who re-runs matching must land in the **same crew**" — determinism,
  including whether the candidate-set bound is itself deterministic (`ORDER BY`
  plus `LIMIT`, "never a sample").
- "five concurrent joins against two seats" — the placement transaction that
  must not overfill a crew.
- The **erasure** boundary — erasing a user who never onboarded, erasing twice,
  onboarding again after erasure.
- "The profile is never logged, never traced, never put on an event" —
  `BlueprintSpanAttributes` as a closed type.
- "`card_asset_url` is written **only** on a real render, **only** for the
  portrait, and **only** by `card` — never by `export`."

To pick these up, read `services/svc-blueprint/README.md` — it states each
promise and its Done bar in the same sentence — and §7.1 of
`INTAFACED_DEFINITIVE_BUILD.md`. **Owner-locked; see below.**

### `services/svc-token` — three promises left

Everything else in this service was checked. Not reached:

- **Governance vote weighting under concurrency.** The weight is snapshotted
  inside the vote transaction, which reads correctly, but the racing case was
  never built.
- **`/internal/stake/:userId`** — the hot path every other module gates on. Its
  auth is service headers, and header verification lives in `packages/auth`,
  which is lane B's, not this lane's.
- **The emission curve across a halving boundary.** 106 pure tests already cover
  the arithmetic; no independent attack was made on it.

To pick these up: `services/svc-token/README.md` and
`docs/adr/2026-08-04-token-economics-outcomes.md`, whose "the numbers that are
the owner's" section is the line an agent must not cross.

## Only Nitro can decide

1. **`services/svc-bank` is owner-locked to @cursor-swarm-bank** through the
   `bank.ramps` tracker row, and it was still locked when this note was written.
   **Four real money findings are waiting on that lock**, three of them one-file
   changes and one with a finished patch already pushed. The documented unlock is
   that owner commenting `agents free on services/svc-bank`, or a PR moving the
   `owner` field.

2. **The lock is far broader than the work it protects.** `bank.ramps`
   `requires` only `ramps/ramp-service.ts` and `ramps/rails.ts` — but because the
   row carries `module: 'bank'`, `claim-check`'s rule ("a locked module locks its
   service directory") closes earn, loans, transfers, spaces and cards as well.
   Deliberate, or an accident? The answer decides whether those four fixes ship.

3. **Two PRs merged into the locked service anyway, by other sessions.** #1063
   at 02:24 UTC (README + `env.ts`), and #1102 is open in it as this is written.
   Either those sessions did not run the gate, or ran it from a stale checkout —
   worth knowing which, because #1073 only fixes the second cause.

4. **`services/svc-blueprint` is owner-locked to @shehzad002**
   (`blueprint.attestations`). Thirteen of its twenty-one promises have never
   been read by anyone.

5. **A lane brief was built on a stale claim check.** This session was dispatched
   with "svc-bank verified clear at 02:12 UTC". Both svc-bank and svc-blueprint
   had been locked hours earlier; the check that said otherwise ran from the main
   checkout, 296 commits behind `origin/main`. Root cause fixed in #1073.

6. **Unchanged, restated so it is not lost:** nothing reads the `houseFees`
   balance that `distributeRevenue`'s `sources` claims to sweep (audit **T-03**).
   The figure is operator-typed. That is the declared §13 socket `token.yield`,
   and closing it needs the §4.3 aggregation job — a schedule and a number that
   are the owner's, not an agent's.

## What I could not break, having tried

The honest negative result — where this lane went looking and found nothing
wrong. Full reasoning in the three audit files.

**svc-token**

- **Stake id reuse.** Tried the exact attack that works on svc-bank's earn
  deposit — a second user re-using a live `stakeId`. `claimStakePending` compares
  user, amount and tier and throws `token.stake_conflict`. This is the service
  that gets it right, and its shape is what the parked bank patch copies.
- **Double unstake and concurrent unstake.** The `unstaking → closed` update is
  conditional; only one caller wins and the loser refuses rather than reporting a
  second success.
- **Unstaking a locked stake by re-driving.** The lock check is skipped on an
  `unstaking` row, which looked like a hole — but a row only reaches `unstaking`
  through the `active` branch, where the lock IS checked.
- **Yield paid to an unfunded `pending` stake.** Both queries filter `active`.
- **Buyback window overlap.** The exclusion constraint refuses nested and partial
  overlaps, not only identical ones. Tried `[Jul 1, Aug 1)` against
  `[Jul 10, Jul 20)`; refused.
- **Params silently falling back to compiled defaults.** All three readers refuse
  a missing `token_params` row — and now a test proves it (#1094).

**svc-bank** (read-only after the lock was found)

- **Monthly occurrence drift.** Attacked the classic 31 Jan → 28 Feb → stuck-at-
  the-28th bug. Occurrences are computed from the anchor, so the schedule returns
  to the 31st.
- **Double-fire under a retry, a second replica, or a DST rewind.** Two
  independent guards agree by construction — `unique(schedule_id, occurrence)`
  and the ledger key, both derived from the same pair.
- **Making up a missed March transfer in April.** The occurrence is consumed on
  rejection, with its code; there is no queue that could replay it.
- **Compounding interest by the back door**, and **rounding a unit into
  existence.** Interest goes to `available`, every rounding is `floor` in the
  reserve's favour, and the dust is counted rather than dropped.

**svc-blueprint** (read-only)

- **A card failure fabricating a URL.** Walked every exit of `HttpCardRenderer`
  looking for one that returns a URL or throws past its caller. Timeout,
  transport error, non-2xx, unparseable body, contract mismatch and zero bytes
  all land on the `unavailable` arm. The strongest sentence in that README, and
  it holds.
- **Smuggling session input into the profile column.** The named PII keys are
  refused by a database CHECK, so a caller that forgets the TypeScript path still
  cannot land the row.
- **Introducing a money column by stealth.** The no-`numeric` schema guard is
  genuinely executed on every run, not merely written.
