# svc-quant — sandboxed strategy runtime (§29)

Runs user TypeScript/JavaScript and Python against an internal paper book. It
is **not** a second money book: fills never post to the ledger.

User code never sees Node, `fetch`, or raw sockets. Market data and orders go
through the runtime API only. If the isolate cannot boot, the procedure refuses
`quant.sandbox_unwired` rather than inventing PnL.

## API

| Procedure              | Access                                        | Input                                              | Output                                            |
| ---------------------- | --------------------------------------------- | -------------------------------------------------- | ------------------------------------------------- |
| `health`               | public                                        | —                                                  | `{ ok, service }` — liveness, not a custody claim |
| `studio.save`          | session or allow-listed service               | `{ name, blocks, risk, cash }` — risk is mandatory | caller's saved strategy (no return)               |
| `studio.list`          | session or allow-listed service               | `{ limit }` — omit is refused, never 50            | that account's strategies only                    |
| `studio.get`           | session or allow-listed service               | `{ id }`                                           | that account's strategy, or not found             |
| `studio.update`        | session or allow-listed service               | `{ id, name, blocks, risk, cash }`                 | replaced strategy, or not found                   |
| `studio.delete`        | session or allow-listed service               | `{ id }`                                           | `{ ok: true }`, or not found                      |
| `studio.clone`         | session or allow-listed service               | `{ id, name? }`                                    | new id on the same account, or not found          |
| `studio.run`           | session or allow-listed service               | `{ id }`                                           | sandbox result of that account's source           |
| `studio.operatorList`  | admin scope                                   | `{ limit }`                                        | metadata only (no source, no blocks)              |
| `backtest.run`         | `publicJurisdictionProcedure('quant','fiat')` | walk-forward + OOS + cost model                    | fill metrics (no invented return)                 |
| `sandbox.capabilities` | `publicJurisdictionProcedure('quant','fiat')` | —                                                  | sandbox isolate + Venue Vault (not the lake)      |
| `sandbox.run`          | `publicJurisdictionProcedure('quant','fiat')` | `{ language, source, cash }`                       | fills, cash, pnl (strings)                        |

## Per-account library (customer contract)

Jurisdiction stays `quant` / `fiat`. The account is never taken from the body
when a session is present.

- Signed-in caller: account id is `principal.sub_account` if the session is a
  sub-account, otherwise `principal.userId`. Do not send `accountId`. If the
  body includes one, it is ignored.
- `studio.save` body stays `{ name, blocks, risk, cash, environment, presentedAs }`.
  `risk` is still mandatory. `studio.list` still requires an explicit `limit`
  from 1 to 50. The response shape is unchanged: `{ strategies }` of the
  caller's rows only, each with `id`, `name`, `language`, `source`, `cash`,
  `blocks`, `risk`, and the simulated stamp.
- Another account's id on get, update, delete, clone, and run is
  `NOT_FOUND` / `quant.studio_not_found`. The message matches a missing id.
- A service with no principal must be in `STUDIO_SERVICE_ALLOWLIST` (empty
  today) and must send `accountId` (uuid). Otherwise `FORBIDDEN`
  `quant.studio_service_denied` or `BAD_REQUEST` `quant.studio_account_required`.
- `studio.operatorList` needs an admin scope (`admin:read`, `admin:write`,
  `admin:treasury`, or `admin:compliance`). Rows are `{ id, accountId, name,
language, environment, kind, claimLabel, live, simulated }` plus
  `quarantineCount`. No `source`, no `blocks`.
- Storage is the process memory, keyed by account. A restart clears it.
  Durable storage is QUANTDEPTH. Owner-unknown rows are quarantined and are
  not returned to any user. Boot quarantine count is 0 (nothing is loaded).

The customer app can turn "save to library" back on for a signed-in session
without adding `accountId` to `studio.save` or `studio.list`. The copy that
says the library is shared across users is no longer true. The copy that says
a restart erases the library is still true.

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
