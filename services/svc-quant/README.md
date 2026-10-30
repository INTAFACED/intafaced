# svc-quant — sandboxed strategy runtime (§29)

Runs user TypeScript/JavaScript and Python against an internal paper book. It
is **not** a second money book: fills never post to the ledger.

User code never sees Node, `fetch`, or raw sockets. Market data and orders go
through the runtime API only. If the isolate cannot boot, the procedure refuses
`quant.sandbox_unwired` rather than inventing PnL.

## API

| Procedure                | Access                                                    | Input                                                                                     | Output                                                                                           |
| ------------------------ | --------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `health`                 | public                                                    | —                                                                                         | `{ ok, service }` — liveness, not a custody claim                                                |
| `studio.save`            | session or allow-listed service                           | `{ name, blocks or modules, risk, cash, clientStrategyId, idempotencyKey, releaseNote? }` | head plus version history                                                                        |
| `studio.list`            | session or allow-listed service                           | `{ limit, cursor? }` — omit limit is refused                                              | that account's live heads, `nextCursor`                                                          |
| `studio.get`             | session or allow-listed service                           | `{ id }`                                                                                  | head plus every version, or not found                                                            |
| `studio.update`          | session or allow-listed service                           | `{ id, name, blocks or modules, risk, cash, idempotencyKey, releaseNote? }`               | new version; older versions stay                                                                 |
| `studio.compile`         | session or allow-listed service                           | `{ modules }`                                                                             | generated source and declared inputs; a blank input refuses by name                              |
| `template.list`          | session or allow-listed service                           | `{ limit, cursor? }`                                                                      | newest version of each starter template; a blank limit refuses `quant.template_list_limit_unset` |
| `template.get`           | session or allow-listed service                           | `{ id }`                                                                                  | every version, newest first; unknown is `quant.template_not_found`                               |
| `ops.template.publish`   | `admin:write` (module quant)                              | `{ id, name, description, rules, releaseNote, reason, idempotencyKey }`                   | next version; a set number refuses `quant.template_number_set`                                   |
| `studio.delete`          | session or allow-listed service                           | `{ id, idempotencyKey }`                                                                  | soft delete (`deletedAt`); versions kept                                                         |
| `studio.organise`        | session or allow-listed service                           | `{ id, name, folder, description, idempotencyKey }`                                       | sets the head (folder one level, blank is the root); adds no version (AL-editor-01)              |
| `studio.restore`         | session or allow-listed service                           | `{ id, idempotencyKey }`                                                                  | brings a deleted strategy back with its versions; not deleted returns the head                   |
| `studio.listDeleted`     | session or allow-listed service                           | `{ limit, cursor? }` — omit limit is refused                                              | the recycle bin: that account's deleted heads, `nextCursor`                                      |
| `studio.diff`            | session or allow-listed service                           | `{ id, from, to }`                                                                        | line diff of source, blocks and rules between two versions; `quant.version_not_found`            |
| `studio.clone`           | session or allow-listed service                           | `{ strategyId, clientStrategyId, idempotencyKey }`                                        | version 1, name suffixed ` copy`                                                                 |
| `studio.run`             | session or allow-listed service                           | `{ id, idempotencyKey }`                                                                  | sandbox result of that account's source; one run row                                             |
| `studio.operatorList`    | admin scope                                               | `{ limit }`                                                                               | metadata only (no source, no blocks)                                                             |
| `quickStart`             | session or allow-listed service                           | —                                                                                         | `{ strategy, backtest, paperRun }` from the account's own rows                                   |
| `backtest.run`           | session or allow-listed service                           | strategy id, `idempotencyKey`, windows, cost model                                        | fill metrics plus `strategyVersion`; one run row                                                 |
| `backtest.get`           | session or allow-listed service                           | `{ runId }`                                                                               | owner equity curve, trades, costs; other accounts are not found                                  |
| `sandbox.capabilities`   | `publicJurisdictionProcedure('quant','fiat')`             | —                                                                                         | sandbox isolate + Venue Vault (not the lake)                                                     |
| `sandbox.run`            | `publicJurisdictionProcedure('quant','fiat')`             | `{ language, source, cash, idempotencyKey }`                                              | fills, cash, pnl (strings); one run row                                                          |
| `marketplace.claim`      | session                                                   | `{ runId, idempotencyKey }` — a client `pnl` is rejected                                  | stored simulated pnl and stamp; no listing                                                       |
| `ops.runs`               | `admin:read`                                              | `{ limit, from?, to?, kind?, userId?, cursor? }`                                          | kind, user, started, duration, outcome; no result                                                |
| `disclosure.current`     | session or allow-listed service                           | —                                                                                         | the published risk disclosure (`published: false` when none)                                     |
| `disclosure.status`      | session or allow-listed service                           | `{ strategyId, strategyVersion }`                                                         | disclosure, and whether this account accepted it for that version                                |
| `disclosure.accept`      | session or allow-listed service                           | `{ strategyId, strategyVersion, disclosureVersion }`                                      | one stored acceptance under `quant.disclose:<id>:v<n>:<d>`                                       |
| `ops.disclosure.publish` | `admin:write`                                             | `{ text, reason, idempotencyKey }`                                                        | the next version; the wording is owner content                                                   |
| `ops.disclosure.counts`  | `admin:read`                                              | —                                                                                         | versions and acceptance counts, no accounts or wording                                           |
| `ops.runCounts`          | `admin:read`                                              | `{ from, to }`                                                                            | counts by kind and outcome, `asOf`                                                               |
| `backtest.report`        | session                                                   | `{ runId }`                                                                               | print document: parameters, statistics, charts, coverage, warnings, labels                       |
| `result.share.get`       | session                                                   | `{ runId }`                                                                               | link count and whether one is active; no token                                                   |
| `result.share.create`    | session                                                   | `{ runId, seq }`                                                                          | one active link; the token is returned only by the call that stores it                           |
| `result.share.revoke`    | session                                                   | `{ runId }`                                                                               | the active link stops opening; the key is kept                                                   |
| `result.share.embed`     | session                                                   | `{ runId, token }`                                                                        | iframe snippet, or `quant.embed_origins_unset` when the origin list is blank                     |
| `result.share.public`    | `publicJurisdictionProcedure('quant','fiat')`, no session | `{ token }`                                                                               | the result with its simulation label; revoked and unknown are both not found                     |

