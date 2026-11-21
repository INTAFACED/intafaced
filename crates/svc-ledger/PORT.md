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

The `assets` slice is ported. It added:

- `src/assets.rs`: the registry's reads (`listAssets`, `getAsset`, `listOperatorAssets`) and `applyAssetEdit`: the edit's payload hash (`assetEditPayloadHash`), the founder pair it spends, applied once per operation id, stale against the revision it was approved at. Every input and every row read out runs through the schemas recorded from `packages/contracts/src/asset-registry.ts`, the body's own check as the `asset_body` refine in `src/refines.rs`.
- `src/door/assets.rs`: `assetsList`, `assetsGet`, `GET /operator/assets` and `POST /operator/assets/apply-edit`, past the door's caller and scope checks.
- The kit's `Replay` may leave out the consuming operator: the asset edit sends its replay key (`requestId`) alone, as `applyAssetEdit` does; the desk's writes send both.
- `tests/assets_pg.rs`: `supported-assets.pg.test.ts` case for case, and the doors of `asset-registry-doors.test.ts`, on a real Postgres.

The `reports` slice is ported. It added:

- `src/reports.rs`: `statementPnl`, `reportExport`, `custody`, `financeClose` and `resilience`, each answering as its TypeScript handler does. None of them posts. `statementPnl` reads the owner's balances when no lots are sent, and still refuses, because posted cash is not lots, marks or NAV. A failed read fails the call. A statement sum or product that does not fit `i128` (past about 1.7e20 units) is refused as the ledger's own fault. The TypeScript's bigint answers it, but the port never answers a wrapped or saturated figure. Custody's difference is worked out exactly.
- The five doors' input schemas, recorded in `schemas.json`. `statementPnl`'s decimal strings carry their own error, recorded as `definedMsg` and run by the kit's `service_kit::schema`.
- `tests/reports_parity.rs`: 1,272 answers (status and body) that the five TypeScript handlers gave to inputs reaching each branch (each distinct answer kept with up to three of its inputs), recorded by `record-door.mjs` into `tests/fixtures/reports.golden.jsonl`.
- `tests/reports_pg.rs`: `statement-pnl-postgres.test.ts` on a real Postgres, plus a failed balance read.

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

The `desk` slice is ported. It added:

- `src/desk.rs`: the desk's reads (the transaction list with its total and cursor, one transaction and a business key's trace with their booking record, the address search with volumes, the book's counts, an account's metadata) and the metadata set and delete. Each read that names a customer writes its `operator_access_log` row first and is refused with nothing read when it cannot. A delete spends identity's approval with its operation as the replay key (`service_kit::approvals::Replay`).
- `src/door/desk.rs`: the eight desk doors, with `lookup`'s and `metadataWrite`'s answers. The metadata writes' input schemas are recorded beside the doors' (`metadataSet`, `metadataDelete`); they run after the token, as `parseOrRefuse` does.
- `tests/desk_pg.rs`: `operator-desk.pg.test.ts` and `operator-account-metadata.pg.test.ts` case for case, and the door cases of the three desk `*-http.test.ts` files that need a real book. The book is seeded in SQL as `recipes.deposit` posts, until `posting` is ported.

The `ops-reads` slice is ported. It added:

