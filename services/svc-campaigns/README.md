# svc-campaigns

Campaigns, task steps and their rewards, seasons, limited drops and the TGE claim. **Not** a money book: it holds no balance. A task reward is paid by svc-ledger's `rewardPay` recipe from the rewards engine, and the pot is funded by `sweepFeesToRewards` from earned trade fees (through `@intafaced/ledger-client`); this service keeps only the intent, its answer and the redemption log.

It serves the campaign catalogue and join (J-campaigns-01), task campaigns and the reward saga (CM-tasks-quests-01, CM-payouts-ledger-02, J-campaigns-02), reward holds and the My Rewards hub (CM-payouts-ledger-01 holds, CM-rewards-hub-01, J-campaigns-03 #1-#3, #7) and the drop room (J-campaigns-20 #4-#6). Locked rewards, bonuses and reclaim (J-campaigns-03 #4-#6) are not built: they need restricted-credit recipes in `packages/ledger-client`.

## API

| Procedure             | Scope                           | Input                                                     | Output                                                                       |
| --------------------- | ------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `health`              | public                          | none                                                      | `{ ok, service }`                                                            |
| `tasks.progress`      | `campaigns:read`                | `{ campaignId }`                                          | my steps, completion, claim deadline and my reward record with its log       |
| `tasks.claim`         | `campaigns:write`               | `{ campaignId }`                                          | `{ reward, created }`; a second claim returns the first                      |
| `rewards.mine`        | `campaigns:read`                | `{}`                                                      | my rewards in plain status, newest first, and totals by status and asset     |
| `ops.payouts.list`    | `campaigns:ops` + second factor | `{ campaignId? }`                                         | every reward record with its redemption log                                  |
| `ops.pot.list`        | `campaigns:ops` + second factor | none                                                      | every pot funding request                                                    |
| `ops.pot.request`     | `campaigns:ops` + second factor | `{ reference, sourceModule, asset, amount }`              | a requested funding (the same request again returns it)                      |
| `ops.pot.approve`     | `campaigns:ops` + second factor | `{ reference }`                                           | the funding, approved by a second person and posted                          |
| `drops.room`          | `campaigns:read`                | none                                                      | the season and my points, each published drop with my claim, the TGE panel   |
| `drops.claim`         | `campaigns:write`               | `{ dropId }`                                              | `{ claim, created, remaining }`; the account is the principal, never a field |
| `tge.claim`           | `campaigns:write`               | `{ network: 'testnet' \| 'mainnet' }`                     | always a named refusal; nothing is posted                                    |
| `ops.list`            | `campaigns:ops` + second factor | none                                                      | every season and drop, drafts included                                       |
| `ops.seasons.create`  | `campaigns:ops` + second factor | `{ name, startsAt, endsAt }`                              | a draft season                                                               |
| `ops.seasons.publish` | `campaigns:ops` + second factor | `{ id }`                                                  | the season, published by a second person                                     |
| `ops.drops.create`    | `campaigns:ops` + second factor | `{ title, seasonId?, count, opensAt, closesAt?, value? }` | a draft drop                                                                 |
| `ops.drops.publish`   | `campaigns:ops` + second factor | `{ id }`                                                  | the drop, published by a second person                                       |

The catalogue, join and `ops.campaigns.*` procedures are in `src/router.ts`. Contracts: `@intafaced/contracts/campaigns-catalogue` and `@intafaced/contracts/campaigns-drops`.

## Rules

- **Campaign time zone and archive (J-campaigns-16).** A definition may name the time zone its time frame is typed in. Absent, it is the platform zone (`CAMPAIGNS_PLATFORM_TIME_ZONE`), as for every caller before the builder; null leaves it blank, and a blank refuses activation `campaigns.timezone_unset` (the founder console's builder sends null until the founder picks it). In this version windows are read in the platform zone only, so any other zone refuses `campaigns.timezone_not_platform`. An active or scheduled campaign cannot be archived (`campaign.archive_active`): a scheduled one is already in the catalogue, so it is ended (allowed before its start) and then archived.
- **Seasons.** A blank start or end refuses `campaigns.window_unset`, a time with no offset `campaigns.timezone_unset`, an end before the start `campaigns.window_invalid`. The room shows the live season that started last, else the next to start. Season points are the caller's reward points from the season's task campaigns; no task campaign exists in this version, so a season shows `taskCampaigns: 0` and the sum over no records, `"0"`.
- **Limited drops.** A blank count refuses `drop.count_unset`; the count is a whole number from 1 to 1,000,000 (`drop.count_invalid`). A claim locks the drop row, writes one row under the business key `drop:<dropId>:<account>` and takes one from the count in the same transaction, so concurrent claims never exceed the count. A second claim by the same account returns the first (`created: false`), even once sold out. Sold out refuses `drop.sold_out`; before it opens or after it closes `drop.not_open`; a draft or missing drop `drop.unknown`.
- **Task steps.** Only a `task` campaign has steps (`campaigns.tasks_invalid`). A step counts settled fills (`trade.fill.settled`) on a listed market (`BTC/USDT`, named from svc-trade's market list by the fill's market id) or any market, on one side or either. Each fill counts once per step (the fill id is in the key), only for an account that joined before the fill, only while the campaign is live and inside its weekdays and hours. A blank claim window refuses activation `campaigns.claim_window_unset`. A streak step (`streakDays`, count 1) is done on that many consecutive calendar days in the platform time zone; a day with no matching event resets the run at the zone's midnight, and a run that reached the target stays done. A streak campaign has no weekday or hour windows and a time frame at least as long as the streak (`campaigns.tasks_invalid`); with the zone blank its progress refuses `campaigns.timezone_unset`. The claim window opens when the steps closed here, so a late fill never opens it in the past.
- **Holds.** A task campaign names its risk-review hold in seconds (`holdSeconds`; 0 pays at once). Blank refuses activation and a claim `campaigns.hold_period_unset`, never "no hold". A claim on a campaign with a hold writes the intent `held` with `hold_until`; it counts in the budget and nothing posts. Each reconciler pass releases every held intent whose hold ended, once, by a conditional update with its log line (`released`), and the saga posts it under its own key; under the posting freeze that post is `pending_retry` and posts once after the freeze lifts. An account that is not active when the hold ends is `withheld`; one identity cannot read stays held for the next pass. With the reconciler unset a held reward stays held.
- **My Rewards.** `rewards.mine` lists the caller's own intents with the campaign name and a plain status: `on_hold` (held, withheld), `still_open` (qualified, posting, pending_funding, pending_retry, unknown), `posted`, `closed` (failed, forfeited). Totals are summed from those rows on each read.
- **Claims.** Not joined `campaigns.not_joined`, steps open `campaigns.tasks_incomplete`, below the campaign's verification gate `campaigns.kyc_required`, after the window `campaigns.claim_expired` (the reward is stored as forfeited), no budget room `campaigns.budget_exhausted`. A reward for an account that is not active is withheld before any ledger call, and qualifies on a later claim once the account is active again, inside the window. A budget in another asset than the reward refuses activation `campaigns.budget_asset_mismatch`. One reward per account and campaign under the business key `task:<campaign>:<account>:once`.
- **Reward saga.** The intent is written first, marked posting by a conditional update, then posted with no transaction open, then the answer recorded. An empty pot (`ledger.insufficient_funds`) leaves it `pending_funding`, a platform freeze `pending_retry`, a lost answer `unknown`; the reconciler posts the same key and body again, so the ledger books it once. Only a named refusal of a first single attempt ends `failed`. The rollback window is shown; a rollback refuses `campaigns.reclaim_unavailable` (no reversing recipe exists).
- **Pot funding.** One operator requests a sweep of earned trade fees into the rewards engine under a reference; a different one approves (`campaigns.second_person_required`, also a CHECK). The sweep key is `token.fee.sweep:campaigns:<reference>:<module>:<asset>`. A refused sweep is final.
- **Value.** A claim records an entitlement and moves nothing. A drop with value pays through the reward saga (CM-payouts-ledger-02), which is not connected, so creating one refuses `campaigns.reward_saga_unwired`.
- **Two people.** One operator creates; a different one publishes (`campaigns.second_person_required`, and a CHECK constraint refuses it in the database too). A published row refuses a second publish (`campaigns.already_published`). Customers see published rows only.
- **Audit.** Every create, publish and claim writes a row to `campaigns.audit_log`.
- **TGE claim.** Mainnet refuses `audit.external` (the audit is external and not done). With a blank owner schedule, testnet refuses `launch.schedule_unset`; with a set one, `chain.go` (the on-chain claim is not deployed). The testnet path is labelled Testnet. Nothing here says audited.

## Owner settings

| Variable                            | Blank means                                                                      |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| `CAMPAIGNS_TGE_SCHEDULE_JSON`       | every TGE claim refuses `launch.schedule_unset`. Set: `{"claimOpensAt":"<ISO>"}` |
| `CAMPAIGNS_RECONCILE_AFTER_SECONDS` | no reconciler runs: an open reward or pot funding stays open                     |
| `CAMPAIGNS_ROLLBACK_WINDOW_SECONDS` | the reward record's rollback window reads "not set"                              |
| `DATABASE_POOL_MAX`                 | boot refuses; never a filled-in size                                             |

Wiring: `IDENTITY_URL` (participant read), `LEDGER_URL` with `INTERNAL_SERVICE_SECRET` (the saga; unset, every claim and approval refuses `campaigns.reward_saga_unwired`), `TRADE_URL` (market names; unset, a step on one market counts no fill), `NATS_URL` (the fill events).

## Events

Publishes none. Consumes `trade.fill.settled` (`fillSettled`) with the durable consumer `campaigns-task-fill-settled`; idempotent by fill id, and an unreachable market list leaves the event to be delivered again.

## Ledger

`rewardPay` (key `reward:task:<campaign>:<account>:once`, reason `campaigns.task.reward`) and `sweepFeesToRewards` (from `houseFees('trade', asset)`), through `@intafaced/ledger-client`, signed as svc-campaigns with a module token. svc-ledger must list svc-campaigns for both recipes in its caller allowlist. Reads only its own keys back.

## Database

Schema `campaigns` (from the database bootstrap): `campaigns`, `participations`, `eligibility_reviews`, `task_progress`, `task_completions`, `reward_intents`, `redemption_attempts`, `pot_fundings`, `seasons`, `drops`, `drop_claims`, `audit_log`, and the view `campaign_rows` (a campaign with the budget its open and paid rewards draw). Migrations in `drizzle/`, applied by `pnpm db:migrate`.
