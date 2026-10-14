# ADR: Ledger reconciliation proves from a snapshot, and a proof that cannot finish does not freeze the book

**Status:** Accepted (phased). Phase 1 (this change) is built: outcome split, snapshot proof, single-flight, staleness backstop, `reconcile_runs`. Phase 2 (incremental proof and its hardening) is designed, not built, and stays Proposed.  
**Date:** 2026-10-14  
**Deciders:** agents (Opus lead, Opus refuter), under Nitro's 2026-10-14 delegation of money-safety rules. **Written by:** agents (Claude).  
**Area:** `svc-ledger` (`ledger/reconcile.ts`, `scheduled-reconcile-tick.ts`, `service.ts`, migration `0022_reconcile_runs`).  
**Issue:** #4755. **Policy rule:** `LEDGER-RECONCILE-NO-FREEZE-ON-INCOMPLETE` (register entry at the end).

## Context and problem

`runScheduledReconciliation` froze ALL posting on ANY error from the hourly proof and labelled it `reconciliation mismatch`. That included a Postgres statement timeout (`57014`), where nothing was found wrong: "the proof could not finish" was treated as "the books are wrong". The same proof ran inside the transaction that holds the singleton `chain_tip` row `FOR UPDATE`, which is the lock every post takes first, so the proof blocked every post for its whole length. The proof is `reconcileBalances` (one `GROUP BY` over all of `ledger_entries`) plus `verifyChain` (paged, from genesis), and it runs under the pool-wide 15 s `statement_timeout` that posts need. On the local stack at 228k transactions it froze twice in one day (2026-10-14, 08:50 and 09:51 WITA).

What the code did at `origin/main` `92fb6102b`:

- The freeze on a throw was written in two places: inside `runScheduledReconciliation` (in the lock-holding transaction, before rethrowing) and again by the tick's `catch`.
- `LedgerService.reconcile` (the operator door, `POST /operator/reconcile` and the tRPC mutation) ran the three checks on the pool, in no transaction, without the tip lock. Under live posts it could report a false `ok: false` (`verifyChain` reads `chain_tip` after its last page), and at scale it would hit the 15 s timeout, which makes "thaw only after the book verifies" impossible.
- No alert path exists: `ledgerReconciliationFailed` has no subscriber, and there is no Alertmanager or pager wired. A fatal log line reaches nobody by itself.

## Options

- **A. Minimal.** Keep the proof under the lock, only stop freezing on non-mismatch errors. Leaves the lock hold and the scaling wall: the proof still times out, and every hour posts stall for up to 15 s.
- **B. Split outcomes and prove from a snapshot** with no tip lock, then (phase 2) prove incrementally from the last verified checkpoint with a periodic full proof.
- **C. Per-post verification only**, drop the scheduled proof. Loses the independent whole-book check; the per-post hash chain proves chain integrity, not balance integrity.
- **D. Always freeze on an incomplete proof** (today). Availability harm, and an alert that cannot tell an outage of the checker from a broken book.

## Decision

**B, in two phases. Phase 1 is this change.**

1. **Outcome model.** A run ends `ok`, `mismatch` or `incomplete`.
   - `mismatch`: a completed proof returned not-ok (balance drift, broken hash chain, unbalanced asset). The run is recorded and posting is **frozen**, exactly as before: reason `reconciliation mismatch`, actor `reconciliation`, in a **separate READ COMMITTED transaction** after the proof's transaction commits.
   - `incomplete`: any error before a verdict (timeout, connection loss, insert failure, a bug). The attempt is recorded best effort, a fatal `LEDGER RECONCILIATION INCOMPLETE` is logged, and **nothing is frozen**. The tick no longer freezes on a throw.
   - A verdict is never lost to a later failure: if the proof finished with a mismatch and only recording it failed, the run still reports `mismatch` and the freeze still lands. If the freeze itself fails, a distinct error (`ledger.reconcile_freeze_failed`) makes the tick retry the freeze.
