# svc-ledger in Rust: the port notes

Each slice of svc-ledger's move to Rust starts here, in a fresh thread. `services/svc-ledger` stays the service that runs until the switch. This crate holds the shell every slice builds on:

- `src/env.rs`: the environment, held to `env.ts` by `tests/env_parity.rs`.
- `src/errors.rs`: the refusals and how each door answers them. The user copy lives in `src/errors_table.rs`.
- `src/door/`: every route `index.ts` serves, who may call each, and each door's first input check (`schemas.json`, run with `src/refines.rs`).

`scripts/record-door.mjs` writes the recorded files from the TypeScript. Its `--check` fails when one is stale.

The `store` slice is ported. It added:

- `src/db.rs`: the one pool, opened as `ledgerPostgresOptions` opens it (`search_path`, `application_name`, the statement, idle and connect timeouts), and the transaction helper. `DATABASE_SSL=true` refuses to start: the kit's pool has no TLS yet.
- `migrations/`: the 66 files of `services/svc-ledger/drizzle`, held byte for byte by `migrate.rs`'s tests.
- `src/migrate.rs`: `svc-ledger migrate [--down]`, the TypeScript runner's guards included.
- `src/status.rs`: `/health` and `/ready`, read from the database on every call. The door answers them through the kit's `Door::status`.
- `src/boot.rs` and `src/main.rs`: the chain-tip check, the custody boot check, the startup freeze, and the outbox recovery at boot and every five seconds.
- `tests/store_pg.rs`: `scripts/migrate.test.ts` case for case, and the boot and status doors, on a real Postgres.

The `freeze` slice is ported. It added:

- `src/freeze.rs`: the switch (`writeFreeze`), its attribution and four-eyes thaw rules, the `ledgerFreezeUpdated` intent written beside it, and the relay that publishes each intent once it committed. The startup freeze publishes through it, as `LedgerService.freeze` does.
- `src/approval.rs`: the identity approval each operator write spends, bound to its action, target and version; a thaw also needs identity's founder pair. The client is the kit's `service_kit::approvals`, shared with svc-academy.
- `src/clock.rs`: the clock integrity read against `LEDGER_CLOCK_SKEW_BOUND_MS`.
- `src/door/freeze.rs`: `GET` and `POST /operator/freeze`, `POST /operator/unfreeze` and `GET /operator/integrity/clock`. `freezeSchema` is recorded as zod runs it: its trim, then its pipe (`service_kit::schema` runs pipes).
- `tests/freeze_pg.rs`: the freeze cases of `service.freeze.test.ts`, the clock-skew Postgres case and the freeze doors of `operator-http.test.ts`, on a real Postgres.

The `history` slice is ported. It added:

- `src/history.rs`: `history` (one account's entries in `[from, to)`, refused past 10,000 rather than answered short), `historyPage` (keyset pages newest first on the entry id, the cursor `base64url("v2.<id>")`, and each line's allow-listed rail and product, the owner's own order, its fill fee and its withdrawal id) and `holdingsHistory` (the owner's holdings and what crossed its edge since `from`, per asset, reason and bucket, in one repeatable-read snapshot). Moments cross as milliseconds, the database's microseconds cut as `new Date` cuts them.
- `src/door/history.rs`: the three doors. `history` refuses `after` and `cursor` before its schema would strip them; `holdingsHistory` refuses a start ahead of the clock or off its bucket. Their inputs are recorded in `schemas.json` (the recorder now records `literal` and `default` parts).
- `tests/history_pg.rs`: `history-postgres.test.ts`, `history-page-postgres.test.ts`, `history-page-order-id-postgres.test.ts`, `holdings-history-postgres.test.ts` and `holdings-history-door.test.ts`, case for case, on a real Postgres. Each books the same recipes the TypeScript test posts, recorded in `tests/fixtures/history-book.golden.json`.

The `reconcile` slice is ported. It added:

