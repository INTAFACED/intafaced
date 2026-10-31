import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import {
  accountKey,
  accountPurpose,
  assertBalanced,
  assertIdempotencyKey,
  assertValidPost,
  formatAmount,
  hashTx,
  postFingerprint,
  replayMetaDiffers,
  signedDelta,
  IDEMPOTENCY_CONFLICT_CODE,
  type IdempotencyConflictOptions,
  InsufficientFundsError,
  LedgerError,
  type AccountRef,
  type Balance,
  type LedgerClient,
  type LedgerTx,
  type PostRequest,
  type PostedEntry,
} from '@intafaced/ledger-client';
import { assessClockSkew, readDatabaseNow, sampleClocks, SKEW_BOUND_UNSET, WRITES_BLOCKED_CLOCK_SKEW } from './clock-skew.js';
import { frozenMessage } from './freeze.js';
import {
  HISTORY_MAX_ENTRIES,
  HistoryTooLargeError,
  allowedHistoryRail,
  orderIdFromHoldPurpose,
  decodeHistoryCursor,
  encodeHistoryCursor,
  type HistoryEntry,
  type HistoryPage,
  type HistoryPageInput,
  type HistoryRange,
} from './history.js';
import { assertScaledBigintAmounts, parseStoredAmount } from './live-money.js';
import type { FeeRevenueRow } from './fee-revenue.js';
import { LEDGER_HOLDINGS_HISTORY_MAX_ROWS, LEDGER_HOLDINGS_HISTORY_TOO_LARGE } from '@intafaced/contracts';
import type { HoldingsHistory, HoldingsHistoryInput } from './holdings-history.js';

/** `restore.watermark.read` as of an instant: the instant is malformed (400). */
export const RESTORE_ASOF_INVALID = 'ledger.restore_asof_invalid' as const;
/** `restore.watermark.read` as of an instant: the instant is not yet far enough past to be fixed (409). */
export const RESTORE_ASOF_UNANSWERABLE = 'ledger.restore_asof_unanswerable' as const;

export interface PostgresLedgerOptions extends IdempotencyConflictOptions {
  /**
   * Owner bound in milliseconds. Null or omitted is unset, not zero.
   * Explicit 0 is a real bound. A blank bound must not be passed as 0.
   */
  readonly clockSkewBoundMs?: number | null;
  readonly now?: () => Date;
  /** Defaults to `clock_timestamp()`. Tests pass the service's reader. */
  readonly readDatabaseNow?: (sql: Sql) => Promise<Date>;
}

/**
 * THE LEDGER, on Postgres.
 *
 * Every invariant in §4.2 holds here, and holds in three places on purpose:
 *
 *   1. `assertValidPost` — shared with the reference implementation, so the
 *      rules cannot diverge between them.
 *   2. This transaction — balance checks against locked rows.
 *   3. Database CHECK constraints — a bug in this file still cannot create money.
 *
 * Concurrency: every post takes `FOR UPDATE` on the singleton chain-tip row
 * before reading anything it will write. That lock — not the isolation level —
 * is what totally orders posts, makes the hash chain a chain, and makes
 * concurrent spends impossible to interleave into an overdraft. See the
 * isolation note at the end of `post()` for why READ COMMITTED is correct here.
 *
 * The kill-switch is read under that same lock, not above it — a freeze that a
 * post already in flight can outrun would not be one. See `post()`.
 *
 * Schema: SQL is search_path-relative (not hard-coded `ledger.*`). Production
 * connects with `search_path = ledger,public` (see `src/index.ts`). Tests use
 * `createTestDb`, which allocates a unique schema per suite so parallel
 * worktrees cannot TRUNCATE each other into a false insufficient-funds failure.
 */
export class PostgresLedger implements LedgerClient {
  constructor(
    private readonly sql: Sql,
    private readonly options: PostgresLedgerOptions = {},
  ) {}

