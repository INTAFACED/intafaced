# svc-campaigns

Seasons, limited drops and the TGE claim for the drop room. **Not** a money book: it holds no balance and imports no ledger recipe.

This first version serves RC-campaigns-04 and RC-campaigns-05 (J-campaigns-20 #4-#6). The campaign object, task campaigns, eligibility rules and the reward saga (CM-campaign-types-01, CM-tasks-quests-01, CM-eligibility-rules-03, CM-payouts-ledger-02) are later slices of this service.

## API

| Procedure             | Scope                           | Input                                                     | Output                                                                       |
| --------------------- | ------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `health`              | public                          | none                                                      | `{ ok, service }`                                                            |
| `drops.room`          | `campaigns:read`                | none                                                      | the season and my points, each published drop with my claim, the TGE panel   |
| `drops.claim`         | `campaigns:write`               | `{ dropId }`                                              | `{ claim, created, remaining }`; the account is the principal, never a field |
| `tge.claim`           | `campaigns:write`               | `{ network: 'testnet' \| 'mainnet' }`                     | always a named refusal; nothing is posted                                    |
| `ops.list`            | `campaigns:ops` + second factor | none                                                      | every season and drop, drafts included                                       |
| `ops.seasons.create`  | `campaigns:ops` + second factor | `{ name, startsAt, endsAt }`                              | a draft season                                                               |
| `ops.seasons.publish` | `campaigns:ops` + second factor | `{ id }`                                                  | the season, published by a second person                                     |
| `ops.drops.create`    | `campaigns:ops` + second factor | `{ title, seasonId?, count, opensAt, closesAt?, value? }` | a draft drop                                                                 |
| `ops.drops.publish`   | `campaigns:ops` + second factor | `{ id }`                                                  | the drop, published by a second person                                       |

Contracts: `@intafaced/contracts/campaigns-drops`.

## Rules

- **Seasons.** A blank start or end refuses `campaigns.window_unset`, a time with no offset `campaigns.timezone_unset`, an end before the start `campaigns.window_invalid`. The room shows the live season that started last, else the next to start. Season points are the caller's reward points from the season's task campaigns; no task campaign exists in this version, so a season shows `taskCampaigns: 0` and the sum over no records, `"0"`.
- **Limited drops.** A blank count refuses `drop.count_unset`; the count is a whole number from 1 to 1,000,000 (`drop.count_invalid`). A claim locks the drop row, writes one row under the business key `drop:<dropId>:<account>` and takes one from the count in the same transaction, so concurrent claims never exceed the count. A second claim by the same account returns the first (`created: false`), even once sold out. Sold out refuses `drop.sold_out`; before it opens or after it closes `drop.not_open`; a draft or missing drop `drop.unknown`.
- **Value.** A claim records an entitlement and moves nothing. A drop with value pays through the reward saga (CM-payouts-ledger-02), which is not connected, so creating one refuses `campaigns.reward_saga_unwired`.
- **Two people.** One operator creates; a different one publishes (`campaigns.second_person_required`, and a CHECK constraint refuses it in the database too). A published row refuses a second publish (`campaigns.already_published`). Customers see published rows only.
- **Audit.** Every create, publish and claim writes a row to `campaigns.audit_log`.
- **TGE claim.** Mainnet refuses `audit.external` (the audit is external and not done). With a blank owner schedule, testnet refuses `launch.schedule_unset`; with a set one, `chain.go` (the on-chain claim is not deployed). The testnet path is labelled Testnet. Nothing here says audited.

## Owner settings

| Variable                      | Blank means                                                                      |
| ----------------------------- | -------------------------------------------------------------------------------- |
| `CAMPAIGNS_TGE_SCHEDULE_JSON` | every TGE claim refuses `launch.schedule_unset`. Set: `{"claimOpensAt":"<ISO>"}` |
| `DATABASE_POOL_MAX`           | boot refuses; never a filled-in size                                             |

## Events

None. This service publishes no subjects.

## Ledger

None. No reads, no recipes, no `post`.

## Database

Schema `campaigns` (from the database bootstrap): `seasons`, `drops`, `drop_claims`, `audit_log`. Migrations in `drizzle/`, applied by `pnpm db:migrate`.
