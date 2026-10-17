# ADR: Reconciliation proves a snapshot; an unfinished proof never freezes posting

**Status:** Accepted, phase 1. **Date:** 2026-10-14; revised 2026-10-15; revised 2026-10-17 for D-128.

**Area:** svc-ledger. **Issue:** #4755. **Policy:** `LEDGER-RECONCILE-NO-FREEZE-ON-INCOMPLETE`.

**Decision authority:** agents, under Nitro's money-safety delegation and explicit requirement that incomplete reconciliation never freezes posting.

## Problem

The scheduled runner treated any proof or snapshot-write error as `reconciliation mismatch` and durably froze posting. Historical local-stack logs captured PostgreSQL `57014` statement timeouts in the snapshot insert's account foreign-key check on 2026-10-14 at 08:50 and 09:51 WITA. A timeout provides no corruption verdict. The precise historical blocker was not captured.

The proof also held `chain_tip` for its entire scan, blocking posts. The operator proof used separate pool reads without a consistent snapshot and could report a false mismatch while posts committed.

## Decision

1. **Three outcomes.** `ok` means the complete proof succeeded and its balance snapshots were saved. `mismatch` means a completed report has `ok: false` (drift, a broken chain, an unbalanced asset, a stored amount that cannot be parsed, or a chain row that cannot be hashed), or the run threw `CorruptReconcileAmountError`, or the `chain_tip` seq/hash shape check threw `CorruptChainTipError`. `incomplete` means every other error, including an error with no code, a TLS failure such as `CERT_HAS_EXPIRED`, and a network code that is not on any list. Its `errorCode` is `reconcileErrorCode` (`unknown` when the error has no code). One incomplete attempt is recorded best effort and does not freeze. Once the proof has returned `ok: true`, a later failure (the snapshot write) is incomplete and is never a mismatch. A missing `chain_tip` singleton or an unparsable persisted numeric established by successful reads is corruption. Any completed failed check takes precedence over a sibling timeout; a clean partial check plus timeout remains incomplete. Partial mismatch reports explicitly list unavailable checks and corrupt numeric fields instead of inventing a drift amount.
2. **One consistent snapshot.** Scheduled and operator checks use one REPEATABLE READ transaction on an owned dedicated connection. They take no posting lock. Every post atomically commits entries, cached balances and chain tip, so the snapshot covers a complete committed prefix. Posts continue while the proof reads.
3. **Anchors retain the proved values.** Balances are copied into a session-local temporary table inside that snapshot. After the proof commits, a short READ COMMITTED transaction writes those staged balances, their covered sequence/hash/entry id, and the `ok` run together. This avoids REPEATABLE READ foreign-key failures when live posts update referenced accounts. An unsuccessful insert rolls back the anchors and `ok` record together and becomes incomplete.
4. **Single flight spans both transactions.** A schema-scoped session advisory lock remains held from proof start through the verdict or snapshot commit. A competing scheduled run skips; the operator receives `ledger.reconcile_in_progress`. Cleanup unlocks and closes only the owned proof connection, including when explicit unlock fails. The posting pool remains usable.
5. **Completed mismatch still halts durably.** A short READ COMMITTED transaction commits the mismatch record, posting freeze and freeze-event outbox together. Publication follows commit. If recording fails, the completed mismatch verdict survives and the caller still attempts the freeze. Existing operator attribution is preserved. An infrastructure failure that prevents both recording and freezing remains a surfaced failure, not a claim of a successful halt.
6. **Separate operational bounds.** Reconciliation uses `LEDGER_RECONCILE_STATEMENT_TIMEOUT_MS` (default 600,000 ms, validated 1,000–3,600,000) with SET LOCAL. Posting retains its existing pool timeout. This bounds each SQL statement, not total proof duration. The runner does not retry within a tick.
7. **Retry, alert, then halt.** Consecutive incomplete runs skip the next 0, 1, 3, 7, then 8 ticks, counted in this process; an ok run resets that in-memory backoff. Every incomplete run emits `ledgerReconciliationRunFailed`. The streak that freezes is the larger of that in-memory count and the durable count: incomplete rows whose id is greater than the latest `ok` or `mismatch` row. After `RECONCILE_MAX_CONSECUTIVE_INCOMPLETE` (default 3, D-128) posting freezes with reason `reconcile_unproven`, and the alert carries the larger number. If the durable read throws, the tick logs fatal and uses the in-memory count. Backoff keeps using the in-memory count. A single timeout does not freeze. An operator thaw does not reset either count: the next incomplete run freezes again while the larger streak is still at the limit. Every tick also reports last verified evidence. `LEDGER_RECONCILE_MAX_STALE_HOURS` (default 24) is a reporting threshold: stale verification emits a fatal log and never freezes by itself. `/health` and `/metrics` expose the highest verified sequence and its verification time; older evidence cannot move coverage backward.
8. **Honest delivery.** Fatal logs and drift events do not establish that a person was paged: no alert subscriber is wired here. Operators must monitor the logs/metrics. A successful proof does not automatically thaw an existing freeze; the approved operator recovery procedure remains required.

## Trade-offs and rejected alternatives

Keeping the entire proof under the posting lock would retain the same posting stall and scaling problem. Freezing on the first incomplete run, or on an error that has not proved the book wrong, would reintroduce the original availability failure. D-128 freezes only on a proven mismatch, or after N consecutive incomplete runs (default 3) as `reconcile_unproven`. The durable streak survives a restart, so restarting the service does not clear it.

Posts can continue on a broken book until a proof completes and finds the mismatch, and through up to N consecutive unfinished proofs. Long snapshots also retain old row versions and can increase database pressure. This phase does not introduce incremental reconciliation, a pager, or a posting-latency claim.

## Evidence and deployment

The regression tests exercise real PostgreSQL statement cancellation, durable mismatch freeze/outbox, concurrent posts during proof, consistent anchors, serialization through the post-proof snapshot write, unlock failure cleanup, retry, stale reporting, and health/metrics. Exact commands/results belong to the implementation/PR receipts; source existence alone is not a passed run.

Migration `0022` adds `reconcile_runs`; apply it before deploying the new runner. Old instances retain the old timeout-freeze behavior until replaced. Its down migration refuses to discard recorded proof history. Existing journal guards from current main remain in force.

| Rule id                                    | Rule                                                                                                                                                                                                                | Status                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `LEDGER-RECONCILE-NO-FREEZE-ON-INCOMPLETE` | One incomplete run does not freeze posting. A proven mismatch freezes immediately. After N consecutive incomplete runs (default 3) posting freezes as `reconcile_unproven`. Stale verification alone never freezes. | Accepted, phase 1, D-128 |