## Per-account library (customer contract)

Jurisdiction stays `quant` / `fiat`. The account is never taken from the body
when a session is present.

- Signed-in caller: account id is `principal.sub_account` if the session is a
  sub-account, otherwise `principal.userId`. Do not send `accountId`. If the
  body includes one, it is ignored.
- `studio.save` also requires `clientStrategyId` and `idempotencyKey`.
- A strategy trades by order `blocks` or by signal rules (`modules`, the no-code builder: symbol, bar size, a
  moving-average cross, a sizing rule and optional exits), never both. A blank required input refuses
  `quant.param_unset` or `quant.sizing_rule_unset` naming it; a value outside its range refuses
  `quant.param_out_of_range`. The stored source is generated from the rules; nothing evaluates it.
  A blank key is `quant.client_strategy_id_unset` or `quant.idempotency_key_unset`.
  Replaying the same idempotency key returns the first result. Replaying the
  same client id returns the same strategy and does not add a version.
  `studio.update`, `studio.delete`, `studio.clone`, and `backtest.run` each
  require `idempotencyKey`. Clone also requires a new `clientStrategyId`.
- `studio.list` still requires an explicit `limit` from 1 to 50, and takes an
  optional `cursor`. The response is `{ strategies, nextCursor }`. Deleted
  strategies are absent. `studio.get` returns the head and `versions`.
- Another account's id on get, update, delete, clone, run, and backtest is
  `NOT_FOUND` / `quant.studio_not_found`. The message matches a missing id.
- A service with no principal must be in `STUDIO_SERVICE_ALLOWLIST` (empty
  today) and must send `accountId` (uuid). Otherwise `FORBIDDEN`
  `quant.studio_service_denied` or `BAD_REQUEST` `quant.studio_account_required`.
- `studio.operatorList` needs an admin scope (`admin:read`, `admin:write`,
  `admin:treasury`, or `admin:compliance`). A session without one is refused.
  Rows are metadata only: no `source`, no `blocks`. `quarantineCount` is 0
  on the database path.
- `backtest.run` loads the caller's strategy. Omit `strategyVersion` to run
  the head. A missing, foreign, or deleted strategy is `NOT_FOUND` /
  `quant.studio_not_found`, the same message as a missing id, and that
  refusal is still one run row. The result includes `strategyVersion`.
  `backtest.get({ runId })` returns the stored equity curve, trades, and
  cost evidence to the owner. Another account's run is `quant.run_not_found`.
  An absent cost model is `costs: null`, not zero. The result body is capped
  at 262144 bytes.
- `sandbox.run` and `studio.run` require `idempotencyKey`. A blank key is
  `quant.idempotency_key_unset`. Replay returns the first result.
- `marketplace.claim({ runId, idempotencyKey })` reads pnl from that run.
  A client `pnl` is rejected by the schema. The run must be the caller's,
  finished, and simulated. A repeat returns the first claim. No listing is
  created.
- `ops.runs` and `ops.runCounts` need `admin:read`. A session without it is
  refused. Omit `limit` and `ops.runs` answers `quant.ops_runs_limit_unset`.
  Omit `from` or `to` and `ops.runCounts` names that key. Neither returns
  an equity curve or a trade.