  async post(request: PostRequest): Promise<LedgerTx> {
    // The shared order, documented at `assertIdempotencyKey`: key, then
    // idempotency, then body (STOP §4.2b #4).
    //
    // This used to validate the whole request first — "no point opening a
    // transaction for a request that can never be legal", which is true as a
    // cost argument and wrong as a correctness one. It made this engine throw
    // where `MemoryLedger` returned the committed transaction, for the one input
    // that matters: a retry of a body that was legal when it posted and is not
    // legal now. Every tightened validation rule creates that input, and the
    // conformance suite could not see the divergence because it only ever
    // replayed a VALID request.
    //
    // The order below is also the order this engine already uses inside the
    // lock, where idempotency deliberately precedes the freeze check for exactly
    // the same reason. It was inconsistent with itself, not just with memory.
    //
    // Cost of the change: one indexed single-row lookup before refusing a
    // malformed request. The lock is still never taken for one.
    assertIdempotencyKey(request.idempotencyKey);

    // Fast path — a retry that has already committed needs no lock at all.
    // Clock skew is not consulted here: the value already moved.
    const existing = await this.loadClaimedTxByKey(this.sql, request.idempotencyKey);
    if (existing) return this.replayOf(existing, request);

    // A JS-number amount is a TypeError inside bigint math —
    // refuse it as invalid money, not a crash that looks like our bug.
    assertScaledBigintAmounts(request.entries);
    assertValidPost(request);

    return transaction(
      this.sql,
      async (tx) => {
        // THE LOCK. Everything after this line runs single-file, platform-wide.
        //
        // Taken first, before any read this transaction will later write, so it
        // establishes a total order over posts by itself — which is exactly why
        // READ COMMITTED is sufficient here (see the isolation note below) and
        // why the hash chain can be a chain at all.
        //
        // A statement waiting on the tip lock can retain a pre-wait snapshot
        // of any joined freeze row. Lock first; the separate freeze read below
        // starts a fresh statement snapshot after that wait has completed.
        const tipRows = await tx<Array<{ hash: string | null; seq: string }>>`
          SELECT hash, seq FROM chain_tip WHERE id = true FOR UPDATE
        `;

        const tip = tipRows[0];
        if (!tip) {
          throw new LedgerError('chain_tip / posting_freeze row is missing — the ledger is not initialised', 'ledger.uninitialised');
        }

        // Re-check inside the lock: two retries of the same key can both get
        // past the fast path above.
        //
        // Ahead of the freeze check, matching that fast path. A retry of a
        // transaction that ALREADY COMMITTED returns the original even while
        // frozen: the value moved, and telling a caller otherwise would have it
        // retry a movement that already happened. The freeze stops new writes,
        // not the truth about old ones.
        const inTx = await this.loadClaimedTxByKey(tx, request.idempotencyKey);
        if (inTx) return this.replayOf(inTx, request);

        // Both lookups missed, so this key has not committed. Same place as the
        // freeze: a drifted clock refuses a new write and must not hide a retry.
        await this.refuseNewWriteOnClockSkew(tx);

        const freezeRows = await tx<Array<{ frozen: boolean; reason: string | null }>>`
          SELECT frozen, reason FROM posting_freeze WHERE id = true
        `;
        const freeze = freezeRows[0];
        if (!freeze) throw new LedgerError('posting_freeze row is missing — the ledger is not initialised', 'ledger.uninitialised');
        if (freeze.frozen) throw new LedgerError(frozenMessage(freeze.reason), 'ledger.frozen');

        // Inside the lock: a body that does not sum to zero never writes. The
        // shared `assertValidPost` already ran; this is the engine's own refuse
        // so removing the outer call cannot mint money.
        assertScaledBigintAmounts(request.entries);
        assertBalanced(request.entries);

        const previousHash = tip.hash;

        // Lock accounts in a deterministic order. The chain-tip lock already
        // prevents deadlock, but ordering keeps that true if the tip lock is ever
        // sharded away (§13 socket).
        const ordered = [...request.entries].sort((a, b) => accountKey(a.account).localeCompare(accountKey(b.account)));

        const balances = new Map<string, { id: string; balance: bigint }>();
        for (const entry of ordered) {
          const key = accountKey(entry.account);
          if (balances.has(key)) continue;
          balances.set(key, await this.upsertAccount(tx, entry.account));
        }

        // Apply every entry, checking as we go.
        const txId = crypto.randomUUID();
        const postedAt = new Date();
        const postedEntries: PostedEntry[] = [];

        for (const entry of request.entries) {
          const key = accountKey(entry.account);
          const account = balances.get(key)!;
          const next = account.balance + signedDelta(entry);

          if (next < 0n && entry.account.ownerType !== 'treasury') {
            throw new InsufficientFundsError(account.id, entry.account.assetId, formatAmount(entry.amount), formatAmount(account.balance));
          }

          account.balance = next;
          postedEntries.push({
            id: '', // assigned by the database
            txId,
            accountId: account.id,
            assetId: entry.account.assetId,
            direction: entry.direction,
            amount: entry.amount,
            balanceAfter: next,
          });
        }

        const meta = canonicalMeta(request.meta ?? {});
        const hash = hashTx(
          {
            id: txId,
            module: request.module,
            reason: request.reason,
            postedAt,
            entries: postedEntries,
          },
          previousHash,
        );

        const insertedTx = await tx<Array<{ id: string; seq: string; posted_at: Date }>>`
        INSERT INTO ledger_tx (id, idempotency_key, module, reason, meta, posted_at, hash, previous_hash)
        VALUES (
          ${txId}, ${request.idempotencyKey}, ${request.module}, ${request.reason},
          ${tx.json(meta as never)}, ${postedAt}, ${hash}, ${previousHash}
        )
        RETURNING id, seq, posted_at
      `;
        // Same transaction as the journal row. The claim keeps the key, the
        // hash, and the meta from this insert. Rewriting the journal row does
        // not free the key and does not move this copy.
        await tx`
          INSERT INTO ledger_posted_keys (idempotency_key, tx_id, posted_hash, posted_meta, request_fingerprint)
          VALUES (${request.idempotencyKey}, ${txId}, ${hash}, ${tx.json(meta as never)}, ${postFingerprint(request)})
        `;
        const seq = insertedTx[0]!.seq;

        for (const entry of postedEntries) {
          const inserted = await tx<Array<{ id: string }>>`
          INSERT INTO ledger_entries (tx_id, account_id, asset_id, direction, amount, balance_after)
          VALUES (
            ${txId}, ${entry.accountId}, ${entry.assetId}, ${entry.direction},
            ${formatAmount(entry.amount)}::numeric, ${formatAmount(entry.balanceAfter)}::numeric
          )
          RETURNING id
        `;
          (entry as { id: string }).id = String(inserted[0]!.id);
        }

        for (const [, account] of balances) {
          await tx`
          UPDATE accounts
             SET balance = ${formatAmount(account.balance)}::numeric
           WHERE id = ${account.id}
        `;
        }

        await tx`
        UPDATE chain_tip
           SET hash = ${hash}, seq = ${seq}, updated_at = now()
         WHERE id = true
      `;

        // Same transaction as the book: crash after COMMIT still has a row to
        // publish. Amounts are decimal strings (`formatAmount`). The CHECK
        // rejects a missing entries key and a JSON number amount.
        const outboxPayload = {
          txId,
          module: request.module,
          reason: request.reason,
          hash,
          previousHash,
          entries: postedEntries.map((e) => ({
            accountId: e.accountId,
            assetId: e.assetId,
            direction: e.direction,
            amount: formatAmount(e.amount),
          })),
          postedAt: postedAt.toISOString(),
        };
        await tx`
          INSERT INTO ledger_tx_outbox (tx_id, payload, correlation_id)
          VALUES (
            ${txId},
            ${tx.json(outboxPayload as never)},
            ${request.correlationId ?? txId}
          )
        `;

        return {
          id: txId,
          idempotencyKey: request.idempotencyKey,
          module: request.module,
          reason: request.reason,
          meta,
          postedAt,
          hash,
          previousHash,
          entries: postedEntries,
        } satisfies LedgerTx;
      },
      {
        // READ COMMITTED, deliberately — see the chain-tip lock above.
        //
        // The `FOR UPDATE` on the singleton tip row is taken before this
        // transaction reads any balance it will write, so no two posts can ever
        // interleave: they queue. That is a stronger guarantee than SERIALIZABLE
        // would give us here, and it does not abort.
        //
        // Under SERIALIZABLE the same lock produced a retry storm — 50
        // concurrent posts aborted each other faster than the retry budget
        // could absorb. Queuing is both correct and predictable.
        //
        // The database CHECK constraints remain the final backstop either way.
        isolation: 'read committed',
        maxAttempts: 10,
      },
    );
  }

