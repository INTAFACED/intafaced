# Stop note — agent lane C (svc-bank · svc-blueprint · svc-token), 2026-08-08

New tip at stop: **`5bf658ef`** — `test(token): three refusals the service
declares and nothing ever executed (#1094)`.

Session window: 02:25 → 04:35 UTC. Nitro AFK throughout. Three other agent
sessions were live in disjoint lanes.

---

## Landed

| PR        | What broke, for a person                                                                                                                                                                                                                                                                                                                                                                 |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **#1076** | A settled yield window paid a staker who joined **after** it settled — out of the rewards engine, which means out of another window's undistributed revenue, and the operator was told nothing because the run counted the ledger's no-ops as fresh payouts. Class M, red-first, merged green.                                                                                           |
| **#1083** | Retuning the emission curve could **mint past max supply**. The ceiling compared the CURVE's cumulative against `maxSupply`, and both live in `token_params` — editable by design. Lower the curve after minting under a generous one and it mints again on top of what is already circulating. `token.supply_exhausted` had no test naming it at all. Class M, red-first, merged green. |
| **#1094** | Three refusals svc-token declares and no test ever executed — `token.params_missing` (the refusal that stops a deployment charging a discount, or minting against a curve, its own database does not hold) and `token.proposal_not_found`. Coverage only.                                                                                                                                |
| **#1092** | The svc-token README warned that a money path was unsafe. It was fixed months of merges ago (#767 / migration 0002), and the constraints table still listed an index that migration drops. A README that says a safe path is unsafe invites the next reader to fix it twice.                                                                                                             |
| **#1073** | Every worktree cut on this machine started **296 commits behind main**, because `pnpm wt` looked only for a _local_ `main` and, finding none, silently branched off whatever the main checkout was parked on. Class N, merged green.                                                                                                                                                     |
| **#1069** | (Not mine — lane A's, merged as closer duty.) A completed P2P trade could pay out and then tell nobody, losing the release event and both parties' XP. Green and stalled 25 minutes; diff reviewed personally before merging.                                                                                                                                                            |

## In flight

None. No PR of mine is unmerged.

## Found, parked — and why each is not an agent call today

