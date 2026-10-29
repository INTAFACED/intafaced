# svc-ledger

**THE BALANCE (§4.2).** The single wallet graph for the entire OS. Every value movement anywhere in INTAFACED is a double-entry transaction here.

**What this service is not:** it does not decide whether a movement is _allowed_. That is the calling module's job — svc-trade decides an order may be placed, svc-p2p decides an escrow may release. This service decides only whether a transaction is _legal_: balanced, funded, and idempotent. It will refuse an illegal one from any caller, including one of ours.

---

## API

Internal tRPC. Note there is no user-facing write path, and `packages/auth` has no `ledger:write` scope at all — a user moves value by asking a module to act, never by calling the ledger.

| Procedure   | Scope               | Input                                       | Output                                                                                                                        |
| ----------- | ------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `health`    | —                   | —                                           | `{ ok, service, postingEnabled }`                                                                                             |
| `post`      | service credentials | `PostRequest` (decimal-string amounts)      | `{ txId, hash, postedAt }`                                                                                                    |
| `balance`   | `ledger:read`       | `AccountRef`                                | `{ accountId, assetId, kind, purpose, amount }`                                                                               |
| `balances`  | `ledger:read`       | `{ ownerType, ownerId }`                    | `{ accountId, assetId, kind, purpose, amount }[]` — own pots only; `purpose` is identity (P0-3), empty string when unpurposed |
| `history`   | service credentials | `{ account, from, to }` — ISO, `[from, to)` | `{ txId, module, reason, direction, amount, postedAt }[]`                                                                     |
| `reconcile` | `admin:treasury`    | —                                           | `{ ok, accountsChecked, chainLength, unbalancedAssets, chainBrokenAt? }`                                                      |
| `freeze`    | `admin:treasury`    | `{ reason, confirmOperatorId }`             | `{ postingEnabled, frozenReason, frozenBy, confirmOperatorId }`                                                               |
| `unfreeze`  | `admin:treasury`    | `{ confirmOperatorId }`                     | `{ postingEnabled, frozenReason, frozenBy, confirmOperatorId }`                                                               |

HTTP: `GET /health` (liveness) · `GET /ready` — returns **503 when frozen**, so a frozen ledger leaves the load balancer rotation instead of refusing posts one by one.

### Operator HTTP (`admin:treasury` + MFA on every route; the two lookups also take a founder's `admin:read` + MFA)

tRPC procedures above are exported for their type; **nothing mounts the tRPC plugin**. Operator control reaches the process through raw Fastify routes:

| Method | Path                                            | Effect                                                                      |
| ------ | ----------------------------------------------- | --------------------------------------------------------------------------- |
| `GET`  | `/operator/freeze`                              | Durable `posting_freeze` row                                                |
| `GET`  | `/operator/integrity/clock`                     | App clock vs `clock_timestamp()`. Blank bound is `ledger.skew_bound_unset`  |
| `POST` | `/operator/freeze`                              | Halt posting (`reason` ≥ 12 chars + distinct `confirmOperatorId`)           |
| `POST` | `/operator/unfreeze`                            | Resume posting (distinct `confirmOperatorId`)                               |
| `POST` | `/operator/reconcile`                           | Full three-check run (balances · chain · totalsByAsset); freezes on failure |
| `GET`  | `/operator/transactions/:txId`                  | One booked transaction with its postings; 404 `ledger.tx_not_found`         |
| `GET`  | `/operator/trace?businessKey=`                  | The transaction a business key booked, or `found: false`                    |
| `GET`  | `/operator/transactions`                        | Desk list: `assetId`, `from`, `to` (half-open), `before` cursor; the total  |
| `GET`  | `/operator/accounts?prefix=`                    | Desk address search: `<owner type>:<owner id prefix>`, `after` cursor       |
| `GET`  | `/operator/stats`                               | Desk counts: transactions, postings, accounts, assets, newest sequence      |
| `GET`  | `/operator/accounts/:accountId/metadata`        | An account's operator metadata: keys, deleted keys, newest changes          |
| `POST` | `/operator/accounts/:accountId/metadata/set`    | Set or overwrite one key from the revision read (treasury)                  |
| `POST` | `/operator/accounts/:accountId/metadata/delete` | Delete one key with a second founder (`ledger.account_metadata.delete`)     |
| `GET`  | `/operator/assets`                              | Every asset registry row, published or not (W-balances-05)                  |
| `POST` | `/operator/assets/apply-edit`                   | Apply one founder-approved registry edit (`ledger.asset_edit`)              |

