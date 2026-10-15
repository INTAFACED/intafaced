# ADR: Reconciliation proves a snapshot; an unfinished proof never freezes posting

**Status:** Accepted, phase 1. **Date:** 2026-10-14; revised 2026-10-15.  
**Area:** svc-ledger. **Issue:** #4755. **Policy:** `LEDGER-RECONCILE-NO-FREEZE-ON-INCOMPLETE`.  
**Decision authority:** agents, under Nitro's money-safety delegation and explicit requirement that incomplete reconciliation never freezes posting.

## Problem

The scheduled runner treated any proof or snapshot-write error as `reconciliation mismatch` and durably froze posting. Historical local-stack logs captured PostgreSQL `57014` statement timeouts in the snapshot insert's account foreign-key check on 2026-10-14 at 08:50 and 09:51 WITA. A timeout provides no corruption verdict. The precise historical blocker was not captured.

The proof also held `chain_tip` for its entire scan, blocking posts. The operator proof used separate pool reads without a consistent snapshot and could report a false mismatch while posts committed.

## Decision

1. **Three outcomes.** `ok` means the complete proof succeeded and its balance snapshots were saved. `mismatch` means a completed proof found drift, broken chain structure, or an unbalanced asset. `incomplete` means a timeout, unavailable database, failed snapshot insert, or another interruption prevented a successful run. An incomplete attempt is recorded best effort and reported; it never changes posting. A missing `chain_tip` singleton established by successful reads is a structural mismatch.
2. **One consistent snapshot.** Scheduled and operator checks use one REPEATABLE READ transaction on an owned dedicated connection. They take no posting lock. Every post atomically commits entries, cached balances and chain tip, so the snapshot covers a complete committed prefix. Posts continue while the proof reads.
3. **Anchors retain the proved values.** Balances are copied into a session-local temporary table inside that snapshot. After the proof commits, a short READ COMMITTED transaction writes those staged balances, their covered sequence/hash/entry id, and the `ok` run together. This avoids REPEATABLE READ foreign-key failures when live posts update referenced accounts. An unsuccessful insert rolls back the anchors and `ok` record together and becomes incomplete.
4. **Single flight spans both transactions.** A schema-scoped session advisory lock remains held from proof start through the verdict or snapshot commit. A competing scheduled run skips; the operator receives `ledger.reconcile_in_progress`. Cleanup unlocks and closes only the owned proof connection, including when explicit unlock fails. The posting pool remains usable.
5. **Completed mismatch still halts durably.** A short READ COMMITTED transaction commits the mismatch record, posting freeze and freeze-event outbox together. Publication follows commit. If recording fails, the completed mismatch verdict survives and the caller still attempts the freeze. Existing operator attribution is preserved. An infrastructure failure that prevents both recording and freezing remains a surfaced failure, not a claim of a successful halt.
6. **Separate operational bounds.** Reconciliation uses `LEDGER_RECONCILE_STATEMENT_TIMEOUT_MS` (default 600,000 ms, validated 1,000–3,600,000) with SET LOCAL. Posting retains its existing pool timeout. This bounds each SQL statement, not total proof duration. The runner does not retry within a tick.
7. **Retry and report.** Consecutive incomplete runs skip the next 0, 1, 3, 7, then 8 ticks; an ok run resets backoff. Every tick also reports last verified evidence. `LEDGER_RECONCILE_MAX_STALE_HOURS` (default 24) is a reporting threshold: stale verification emits a fatal log and never freezes. `/health` and `/metrics` expose the highest verified sequence and its verification time; older evidence cannot move coverage backward.
8. **Honest delivery.** Fatal logs and drift events do not establish that a person was paged: no alert subscriber is wired here. Operators must monitor the logs/metrics. A successful proof does not automatically thaw an existing freeze; the approved operator recovery procedure remains required.

## Trade-offs and rejected alternatives

Keeping the entire proof under the posting lock would retain the same posting stall and scaling problem. Freezing after repeated incomplete runs would reintroduce the original availability failure after a delay, so the previous draft's 24-hour freeze backstop is removed.

Posts can continue on a broken book until a proof completes and finds the mismatch. Persistent incomplete runs can leave the book unverified indefinitely; reporting and retry do not remove that risk. Long snapshots also retain old row versions and can increase database pressure. This phase does not introduce incremental reconciliation, a pager, or a posting-latency claim.

## Evidence and deployment

The regression tests exercise real PostgreSQL statement cancellation, durable mismatch freeze/outbox, concurrent posts during proof, consistent anchors, serialization through the post-proof snapshot write, unlock failure cleanup, retry, stale reporting, and health/metrics. Exact commands/results belong to the implementation/PR receipts; source existence alone is not a passed run.

Migration `0022` adds `reconcile_runs`; apply it before deploying the new runner. Old instances retain the old timeout-freeze behavior until replaced. Its down migration refuses to discard recorded proof history. Existing journal guards from current main remain in force.

| Rule id                                    | Rule                                                                                                                            | Status            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `LEDGER-RECONCILE-NO-FREEZE-ON-INCOMPLETE` | Only a completed mismatch freezes posting. Incomplete and stale verification are reported and retried without changing posting. | Accepted, phase 1 |