- `src/ops_reads.rs`: svc-ops' five reads. `feeRevenue` sums earned, returned and collected per venue and asset over a half-open window, and refuses an empty or inverted one with `ledger.fee_revenue_window_invalid`. `ownFunds` reads our house and module accounts and our own-funds places in one statement, then checks every row again with the custody split, so a customer's row is a 500, never counted as ours. `restoreWatermark` reads the chain tip, live or as of `{ asOf }` (`ledger.skew_bound_unset` with no bound, `ledger.restore_asof_unanswerable` before the cut-off is past it). `reconciliationEvaluations` reads settled runs after a microsecond cursor. `transactionsExist` answers ids only.
- `src/door/mod.rs`: the door answers these five past their checks, with `httpError`'s statuses. `feeRevenue`, `reconciliationEvaluations` and `transactionsExist` now run their recorded input schemas at the door.
- `src/door/schemas.json`: the four inputs, and the two replies the feed checks before it answers (`reconciliationControlRunSchema`, `reconciliationEvaluationFeedSchema`). A stored run the contract no longer reads is the ledger's 500, and the reply takes the contract's key order. The recorder now records literals and unions.
- `tests/ops_reads_pg.rs`: `fee-revenue-postgres.test.ts`, `own-funds-postgres.test.ts`, `restore-watermark-asof.pg.test.ts`, the feed case of `reconciliation-controls.pg.test.ts` and the database side of `transactionsExist`, on a real Postgres. The port cannot post yet, so each book is written straight into the tables. The posts are the TypeScript tests' own, made by the same recipes (`tests/fixtures/ops-reads-books.json`).

The `posting` slice is ported, not served yet (the switch is its own item). It added:

- `src/posting/`: the `post` door after its first input check, in the TypeScript's order. `gate.rs` is the caller binding and the recipe gate (`caller-binding.ts`, `recipe-gate.ts`); `bindings.rs` the four binding checks (`*-binding.ts`); `rules.rs` `assertValidPost`, the fingerprint and the balance rule (the chain hash is `chain.rs`'s); `engine.rs` `PostgresLedger.post` (idempotency, the freeze read, clock skew, balances, the chain tip, `ledger_tx_outbox`); `mod.rs` `LedgerService.post` (the custody switch, then this post's intent published) and the `ledgerTxPosted` relay, which the outbox recovery drains beside `ledgerFreezeUpdated`'s.
- `src/posting/recorded.rs` and `tests/fixtures/posting-parity/`, written from the TypeScript by `scripts/record-posting.mjs` (`--check` fails when stale): the recipe catalog, the caller allowlist, and 1,172 recorded posts with what the TypeScript answered for each.
- `tests/posting_parity.rs`: every recorded post judged, refused, fingerprinted and hashed as the TypeScript does.
- `tests/posting_pg.rs`: the intent and its relay, a failed publish and its retry, the freeze and the custody switch, on a real Postgres.
- `tests/conformance/`: the TypeScript's own database tests against the binary (`run.mjs`). The ledger conformance suite through the TypeScript door and the Rust one; the four binding files (`*-binding.pg.test.ts`) unmodified on the Rust door; the engine's Postgres tests (`ledger/`) with every post sent through each door. It needs Postgres, NATS and `cargo build -p svc-ledger`; CI does not run it yet.

The `post-recipe` slice is ported, not served yet (the switch is its own item). It added:

- `src/posting/recipe_door.rs`: `postRecipe`, in `handleS2sPostRecipe`'s order: the recipe named, a proven caller's grant for it, the record's input (`postRecipe` in `schemas.json`), the recipe, the grant's module, `post`'s own input, then the booking through `posting::post` and the reply checked against the record's output (`postRecipeReply`). The door's two recipes (`academyPurchase`, `academyPurchaseRefund`) build their legs as `academy-purchase.ts` does.
- `tests/fixtures/post-recipe.golden.jsonl`, recorded by `record-door.mjs`: what the TypeScript door answers five callers for 239 bodies, its refusal or the post it hands its ledger. `tests/post_recipe_parity.rs` holds the Rust door to every answer, and to the TypeScript door's list of recipes.
- `tests/conformance/`: `post-recipe-door.pg.test.ts`, unmodified, on the Rust binary (project `post-recipe-pg`, `rust-s2s-register.ts`), custody off as the test sets it.

The `controls` slice is ported, not served yet (the switch is its own item). It added:

- `src/controls/`: `mod.rs` defines, updates, lists and runs a control (`reconciliation-controls.ts`), opening the run's row before any source is read and finishing a started one on retry; `schedule.rs` the periods and due instants (`reconciliation-schedule.ts`); `judge.rs` the pure verdicts; `sources.rs` the outside side (`reconciliation-sources.ts`): the whole book, one rail's statement, and svc-pay's open items, signed as svc-ledger. An amount is a scaled `i128`, so a sum past its range answers ERROR, where the TypeScript's `bigint` would keep counting.
- `src/door/controls.rs`: the four operator doors; their inputs and the replies they check are recorded in `src/door/schemas.json`. The tick runs the due controls after its staleness check (`reconciler.rs`), and one that throws pages and freezes nothing. `reconciliationEvaluations` now reads its runs through `controls::to_run`.
- `tests/controls_pg.rs`: `reconciliation-controls.pg.test.ts` case for case on a real Postgres, each case in its own database, its outside sources a local HTTP server. The tRPC router case runs through the operator door. The feed case and `transactionsExist` stay in `tests/ops_reads_pg.rs`.
- `tests/controls_sources.rs`: `reconciliation-sources.test.ts`; the tick hook case of `reconciliation-controls.test.ts` is in `tests/reconcile_tick.rs`, its schedule cases in `src/controls/schedule.rs`.

The `/metrics` route is ported, not served yet (the switch is its own item). It added:

- `service_kit::metrics`: `@intafaced/telemetry`'s `Metrics` (the series names, labels, buckets, HELP and TYPE text, label escaping, the 2,000-series cap with its `_overflow` series, the trailing newline and the content type) and `renderGauges`. A door turns it on with `Door::metrics` (default off, so svc-tax, svc-academy, svc-agents and svc-matching are unchanged): the kit's server then serves `GET /metrics` and observes every reply it sends, 404s and `/metrics` included, under `module="_local"` and `outcome="none"`. `crates/service-kit/tests/metrics_golden.rs` holds the exposition byte for byte to what `Metrics` rendered for the same observations (`tests/fixtures/metrics.golden.json`, written by `crates/service-kit/scripts/record-metrics.mjs`).
- `src/metrics.rs`: `reconcileGauges`, read from the book on each scrape through `Door::gauges` (`read_last_verified`); a read that fails leaves the gauges out and the scrape answers.
- `tests/metrics.rs`: `metrics.test.ts`, `metrics.boot.e2e.test.ts` and `observability-wiring.test.ts` case for case, over a real socket to the kit's `serve` loop; every scrape and the counts a sequence of requests leaves, against what the TypeScript route answered (`tests/fixtures/metrics-route.golden.json`, written by `scripts/record-metrics.mjs`). `tests/store_pg.rs` reads the gauges from a real book.
- Where it cannot be the TypeScript's: a reply is observed once its answer is ready, just before it is written; Fastify's `onResponse` takes the time after the write. The difference is the socket write.

## What the shell holds, and how it is proved

- **`tests/wire_replay.rs`** sends every request of `services/svc-ledger/src/wire-replay.golden/` to the door. That is 11,772 answers over 44 routes, three settings and every caller.
  - Each answer the door decides must match byte for byte: 404s, Fastify's body refusals, a service's signature and caller-list refusals, operator token and scope refusals, and the first input checks.
  - Any other answer must be one the door names as its slice's (`Outcome::Owed`).
  - A recorded 401, 403, 404 or Fastify refusal can never be owed.
  - `WIRE_REPLAY_SLICE=<name>` prints what a slice owes. `WIRE_REPLAY_STRICT=<name>` fails while it owes any.
- **`tests/input_parity.rs`**: 371 inputs over the 14 door schemas, against zod's own verdicts.
- **`tests/tokens.rs`**: 41 access tokens, against `verifyAccessToken`. The verifier is the kit's `service_kit::tokens`.
- **`tests/env_parity.rs`**: 36 environments, against `env.ts`.

The replay's store refuses every query, so `/health` and `/ready` answer its 500 there; `tests/store_pg.rs` proves their real answers. A transaction (`sql.begin`) on the replay's store is refused as `replay stub: sql.begin`, as the TypeScript stub names it. The replay never gets past the input check of `post`, the balance reads or `/operator/reconcile`: every recorded sample is refused there. For those slices the proof is the TypeScript database tests named below, run against the Rust code.

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
