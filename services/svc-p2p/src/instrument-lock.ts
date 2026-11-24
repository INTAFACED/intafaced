import type { Queryable } from '@intafaced/db';

/**
 * THE ERASE/TAKE LOCK — one person's payment destinations, one writer at a time.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RACE THIS EXISTS FOR, exactly as it was reproduced
 *
 * `eraseFor` runs at READ COMMITTED and, before this file, took no lock at all.
 * Its refusal read — "is any trade of this person still open or unsettled?" —
 * was a plain `SELECT` with no `FOR UPDATE`, and nothing re-examined it before
 * the transaction committed. A take that STARTED after erase's UPDATEs and
 * before its COMMIT reads the pre-update row under MVCC, because that is what
 * READ COMMITTED means and the erase has not committed yet:
 *
 *     erase · refusal check      -> 0 live trades (proceeds)
 *     erase · REPORTS TO USER:      instruments erased=1, frozen snapshots erased=0
 *     take  · attachToTrade         sees 1 active instrument(s)
 *     trade snapshot: { "purged_at": null, "details": { "account_number": "…" } }
 *
 * Both transactions are individually correct. Together they leave the person's
 * bank details in cleartext on a trade, in a row erase never saw, after erase
 * told them their details were gone. It is not a window that closes either:
 * `purgeExpiredSnapshots` only sweeps TERMINATED trades, so a trade that never
 * terminates carries it indefinitely.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A LOCK AND NOT `FOR UPDATE`
 *
 * `SELECT … FOR UPDATE` on `payment_instruments` fixes exactly one ordering. If
 * the take goes first, there is nothing to lock: the row erase must not miss is
 * the `trade_payment_instruments` snapshot the take has not INSERTED yet, and
 * no lock can be taken on a row that does not exist. The predicate erase needs
 * to hold — "this person acquires no new trade before I commit" — is about rows
 * that are not there, which is what an advisory lock is for and what row locks
 * structurally cannot express.
 *
 * So both directions take the SAME key, and both take it FIRST:
 *
 *   · erase first → the take blocks, and when it runs the instrument is
 *     `removed`, so `attachToTrade` refuses the take like any other seller with
 *     no destination. The buyer sees the same sentence every refused take sees.
 *   · take first  → erase blocks, and when it runs its refusal read sees the
 *     new open trade and refuses with `p2p.erase_blocked`, naming it. The
 *     person is told the truth instead of a manifest that is wrong.
 *
 * Both outcomes are coherent. The one that could not be reached before is the
 * incoherent one.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ORDERING, so this cannot become the deadlock it is preventing
 *
 * A take involves TWO people — the maker and the taker, either of whom may be
 * the seller depending on the offer's side — and it also takes row locks on
 * `p2p.offers`, which `eraseFor` DELETEs from. That is a lock-order inversion
 * waiting to happen, so two rules, both of them here rather than at the call
 * sites:
 *
 *   1 · keys are acquired in SORTED order, so two concurrent takes over the
 *       same pair of people cannot each hold the key the other wants;
 *   2 · every caller takes these keys BEFORE any row lock, which is why
 *       `reserveTrade` locks on the offer PREVIEW's `maker_id` rather than
 *       waiting until it has the offer row. `maker_id` is written once at
 *       insert and by nothing afterwards — the three `UPDATE p2p.offers`
 *       statements in this service touch `status`, `remaining_amt` and
 *       `updated_at` — so reading it unlocked cannot name the wrong person.
 *
 * `pg_advisory_xact_lock` and not a session lock: it is released by COMMIT or
 * ROLLBACK, including the rollback a refused take causes, so no path can leak
 * it. The two-integer form keeps this out of the single-bigint key space the
 * suites' migration lock uses — Postgres does not let the two overlap.
 */

/**
 * The class half of the key. Any constant, as long as every caller uses the
 * same one; this one sits beside the suites' migration lock so a reader
 * grepping for advisory locks in this service finds both.
 */
export const INSTRUMENT_OWNER_LOCK_CLASS = 8_140_703;

/**
 * Take the payment-instrument lock for each of these people, for the rest of
 * the transaction.
 *
 * `hashtext` collides, and a collision costs two unrelated people a moment of
 * serialisation — never correctness, because a collision can only ever make
 * this more exclusive than it needs to be.
 */
export async function lockInstrumentOwners(tx: Queryable, ...ownerIds: string[]): Promise<void> {
  for (const ownerId of [...new Set(ownerIds)].sort()) {
    await tx`SELECT pg_advisory_xact_lock(${INSTRUMENT_OWNER_LOCK_CLASS}, hashtext(${ownerId}))`;
  }
}
