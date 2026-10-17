# svc-quant — sandboxed strategy runtime (§29)

Runs user TypeScript/JavaScript and Python against an internal paper book. It
is **not** a second money book: fills never post to the ledger.

User code never sees Node, `fetch`, or raw sockets. Market data and orders go
through the runtime API only. If the isolate cannot boot, the procedure refuses
`quant.sandbox_unwired` rather than inventing PnL.

## API

| Procedure              | Access                                        | Input                                                            | Output                                                          |
| ---------------------- | --------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------- |
| `health`               | public                                        | —                                                                | `{ ok, service }` — liveness, not a custody claim               |
| `studio.save`          | session or allow-listed service               | `{ name, blocks, risk, cash, clientStrategyId, idempotencyKey }` | head plus version history                                       |
| `studio.list`          | session or allow-listed service               | `{ limit, cursor? }` — omit limit is refused                     | that account's live heads, `nextCursor`                         |
| `studio.get`           | session or allow-listed service               | `{ id }`                                                         | head plus every version, or not found                           |
| `studio.update`        | session or allow-listed service               | `{ id, name, blocks, risk, cash, idempotencyKey }`               | new version; older versions stay                                |
| `studio.delete`        | session or allow-listed service               | `{ id, idempotencyKey }`                                         | soft delete (`deletedAt`); versions kept                        |
| `studio.clone`         | session or allow-listed service               | `{ strategyId, clientStrategyId, idempotencyKey }`               | version 1, name suffixed ` copy`                                |
| `studio.run`           | session or allow-listed service               | `{ id, idempotencyKey }`                                         | sandbox result of that account's source; one run row            |
| `studio.operatorList`  | admin scope                                   | `{ limit }`                                                      | metadata only (no source, no blocks)                            |
| `backtest.run`         | session or allow-listed service               | strategy id, `idempotencyKey`, windows, cost model               | fill metrics plus `strategyVersion`; one run row                |
| `backtest.get`         | session or allow-listed service               | `{ runId }`                                                      | owner equity curve, trades, costs; other accounts are not found |
| `sandbox.capabilities` | `publicJurisdictionProcedure('quant','fiat')` | —                                                                | sandbox isolate + Venue Vault (not the lake)                    |
| `sandbox.run`          | `publicJurisdictionProcedure('quant','fiat')` | `{ language, source, cash, idempotencyKey }`                     | fills, cash, pnl (strings); one run row                         |
| `marketplace.claim`    | session                                       | `{ runId, idempotencyKey }` — a client `pnl` is rejected         | stored simulated pnl and stamp; no listing                      |
| `ops.runs`             | `admin:read`                                  | `{ limit, from?, to?, kind?, userId?, cursor? }`                 | kind, user, started, duration, outcome; no result               |
| `ops.runCounts`        | `admin:read`                                  | `{ from, to }`                                                   | counts by kind and outcome, `asOf`                              |

## Per-account library (customer contract)

Jurisdiction stays `quant` / `fiat`. The account is never taken from the body
when a session is present.

- Signed-in caller: account id is `principal.sub_account` if the session is a
  sub-account, otherwise `principal.userId`. Do not send `accountId`. If the
  body includes one, it is ignored.
- `studio.save` also requires `clientStrategyId` and `idempotencyKey`.
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