All four are in `services/svc-bank`, which is **owner-locked to
@cursor-swarm-bank** through `bank.ramps` (claim landed 2026-08-07 18:21, #997).
`claim-check` refuses every path under the service, so these are written up and
left alone. Full detail: `docs/audit/2026-08-08-svc-bank.md`.

1. **A re-used request id is answered with somebody else's position.** earn's
   deposit has no conflict check at all; loans' guard checks the amount but not
   the borrower. A second caller's money lands in a stake pot no withdrawal of
   theirs can reach, and the service's own reconciliation invariant
   (`principalOf` == `stakedOf`) breaks for both users. **A complete, typechecked
   patch with five tests is pushed to `fix/bank-idempotency-conflict-parked`** —
   no PR, rebased on tip, take it or drop it.
2. **A standing order ignores a lock the same user set.** `resolveForDebit`
   refuses an archived or self-locked space and has exactly two call sites, both
   on the manual path. The scheduled path checks neither, so a savings space the
   user locked until December is drained monthly anyway.
3. **One stuck standing order stops everyone else's.** A non-insufficient-funds
   error escapes three nested loops with no `try` between them; the schedule's
   `next_run_at` never advances, so it sorts first on every subsequent pass —
   forever. One user's frozen asset stops every standing order on the platform.
4. **One underfunded pool stops every other pool's interest.** Same shape in
   `accrueAll`. The README is right that an underfunded pool must be loud; being
   loud is not the same as being allowed to withhold everyone else's yield.

**Two refusals in svc-token that no test names** — `token.params_missing` and
`token.proposal_not_found`. Neither moves money, which is the only reason they
are parked; both are the shape that hid #1083.

Plus one docs correction, in svc-token and therefore actually free to take:
`services/svc-token/README.md` still carries a _"Known ordering gap … flagged,
not fixed"_ block about `recordBuyback` burning before it claims. That was fixed
in **#767** / migration `0002`. The README also still lists
`buyback_runs_window_idx (unique)`, which 0002 drops. Left out of #1076 only
because it is a different story and would have needed "and" in the title.

## Could not break — the honest negative

Attacked and failed to falsify. Detail in the two audit files.

- **svc-token**: stake-id reuse (this is the service that gets it _right_, and
  its `claimStakePending` is the reference the bank patch copies); double and
  concurrent unstake; re-driving an `unstaking` row past its lock; yield paid to
  an unfunded `pending` stake; minting past the schedule; buyback window overlap
  including nested and partial ranges; params silently falling back to compiled
  defaults instead of `token_params`.
- **svc-bank** (read-only): monthly occurrence drift across short months;
  double-fire under retry, replica or DST rewind; a rejected March transfer being
  made up in April; compounding by the back door; rounding a unit into existence;
  earning the native asset in a bank pool.
- **svc-blueprint** (read-only): a card failure fabricating a URL — every
  `HttpCardRenderer` exit lands on `unavailable`, the strongest sentence in that
  README and it holds; smuggling session input past `blueprints_profile_no_pii_ck`;
  introducing a money column past a schema guard that is genuinely executed.

## Not reached — so silence is not read as coverage

- **svc-bank**: ~28 of ~37 promises. Cards (the whole ledger half), ramps (both
  halves), spend analytics and the `ledger.history` socket, the loan liquidation
  ladder and price-mark guards, cross-service honesty claims.
- **svc-blueprint**: 13 of ~21 promises, listed by name in its audit file —
  matching determinism, the crew-placement transaction under concurrency, the
  erasure boundary, `card_asset_url` write discipline, and the tracing closed-type
  claim.
- **svc-token**: governance vote weighting under concurrency; the
  `/internal/stake/:userId` header auth (belongs to `packages/auth`, lane B); the
  emission curve across a halving boundary.

## Closed for others

- Merged **#1069** (lane A, P2P settlement announce-before-stamp) — green and
  stalled past 20 minutes, diff reviewed personally rather than relayed.
- Left **#1075** alone: it is a **draft**, and its red `Tests` is the author's
  own red-first evidence, not a broken build. Not a flake, not to be "fixed".
- Worktree GC: `pnpm wt:gc:apply`, 5 safe worktrees removed, 32 → **27**. Still
  over the cap of 20; every remaining one is either `DIRTY` (uncommitted work) or
  `KEEP` (ahead of main), and the GC tool correctly refuses both. Clearing the
  rest needs the sessions that own them, not a sweep.
- Dependency audit was green on every run of this session — no advisory to pin
  forward.

---

## Nitro must decide

1. **`services/svc-bank` is closed to agents, and four real money findings are
   waiting on that.** Owner **@cursor-swarm-bank**, via `bank.ramps`. The unlock
   is that owner commenting `agents free on services/svc-bank`, or a PR moving
   the `owner` field. Three of the four fixes are one file each; one is already
   written and pushed.
2. **The `bank.ramps` lock is far broader than the work it protects.** That row
   `requires` only `ramps/ramp-service.ts` and `ramps/rails.ts`, but because it
   carries `module: 'bank'`, `claim-check` locks the entire service — earn,
   loans, transfers, spaces, cards. Deliberate breadth or an accident? The answer
   decides whether four fixes ship tonight or wait.
3. **`services/svc-blueprint` is closed to agents** — owner **@shehzad002**
   (`blueprint.attestations`). Thirteen of its twenty-one promises have never been
   read by anyone.
4. **A lane brief was built on a stale claim check.** This session was told
   svc-bank and svc-blueprint were clear at 02:12 UTC. Both were locked hours
   earlier; the check that said otherwise was run from the main checkout, 296
   commits behind. #1073 fixes the tooling cause. What it cannot fix: **#1063
   merged into the locked `services/svc-bank` at 02:24 today**, after the claim
   landed. Worth knowing whether that session ran the gate at all or ran it from
   the same stale tree.
5. **Unchanged and restated so it does not get lost:** nothing reads the
   `houseFees` balance that `distributeRevenue`'s `sources` claims to sweep
   (audit T-03). The figure is operator-typed. That is the declared §13 socket
   `token.yield`, and closing it needs the §4.3 aggregation job — a number and a
   schedule that are the owner's, not an agent's.

tip: `5bf658ef`