`LEDGER_CLOCK_SKEW_BOUND_MS` is the owner's millisecond bound between this process's clock and `clock_timestamp()`. Blank or unset is not a number: the integrity read refuses `ledger.skew_bound_unset`, and posts are not blocked by an invented 0 or an invented open window. Explicit `0` is a real bound. When a set bound is exceeded, a new `post` refuses `ledger.writes_blocked_clock_skew` after the idempotency lookups miss and before anything new is booked (503 on the service door). A key that already committed returns the original transaction, or `ledger.idempotency_conflict` when the body differs, even while the clocks are past the bound.

Operator freeze/unfreeze is dual-control: the signed treasury principal plus a distinct `confirmOperatorId`. Missing or same-as-operator confirm refuses (`missing_operator`) — the ledger does not invent a second caller. Reconciliation and boot `LEDGER_POSTING_ENABLED=false` still freeze through `LedgerService` without a confirmer (not operator doors).

The two lookups are reads that answer while posting is frozen. Who may look (owner decision 2026-10-23): a founder's own sign-in with `admin:read` and a second factor, so the access row names the person, or `admin:treasury`; the tRPC `trace` and `transactionGet` take the same rule (`requireLookupAuthority`). Each writes one `operator_access_log` row first (`transaction.read` or `trace.read`, migration 0026), inside the read itself, so the `trace` and `transactionGet` tRPC procedures record the same way; a row that cannot be written refuses with 503 `ledger.lookup_unrecorded` and nothing is read. A malformed id or key refuses with 400 `ledger.lookup_input_invalid`; a recorded lookup the database could not answer is 503 `ledger.lookup_unavailable`. Postings name opaque account ids only; transaction metadata is not returned. Each posting also says whether value left the account (`source`, a credit) or arrived (`destination`, a debit) with the balance before and after it, and a transaction carries its booking record: the log sequence, the reference (the request's correlation id, or the transaction id), the database's time for the booking (Postgres `now()` on its event record: when the booking's database transaction began, before it waited for the chain lock) beside the request time `postedAt` (the process clock after that lock, which the hash covers), and the `tx.posted` event record written in the same commit. The ledger keeps no record of a write it refused, so a key that never booked answers only `found: false`.

