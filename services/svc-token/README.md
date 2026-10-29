# svc-token

**The native economy — IFC (§4.3).** Third and last of the Phase 1 Core services.

Owns the emission schedule and the staking ladder. Holds the maths and the ledger recipes for real-yield distribution and burn — and, as of 2026-08-03, says plainly that those last two are operator actions rather than the §4.3 flywheel.

**What this service is not:** it does not hold balances and it does not price anything. `stakes` records who staked what and when; the value lives in the ledger's `stake` accounts. Pricing and execution are svc-trade's job — this service never decides a price.

---

## What is automatic, and what is a person (read before quoting §4.3 at a user)

Staking, access tiers, emissions and governance **tally/close** are live. Yield and buyback remain the §4.3 surfaces that are not a flywheel — yield has a job when `YIELD_JOB_ENABLED` is on; buyback is still a socket.

| §4.3 says                                                                       | What actually runs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Socket             |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| "weekly job aggregates house fee accounts per asset → distributes"              | `distributeRevenue`, invoked by hand. **No caller exists** outside tests — no cron, no bus subscriber, no admin form. Operator-typed `sources[].amount` is still required (no aggregation job). On **first claim** each module is bound to the live `houseFees` pot — over-claim refuses as `token.yield_source_underfunded` before the window header (T-03 residual of #1353). Under-claim (leaving fees in the pot) stays allowed. The weekly job that _builds_ `sources` from balances is still the socket.                                                                     | `token.yield`      |
| "market-buy on internal book → split to burn + rewards. Structural, scheduled." | `recordBuyback`, invoked by hand. **Nothing is bought** — `tokensBought` is typed by the operator (must be positive; zero would still claim the revenue window). `revenueTotal` is validated as assetId → unsigned decimal strings before claim. No ledger post: a fee-funded burn is not a buy, so the run refuses `token.buyback_tokens_unmoved` rather than settling. `buybackBudget()` has no caller but its own tests.                                                                                                                                                        | `token.buyback`    |
| "IFC-weighted voting" with `proposals.status`                                   | Ballots are recorded and weighted. **`closeProposal` writes `passed` / `rejected`** from the tally vs `TOKEN_GOVERNANCE_QUORUM_BPS` + `TOKEN_GOVERNANCE_THRESHOLD_BPS`. Blank env refuses `token.governance_quorum_unset` (never a compiled bar). Grant/listing close does **not** execute — `token.governance_execute_unwired`, no ledger post. `executed` / `cancelled` stay unwired. A future `opensAt` stays `draft` until `openDueProposals`. Who may propose is a stored rule (or `TOKEN_PROPOSER_RULE` while that row is blank): blank refuses `token.proposer_rule_unset`. | `token.governance` |

Yield and buyback are not a rename away from the flywheel. Yield has a window header (`token.yield_windows`, 0004) plus plan claim (`token.yield_payouts`, 0003) so a re-run cannot pay late joiners — including after an empty first run — but still needs a scheduled caller when the job is off. Buyback has claim-before-burn (0002) and validated `revenueTotal`, but still needs svc-trade to execute a real purchase. Governance close tallies from owner env bps (blank → `token.governance_quorum_unset`); grant/listing execute stays `token.governance_execute_unwired`.

### And IFC is a ledger asset, not a coin

Worth stating here because the word "token" invites the wrong inference. No `.sol` file in this repo mentions IFC; there is no contract, no chain, no deposit or withdrawal path. Supply is rows in `token.emission_epochs` and balances in svc-ledger. The "burn address" is `house/burn` (`packages/ledger-client/src/accounts.ts:155-157`) — an ordinary operator-owned internal account of kind `available`; "tokens debited to the burn account never move again" is a convention this codebase observes, not a constraint anything enforces. No holder can self-custody IFC, withdraw it, or verify total supply independently of us. `burnedSupply` is the only supply-side read on the router and it is `token:read` scoped.

---

## API

| Route / method                                      | Scope / auth                                                | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /internal/stake/:userId`                       | service headers                                             | **The hot path.** §4.3: other services call this to gate launchpad allocations, OTC access, premium lobbies, vendor slots                                                                                                                                                                                                                                                                                                                                                                                             |
| `POST /internal/emissions/mint-next`                | service headers                                             | Cron-friendly mint of the next sequential epoch (refuses `503` when `EMISSIONS_ENABLED=false`; `429` + `Retry-After` + `token.epoch_too_early` before one epoch length has passed)                                                                                                                                                                                                                                                                                                                                    |
| tRPC `stake`                                        | `token:stake`                                               | Opens a stake for the signed principal — claim `pending` → ledger fund → `active`                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| tRPC `unstake`                                      | `token:stake`                                               | Returns principal; enforces lock + ownership                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| tRPC `listStakes`                                   | `token:read`                                                | Stakes owned by the signed principal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| tRPC `stakeOf` / `accessOf`                         | `token:read`                                                | Total active stake / access tier + fee discount                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| tRPC `mintEpoch` / `nextEmissionEpoch`              | `admin:treasury` / read                                     | Operator mint (optional `epoch`) and next index                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| tRPC `distributeRevenue`                            | `admin:treasury` + MFA                                      | **Operator action, no caller.** Sweeps the fee sources the operator names → pro-rata staker payouts. Not a scheduled job                                                                                                                                                                                                                                                                                                                                                                                              |
| tRPC `recordBuyback`                                | `admin:treasury` + MFA                                      | **Operator action, no caller.** Refuses `token.buyback_tokens_unmoved` unless a recipe booked the buy. Buys nothing; does not emit `buybackExecuted`                                                                                                                                                                                                                                                                                                                                                                  |
| tRPC `feeDiscount.get` / `feeDiscount.publish`      | `token:read` or `admin:read` / `admin:write` + two founders | The fee-decay ladder `accessOf` reads (stake thresholds to discount bps) and its version (`unset` while blank). `publish` writes a whole ladder over the version it names, after identity's `token.fee_discount.publish` approval by two founders of exactly that ladder and version; a stale version refuses `token.fee_discount_stale` and a ladder that is unsorted, falls, or passes the 5000 bps ceiling refuses `token.fee_discount_invalid`. The owner's door until governance executes `fee_param` proposals. |
| tRPC `burnedSupply`                                 | `token:read`                                                | Balance of the `house/burn` ledger account                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| tRPC `createProposal` / `editProposal` / `castVote` | `token:stake` / admin                                       | Creates or edits a draft. A blank proposer rule or period cap refuses. `castVote` records a ballot, weight = `stakeOf` snapshot taken inside the vote transaction                                                                                                                                                                                                                                                                                                                                                     |
| tRPC `followSpace` / `governanceHome`               | `token:read`                                                | Follow the one space and read that follow plus whether this account may propose. Opening due drafts is not a customer door.                                                                                                                                                                                                                                                                                                                                                                                           |
| tRPC `listProposals` / `getProposal`                | `token:read`                                                | Reads proposals; `getProposal` recomputes a tally                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| tRPC `closeProposal`                                | `token:stake`                                               | After the window: writes `passed` / `rejected`. Blank quorum env → `token.governance_quorum_unset`. Grant/listing → `token.governance_execute_unwired`                                                                                                                                                                                                                                                                                                                                                                |
| tRPC `delegation` / `delegate`                      | `token:read` / `token:stake`                                | Read is a null delegatee with blocker `no_chain_service`. Write refuses `token.delegation_unavailable` with that blocker after a blank or non-member target is named. Nothing is stored. There is no chain service and no on-chain delegate registry.                                                                                                                                                                                                                                                                 |
| tRPC `treasury`                                     | `token:read`                                                | `burned` is the `burnedSupply` balance. Lifetime minted, bought, toRewards and distributed sums, plus the last settled buyback (`lastBuyback`). No rows on those sums is null. Not a price. A blank stored total refuses `token.treasury_figure_unreadable`.                                                                                                                                                                                                                                                          |

### Launch events (J-more-catalogue-11)

`src/launch/`. A launch event is an issuer's published token sale, whitelist drop or primary subscription. It has five periods, a status, an allocation rule (method, per-user cap, ticket size, tier weights) and terms (price, payment asset, rate source). **No money moves here**: there is no subscription, payment or distribution, and an event refuses `launch.allocation_unwired` past `closed`. A blank allocation or price field stays null and the page shows "not set" or "price not set".

| tRPC                                   | Scope                        | Purpose                                                                                                                                                                                                                                 |
| -------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `launch.events.list` / `events.get`    | public                       | Published events (never a draft), newest opening first, filtered by `type` and `state` (`upcoming`, `open`, `past`). A blank page size refuses `launch.events_list_limit_unset`.                                                        |
| `launch.events.create` / `events.move` | `admin:write` + two founders | Creates a draft (idempotent on id and content) or moves it one status forward (or to `cancelled`) over `expectedRevision`. Moving to `snapshot` seals one row per account with active stake at that moment, plus count, total and hash. |
| `launch.issuer.set`                    | `admin:write` + two founders | Adds an issuer (`applied`) or moves it one review step (`reviewing`, `onboarded`, `suspended`). An event of an issuer that is not onboarded cannot open.                                                                                |
| `launch.eligibility`                   | `token:read`                 | The requirements list for the signed account, each met or not: identity verification, region, active account, main account, issuer onboarded, launch open. The account is read from identity per check; svc-token keeps no copy.        |
| `launch.basis`                         | `token:read`                 | The signed account's stored snapshot row, the cap as a decimal string, and the tickets or tier weight the stored rule gives it. Nothing is recomputed from live stakes.                                                                 |

Who may take part is two owner values, **NO DEFAULT**: `TOKEN_LAUNCH_MIN_KYC_TIER` (`none`, `basic`, `full`, `institutional`) and `TOKEN_LAUNCH_RESTRICTED_REGIONS` (`none` or a comma list of two-letter regions). Either blank refuses `launch.eligibility_unset`; an unread account refuses `launch.eligibility_unavailable`, never reads as eligible.

Optional auto-tick: set `EMISSIONS_AUTO_TICK=true` (and leave `EMISSIONS_ENABLED=true`) to have an in-process timer **ask** whether the next epoch is due every `EMISSIONS_TICK_MS`. Blank `EMISSIONS_TICK_MS` polls every `min(EMISSIONS_EPOCH_MS, 60s)`; a non-blank value that is not an integer of at least 1000 refuses at boot (`token.emissions_tick_unset`). The poll is not the cadence — the time gate below is. Do not set the tick equal to the epoch length: the claim is stamped a few ms after the tick fires, so the next tick lands just inside the gate and an epoch is lost to the wait. Prefer external cron → `/internal/emissions/mint-next` or tRPC `mintEpoch` so the job is pauseable. **Cron cadence trap:** a cron that fires exactly every 24 h is refused every other day (the claim is stamped a few ms after the cron fires, so the next day's call lands just inside the gate and gets `429 token.epoch_too_early`, `Retry-After: 1`), which silently halves emission. Run the cron MORE often than the epoch (hourly is fine: extra polls are harmless because the gate refuses them) or retry once after `Retry-After`; alert if the newest epoch is older than 26 h.

### Epoch time gate

One epoch is **1 day** (`EMISSIONS_EPOCH_MS`, default `86400000` — owner-present, Nitro's pick 2026-10-14). A **new** epoch cannot start sooner than one epoch length after the previous epoch was claimed; `mintEpoch`, `mintNextEpoch`, the HTTP endpoint and the auto-tick all go through the same check and refuse with `token.epoch_too_early` (message says how long to wait).

- **Clock:** the database's. `emission_epochs.created_at` is stamped with `clock_timestamp()` when an epoch is claimed, and the gap is measured with `clock_timestamp()` inside the same claim transaction, under the per-asset advisory lock — so two concurrent callers cannot both pass, and app-server clock skew or restarts do not move the gate. No new column or migration: `created_at` already exists.
- **Timestamp:** the newest `created_at` of any epoch row (the claim time, not the close time).
- **Not refused:** the very first epoch (no row yet), and a **resume** of an epoch that is claimed but not closed (a retry after a lost reply: same epoch number, same snapshotted reward, same ledger key `token.emission:<epoch>`).
- **Explicit `epoch` argument:** a closed epoch is still `token.epoch_closed`; skipping ahead to any other new epoch number is a new claim and is gated the same way.
- **Order of refusals:** kill switch (`EMISSIONS_ENABLED=false`) first, then closed / supply exhausted, then the time gate.
- **What it is not:** it does not set the amount. Reward per epoch, supply cap and halving interval stay blank and owner-only in `token_params`.
- **Statuses:** tRPC `TOO_MANY_REQUESTS` (message = the wait time); HTTP `429` with `Retry-After` (seconds) and `retryAfterSeconds`.

### Environment (emissions)

| Variable              | Default    | Meaning                                                                                                                                             |
| --------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EMISSIONS_ENABLED`   | `true`     | Kill switch for every mint path                                                                                                                     |
| `EMISSIONS_EPOCH_MS`  | `86400000` | Epoch length (1 day): minimum gap between NEW epochs, database clock. Positive integer. Owner-present, 2026-10-14                                   |
| `EMISSIONS_AUTO_TICK` | `false`    | In-process timer that asks whether the next epoch is due                                                                                            |
| `EMISSIONS_TICK_MS`   | blank      | Poll interval for the auto-tick; blank means `min(EMISSIONS_EPOCH_MS, 60000)`. Non-blank must be an integer >= 1000 or `token.emissions_tick_unset` |

| Error code               | Meaning                                                                                             |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| `token.epoch_too_early`  | A new epoch was requested before one epoch length passed since the last claim; retry after the wait |
| `token.epoch_closed`     | That epoch is already minted                                                                        |
| `token.supply_exhausted` | Schedule exhausted or the cap would be exceeded                                                     |

---

## Events

**Publishes**

| Subject                         | When                                    |
| ------------------------------- | --------------------------------------- |
| `intafaced.token.stake.created` | a stake opens — gates unlock downstream |

`intafaced.token.buyback.completed` (`buybackExecuted`) is **declared and not published**. `recordBuyback` posts nothing, so emitting it would lie that tokens moved. `WIRING_SOCKETS` is in `packages/events` — a second PR must record the missing publisher (or a buyback recipe must post, then this service publishes). Exclusive `svc-token` cannot clear event-wiring.

**Consumes — nothing, and that is the gap, not a phase.** §4.3's yield job and buyback schedule would both be consumers; neither exists. Today every revenue figure this service acts on is supplied by an operator on the wire, and no subscriber anywhere turns a trade fill into one.

---

## Ledger

Every recipe this service invokes, and what it touches:

| Recipe               | Reason code               | Accounts                             |
| -------------------- | ------------------------- | ------------------------------------ |
| `stake`              | `token.stake`             | user available → user stake          |
| `unstake`            | `token.unstake`           | user stake → user available          |
| `sweepFeesToRewards` | `token.fee.swept`         | `houseFees(module)` → rewards engine |
| `rewardPay`          | `token.yield.distributed` | rewards engine → user available      |
| `burn`               | `token.burn`              | rewards engine → burn account        |
| `mintEmission`       | `token.emission`          | mint boundary → destination          |

> **This PR adds one recipe to `packages/ledger-client`:** `sweepFeesToRewards`. Strictly §15.2 says a shared-package change should be its own PR first — flagging it rather than burying it. It exists because real yield must demonstrably come from fees the platform earned, and the trail from `houseFees(module)` to a user's balance should be two queryable ledger transactions rather than one opaque one.

### Why staking value lives in the ledger

"How much IFC is staked" is answerable two independent ways — by summing `token.stakes`, and by reading the ledger's `stake` accounts. They must agree. A test asserts exactly that. If the principal lived only in this service's table, there would be nothing to reconcile against and Doctrine §0.6 would be a comment rather than a property.

`stakes.amount` is the principal recorded at stake time and **never changes after insert**. Yield goes to `available`, not to the principal. A mutating amount column would be a second source of truth for money.

---

## Ordering decisions that matter

**Stake: claim `pending` → ledger post → `active`.** A pending row is not yield-eligible and is excluded from `stakeOf`, so a claim without funding cannot create an unfunded obligation. If the ledger **confirms** insufficient funds, the pending row is deleted. Ambiguous post failures (timeout after apply) leave the pending claim so the same `stakeId` can resume — deleting on every error was post-without-claim. If the process dies after the post and before activate, the ledger key is idempotent and a retry re-posts (no-op) and activates. Activate checks row count; a vanished claim never returns a fake `active`.

**Unstake: claim `unstaking` under row lock, then post, then close.** Two concurrent unstakes cannot both post — only one claim wins the `active → unstaking` transition. The ledger post is **not** held inside the same Postgres transaction as the lock (remote ledger must not hold a DB lock open). The ledger's idempotency key is still the backstop if the claim ever failed; it is not the ordinary path.

**Yield: one ledger transaction per recipient**, keyed on `(window, user)`. A crash halfway through is resumable — re-running pays only whoever was missed. One giant transaction would be atomic but unresumable, and with thousands of stakers that is the worse trade.

**Yield: claim `(window_id, total)` before the fee sweep, then plan who is paid.** That resumability sentence is only true while the recipient list stands still, and the list was recomputed from `stakes WHERE status = 'active'` on every call. Re-run a settled window after one new stake opened and the list grew: the users already paid had spent their `(window, user)` keys, so their posts were silent no-ops — and the newcomer's key was fresh, so the newcomer was paid in full out of a window whose revenue was already gone. So the plan is written once into `token.yield_payouts` and read thereafter (0003). A window pays the stakers it had, not the stakers it has; a re-run naming a different revenue total is refused (`token.yield_window_mismatch`) rather than guessed at. `distributeRevenue` now reports `alreadyPaid` alongside `recipients`, so a re-run reads as "already settled" instead of as a second payout.

**Yield: an empty pool is still a settled window (0004).** #1076 left zero-staker runs unclaimed so the first staker could re-use the same window id. That re-opened the late-joiner class. `token.yield_windows` claims `(window_id, total)` before the sweep even when nobody is staked; fees still move into the rewards engine. Re-running that id never invents recipients. A later window id with stakers needs its own sources (and fees still in houseFees).

---

## Database constraints as a backstop

The service checks these; the database enforces them regardless.

| Constraint                                | What it catches                                                                                                                                                               |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `emission_epochs_within_schedule_ck`      | one epoch minting more than its own scheduled amount. **Not the supply ceiling** — that is the emitted-total check in `mintEpoch`, because a per-row bound cannot see a total |
| `buyback_runs_split_conserved_ck`         | a rounding bug promising the rewards engine tokens that do not exist                                                                                                          |
| `buyback_runs_window_no_overlap_ex`       | two runs covering the same instant — identical, nested or partial. Claimed BEFORE the burn posts (0002)                                                                       |
| `stakes_lock_required_ck`                 | an m3/m12 stake with no `unlocks_at` — a lock multiplier on withdrawable-on-demand funds, i.e. free yield                                                                     |
| `stakes_amount_positive_ck`               | a negative stake dragging the pro-rata denominator down and overpaying everyone else                                                                                          |
| `governance_votes_one_per_user_idx`       | ballot stuffing                                                                                                                                                               |
| `token_params_singleton_ck`               | two rows = two economies, whichever a job reads first wins                                                                                                                    |
| `yield_windows` PK `window_id`            | two claims for one window id — freezes empty settlements so a late staker cannot re-plan the same id (0004)                                                                   |
| `yield_windows_total_positive_ck`         | a claimed window of nothing — free key for a later real total                                                                                                                 |
| `yield_payouts` PK `(window_id, user_id)` | two payouts to one staker for one window — the pair the reward key already assumed                                                                                            |
| `yield_payouts_paid_has_tx_ck`            | a payout marked paid with nothing in the book to point at, or a transaction nobody recorded finishing                                                                         |
| `yield_payouts_amount_positive_ck`        | a planned payout of nothing — an instruction the ledger would refuse and no run could ever clear                                                                              |

> **Fixed — this paragraph used to say it was not.** `recordBuyback` posted the burn to the ledger _before_ inserting the `buyback_runs` row, and that insert was `ON CONFLICT (id) DO NOTHING`, which dedupes only on the run id — so a second call over the same `revenueWindow` under a _different_ `runId` burned for real and only then tripped an index its conflict clause did not name: tokens irreversibly gone, no row, no event, an opaque 500. **#767 and migration `0002_buyback_window_claim.sql` closed it**: the window is now claimed `pending` before the burn posts and settled after, the same claim-before-post shape `stake` uses, and the unique index was replaced by the exclusion constraint above — which also refuses the nested and partial overlaps the old index never saw. The text above stayed stale for months of merges, which is its own lesson: a README that says a money path is unsafe, about a path that is now safe, invites somebody to fix it a second time.

---

## Kill-switch

`EMISSIONS_ENABLED=false` halts minting on every path (tRPC, internal cron endpoint, auto-tick); the epoch time gate (1 day by default) limits how fast a NEW epoch can open when it is on. This is the only thing between a mis-tuned curve and permanent supply inflation, and **inflation cannot be un-minted** — which is why it is a separate switch rather than a general service toggle. `EMISSIONS_AUTO_TICK` defaults off so a redeploy never silently opens the faucet.

---

## Running it

```bash
docker compose up -d
pnpm --filter @intafaced/svc-token db:migrate
pnpm --filter @intafaced/svc-token test
```

## Tests

~230 cases across pure economics, Postgres money paths, router mount, and internal S2S boundaries. The economics (emission curve, staking multipliers, buyback split, yield distribution) are pure functions tested exhaustively without a database — including property-style checks that a split always sums back exactly and that 1,000 uneven stakers lose no dust.

The money paths run against real Postgres with the ledger's in-memory reference implementation, which the conformance suite proves equivalent to svc-ledger's Postgres engine (§4.4).

Failure branches covered: staking more than you hold, unstaking while locked, unstaking twice, concurrent unstakes, crash mid stake/unstake resume, minting a closed epoch, minting past the schedule, empty yield freezes, fee pot underfund, buyback window claim, distributing a window, and re-running a distribution.

## Service keys: ledger calls

The ledger client signs with svc-token's own key when `S2S_AUTH_MODE`, `S2S_SIGNING_KID` and `S2S_SIGNING_KEY` are set (`dual` also sends the shared secret, `keypair` the key only); unset, it signs with the shared secret as before. Setup and rotation: `services/svc-ledger/CALLER-BINDING.md`.

## Service keys: inbound doors

The four internal doors (stake read, emission mint, yield window, buyback window) and `/trpc` name the caller from its own service key when `S2S_AUTH_MODE`, `S2S_KEYRING` and the signing pair are set: `dual` accepts the key and the shared secret, `keypair` the key only. Unset, the shared secret works exactly as before. A key-signed call that fails is refused and never retried against the shared secret. The job doors still run only for a call named svc-token. Setup and rotation: `services/svc-ledger/CALLER-BINDING.md`.