- `src/chain.rs`: `hashTx`, the chain's digest, held to the TypeScript's by its tests. A row's asset hashes and cross-shard anchor are `posting`'s.
- `src/reconcile.rs`: the proof (`reconcileBalances`, `verifyChain`, `totalsByAsset`, `customerBalancesWhileCustodyOff`, `runReconciliation`) and the run (`runSnapshotReconciliation`): its own session, one REPEATABLE READ snapshot, the single-flight advisory lock, the staged `balance_snapshots` write, and the `ok`, `mismatch` and `incomplete` run rows. The checks issue their statements in the order the TypeScript's pipelined checks reach its one connection, so the same checks finish when one statement times out. `readLastVerified` and `countConsecutiveIncompleteRuns` read the run rows.
- `src/reconciler.rs`: `LedgerService.reconcile`, `handleReconciliationMismatch` (the freeze, then the `ledgerReconciliationFailed` page), `runScheduledReconciliation`, the `ledgerReconciliationRunFailed` alert, and the hourly tick with its streak, backoff and staleness report. `src/freeze.rs` gained `write_in`, the switch inside a transaction the caller holds, for the mismatch run row and its halt.
- `src/door/reconcile.rs`: `POST /operator/reconcile`. The binary runs the tick every `RECONCILE_CRON_MINUTES`; a blank cadence refuses the start.
- `tests/reconcile_pg.rs` and `tests/reconcile_tick.rs`: the TypeScript's reconcile cases, case for case, on a real Postgres (the book written there as a deposit is posted, since posting is not ported) and against a recording ledger. The shared operator test kit is `tests/support/operator.rs`.

Where the port cannot be the TypeScript's:

- A connection failure's code is the server's SQLSTATE, else the socket's errno name as Node gives it (`ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `EPIPE`, `EHOSTUNREACH`, `ENETUNREACH`), else `unknown`. A TLS failure cannot happen yet: the pool has no TLS.
- The custody switch is a type with two values, so the TypeScript's refusal of a missing or unknown one cannot be reached.

The `balances` slice is ported. It added:

- `src/balances.rs`: `balance`, `balances`, `portfolio`, `txByKey` and `txById`, answered by the door once their input parses. Each read runs `PostgresLedger`'s query: an untouched account reads as zero without a row being made, purpose is matched after its trim, and a booked transaction whose claim (`ledger_posted_keys`) no longer matches is refused with `ledger.posted_claim_mismatch`.
- `portfolio`'s chain half: `INDEXER_URL` (read from the process, as `handleS2sPortfolio` reads it; `env.ts` does not hold it) and the indexer's `positions` record, through the door's one `Fetch`. Anything it cannot verify is named absent.
- `tests/balances_pg.rs`: the TypeScript cases for these doors (`s2s-http.test.ts`, `s2s-tx-by-key.test.ts`, `s2s-tx-by-id.test.ts`, the claim check of `ledger/tx-hash-bind.test.ts`) through the door, on a real Postgres.

Left to later slices:

- The recovery has one relay. `posting` adds the `ledgerTxPosted` one; until then a committed post's intent waits unsent.
- The tick's due-controls run (`runDueReconciliationControls`) is `controls`'s.
- `/metrics` is in no slice yet. The switch needs it, since Prometheus scrapes it; the `ledger_reconcile_last_verified_*` gauges come with it.

## What the shell holds, and how it is proved

- **`tests/wire_replay.rs`** sends every request of `services/svc-ledger/src/wire-replay.golden/` to the door. That is 11,772 answers over 44 routes, three settings and every caller.
  - Each answer the door decides must match byte for byte: 404s, Fastify's body refusals, a service's signature and caller-list refusals, operator token and scope refusals, and the first input checks.
  - Any other answer must be one the door names as its slice's (`Outcome::Owed`).
  - A recorded 401, 403, 404 or Fastify refusal can never be owed.
  - `WIRE_REPLAY_SLICE=<name>` prints what a slice owes. `WIRE_REPLAY_STRICT=<name>` fails while it owes any.
- **`tests/input_parity.rs`**: 371 inputs over the 14 door schemas, against zod's own verdicts.
- **`tests/tokens.rs`**: 41 access tokens, against `verifyAccessToken`. The verifier is the kit's `service_kit::tokens`.
- **`tests/env_parity.rs`**: 36 environments, against `env.ts`.

The replay's store refuses every query, so `/health` and `/ready` answer its 500 there; `tests/store_pg.rs` proves their real answers. The replay never gets past the input check of `post`, the balance reads or `/operator/reconcile`: every recorded sample is refused there. For those slices the proof is the TypeScript database tests named below, run against the Rust code.

## The doors

Every service door is `POST /trpc/<door>`. It goes through `registerS2sHttp`'s `authenticate`:

- the caller's key, or the shared secret while the mode allows it;
- a proven key must be on the door's list in `door/callers.rs`, which comes from `door-callers.ts`;
- a refusal is answered by `httpError`, ported as `errors::http_error`.

Every operator door is `/operator/*` behind `registerOperatorHttp`'s `guarded`:

- a Bearer access token;
- then `admin:treasury` with a second factor, or the lookup authority (`admin:read` and a second factor), or the control list;
- past the door, `guarded`'s catch turns a thrown error into a 400 with code `ledger.operator_request_failed`, after its named codes.