- `studio.clone({ strategyId, clientStrategyId, idempotencyKey })` copies
  the caller's head as version 1 with the name suffixed ` copy`. The same
  client id returns that clone. A deleted or foreign strategy is not found.
  `id` is still accepted as the strategy id.
- Storage is Postgres (`quant.strategies`, `quant.strategy_versions`,
  `quant.write_receipts`, `quant.backtest_runs`, `quant.runs`,
  `quant.claims`) when `DATABASE_URL` and `DATABASE_POOL_MAX` are both set. Neither has a default. If `DATABASE_URL`
  is unset the procedures refuse `quant.database_url_unset`. If the pool max
  is unset they refuse `quant.database_pool_max_unset`. Apply
  `drizzle/0000_quant_strategies.sql` with `pnpm db:migrate` before serving.
  There is no process-memory library on this path. The in-memory repository
  exists for tests. Owner-unknown rows are still quarantined only in the old
  unit-test map; the database refuses a blank account before insert.

The customer app can save, list, get, update, and delete for a signed-in
session without sending `accountId`. It must send `clientStrategyId` on
create and `idempotencyKey` on every write. A restart keeps the library.
Another account's id is not found. `backtest.run` is no longer anonymous:
it needs the same session and a strategy that account still has.

HTTP: `GET /health` (process liveness) · `GET /ready` — process `ready: true`; isolate is **not** sold as `wired` when the lake is `missingLake()` (`lake: missing`, `refuse: quant.backtest_lake_missing`). Sandbox capabilities still name the VM separately.

## Events

**None.** This service publishes and consumes nothing.

## Ledger

This service holds no balances and posts no ledger transactions. The internal
book is paper: starting cash is a caller-supplied decimal string, marks are
fixture prices, PnL is computed from fills in that run.

## Kill-switch

`module.quant` at the edge (`/api/quant`). Flag `quant.sandbox` is rollout plan
only; the live halt is the edge kill.

## Residual

Venue Vault is trade-only when `QUANT_VENUE_VAULT` is set. Unset →
`quant.venue_vault_unset` on venue OMS calls. Internal book still runs. The
boot lake is `missingLake()` until a real fills port is injected.

## Risk disclosure (AL-risk-02)

The owner and the lawyers supply the wording; this service never writes any. An operator publishes it with
`ops.disclosure.publish` (`admin:write`, a reason and a business key); each publish is the next version and is the audit
row. Until one is published, `disclosure.current` answers `published: false` and `disclosure.accept` refuses
`quant.disclosure_unset`. An acceptance is for one strategy version and one disclosure version, written once under
`quant.disclose:<strategyId>:v<version>:<disclosureVersion>` for the signed-in account; a new strategy version or a new
disclosure version needs a new one, and an older disclosure version refuses `quant.disclosure_version_stale`. Another
account's strategy, a version that does not exist and a deleted strategy all read as `quant.studio_not_found`. The deploy
and publish doors of later slices read the acceptance; nothing here starts a live run. Rows are append-only; the counts
view carries no account, strategy or text.

## Shared results (AL-report-03)

`studio.save` and `studio.update` keep an optional release note with the version they write. `QUANT_RELEASE_NOTE_MAX`
is the owner's length cap for it (1 to 2000). Blank, a save with a note refuses `quant.release_note_limit_unset`; a save
without one still works. A note over the cap refuses `quant.params_invalid` naming `releaseNote`. A replayed save answers
with the note its first press stored. `backtest.history` takes an optional `strategyId` and then lists only that
strategy's runs, each with the version it ran.

`backtest.report` builds the print document from the stored run on each read. It does not write a row.

`result.share.create` stores one active link per run under `result.share:<runId>:<seq>`, where `seq` is the link count
`result.share.get` returned. The token is a secret, hashed at rest, and is returned only by the call that inserts the
row. A repeat of that key, including a reply that was lost, returns the same link without the token. To replace a lost
token, revoke and create with the next count. Nothing is left half-written: the insert is one transaction, and a crash
after it is cleared by that revoke and the next seq.

`QUANT_SHARE_RATE` and `QUANT_SHARE_WINDOW_SEC` are the owner's cap on public reads of an active link, counted on that
link's own bucket. Blank refuses `quant.share_rate_unset` or `quant.share_window_unset`; neither is filled in. Zero rate
refuses a read of an active link. A revoked token and an unknown token both answer `quant.share_not_found` and are not
counted, including when the rate is zero and when other misses have already filled a bucket. `QUANT_EMBED_ORIGINS` is the
frame list. Blank refuses only `result.share.embed` (`quant.embed_origins_unset`); the link still opens. The public read
returns the result, the historical-simulation label, the checks and the coverage. It does not return an account, the
strategy source or the run key.