  async balance(ref: AccountRef): Promise<Balance> {
    const rows = await this.sql<Array<{ id: string; balance: string }>>`
      SELECT id, balance FROM accounts
       WHERE owner_type = ${ref.ownerType}::owner_type
         AND owner_id   = ${ref.ownerId}
         AND asset_id   = ${ref.assetId}
         AND kind       = ${ref.kind}::account_kind
         AND purpose    = ${accountPurpose(ref)}
    `;

    const row = rows[0];
    // An account that has never been touched holds zero. Reading a balance must
    // never have the side effect of creating a row.
    return { account: ref, accountId: row?.id ?? '', amount: row ? parseStoredAmount(row.balance, 'accounts.balance') : 0n };
  }

  async balances(ownerType: AccountRef['ownerType'], ownerId: string): Promise<Balance[]> {
    const rows = await this.sql<
      Array<{ id: string; owner_type: string; owner_id: string; asset_id: string; kind: string; purpose: string; balance: string }>
    >`
      SELECT id, owner_type, owner_id, asset_id, kind, purpose, balance
        FROM accounts
       WHERE owner_type = ${ownerType}::owner_type AND owner_id = ${ownerId}
       ORDER BY asset_id, kind, purpose
    `;

    return rows.map((r) => ({
      account: {
        ownerType: r.owner_type as AccountRef['ownerType'],
        ownerId: r.owner_id,
        assetId: r.asset_id,
        kind: r.kind as AccountRef['kind'],
        // Empty string for unpurposed available — never omit, or two holds
        // keyed without purpose collapse into one wire identity.
        purpose: r.purpose,
      },
      accountId: r.id,
      amount: parseStoredAmount(r.balance, 'accounts.balance'),
    }));
  }

  /**
   * Every entry against ONE account in the half-open window `[from, to)`.
   *
   * The read behind svc-bank's spend projection. See `history.ts` for why it
   * refuses over `HISTORY_MAX_ENTRIES` rather than returning a short array, and
   * for the §13 pagination socket.
   *
   * An account nobody has ever posted to has no row, and this returns `[]` — the
   * same reasoning as `balance()` returning zero for one: a read must never have
   * the side effect of creating an account, and "no movements" is the true and
   * complete answer for an account that has had none. It is NOT an error, and
   * making it one would turn every user who has not yet transacted into a failure
   * on their own analytics screen.
   *
   * `ORDER BY t.posted_at, e.id` and not `posted_at` alone: two entries can share
   * a timestamp (one transaction touching an account twice, or two transactions
   * inside the same instant), and an unstable order makes a re-run of the same
   * read disagree with itself for no reason a caller could diagnose.
   */
  async history(ref: AccountRef, range: HistoryRange): Promise<HistoryEntry[]> {
    // Same identity predicate as `balance()`, `purpose` included: a withdrawal
    // hold and an order's reservation are different accounts, and a history that
    // merged them would report movements the caller did not ask about.
    const accountRows = await this.sql<Array<{ id: string }>>`
      SELECT id FROM accounts
       WHERE owner_type = ${ref.ownerType}::owner_type
         AND owner_id   = ${ref.ownerId}
         AND asset_id   = ${ref.assetId}
         AND kind       = ${ref.kind}::account_kind
         AND purpose    = ${accountPurpose(ref)}
    `;

    const accountId = accountRows[0]?.id;
    if (!accountId) return [];

    // LIMIT cap + 1. One row past the cap is the whole detection: the cheapest
    // way to learn the answer would have been clipped, and it keeps what this
    // process buffers bounded whether the read answers or refuses.
    const rows = await this.sql<HistoryRow[]>`
      SELECT t.id AS tx_id, t.module, t.reason, e.direction, e.amount, t.posted_at
        FROM ledger_entries e
        JOIN ledger_tx t ON t.id = e.tx_id
       WHERE e.account_id = ${accountId}
         AND t.posted_at >= ${range.from}
         AND t.posted_at <  ${range.to}
       ORDER BY t.posted_at ASC, e.id ASC
       LIMIT ${HISTORY_MAX_ENTRIES + 1}
    `;

    if (rows.length > HISTORY_MAX_ENTRIES) throw new HistoryTooLargeError(accountId, range, HISTORY_MAX_ENTRIES);

    return rows.map((r) => ({
      txId: r.tx_id,
      module: r.module,
      reason: r.reason,
      direction: r.direction,
      amount: parseStoredAmount(r.amount, 'ledger_entries.amount'),
      postedAt: r.posted_at,
    }));
  }