The tables live in Postgres schema `ledger`, in 66 migration files under `services/svc-ledger/drizzle`. Events go out through the bus, from `service.ts`: `ledgerTxPosted` and `ledgerFreezeUpdated` (each relayed from its outbox), `ledgerReconciliationFailed` and `ledgerReconciliationRunFailed`.

| Door                                                                                                         | TypeScript                                                                                                                 | Reaches                                                                                                                                                                                                             | Tables                                                                                                                    | Callers                                     |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `GET /health`, `GET /ready`                                                                                  | `status-http.ts`                                                                                                           | `status`, `lastVerified`                                                                                                                                                                                            | `posting_freeze`, `reconcile_runs`                                                                                        | anyone                                      |
| `post`                                                                                                       | `s2s-http.ts` `postChecked`                                                                                                | `applyCallerBinding` (`caller-binding.ts`), `assertKnownRecipePost` (`recipe-gate.ts`), the four binding checks (`*-binding.ts`), then `LedgerService.post` and `PostgresLedger.post` (`ledger/postgres-ledger.ts`) | `accounts`, `ledger_tx`, `ledger_entries`, `ledger_posted_keys`, `chain_tip`, `ledger_tx_outbox`, `posting_freeze`        | every grant holder in `caller-allowlist.ts` |
| `postRecipe`                                                                                                 | `s2s-http.ts` `handleS2sPostRecipe`                                                                                        | `@intafaced/ledger-client/post-recipe`, `grantFor`, then `postChecked`                                                                                                                                              | as `post`                                                                                                                 | the record's callers (`svc-academy`)        |
| `balance`, `balances`, `portfolio`                                                                           | `s2s-http.ts`                                                                                                              | `LedgerService.balance` and `balances`; `portfolio` also calls the indexer (`INDEXER_URL`, `@intafaced/portfolio-view`)                                                                                             | `accounts`, `ledger_entries`                                                                                              | readers                                     |
| `txByKey`, `txById`                                                                                          | `s2s-http.ts`                                                                                                              | `getTxByKey`, `getTx`                                                                                                                                                                                               | `ledger_tx`, `ledger_entries`                                                                                             | readers, plus posters for `txByKey`         |
| `history`, `historyPage`, `holdingsHistory`                                                                  | `s2s-http.ts`, `ledger/history.ts`, `ledger/holdings-history.ts`                                                           | `history`, `historyPage`, `holdingsHistory`                                                                                                                                                                         | `ledger_entries`, `ledger_tx`, `accounts`, `chain_tip`                                                                    | readers; `holdingsHistory` svc-bank         |
| `assetsList`, `assetsGet`, `GET /operator/assets`, `POST /operator/assets/apply-edit`                        | `ledger/supported-assets.ts`                                                                                               | `listAssets`, `getAsset`, `listOperatorAssets`, `applyAssetEdit` (spends an identity approval)                                                                                                                      | `assets`, `asset_edits`                                                                                                   | readers; treasury                           |
| `feeRevenue`, `ownFunds`, `restoreWatermark`, `reconciliationEvaluations`, `transactionsExist`               | `ledger/fee-revenue.ts`, `own-funds.ts`, `postgres-ledger.ts`, `reconciliation-controls.ts`, `transactions-exist.ts`       | the reads of the same names                                                                                                                                                                                         | `accounts`, `ledger_entries`, `ledger_tx`, `chain_tip`, `reconciliation_control_runs`                                     | svc-ops                                     |
| `statementPnl`, `reportExport`, `custody`, `financeClose`, `resilience`                                      | `ledger/statement-pnl*.ts`, `report-export.ts`, `custody-adapters.ts`, `finance-close.ts`, `resilience-gate.ts`            | `statementPnl` reads the book; the other four are pure answers to their input                                                                                                                                       | `ledger_entries` (`statementPnl` only)                                                                                    | none yet                                    |
| `GET`/`POST /operator/freeze`, `POST /operator/unfreeze`, `GET /operator/integrity/clock`                    | `operator-http.ts`, `ledger/freeze.ts`, `ledger/clock-skew.ts`, `ledger/action-approval-consume.ts`                        | `freezeState`, `freeze`, `unfreeze` (each spends an identity approval), `clockSkew`                                                                                                                                 | `posting_freeze`, `ledger_freeze_outbox`                                                                                  | treasury                                    |
| `POST /operator/reconcile`, and the reconcile timer in `index.ts`                                            | `operator-http.ts`, `ledger/reconcile.ts`, `service.ts` `reconcile`                                                        | the three book checks; a failed one freezes posting and publishes                                                                                                                                                   | `ledger_entries`, `ledger_tx`, `ledger_posted_keys`, `chain_tip`, `balance_snapshots`, `reconcile_runs`, `posting_freeze` | treasury                                    |
| `/operator/reconciliation/controls`, `/runs`, `/update`, `/run`, and the due-controls tick                   | `ledger/reconciliation-controls.ts`, `reconciliation-sources.ts`, `reconciliation-schedule.ts`                             | define, list, update and run a control; outside sources from the rail URLs in `env.rs`                                                                                                                              | `reconciliation_controls`, `reconciliation_control_runs`, `reconciliation_control_audit`, `accounts`, `ledger_entries`    | treasury; listing also compliance           |
| `/operator/transactions`, `/:txId`, `/trace`, `/accounts`, `/stats`, `/accounts/:id/metadata[/set\|/delete]` | `ledger/operator-desk.ts`, `operator-tx-get.ts`, `operator-trace.ts`, `operator-lookup.ts`, `operator-account-metadata.ts` | each lookup writes its access row first; metadata set and delete are treasury writes (a delete spends an approval)                                                                                                  | `operator_access_log`, `ledger_tx`, `ledger_entries`, `accounts`, `account_metadata`, `account_metadata_changes`          | the lookup authority; treasury for writes   |

