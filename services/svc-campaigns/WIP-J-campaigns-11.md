# WIP: J-campaigns-11 design (delete before merge)

Builder handover notes for J-campaigns-11 "Enter a trading competition" (slice CM-promotions-events-01, spec
project-state `operation-zero/modules/campaigns/specs/campaigns-promotions-events.md`). Nothing is built yet.

## Where it goes

The slice's lane says svc-academy, but the competition is a campaign: it belongs in **svc-campaigns** (task campaigns,
the fill consumer `campaigns-task-fill-settled`, the reward saga and My Rewards are all there). The academy paper ladder
(`services/svc-academy/src/tournaments`) stays a simulated score and is not touched. No open PR touched svc-campaigns
or the campaign rooms on 6 Nov.

## Facts checked

- `competition` is already in `CAMPAIGN_TYPES` (packages/contracts/src/campaigns-catalogue.ts) with no behaviour.
- The stack charges taker 10 bps (tooling/scripts/local-stack-services/trade.mjs `TRADE_FEE_SCHEDULE`), so real
  market-order fills carry a positive `feeAmount`; `fillSettled` carries `quoteAmount`, `feeAmount`, `feeAsset`.
- Reconciler interval on the stack is 5 s (tooling/profiles/test-owner-values/campaigns.json).
- My Rewards is `/uc/promotion` (`rewards-hub`, `reward-row` with `data-reward-key`, `data-status`).

## Contract (packages/contracts/src/campaigns-catalogue.ts)

`competition` on the definition and on `campaignSchema`:
`{ basis: 'volume'|'returns', market: 'BTC/USDT', threshold: decimal|null, seats: int|null,
prizes: [{rank, amount}]|null, milestones: [{title, volume, amount}], holdSeconds: int|null }`.
New codes: `campaigns.seats_full`, `campaigns.seats_unset`, `campaigns.threshold_unset`, `campaigns.prize_table_unset`,
`campaigns.prize_pool_short`, `campaigns.period_open`, `campaigns.not_competition`. Basis `returns` refuses
`owner.decision` at save.

## Service (services/svc-campaigns)

- Migration: `competition jsonb` on `campaigns.campaigns`; `competition_seats (campaign_id, seat) PK, unique
(campaign_id, account_id)`; `competition_volume (campaign_id, account_id, fill_id) PK, quote_amount, occurred_at`;
  `competition_settlements (campaign_id PK, settled_by, settled_at, pool, paid, remainder)`.
- campaigns.ts: thread `competition` through Definition, create/update/moveChange SQL, inputOf, rowWith, inputOfRow,
  toCampaign, sameDefinition. Gate: threshold, seats, prizes, hold blank refuse; reward not required for competition;
  `sum(prizes) + seats * sum(milestones) <= budget` else `campaigns.prize_pool_short`.
- join(): for a competition lock the campaign `FOR UPDATE`, count seats, refuse `campaigns.seats_full`, insert seat n+1.
- New `competitions.ts`: `onFill` counts a fill once per (campaign, account, fill id) only when the account joined
  before it, the campaign is live, the market matches and `feeAmount > 0` (zero and negative fees add nothing); then
  milestones crossed write one intent each, key `rewardKeyOf(c, a, 'competition:p1:milestone:<i>')`, state `held`
  until the period closes. `board()` for customers: terms, seats left, my volume and rank, leaderboard (rank, masked
  name, volume) ordered volume desc, reached-at asc, account asc. `settle()` (reconciler pass + `ops.competitions.settle`):
  only once ended; one row in `competition_settlements`; one intent per prize under `competition:p1:rank`; withheld for
  a non-active account; held milestones released at close; the saga posts each key once. Pool = prizes + remainder.
- index.ts: call `competitions.onFill` from the fill consumer and `settleDue()` in the reconciler.
- router.ts: `competition.board` (campaigns:read), `ops.competitions.settle` (campaigns:ops + second factor).

## Customer room (apps/customer/src/features/more)

`campaign-competition.tsx` + copy (en, es, fr) under the campaign detail: rules, threshold, prize table, seats left,
basis "trading volume" and returns shown refused `owner.decision`; leaderboard; milestones reached/queued; settlement
with pool, prizes and remainder. Add `campaigns.seats_full` to `JOIN_CODES` and the money refusal copy.

## Journey test (write first): apps/customer/tests/real-app/J-campaigns-11.pw.mjs

Model on J-campaigns-02 (liveCampaign, fundPot, verifyAs Basic, trade, redeliverFill, fillConsumerCaughtUp).
#1 three accounts; TEST competition seats 2, threshold 0.5 trade, milestone 2.5 trades, prizes 0.02/0.01, milestone
0.005, pool 0.05; page shows rules, threshold, prize table, seats left 2, basis volume. #2 filler joins; me and rival
click Join at once in two browser contexts: one joined, the other `campaigns.seats_full`. #3 filler trades twice, winner
once; redeliver a fill: volume unchanged; order stable across reloads and equals the API. #4 winner trades twice more:
milestone reached, one held intent; a further trade queues nothing new. #5 founders end it, settle twice (second
`created: false`), fund pot, prizes post once each; winners see them in My Rewards; prizes + remainder = pool.