  /**
   * Where this ledger stands, for the joint restore (OPS-ledger-desk-05). A READ:
   * no lock and no write, so it can never delay a post. The position is the
   * chain tip's `seq` and the integrity is its hash; `lastWriteAt` is the newest
   * `posted_at`, so a post after the operator's cut-off is visible.
   */
  async restoreWatermark(): Promise<{ position: string; integrity: string | null; lastWriteAt: Date | null }> {
    const [tip] = await this.sql<Array<{ seq: string; hash: string | null }>>`
      SELECT seq::text AS seq, hash FROM chain_tip WHERE id = true`;
    if (!tip) throw new LedgerError('chain_tip is missing: the ledger is not initialised', 'ledger.uninitialised');
    const [last] = await this.sql<Array<{ at: Date | null }>>`SELECT MAX(posted_at) AS at FROM ledger_tx`;
    return { position: tip.seq, integrity: tip.hash, lastWriteAt: last?.at ?? null };
  }

  /**
   * Where this ledger stood at `asOf`, for the joint restore as of its cut-off (OPS-ledger-desk-05, RS-3). A READ. Every
   * post stamps `posted_at` from this process's clock after the chain-tip lock, and a set `LEDGER_CLOCK_SKEW_BOUND_MS`
   * keeps that clock within the bound of the database's. So once the database clock is more than the bound past `asOf`,
   * no post can still land at or before it: `FOR SHARE` on the tip waits out a post in flight, the lock is released, and
   * the position is the newest `seq` posted at or before `asOf` (0, the genesis tip, when none was). A blank bound refuses
   * `ledger.skew_bound_unset`, and a cut-off not yet that far past refuses `ledger.restore_asof_unanswerable`.
   */
  async restoreWatermarkAsOf(asOf: Date): Promise<{ position: string; integrity: string | null; lastWriteAt: Date | null }> {
    const bound = this.options.clockSkewBoundMs;
    if (bound === undefined || bound === null) {
      throw new LedgerError('the clock skew bound is unset, so no position can be fixed as of an instant', SKEW_BOUND_UNSET);
    }
    // The lock only waits out a post already in flight; it is released before the reads below, so no post waits on them.
    const [tip] = await this.sql.begin(
      (tx) => tx<Array<{ now: Date }>>`
      SELECT clock_timestamp() AS now FROM chain_tip WHERE id = true FOR SHARE`,
    );
    if (!tip) throw new LedgerError('chain_tip is missing: the ledger is not initialised', 'ledger.uninitialised');
    if (!(tip.now.getTime() - asOf.getTime() > bound)) {
      throw new LedgerError(
        `the cut-off is not yet more than the clock skew bound (${bound} ms) in the past, so a post could still land at it`,
        RESTORE_ASOF_UNANSWERABLE,
      );
    }
    // The position is the chain prefix posted at or before the cut-off (`posted_at` is each process's clock, so it need not
    // rise with seq; seq is the chain's own order), or the whole chain when no post is stamped after it. `integrity` is the chain hash at that position, null at the genesis 0, as the contract defines it.
    const [at] = await this.sql<Array<{ seq: string | null; hash: string | null; last: Date | null }>>`
      WITH cut AS (
        -- The newest seq before the first post stamped after the cut-off; seqs can skip (a rolled-back post), so the row is
        -- looked up, never computed.
        SELECT COALESCE(
                 (SELECT MAX(seq) FROM ledger_tx
                   WHERE seq < COALESCE((SELECT MIN(seq) FROM ledger_tx WHERE posted_at > ${asOf}), 9223372036854775807)),
                 0
               ) AS seq
      )
      SELECT cut.seq::text AS seq,
             (SELECT hash FROM ledger_tx WHERE ledger_tx.seq = cut.seq) AS hash,
             (SELECT MAX(posted_at) FROM ledger_tx) AS last
        FROM cut`;
    if (!at) throw new LedgerError('the as-of position could not be read', RESTORE_ASOF_UNANSWERABLE);
    return { position: at.seq ?? '0', integrity: at.hash, lastWriteAt: at.last };
  }