## What the calls share

- **One store.** Every slice reads through one Postgres pool, made once in the binary and passed in (`docs/agents/shape.md` rule 5). The `store` slice builds it, with the migrations and the service's start-up.
  - `index.ts` runs `applyStartupPolicy` (`LEDGER_POSTING_ENABLED=false` can freeze and never thaw) and `assertCustodyLayerBootable`.
  - It also runs the outbox recovery at boot and on a timer.
- **The posting freeze** (`posting_freeze`) is read by every write and by `/health` and `/ready`.
- **The custody switch** (`LEDGER_CUSTODY_LAYER`, off at launch) refuses every recipe that touches a customer account, with 412 `ledger.custody_layer_off`.
- **Amounts** are decimal strings on the wire and scaled integers inside: the kit's `service_kit::money`, never a float.
- **Idempotency keys** are business keys. A repeat of the same movement answers the first booking. A different movement under a taken key is detected, or refused with 409 `ledger.idempotency_conflict` (`LEDGER_IDEMPOTENCY_CONFLICT_MODE`; always refused in production posture).
- **Identity approvals** (`IDENTITY_URL`) are spent by the freeze, the thaw, reconcile, asset edits, metadata deletes and control lifecycle moves. Without `IDENTITY_URL` the consumer is the unwired one, which refuses.
- **The TypeScript database tests** a slice must pass against its Rust code are the `*.pg.test.ts` and `*-postgres.test.ts` files beside its TypeScript, and `src/db/*.test.ts` for the store.

## Slices

- `store`: the Postgres pool and transaction helper, the 66 migrations copied from `services/svc-ledger/drizzle` (a test keeps them byte for byte), `migrate [--down]`, the binary serving the door, `/health` and `/ready`, the start-up policy and custody boot check, and the outbox recovery's timer
- `posting` (after `store`): `post`, with the caller binding, the recipe gate, the four binding checks, idempotency, the freeze and custody checks, the chain hash, `ledger_tx_outbox` and its `ledgerTxPosted` relay
- `post-recipe` (after `posting`): `postRecipe`
- `balances` (after `store`): `balance`, `balances`, `portfolio`, `txByKey`, `txById`
- `history` (after `store`): `history`, `historyPage`, `holdingsHistory`
- `assets` (after `store`): `assetsList`, `assetsGet`, `GET /operator/assets`, `POST /operator/assets/apply-edit`
- `ops-reads` (after `store`): `feeRevenue`, `ownFunds`, `restoreWatermark`, `reconciliationEvaluations`, `transactionsExist`
- `reports` (after `store`): `statementPnl`, `reportExport`, `custody`, `financeClose`, `resilience`
- `freeze` (after `store`): `GET /operator/freeze`, `POST /operator/freeze`, `POST /operator/unfreeze`, `GET /operator/integrity/clock`, `ledger_freeze_outbox` and its `ledgerFreezeUpdated` relay
- `reconcile` (after `store`): `POST /operator/reconcile`, the reconcile timer, the mismatch freeze and its events
- `controls` (after `reconcile`): `GET`/`POST /operator/reconciliation/controls`, `POST /operator/reconciliation/controls/runs`, `/update`, `/run`, and the due-controls tick
- `desk` (after `store`): `GET /operator/transactions`, `GET /operator/transactions/:txId`, `GET /operator/trace`, `GET /operator/accounts`, `GET /operator/stats`, `GET /operator/accounts/:accountId/metadata`, `POST /operator/accounts/:accountId/metadata/set`, `POST /operator/accounts/:accountId/metadata/delete`