The ledger desk's browsing reads (OPS-ledger-desk-01) take the lookups' authority and answer while frozen. `GET /operator/transactions` lists newest first, 50 a page, with a `nextCursor` (the last row's sequence); the first page also answers the total that matches the filters, counted in the same read-only snapshot, and a later page answers `total: null` rather than count the book again. `GET /operator/accounts` finds accounts whose address (`<owner type>:<owner id>`) starts with the prefix, which must name a whole owner type and at least one character of the owner id; the prefix is matched literally. Each account answers its debit and credit volumes and the balance derived from them (`debits − credits`) as decimal strings. Both write one access row first (`transactions.list` naming the filters, `accounts.search` naming the prefix; migration 0028) and refuse with 503 `ledger.lookup_unrecorded` when they cannot. `GET /operator/stats` answers the book's counts and the newest sequence with the database time it read them; it names no one and writes no row.

Account metadata (OPS-ledger-desk-01, J-ops-console-03 #6, #7; migration 0029) is a founder's label on a ledger account: a key (lower case, 64 characters at most) and a value (1 to 500 characters), always with a reason of 12 to 500 characters. It is not a posting and never touches an entry, a balance or a transaction's own metadata, which the hash chain covers and stays immutable (0016). The read takes the lookups' authority, writes one access row first (`account_metadata.read`) and answers while frozen. A set is a treasury write from the revision the founder read (0 for a new key); a retry of the same set answers its first change, and any other change at that revision is 409 `ledger.account_metadata_stale`. A delete spends a second founder's approval (`ledger.account_metadata.delete`, target `posting_account_metadata.delete`, bound to the account, the key, the reason and the revision) once; a retry with the same approval answers the same change without asking identity again. Both writes refuse 412 `ledger.frozen` while the posting freeze is on, reading the freeze under a share lock in their own transaction, and a delete checks the freeze and the revision before identity spends anything, so a refused delete keeps its approval. A freeze or another write that lands in the moment after that check and before the delete is written refuses 409 `ledger.account_metadata_approval_spent`: nothing changed and the founders approve again (a crash in that moment also leaves the approval spent). A deleted key keeps its row with no value, so its revision only grows. `account_metadata_changes` keeps every set and delete with the value before and after, who asked, who approved and why; it is append-only by trigger.

`POST /operator/reconcile` is the on-demand path for apps/admin. A broken chain reports `chainLength` as how far verification got and names `chainBrokenAt` — never collapses a break to zero (that would look like an empty healthy book). Edge/admin must proxy this route; until they do, the scheduled job and this path are the live answers.

### Who may call which door

Each door on the service port names the services that may call it (`src/door-callers.ts`), and the caller is the owner of the S2S v3 key that signed the request. A service not listed gets `403 ledger.caller_forbidden`; a door with no named caller (`portfolio`, `statementPnl`, `reportExport`, `custody`, `financeClose`, `resilience`) refuses everyone until one exists. Settings and the move off the shared secret: [`CALLER-BINDING.md`](CALLER-BINDING.md).

### `feeRevenue` — fee revenue per asset, for one caller

`POST /trpc/feeRevenue` takes a half-open ISO window (`from` inclusive, `to` exclusive) and answers, for each asset with a fee movement in it, the fees collected (debits to `fees:*` house accounts), the fees returned (credits out of them) and the signed net, as decimal strings. It reads sums over those accounts and nothing else: no user account, no insurance fund, no entries. An asset with no movement is absent, never a zero row. It is a READ with no path into `post()`.

The door names one caller, svc-ops (`src/door-callers.ts`), which uses it for the venue unit-economics report. Besides it, svc-ops is named on `restoreWatermark`, `reconciliationEvaluations`, `transactionsExist`, and `post` and `txByKey` for its staff holds; `fee-revenue-door.test.ts` proves every other door refuses it.

### `reconciliationEvaluations` — every finished reconciliation evaluation, for svc-ops' alerts

`POST /trpc/reconciliationEvaluations` takes `{ after: { finishedAt, id } | null, limit }` (`limit` 1 to 500) and answers the finished evaluations after the cursor, oldest first by `(finishedAt, id)`, each with the control's severity as it is now, and `next`, the cursor to read from next (the last row returned, or the one asked for when none was). A run still `started` is left out, and so is one finished less than 30 seconds ago, so a run committed just behind a reader's cursor is not skipped. The cursor's `finishedAt` carries microseconds: keep it as the string the door returned, never as a JavaScript `Date`, or the last row comes back on every read. A reader keeps its own write idempotent by run id, so it may re-read from an earlier cursor. The run omits its account list. A stored run that no longer fits the contract answers 500, never 400. It is a READ with no path into `post()`.

### `transactionsExist` — which named transaction ids are booked, for svc-ops resolving an alert

`POST /trpc/transactionsExist` takes `{ txIds }` (1 to 20 UUIDs) and answers `{ found }`: the asked ids that name a booked transaction, lowercase, in the order asked, each once. svc-ops alone may call it (`src/door-callers.ts`); it checks the corrective transactions an operator names when resolving a reconciliation alert as fixed (OPS-reconciliation-04). It answers ids only, never an amount, account or entry. A malformed id or an extra key answers 400. It is a READ with no path into `post()`.

The door names one caller, svc-ops (`src/door-callers.ts`), which keeps one alert per control, failing asset and period from it (OPS-reconciliation-03). `reconciliation-evaluations-door.test.ts` proves other callers are refused.

### `holdingsHistory` — what one customer holds now, and how it moved

`POST /trpc/holdingsHistory` takes `{ ownerType: 'user' | 'subaccount', ownerId, from, bucketSeconds }`, with `bucketSeconds` one of 60, 300, 3600, 14400 or 86400 and `from` an ISO time on that bucket's UTC grid, not in the future. It answers, from one repeatable-read snapshot:

- `holdings`: every account of the owner (available and every lock kind) summed per asset, as of `asOf`. An asset held at zero is absent.
- `movements`: each transaction posted at or after `from`, netted over the owner's accounts per asset, then summed per asset, ledger reason and bucket, oldest first: `inflow` from the transactions that left the owner with more, `outflow` from those that left it with less, so money in and money out under one reason in one bucket stay apart. `fee` is the trading fee taken from the owner's receiving fill line (the same figure `historyPage` names per line, held to it by the Postgres test). A transaction between the owner's own accounts (an order hold, a withdrawal put on hold or reversed) nets to zero and is left out.

So holdings at any bucket boundary are `holdings` less `inflow - outflow` of every movement from that bucket on: svc-bank replays value over time and names the flows of the change-in-value bridge from it, without a second book (`holdings-history-postgres.test.ts` proves the replay lands on what was held before the first movement). More than 10,000 rows refuses `ledger.holdings_history_too_large`; a start off its grid or in the future refuses `ledger.holdings_history_window_invalid`; both are 400. It is a READ with no path into `post()`. The door names one caller, svc-bank (`src/door-callers.ts`), which decides whose holdings a customer may see before it asks.

### The asset and network registry (W-balances-05)

The one list of supported assets, their networks, their precision and what each may be used for, in the wire shape of `packages/contracts/src/asset-registry.ts`. The rows live on `assets` (0025), the table every balance already has a foreign key to.

- **Reads.** `POST /trpc/assetsList` (`{ state?, action? }`) and `POST /trpc/assetsGet` (`{ assetId }`), open to every service that reads balances. Only published rows are listed: a row whose precision the owner has not set is left out of the list and refused by `get` with `ledger.asset_precision_unset` (400), never read as 18. An unknown id is `ledger.asset_not_found` (400). The migration publishes nothing: every existing row starts with no precision, no network and no allowed action.
- **Writes.** Founder edits only, through svc-identity's action approval: action `ledger.asset_edit`, target `svc-ledger`, target id the asset, `expectedVersion` the row's `revision` (`0` for a new asset), payload hash `assetEditPayloadHash(edit)`. `POST /operator/assets/apply-edit { approvalId, operationId, edit }` consumes the approval under the operation id identity issued with it. A retry after the edit landed answers with the row it produced. A retry after identity consumed the approval but before the edit landed refuses `action_approval.not_founders`: identity does not repeat its founder attestation on a repeated consume, so the ledger fails closed and the founders approve again and requires identity to attest a distinct founder pair. One operation id applies once; a retry answers with the row. An edit approved against an older revision refuses (`ledger.asset_edit_stale`, 409), as does an operation id reused for another edit (`ledger.asset_operation_conflict`, 409). An edit cannot change an asset's kind. Each applied edit is kept in the append-only `asset_edits` table with who proposed, approved and sent it. Nothing here moves value.

### `history` — a read, and the two ways it refuses

The projection source for svc-bank's spend view (§8.1). That service keeps no `spent_this_month` counter — a second source of truth for money in everything but name — so it folds this window on demand instead. It is a READ: it takes no chain-tip lock, touches no balance, and has no path into `post()`.

**Service credentials, not `ledger:read`.** The caller is a service, and it forwards no user token: svc-bank has already decided, with the user's token, which spaces that user may see. The input is a bare `AccountRef`, which can name `house` and `treasury` accounts — `rail:*`, `fees:*`, `mint` — and unlike `balances` there is nothing in it to compare a principal against, so `ledger:read` would turn every holder of a read scope into someone who can enumerate the platform's own movements transaction by transaction. Which human may see a movement stays svc-bank's question, exactly as whether a movement is _allowed_ stays the calling module's.

**Bounded at 10 000 entries per window, and it refuses rather than truncating.** An unbounded read of the service that owns every balance in the OS is one request away from exhausting its heap, so there is a cap. Returning the first 10 000 would produce an array indistinguishable from a complete one — svc-bank would sum it and call the total "your spending", short by whatever fell off the end with nothing saying so. So over the cap the read refuses with `ledger.history_range_too_large`, naming the cap and the window; the remedy is a narrower window, and it works. The query asks for `cap + 1` rows: one row past the cap is enough to know the answer would have been clipped, and memory stays bounded either way.

An **inverted** window (`to` before `from`) refuses too — `ledger.history_range_invalid`. It matches no row, so an empty array would be a plausible-looking answer to a question nobody meant to ask. A **zero-width** window (`from == to`) is legal and empty: half-open `[t, t)` genuinely contains nothing. An account that has never been posted to answers `[]`, and reading it does not create it.

> **§13 socket — paged history.** Nothing browses this yet, and a `limit` without a cursor is silent truncation with a parameter in front of it. When a paged history is needed, add `after: <entry id>` and page on `(posted_at, e.id)` — the order this already returns, and the one `ledger_entries_account_idx` already supports.

---

## Events

**Publishes**

| Subject                                      | When                     | Payload                                             |
| -------------------------------------------- | ------------------------ | --------------------------------------------------- |
| `intafaced.ledger.tx.posted`                 | after every commit       | tx id, module, reason, hash chain link, all entries |
| `intafaced.ledger.reconciliation.failed`     | balance drift detected   | account, cached vs replayed balance, difference     |
| `intafaced.ledger.reconciliation_run.failed` | every incomplete run     | error code, phase, consecutive count, run id        |
| `intafaced.ledger.freeze.updated`            | posting frozen or thawed | `frozen`, `reason`, `actor`, `changedAt`            |

`freeze.updated` carries both directions on one subject. Its stored idempotency key is `ledger.freeze:seq:<switch_seq>`. The sequence is allocated only while holding the actual `posting_freeze` row lock, so an earlier transaction start cannot reorder a later switch. `changedAt` is database observation time; replay order uses the sequence, not timestamps or UUIDs.

`tx.posted` is emitted **after** commit, never inside the transaction. A consumer must never observe a transaction that could still roll back: at-least-once delivery of a fact that happened beats at-most-once delivery of one that might not have. Idempotency key is `ledger.tx:<txId>`.

**Consumes** — nothing. The ledger is the bottom of the stack; it reacts to no one.

---

## Ledger

This service _is_ the ledger, so rather than recipes it invokes, here is what it enforces. Every recipe in `@intafaced/ledger-client` passes through `post()`.

| Invariant                                           | Enforced where                                                  |
| --------------------------------------------------- | --------------------------------------------------------------- |
| Σ debits = Σ credits, per asset                     | `assertValidPost` (shared with the reference impl)              |
| `available` never negative (except `treasury`)      | service check on locked rows **+** `accounts_non_negative_ck`   |
| Locks funded from the owner's own available balance | `assertPairedLocks`                                             |
| Entry amounts strictly positive                     | `assertBalanced` **+** `ledger_entries_positive_ck`             |
| Idempotency — a retry returns the original          | `ledger_tx_idempotency_idx` unique index                        |
| Hash chain unbroken                                 | `chain_tip` `FOR UPDATE` + `verifyChain`                        |
| A frozen ledger accepts no new posts                | `posting_freeze` read under that same `FOR UPDATE`              |
| `owner_id` is from the space `owner_type` declares  | `assertOwnerIdentifierSpace` **+** `accounts_owner_id_space_ck` |

Enforced in three layers on purpose: shared pure validation, the transaction, and database CHECK constraints. **A bug in this service still cannot create money.** There is a test that proves it, by trying to write a negative balance with raw SQL.

### A reused idempotency key with a different body

A retry returns the original transaction. If the retry's body (module, reason, entries) differs from what that key booked, the engine either refuses it (`ledger.idempotency_conflict`, 409 over S2S) or, in `detect` mode, returns the original anyway and logs one JSON line `ledger.idempotency_mismatch` (key, module, reason). `LEDGER_IDEMPOTENCY_CONFLICT_MODE` is `detect` (default in dev and test) or `refuse`; in staging and production posture (`APP_ENV` other than dev/test) the ledger always runs `refuse`, whatever this says; flip to `refuse` once every call site that rebuilds a body on replay is fixed and the log has been quiet for a day. The fingerprint lives in the nullable `ledger_posted_keys.request_fingerprint` (migration 0021, run before the new code); rows booked before it have none and keep the old behaviour.

### Who an account belongs to

`owner_type` says what role an owner plays. It now also fixes which **identifier space** `owner_id` is drawn from, because it was the only thing in the row that could:

| `owner_type`                | `owner_id` must be                                                     |
| --------------------------- | ---------------------------------------------------------------------- |
| `user`, `subaccount`        | a lowercase canonical UUID — `identity.users.id` / `sub_accounts.id`   |
| `module`,`house`,`treasury` | a namespaced platform slug — `fees:trade`, `rail:card-sandbox`, `mint` |

Before `0005_owner_identifier_space.sql`, `owner_id` was `text` and took either. That is only interesting because of what the 2026-08-02 ADR accepted: the vendored product's money controllers keep their business logic and have their balance writes redirected here through an adapter, and their member ids are `bigint`. An adapter that passes the wrong one **does not fail** — it opens a second, individually conformant account for the same human. Both sum to zero, both hash-chain, both reconcile, both are non-negative; every gate reports clean and no query over this book can tell. It is a dual book, arriving through the door the ADR was written to close.

Not modelled as a separate namespace column, deliberately: a namespace supplied by the caller is supplied by the same caller that supplied the wrong id, so `ns='member'` would arrive alongside `1042` and the pair would be accepted. The space has to be something the ledger already knows.

The constraint also refuses an uppercase UUID. `550E8400-…` and `550e8400-…` are one human and two rows under `accounts_identity_purpose_idx` — the same failure in different clothing.

### Account boundaries

`treasury` accounts are the seam with the outside world and the only ones permitted to run negative. A negative balance there is exactly our obligation:

| Boundary         | Negative balance means                    |
| ---------------- | ----------------------------------------- |
| `rail:<rail>`    | value users have deposited and we custody |
| `venue:<venue>`  | user value sitting at an external venue   |
| `bridge:<chain>` | value bridged to the Protocol Plane       |
| `mint`           | IFC in circulation                        |

---

## Concurrency

Every post takes `SELECT … FOR UPDATE` on the singleton `chain_tip` row **before** reading any balance it will write. That lock establishes a total order over all posts by itself, which is why the transaction runs at **READ COMMITTED** rather than SERIALIZABLE: transactions queue on the lock instead of aborting one another.

This was measured, not assumed. Under SERIALIZABLE, 50 concurrent posts aborted each other faster than the retry budget could absorb (`40001` storm). Queuing is correct _and_ predictable.

**Consequence:** posting throughput is globally serial — one transaction at a time, platform-wide. Accepted at soft-launch volume.

> **§13 socket — chain sharding.** When posting rate becomes the constraint, shard the chain per asset (independent `chain_tip` rows) with a periodic cross-shard anchor transaction. The hash-chain guarantee narrows from "one total order" to "one total order per asset, anchored", which is sufficient for audit. `hashTx` and the reconciliation replay are already per-transaction and need no change.

---

## Reconciliation

Runs on the owner-published `RECONCILE_CRON_MINUTES` cadence (blank / unset refuses boot — never invent 60; owner may set 60), and on demand via `POST /operator/reconcile` (`admin:treasury` + MFA). apps/admin reaches that path only after edge proxies it — until then the live answers are the scheduled job and a direct call to this service. Three independent checks:

1. **`reconcileBalances`** — cached `accounts.balance` vs a full replay of `ledger_entries`. Catches a bug in the posting path.
2. **`verifyChain`** — every hash recomputed from its predecessor. Catches tampering, _including by someone with database access_.
3. **`totalsByAsset`** — every asset must net to exactly zero across all accounts. Catches value created or destroyed by any means.

**How it runs.** The proof reads **one consistent snapshot** (a `REPEATABLE READ` transaction on its own connection) and takes **no `chain_tip` lock**, so posts are not blocked while it runs and a live post can never make it report a false `ok: false`. Balances staged inside the proof snapshot retain its tip (`through_seq`, hash, last entry id); a short READ COMMITTED transaction then writes those `balance_snapshots` and the `ok` run together. A completed mismatch instead commits its run, durable freeze and freeze outbox atomically. The proof has its own `statement_timeout` (`LEDGER_RECONCILE_STATEMENT_TIMEOUT_MS`, default 10 minutes, set with `SET LOCAL`; posts keep the pool-wide 15 s). Only one run goes at a time per book (a session advisory lock held across both proof and snapshot-write transactions): a tick that finds another run in progress skips quietly, and `POST /operator/reconcile` answers 409 `ledger.reconcile_in_progress`.

**Three outcomes, only one freezes.**

| Outcome      | Meaning                                                                                                                                                                                    | Posting                                                                                                                                                                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ok`         | The proof finished and the book is consistent through `through_seq`.                                                                                                                       | Unchanged.                                                                                                                                                                                                                                                           |
| `mismatch`   | The proof **finished** and found drift, a broken hash chain, an unbalanced asset, a corrupt stored amount, or a non-text `chain_tip`. A snapshot write after `ok: true` is not a mismatch. | **Frozen** (`reconciliation mismatch`) and `reconciliation.failed` emitted for a balance drift.                                                                                                                                                                      |
| `incomplete` | Any error that did not prove the book wrong, including Postgres, TLS, a code-less error, and a snapshot write after a green proof.                                                         | **Not frozen** until `RECONCILE_MAX_CONSECUTIVE_INCOMPLETE` in a row (default 3), the larger of this process and `reconcile_runs`. Each run emits `reconciliation_run.failed`. The Nth freezes as `reconcile_unproven`. An operator thaw does not reset that streak. |

A mismatch is frozen when the proof **finishes**, not while it reads: posts continue on a broken book for the duration of one proof. That cost is accepted and written down in [`docs/adr/2026-10-14-ledger-reconcile-snapshot-no-freeze-on-incomplete.md`](../../docs/adr/2026-10-14-ledger-reconcile-snapshot-no-freeze-on-incomplete.md).

**Staleness reporting.** If no `ok` proof is newer than `LEDGER_RECONCILE_MAX_STALE_HOURS` (default 24), each tick emits a fatal stale log. Staleness alone never freezes posting. Repeated incomplete runs do: after the configured consecutive limit the tick freezes as `reconcile_unproven`. `GET /health` reports `lastVerifiedAt` and `lastVerifiedSeq` (the highest proved prefix; null before the first), and `/metrics` carries `ledger_reconcile_last_verified_timestamp_seconds` and `ledger_reconcile_last_verified_seq`. The incomplete-run event has no subscriber wired here.

See the runbook for what to do on `incomplete` and `stale`: [`docs/runbooks/INCIDENT-MONEY-PATH-RUNBOOK.md`](../../docs/runbooks/INCIDENT-MONEY-PATH-RUNBOOK.md) §"Reconcile incomplete or stale".

### The one denormalisation

`accounts.balance` is a cache of the entry sum, so a balance read is O(1) rather than a table scan. It is written only inside the same transaction as its entries, and check (1) above is what earns it the right to exist. Per the agent protocol, a balance-shaped column is a doctrine violation _unless_ it comes with a documented reconciliation job. This one does.

---

## Posted history is append-only (0023)

The database itself refuses to rewrite the journal. `ledger_entries` and `ledger_tx` reject `UPDATE`, `DELETE` and `TRUNCATE` (SQLSTATE `23514`, message "… is append-only"), and a `DEFERRABLE INITIALLY DEFERRED` constraint trigger refuses, at `COMMIT`, any transaction whose entries do not net to zero per asset. A mistake is corrected with a reversing post, never an edit. `accounts.balance`, `chain_tip` and the outbox tables stay writable because the posting path writes them. Reconcile and `verifyChain` still run on schedule: they detect, these triggers prevent.

Not covered yet: no `REVOKE` (the repo's migrations do not manage a separate application role, so the runtime role keeps its grants and the triggers are the only barrier), and a `ledger_tx` row inserted with no entries is not judged.

### Break-glass: the journal triggers

Only for a repair that cannot be done with a reversing post (for example a corrupt row found by `verifyChain`). Disabling a trigger needs table ownership: the **migration role** (the schema owner that runs `pnpm db:migrate`) or a superuser. Today the service also connects as that same owner role (`svc_ledger`, see `docker-compose.apps.yml`), so these triggers stop application bugs and stray SQL, not someone holding the service's database password. Splitting the runtime role from the owner is the follow-up that closes that. Until then this procedure is a rule people follow, not something the database enforces; never run it from the service's runtime connection.

1. Freeze posting first (`POST /operator/freeze`, dual-control) so no post runs while a guard is off.
2. Log it before touching anything: who, why, the exact statements, a second approver, and the ticket. Break-glass without a log entry is a tampering incident.
3. In one session as the migration role, disable only what the repair needs, make the change, and re-enable in the same session:

```sql
ALTER TABLE ledger.ledger_entries DISABLE TRIGGER ledger_entries_immutable;      -- UPDATE / DELETE
ALTER TABLE ledger.ledger_tx      DISABLE TRIGGER ledger_tx_immutable;           -- UPDATE / DELETE
ALTER TABLE ledger.ledger_entries DISABLE TRIGGER ledger_entries_no_truncate;     -- TRUNCATE
ALTER TABLE ledger.ledger_tx      DISABLE TRIGGER ledger_tx_no_truncate;
ALTER TABLE ledger.ledger_entries DISABLE TRIGGER ledger_entries_tx_must_balance; -- balance at commit
-- ... the repair ...
ALTER TABLE ledger.ledger_entries ENABLE TRIGGER ledger_entries_immutable;
-- ... and every other trigger disabled above
```

4. Confirm every trigger is enabled again (`SELECT tgname, tgenabled FROM pg_trigger WHERE tgname LIKE 'ledger\_%'`, expect `O`), then run `POST /operator/reconcile`. A repaired row usually breaks the hash chain; that is expected and must be explained in the log, never papered over by rehashing.
5. Unfreeze only after reconcile is green or the owner has signed off the documented exception.

`pnpm db:migrate --down` also removes these triggers, but it refuses any non-empty book, so it is not a break-glass path.

---

## Kill-switch

`ledger.posting` in the admin console, or `LEDGER_POSTING_ENABLED=false`.

**Effect when off:** every `post()` throws `ledger.frozen`; reads continue to work. This halts all value movement across the entire platform — trading, payments, escrow, staking, rewards. It is the most consequential switch in the OS and exists because §4.2 demands it.

`ledger.reconciliation` disables the scheduled job only. It does not disable the freeze-on-mismatch behaviour.

### The switch is durable

It lives in `ledger.posting_freeze` — one row, like `chain_tip`, holding `frozen`, `reason`, `actor` and `changed_at`. It is not a field on a service object, because a freeze is a fact about **the ledger**, not about a server. In memory it lost three ways: a restart resumed posting on a book reconciliation had halted, a second replica never heard about the freeze at all, and the operator's reason was written nowhere.

`post()` first locks `chain_tip`, then reads `posting_freeze` in a fresh statement under that lock. A joined read in the statement waiting on the tip can retain a pre-wait freeze snapshot. Scheduled mismatch freezes commit the switch, durable intent and mismatch record in a short transaction after the snapshot proof. New posts that read the switch after that commit refuse; a post already past its freeze read may still complete. Posts do not lock the freeze row; the standalone operator freeze policy remains unchanged.

A retry of a transaction that **already committed** still returns the original while frozen. The value moved; telling the caller otherwise would have it retry a movement that already happened.

Every freeze and thaw is attributed. The database refuses `frozen = true` with neither reason nor actor (`posting_freeze_attributed_ck`) — whoever finds the platform halted must be able to find out why and by whom.

### `LEDGER_POSTING_ENABLED` vs the database

**The database wins, in one direction only.** The asymmetry is the safety property:

| Flag                           | Database says | Result                                                   |
| ------------------------------ | ------------- | -------------------------------------------------------- |
| `LEDGER_POSTING_ENABLED=false` | not frozen    | **freezes**, durably, actor `env:LEDGER_POSTING_ENABLED` |
| `LEDGER_POSTING_ENABLED=false` | frozen        | left alone — the existing reason is the one that matters |
| `LEDGER_POSTING_ENABLED=true`  | frozen        | **stays frozen** — the flag can never thaw               |

The flag defaults to `true`. If a restart honoured it, every deploy, OOM kill and autoscaler event would silently resume posting on a book that reconciliation halted — which is exactly the bug this design removes, arriving back through the front door. An unfreeze is a deliberate act with a named actor; a default-valued environment variable is not one, and must never be able to impersonate one.

Applied once at boot (`LedgerService.applyStartupPolicy`), never per request.

---

## Running it

```bash
docker compose up -d
pnpm --filter @intafaced/svc-ledger db:migrate     # runs as svc_ledger, which owns the schema
pnpm --filter @intafaced/svc-ledger test           # conformance suite vs real Postgres
pnpm --filter @intafaced/svc-ledger dev
```

Migrations run as the schema's **owner**, not an admin role — this role deliberately holds no database-level `CREATE`, so a migration physically cannot reach outside `ledger` (§2).

## Tests

`postgres-ledger.test.ts` runs `runLedgerConformance` from `@intafaced/ledger-client/testing` — **the same suite the in-memory reference runs.** If the two ever disagree, one is wrong and the suite decides which (§4.4).

Beyond conformance it proves what only a real database can: CHECK constraints rejecting direct SQL, 18-decimal round trips, tamper detection, drift detection, and 50 concurrent posts leaving the chain intact. Skips cleanly when Postgres is unreachable.

`owner-identity.test.ts` proves the other two things a client-side suite cannot. First, `accounts_owner_id_space_ck` refuses a vendored `bigint` member id against a **raw INSERT**, with `ledger-client` out of the picture — an adapter bridging a Java stack is the least likely caller in the OS to route through a TypeScript library, so application-only enforcement would be bypassable by exactly the thing it exists to stop. Second, it runs migration `0005` against a table that **already has rows**, in each of the four shapes it can meet: conformant (changes nothing), an uppercase UUID (canonicalised, 18dp balance preserved), a never-used wrong-space row (reclaimed), and one that holds value or appears in the journal (**refuses, naming the row**). A constraint added ahead of its backfill passes on an empty database and stops a deploy on a real one. It also asserts, case for case, that the CHECK and `isValidOwnerId` give the same answer — two copies of one rule in two languages, so the drift is caught here rather than as a 500 on a money path.

`service.freeze.test.ts` builds **two `LedgerService` instances over separate connection pools** against one database and asserts that a freeze on one refuses a post on the other, survives a third instance starting cold, and is attributed to `reconciliation` when the reconciliation job sets it. A test that only asserted `freeze()` set a field would pass against the bug it exists to catch.

Freeze is a `LedgerService` method and deliberately **not** on the `LedgerClient` interface, so it is not in the conformance suite. `LedgerClient` is what every calling service codes against — widening it would hand svc-trade a method to halt the platform, and promise the in-memory reference a durability guarantee it cannot honour.

## Durable recovery and upgrades

Forward migrations `0014`–`0020` widen purpose trim checks, record nullable historical snapshot anchors, preserve immutable posted key/hash/metadata claims, enforce direct-object decimal-string outbox amounts, and add durable freeze event intents. Existing `0000`–`0013` up files retain their published bytes. The runner refuses unnamed lock claims before historical `0007` can stamp a synthetic purpose.

Run the complete upgrade while posting processes are stopped before starting this version. Each forward file and its tracking row commit together under the migration lock. Claims copy the actual stored journal key/hash/metadata; that upgrade baseline cannot prove whether an earlier administrator changed them. Historical digests remain unchanged. Receipt reads and idempotent retries refuse a journal row that contradicts its append-only claim.

Scheduled and operator reconciliation read one REPEATABLE READ snapshot on a dedicated connection, including when the posting pool has one connection. A short READ COMMITTED transaction writes the staged, tip-pinned anchors and ok record, or commits a completed mismatch with its freeze and durable intent. Bus publication follows commit. An error that has not proved the book wrong, including a code-less error and a snapshot write after a green proof, is incomplete and does not freeze on that run; an established mismatch survives a sibling check failing. A stored amount that cannot be parsed, a chain row that cannot be hashed, and a non-text `chain_tip` are proven corruption and freeze. After N consecutive incomplete runs, counted in `reconcile_runs` as well as in this process, the tick freezes as `reconcile_unproven`. An operator thaw does not reset that streak. Old snapshots retain NULL anchors. A chain-only failure reports the actual failure without inventing a balance drift account.

Freeze/thaw intents commit with the switch, receive monotonic sequence identity under its row lock, and drain by that order after commit through the existing bus. Failed sends remain pending, and same-attribution retries drain them without changing the switch again. The full down runner reverses only applied files in one transaction, refuses any posted book, and rolls back tracking deletion with DDL. Direct downs also refuse known snapshot/claim/freeze-event history before removing it.

Posting configuration keeps the current default. Explicit strings enable only after trim/case normalization to `true`, `yes`, `on`, or `1`; malformed, blank, or explicit disable strings freeze durably at boot. This recovery adds no HTTP transaction-receipt route or bearer authority to the internal service door.