  /**
   * Fee revenue per asset over one window (see `fee-revenue.ts`). A READ: no lock,
   * no write, no path into `post()`. Debits to `fees:*` house accounts are fees
   * collected, credits out of them are fees returned. One row per asset that had
   * a movement; an asset with none is absent. The sums run in the database, so
   * nothing is buffered and no row cap can clip the answer.
   */
  async feeRevenue(range: HistoryRange): Promise<FeeRevenueRow[]> {
    const rows = await this.sql<Array<{ asset_id: string; collected: string; returned: string }>>`
      SELECT a.asset_id,
             COALESCE(SUM(e.amount) FILTER (WHERE e.direction = 'debit'), 0)::text  AS collected,
             COALESCE(SUM(e.amount) FILTER (WHERE e.direction = 'credit'), 0)::text AS returned
        FROM ledger_entries e
        JOIN accounts a   ON a.id = e.account_id
        JOIN ledger_tx t  ON t.id = e.tx_id
       WHERE a.owner_type = 'house'::owner_type
         AND a.kind       = 'available'::account_kind
         AND a.purpose    = ''
         AND a.owner_id LIKE 'fees:%'
         AND t.posted_at >= ${range.from}
         AND t.posted_at <  ${range.to}
       GROUP BY a.asset_id
       ORDER BY a.asset_id
    `;
    return rows.map((r) => ({
      assetId: r.asset_id,
      collected: parseStoredAmount(r.collected, 'ledger_entries.amount'),
      returned: parseStoredAmount(r.returned, 'ledger_entries.amount'),
    }));
  }

  /**
   * What one owner holds now and how it moved since `input.from`, per asset, ledger reason and time bucket (see
   * `holdings-history.ts`). A READ in one repeatable-read snapshot: the holdings are what the movements lead up to.
   *
   * Every account of the owner counts: available and every lock kind. Each transaction is netted over them first
   * (inner query), so a move between two of them (an order hold, a withdrawal put on hold) is zero; the outer query
   * sums what came in and what went out per bucket apart. The fee lookup runs only for the owner's own receiving fill
   * line, the same rule as `historyPage` ("ON A FILL, THE FEE" in `history.ts`; the Postgres test holds the two to one
   * figure). Past `maxRows` rows the read refuses instead of answering short: a replay that silently missed
   * movements would draw the wrong past. `maxRows` is the contract's bound; tests lower it to reach the refusal.
   */
  async holdingsHistory(input: HoldingsHistoryInput, maxRows: number = LEDGER_HOLDINGS_HISTORY_MAX_ROWS): Promise<HoldingsHistory> {
    const bucket = input.bucketSeconds;
    return transaction(
      this.sql,
      async (tx) => {
        const [clock] = await tx<Array<{ now: Date }>>`SELECT now() AS now`;
        const holdings = await tx<Array<{ asset_id: string; amount: string }>>`
          SELECT asset_id, SUM(balance)::text AS amount
            FROM accounts
           WHERE owner_type = ${input.ownerType}::owner_type AND owner_id = ${input.ownerId}
           GROUP BY asset_id
          HAVING SUM(balance) <> 0
           ORDER BY asset_id
        `;
        const rows = await tx<
          Array<{ asset_id: string; module: string; reason: string; bucket_start: Date; inflow: string; outflow: string; fee: string }>
        >`
          SELECT m.asset_id, m.module, m.reason, to_timestamp(m.bucket) AS bucket_start,
                 m.inflow::text AS inflow, m.outflow::text AS outflow, m.fee::text AS fee
            FROM (
              SELECT x.asset_id, x.module, x.reason, x.bucket,
                     SUM(GREATEST(x.net, 0)) AS inflow,
                     SUM(GREATEST(-x.net, 0)) AS outflow,
                     SUM(x.fee) AS fee
                FROM (
                  SELECT a.asset_id, t.module, t.reason, t.id AS tx_id,
                         (floor(extract(epoch FROM t.posted_at) / ${bucket}) * ${bucket})::bigint AS bucket,
                         SUM(CASE WHEN e.direction = 'debit' THEN e.amount ELSE -e.amount END) AS net,
                         COALESCE(SUM(f.fee), 0) AS fee
                    FROM accounts a
                    JOIN ledger_entries e ON e.account_id = a.id
                    JOIN ledger_tx t      ON t.id = e.tx_id
                    LEFT JOIN LATERAL (
                      SELECT SUM(fe.amount) AS fee
                        FROM ledger_entries fe
                        JOIN accounts fa ON fa.id = fe.account_id
                       WHERE t.module = 'trade'
                         AND t.reason IN ('trade.fill', 'trade.fill.mm_maker', 'trade.fill.buyback')
                         AND a.owner_type = 'user'
                         AND a.kind = 'available'
                         AND e.direction = 'debit'
                         AND fe.tx_id = t.id
                         AND fe.direction = 'debit'
                         AND fa.owner_type = 'house'
                         AND fa.owner_id = 'fees:trade'
                         AND fa.kind = 'available'
                         AND fa.purpose = ''
                         AND fa.asset_id = a.asset_id
                    ) f ON true
                   WHERE a.owner_type = ${input.ownerType}::owner_type
                     AND a.owner_id   = ${input.ownerId}
                     AND t.posted_at >= ${input.from}
                   GROUP BY a.asset_id, t.module, t.reason, t.id, t.posted_at
                ) x
               GROUP BY x.asset_id, x.module, x.reason, x.bucket
              HAVING SUM(GREATEST(x.net, 0)) <> 0 OR SUM(GREATEST(-x.net, 0)) <> 0 OR SUM(x.fee) <> 0
            ) m
           ORDER BY m.bucket, m.asset_id, m.module, m.reason
           LIMIT ${maxRows + 1}
        `;
        if (rows.length > maxRows) {
          throw new LedgerError(
            `More than ${maxRows} movement rows since ${input.from.toISOString()}: ask for a later start or a larger bucket`,
            LEDGER_HOLDINGS_HISTORY_TOO_LARGE,
          );
        }
        return {
          asOf: clock!.now,
          holdings: holdings.map((h) => ({ assetId: h.asset_id, amount: parseStoredAmount(h.amount, 'accounts.balance') })),
          movements: rows.map((r) => ({
            assetId: r.asset_id,
            module: r.module,
            reason: r.reason,
            bucketStart: r.bucket_start,
            inflow: parseStoredAmount(r.inflow, 'ledger_entries.amount'),
            outflow: parseStoredAmount(r.outflow, 'ledger_entries.amount'),
            fee: parseStoredAmount(r.fee, 'ledger_entries.amount'),
          })),
        };
      },
      { isolation: 'repeatable read' },
    );
  }