2. **Snapshot, not lock.** The proof runs in `BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE` on its own pooled connection and takes **no `chain_tip` lock**. It reads the tip (seq, hash, highest entry id) inside the snapshot. The ledger is append-only at runtime and every post commits its entries, the `accounts.balance` update and the `chain_tip` advance in one transaction under the tip lock, so a snapshot always sees a whole prefix of the chain, never half a post. A snapshot at seq S proves "everything through S"; posts continue.
   - It is READ WRITE and the `balance_snapshots` rows are read from the same snapshot, which pins them to the exact tip (the gap-commit bug migration 0015 fixed). They are **not inserted inside it**: `balance_snapshots.account_id` is a foreign key to `accounts`, and in REPEATABLE READ an FK check on a row that a post has updated since the snapshot began fails with `could not serialize access due to concurrent update` (`40001`). On a live book that is every run. The first version of this change did exactly that insert and failed its own concurrency tests. So inside the snapshot the balances are copied to a session-local temp table, the snapshot commits, and a short READ COMMITTED transaction on the same connection writes the staged rows and the `ok` run row together (atomic; the values still never left the snapshot). A `mismatch` run row has no FK and is written inside the snapshot. A `40001` is not retried (a retry would be a second long snapshot inside one tick).
   - `SET LOCAL statement_timeout = 10 min` inside that transaction (constant, env override `LEDGER_RECONCILE_STATEMENT_TIMEOUT_MS`, validated 1 s to 1 h). Posts keep the pool-wide 15 s.
3. **Single flight.** `pg_try_advisory_xact_lock` on a key derived from the schema name is the first statement of the run. A tick that finds it held skips quietly. The operator door answers 409 `ledger.reconcile_in_progress`. The transaction-scoped form releases on commit, rollback or a dropped connection, so no unlock can be forgotten. (The brief said `pg_try_advisory_lock`; the session-level form needs a dedicated connection and an explicit unlock, which the pooled client does not give for free.)
4. **Backoff across ticks, never inside one.** After the n-th consecutive incomplete run the next 0, 1, 3, 7, then 8 ticks are skipped. No in-tick retries: three 10-minute snapshots in one tick is the failure this removes.
5. **Staleness backstop.** At every tick (skipped ones included), if the last `ok` run is older than `LEDGER_RECONCILE_MAX_STALE_HOURS` (default 24, validated 1 to 720), freeze with reason `reconciliation stale`, actor `reconciliation`. With no `ok` run ever, the age is measured from the first recorded attempt, else from process boot. An operator freeze already standing is never overwritten (`ledger.freeze_attributed`).
6. **Visibility.** `GET /health` returns `lastVerifiedAt` and `lastVerifiedSeq`. `/metrics` carries `ledger_reconcile_last_verified_timestamp_seconds` and `ledger_reconcile_last_verified_seq` (0 = never). Each tick logs the same two fields.
7. **One proof path.** `LedgerService.reconcile` (operator and tRPC) uses the same snapshot runner, so it works at scale and cannot report a false `ok: false` under live posts. It keeps its report shape and its freeze on a failed report. An `incomplete` run throws `ledger.reconcile_incomplete` (HTTP 503), which is neither a green nor a red.
8. **Mixed deploy.** Migrate first (`0022` is additive: one new table). Old pods keep freezing on a throw until they drain. Pre-0015 snapshot rows with NULL tips are never read by the proof and are left untouched.
9. **Thaw rule unchanged.** Unfreeze only after the book verifies, which now means a fresh `ok` run. A stale freeze is lifted the same way; thawing without an `ok` run re-freezes on the next tick.

## Phase 2 (separate change, same ADR)

- Incremental proof from the last `ok` run using `through_entry_id` (`ledger_entries.id` is assigned under the tip lock, so `id <= E` means "through S") with the comparisons the first sketch missed: an account created in the window has checkpoint balance 0; an anti-join of checkpoint accounts against `accounts`; `totalsByAsset` on every run; `verifyChain` starting from the checkpoint hash.
- Index on `balance_snapshots.chain_tip_seq`, append-only checkpoint rows, pruning.
- Full proof **daily** (not weekly) and resumable; staleness limit for the last full proof (the lead proposed 8 days, to be re-derived once the daily job exists).
- `BEFORE UPDATE/DELETE` append-only triggers on `ledger_entries` and on the full `ledger_tx` row, closing the old-row tampering detection gap (today only a full proof catches an edited old entry; `0016`, `0017`, `0018` cover only key and metadata).
- Measure post p99 during a full run (snapshot cost on the hot `chain_tip` and house accounts).

## Evidence

