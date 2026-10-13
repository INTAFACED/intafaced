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
  signedDelta,
  InsufficientFundsError,
  LedgerError,
  type AccountRef,
  type Balance,
  type LedgerClient,
  type LedgerTx,
  type PostRequest,
  type PostedEntry,
} from '@intafaced/ledger-client';
import { frozenMessage } from './freeze.js';
import {
  HISTORY_MAX_ENTRIES,
  HistoryTooLargeError,
  decodeHistoryCursor,
  encodeHistoryCursor,
  type HistoryEntry,
  type HistoryPage,
  type HistoryPageInput,
  type HistoryRange,
} from './history.js';
import { assertScaledBigintAmounts, parseStoredAmount } from './live-money.js';

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
  constructor(private readonly sql: Sql) {}

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
    const existing = await this.getTxByKey(request.idempotencyKey);
    if (existing) return existing;

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
        const inTx = await this.loadTxByKey(tx, request.idempotencyKey);
        if (inTx) return inTx;

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
          INSERT INTO ledger_posted_keys (idempotency_key, tx_id, posted_hash, posted_meta)
          VALUES (${request.idempotencyKey}, ${txId}, ${hash}, ${tx.json(meta as never)})
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
   * One page of entries, newest first, over `(posted_at DESC, entry id DESC)`.
   *
   * A READ, like `history()`: no lock, no write, no path into `post()`. Keyset
   * paging (row comparison against the cursor position), never OFFSET, so page N
   * costs the same as page 1 and a movement posted mid-browse cannot shift a
   * boundary. The accounts come from `input` alone — owner, kind, purpose, and
   * optionally one asset — and the cursor contributes only a position inside
   * that set, so a forged cursor cannot widen what is readable.
   *
   * LIMIT + 1 tells us whether a next page exists without a count.
   *
   * INDEX NOTE. `posted_at` lives on `ledger_tx`, so no single index can cover
   * `(account_id, posted_at, id)`. The plan is `accounts_owner_idx` then
   * `ledger_entries_account_idx (account_id, id)` plus a sort of that account's
   * entries; fine at current account sizes. Making it a pure index walk would
   * mean copying `posted_at` onto `ledger_entries`, a change to the money table
   * and the posting path that this read-only change deliberately does not make.
   */
  async historyPage(input: HistoryPageInput): Promise<HistoryPage> {
    const cursor = input.cursor === undefined ? undefined : decodeHistoryCursor(input.cursor);
    const purpose = (input.purpose ?? '').trim(); // same canonical trim as `accountPurpose`
    const limit = input.limit;
    const before = input.before === undefined ? null : new Date(input.before);
    const assetId = input.assetId ?? null;
    const cursorAt = cursor?.postedAt ?? null;
    const cursorId = cursor?.entryId ?? null;

    const rows = await this.sql<Array<HistoryRow & { entry_id: string; asset_id: string }>>`
      SELECT e.id::text AS entry_id, t.id AS tx_id, t.module, t.reason, e.direction, e.amount,
             e.asset_id, t.posted_at
        FROM accounts a
        JOIN ledger_entries e ON e.account_id = a.id
        JOIN ledger_tx t ON t.id = e.tx_id
       WHERE a.owner_type = ${input.ownerType}::owner_type
         AND a.owner_id   = ${input.ownerId}
         AND a.kind       = ${input.kind}::account_kind
         AND a.purpose    = ${purpose}
         AND (${assetId}::text IS NULL OR a.asset_id = ${assetId}::text)
         AND (${before}::timestamptz IS NULL OR t.posted_at < ${before}::timestamptz)
         AND (${cursorAt}::timestamptz IS NULL OR (t.posted_at, e.id) < (${cursorAt}::timestamptz, ${cursorId}::bigint))
       ORDER BY t.posted_at DESC, e.id DESC
       LIMIT ${limit + 1}
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
      })),
      nextCursor: rows.length > limit && last ? encodeHistoryCursor({ postedAt: last.posted_at, entryId: last.entry_id }) : null,
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

  private async loadTxByKey(tx: Sql, key: string): Promise<LedgerTx | null> {
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
              AND k.posted_meta IS NOT DISTINCT FROM t.meta) AS claim_matches
        FROM target JOIN ledger_tx t ON t.id = target.id
        LEFT JOIN ledger_posted_keys k ON k.tx_id = t.id
    `;
    if (rows.length === 0) return null;
    assertPostedClaim(rows);
    return this.hydrate(tx, rows[0]!);
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
}

function assertPostedClaim(rows: ClaimRow[]): void {
  if (rows.length !== 1 || rows[0]?.claim_matches !== true) {
    throw new LedgerError('Posted transaction differs from its immutable idempotency claim', 'ledger.posted_claim_mismatch');
  }
}