  /**
   * One page of entries, newest first, keyed on the entry id.
   *
   * A READ, like `history()`: no lock, no write, no path into `post()`. Keyset
   * paging, never OFFSET, so page N costs the same as page 1 and a movement
   * posted mid-browse cannot shift a boundary. The accounts come from `input`
   * alone — owner, kind, purpose, and optionally one asset — and the cursor
   * contributes only an entry id to start below, so a forged cursor cannot widen
   * what is readable.
   *
   * ORDER. Newest first by posting sequence (entry id; posts are serialised
   * under the global chain_tip lock). The page walks each account's `ledger_entries_account_idx (account_id, id)`
   * backwards, `LIMIT n+1` per account (LATERAL), and merges the accounts —
   * bounded work per page however long the history, no sort of the whole set.
   * There is deliberately no time filter (see `historyPageInputSchema`).
   *
   * LIMIT + 1 tells us whether a next page exists without a count.
   */
  async historyPage(input: HistoryPageInput): Promise<HistoryPage> {
    const cursor = input.cursor === undefined ? undefined : decodeHistoryCursor(input.cursor);
    const purpose = (input.purpose ?? '').trim(); // same canonical trim as `accountPurpose`
    const limit = input.limit;
    const assetId = input.assetId ?? null;
    const cursorId = cursor?.entryId ?? null;

    const rows = await this.sql<
      Array<HistoryRow & { entry_id: string; asset_id: string; rail: unknown; order_purpose: unknown; fill_fee: string | null }>
    >`
      SELECT p.entry_id, p.tx_id, p.module, p.reason, p.direction, p.amount, p.asset_id, p.posted_at, p.rail,
             o.purpose AS order_purpose, CASE WHEN p.fill_line THEN f.fee END AS fill_fee
        FROM (
          SELECT x.entry_id, t.id AS tx_id, t.module, t.reason, x.direction, x.amount, x.asset_id, t.posted_at,
                 t.meta -> 'rail' AS rail, a.id AS account_id, a.owner_type, a.owner_id, a.kind,
                 (t.module = 'trade' AND t.reason IN ('trade.fill', 'trade.fill.mm_maker', 'trade.fill.buyback') AND a.owner_type = 'user'
                   AND a.kind = 'available' AND x.direction = 'debit') AS fill_line
            FROM accounts a
            CROSS JOIN LATERAL (
              SELECT e.id AS entry_id, e.tx_id, e.direction, e.amount, e.asset_id
                FROM ledger_entries e
               WHERE e.account_id = a.id
                 AND (${cursorId}::bigint IS NULL OR e.id < ${cursorId}::bigint)
               ORDER BY e.id DESC
               LIMIT ${limit + 1}
            ) x
            JOIN ledger_tx t ON t.id = x.tx_id
           WHERE a.owner_type = ${input.ownerType}::owner_type
             AND a.owner_id   = ${input.ownerId}
             AND a.kind       = ${input.kind}::account_kind
             AND a.purpose    = ${purpose}
             AND (${assetId}::text IS NULL OR a.asset_id = ${assetId}::text)
           ORDER BY x.entry_id DESC
           LIMIT ${limit + 1}
        ) p
        -- The page owner's own order, for a trade line only (see orderIdFromHoldPurpose in history.ts): the order-hold
        -- account of the SAME owner that this transaction also moves. Never another owner's hold. Looked up AFTER the
        -- page LIMIT, so it runs for at most limit + 1 rows however many candidate rows the accounts offer.
        -- On a hold-account page the id comes only from that account itself (h.id = p.account_id): the owner's OTHER
        -- order in a self-trade fill is never read. Elsewhere, on a fill the owner's line receives the asset the other
        -- side paid, so the owner's order is the hold in the OTHER asset.
        LEFT JOIN LATERAL (
          SELECT h.purpose
            FROM ledger_entries he
            JOIN accounts h ON h.id = he.account_id
           WHERE he.tx_id = p.tx_id
             AND p.module = 'trade'
             AND h.owner_type = p.owner_type
             AND h.owner_id = p.owner_id
             AND h.kind = 'hold'
             AND h.purpose LIKE 'order:%'
             AND (p.kind <> 'hold' OR h.id = p.account_id)
             AND (
               p.reason IN ('order.hold', 'order.hold.amend', 'order.hold.released')
               OR (p.reason IN ('trade.fill', 'trade.fill.mm_maker', 'trade.fill.buyback') AND (p.kind = 'hold' OR h.asset_id <> p.asset_id))
             )
           ORDER BY he.id
           LIMIT 1
        ) o ON true
        -- The fee taken from this line (see "ON A FILL, THE FEE" in history.ts): on the owner's own receiving line of a
        -- fill (fill_line), the trade-fee leg of the same transaction in the same asset, 0 when none was booked. Every
        -- other line: NULL, and the lookup does not run for it. Also after the page LIMIT.
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(fe.amount), 0)::text AS fee
            FROM ledger_entries fe
            JOIN accounts fa ON fa.id = fe.account_id
           WHERE p.fill_line
             AND fe.tx_id = p.tx_id
             AND fe.direction = 'debit'
             AND fa.owner_type = 'house'
             AND fa.owner_id = 'fees:trade'
             AND fa.kind = 'available'
             AND fa.purpose = ''
             AND fa.asset_id = p.asset_id
        ) f ON true
       ORDER BY p.entry_id DESC
    `;

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      entries: page.map((r) => ({
        txId: r.tx_id,
        module: r.module,
        reason: r.reason,
        direction: r.direction,
        amount: parseStoredAmount(r.amount, 'ledger_entries.amount'),
        postedAt: r.posted_at,
        assetId: r.asset_id,
        entryId: r.entry_id,
        // Only the one key, and only if allow-listed: meta is free-form.
        rail: allowedHistoryRail(r.rail),
        orderId: orderIdFromHoldPurpose(r.order_purpose),
        fee: r.fill_fee === null ? null : parseStoredAmount(r.fill_fee, 'ledger_entries.amount'),
      })),
      nextCursor: rows.length > limit && last ? encodeHistoryCursor({ entryId: last.entry_id }) : null,
    };
  }

  async getTx(txId: string): Promise<LedgerTx | null> {
    const rows = await this.sql<ClaimRow[]>`
      SELECT t.*,
             (k.idempotency_key IS NOT DISTINCT FROM t.idempotency_key
              AND k.posted_hash IS NOT DISTINCT FROM t.hash
              AND k.posted_meta IS NOT DISTINCT FROM t.meta) AS claim_matches
        FROM ledger_tx t LEFT JOIN ledger_posted_keys k ON k.tx_id = t.id
       WHERE t.id = ${txId}
    `;
    if (rows.length === 0) return null;
    assertPostedClaim(rows);
    return this.hydrate(this.sql, rows[0]!);
  }

  async getTxByKey(idempotencyKey: string): Promise<LedgerTx | null> {
    return this.loadTxByKey(this.sql, idempotencyKey);
  }

  /**
   * Unpublished `ledgerTxPosted` intents, oldest first.
   *
   * Publish is keyed `ledger.tx:<txId>` so two recover loops (or a post-path
   * flush racing a tick) cannot double-apply at JetStream even if both read
   * the row before either marks sent.
   */
  async unpublishedOutbox(opts: { txId?: string; limit?: number } = {}): Promise<LedgerTxOutboxRow[]> {
    const limit = opts.limit ?? 100;
    const rows = opts.txId
      ? await this.sql<LedgerTxOutboxRow[]>`
          SELECT id, tx_id, payload, correlation_id
            FROM ledger_tx_outbox
           WHERE tx_id = ${opts.txId} AND published_at IS NULL
           ORDER BY created_at ASC
           LIMIT ${limit}
        `
      : await this.sql<LedgerTxOutboxRow[]>`
          SELECT id, tx_id, payload, correlation_id
            FROM ledger_tx_outbox
           WHERE published_at IS NULL
           ORDER BY created_at ASC
           LIMIT ${limit}
        `;
    return rows;
  }

  async markOutboxPublished(id: string): Promise<void> {
    await this.sql`
      UPDATE ledger_tx_outbox
         SET published_at = now()
       WHERE id = ${id} AND published_at IS NULL
    `;
  }

  /**
   * Every transaction in commit order — the replay source (§4.2).
   *
   * One row past `limit` refuses, same as `history()`. A prefix of `limit`
   * rows is indistinguishable from the whole journal, so a replay that
   * accepted it would drop every later transaction and still look complete.
   * The default is this same `limit`, not a higher cap and not a page.
   */
  async journal(limit = 10_000, afterSeq = 0n): Promise<LedgerTx[]> {
    const rows = await this.sql<TxRow[]>`
      SELECT * FROM ledger_tx WHERE seq > ${String(afterSeq)} ORDER BY seq ASC LIMIT ${limit + 1}
    `;
    if (rows.length > limit) throw new HistoryTooLargeError(limit);
    return Promise.all(rows.map((row) => this.hydrate(this.sql, row)));
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /**
   * New writes only. Caller has already missed both idempotency lookups.
   * A blank bound reads no clock and is not treated as 0.
   */
  private async refuseNewWriteOnClockSkew(tx: Sql): Promise<void> {
    const bound = this.options.clockSkewBoundMs;
    if (bound === undefined || bound === null) return;
    const now = this.options.now ?? (() => new Date());
    const readNow = this.options.readDatabaseNow ?? readDatabaseNow;
    const skew = assessClockSkew({ boundMs: bound, ...(await sampleClocks(now, () => readNow(tx))) });
    if (!skew.ok && skew.code === WRITES_BLOCKED_CLOCK_SKEW) {
      throw new LedgerError(`ledger writes are blocked: ${skew.code}`, skew.code);
    }
  }

  private async upsertAccount(tx: Sql, ref: AccountRef): Promise<{ id: string; balance: bigint }> {
    // ON CONFLICT DO UPDATE (rather than DO NOTHING) so RETURNING always yields
    // a row, and so the row is locked for this transaction either way.
    const rows = await tx<Array<{ id: string; balance: string }>>`
      INSERT INTO accounts (owner_type, owner_id, asset_id, kind, purpose)
      VALUES (
        ${ref.ownerType}::owner_type, ${ref.ownerId},
        ${ref.assetId}, ${ref.kind}::account_kind, ${accountPurpose(ref)}
      )
      ON CONFLICT (owner_type, owner_id, asset_id, kind, purpose)
      DO UPDATE SET owner_id = EXCLUDED.owner_id
      RETURNING id, balance
    `;

    const row = rows[0]!;
    return { id: row.id, balance: parseStoredAmount(row.balance, 'accounts.balance') };
  }

  /**
   * A key that already booked a movement. A retry of the SAME body gets the
   * original back; a different body under that key is refused, because
   * answering it with the old booking told the caller its new movement had
   * happened. Rows booked before migration 0021 have no stored fingerprint and
   * keep the old behaviour (nothing to compare against).
   */
  private replayOf(claimed: { tx: LedgerTx; fingerprint: string | null }, request: PostRequest): LedgerTx {
    if ((claimed.fingerprint !== null && claimed.fingerprint !== postFingerprint(request)) || replayMetaDiffers(claimed.tx.meta, request)) {
      if ((this.options.idempotencyConflict ?? 'refuse') === 'refuse') {
        throw new LedgerError(
          `Idempotency key ${request.idempotencyKey} already booked a different movement; a retry must carry the same body`,
          IDEMPOTENCY_CONFLICT_CODE,
        );
      }
      try {
        this.options.onIdempotencyMismatch?.({ idempotencyKey: request.idempotencyKey, module: request.module, reason: request.reason });
      } catch {
        // Reporting a mismatch must never change the answer: detect mode returns the original, always.
      }
    }
    return claimed.tx;
  }

  private async loadTxByKey(tx: Sql, key: string): Promise<LedgerTx | null> {
    return (await this.loadClaimedTxByKey(tx, key))?.tx ?? null;
  }

  private async loadClaimedTxByKey(tx: Sql, key: string): Promise<{ tx: LedgerTx; fingerprint: string | null } | null> {
    // One statement snapshot: separate claim/journal probes can straddle a
    // concurrent commit and falsely call the just-committed row unclaimed.
    const rows = await tx<ClaimRow[]>`
      WITH target AS (
        SELECT tx_id AS id FROM ledger_posted_keys WHERE idempotency_key = ${key}
        UNION
        SELECT id FROM ledger_tx WHERE idempotency_key = ${key}
      )
      SELECT t.*,
             (k.idempotency_key IS NOT DISTINCT FROM t.idempotency_key
              AND k.posted_hash IS NOT DISTINCT FROM t.hash
              AND k.posted_meta IS NOT DISTINCT FROM t.meta) AS claim_matches,
             k.request_fingerprint AS request_fingerprint
        FROM target JOIN ledger_tx t ON t.id = target.id
        LEFT JOIN ledger_posted_keys k ON k.tx_id = t.id
    `;
    if (rows.length === 0) return null;
    assertPostedClaim(rows);
    return { tx: await this.hydrate(tx, rows[0]!), fingerprint: rows[0]!.request_fingerprint ?? null };
  }

  private async hydrate(sql: Sql, row: TxRow): Promise<LedgerTx> {
    const entries = await sql<EntryRow[]>`
      SELECT id, tx_id, account_id, asset_id, direction, amount, balance_after
        FROM ledger_entries WHERE tx_id = ${row.id} ORDER BY id ASC
    `;

    return {
      id: row.id,
      idempotencyKey: row.idempotency_key,
      module: row.module,
      reason: row.reason,
      meta: row.meta ?? {},
      postedAt: row.posted_at,
      hash: row.hash,
      previousHash: row.previous_hash,
      entries: entries.map((e) => ({
        id: String(e.id),
        txId: e.tx_id,
        accountId: e.account_id,
        assetId: e.asset_id,
        direction: e.direction,
        amount: parseStoredAmount(e.amount, 'ledger_entries.amount'),
        balanceAfter: parseStoredAmount(e.balance_after, 'ledger_entries.balance_after'),
      })),
    };
  }
}