| Claim                                                                                                                                                                                                                                                                                                                   | Source                                                                                                                                                     | Status                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| A repeatable read transaction "sees a snapshot as of the start of the first non-transaction-control statement"; it "never sees either uncommitted data or changes committed by concurrent transactions during the transaction's execution".                                                                             | https://www.postgresql.org/docs/current/transaction-iso.html (read 2026-10-14)                                                                             | Verified                                             |
| A repeatable read transaction that tries to modify or lock a row changed by another transaction after it began is rolled back with `could not serialize access due to concurrent update`; the application "should abort the current transaction and retry".                                                             | same page                                                                                                                                                  | Verified                                             |
| `statement_timeout` aborts any statement longer than the value; no unit means milliseconds; 0 disables it; in a multi-statement simple query each statement is timed separately; setting it in `postgresql.conf` "is not recommended because it would affect all sessions".                                             | https://www.postgresql.org/docs/current/runtime-config-client.html (read 2026-10-14)                                                                       | Verified                                             |
| `SET LOCAL` lasts to the end of the current transaction; `set_config(..., true)` is the same.                                                                                                                                                                                                                           | PostgreSQL `SET` reference (general knowledge; that page was not fetched here)                                                                             | Not re-fetched                                       |
| Ledger and payments vendors (Modern Treasury, Stripe, Square, Increase) treat a failed reconciliation run as an alertable job state and a break as a business event.                                                                                                                                                    | Lead's draft                                                                                                                                               | **Unverified.** No part of the decision rests on it. |
| Tests in this change: a post commits while a proof's snapshot is open and is not blocked; the snapshot rows carry the proof's tip even with a post in between; a real `57014` is recorded as `incomplete` and freezes nothing; a finished mismatch freezes; a stale book freezes; two runs started together prove once. | `services/svc-ledger/src/ledger/reconcile-snapshot.test.ts`, `snapshot-anchor.test.ts`, `scheduled-reconcile-tick.test.ts`, `recovery-integration.test.ts` | Run against local Postgres 16                        |

## Consequences

- Good: a slow or failed proof no longer halts the platform; posts are no longer queued behind a proof; the operator reconcile works at scale and stops lying under load; the book's last proof time is visible on `/health` and `/metrics`; an unprovable book still halts, after 24 hours, with a reason that says why.
- Bad, stated plainly: **posts continue on a broken book for the duration of one proof.** A break is frozen when the proof finishes, not while it reads. That is seconds to minutes against a 60-minute cadence, and grows with the book until phase 2.
- Bad: a book with a persistent timeout runs unverified for up to 24 hours before the backstop halts it. The default is a judgement, not a measurement; the page that should shorten it (a real alert subscriber) does not exist yet.
- Bad: a long snapshot holds back vacuum cleanup of rows changed during it, and the hot `chain_tip` and house account rows are updated on every post. Unmeasured; phase 2 measures it.
- Risk: a single replica set shares one advisory lock key per schema, so a stuck run (hung connection) holds the lock until its statement timeout or its connection ends. The 10-minute timeout bounds it.
- Not covered by phase 1: `incomplete` still produces no alert on its own. The backstop freeze is the only guaranteed signal.

## Reversibility

Two-way door. `0022` has a down migration that refuses while any run is on file (proof history must be preserved), so a rollback of the table needs a deliberate delete first. Behaviour reverts by redeploying the previous version; nothing else depends on the new outcomes.

## Revisit when

- A real alert subscriber (pager, Alertmanager) exists for `LEDGER RECONCILIATION INCOMPLETE`: shorten `LEDGER_RECONCILE_MAX_STALE_HOURS` and reconsider whether the backstop should still freeze.
- A stale or incomplete window is ever followed by a found mismatch older than that window (the "posts continue unverified" bet failed once).
- A full proof exceeds half the statement timeout: build phase 2 before it hits the wall.
- Posting rate or book size makes the measured post p99 during a proof worse than the posting SLO.

## Policy register entry

| Rule id                                    | Rule                                                                                                                                                                                                                                          | ADR                                                                        | Status            | Owner                    |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------- | ------------------------ |
| `LEDGER-RECONCILE-NO-FREEZE-ON-INCOMPLETE` | Only a completed reconciliation proof that found a break freezes posting; a proof that could not finish is recorded and paged, and the staleness backstop (`reconciliation stale`, default 24 h) freezes a book that cannot be proved at all. | `docs/adr/2026-10-14-ledger-reconcile-snapshot-no-freeze-on-incomplete.md` | Accepted (phased) | agents (Nitro delegated) |