export interface LedgerTxOutboxRow {
  id: string;
  tx_id: string;
  payload: unknown;
  correlation_id: string;
}

interface TxRow {
  id: string;
  seq: string;
  idempotency_key: string;
  module: string;
  reason: string;
  meta: Record<string, unknown> | null;
  posted_at: Date;
  hash: string;
  previous_hash: string | null;
}

/** The join `history()` projects — deliberately narrower than `EntryRow`. */
interface HistoryRow {
  tx_id: string;
  module: string;
  reason: string;
  direction: 'debit' | 'credit';
  amount: string;
  posted_at: Date;
}

interface EntryRow {
  id: string;
  tx_id: string;
  account_id: string;
  asset_id: string;
  direction: 'debit' | 'credit';
  amount: string;
  balance_after: string;
}

/** Stable JSON metadata. Key order is not part of claim identity. */
function canonicalMeta(meta: unknown): Record<string, unknown> {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return {};
  const source = meta as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] === undefined) continue;
    out[key] = canonicalMetaValue(source[key]);
  }
  return out;
}

function canonicalMetaValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalMetaValue(item));
  if (value !== null && typeof value === 'object') return canonicalMeta(value);
  return value;
}

export { hashTx };

interface ClaimRow extends TxRow {
  claim_matches: boolean;
  request_fingerprint?: string | null;
}

function assertPostedClaim(rows: ClaimRow[]): void {
  if (rows.length !== 1 || rows[0]?.claim_matches !== true) {
    throw new LedgerError('Posted transaction differs from its immutable idempotency claim', 'ledger.posted_claim_mismatch');
  }
}
