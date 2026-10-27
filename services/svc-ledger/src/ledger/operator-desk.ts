import type { Sql } from 'postgres';
import { z } from 'zod';
import { formatAmount } from '@intafaced/ledger-client';
import { parseStoredAmount } from './live-money.js';
import { OWNER_TYPES } from './operator-owner-balances.js';
import { recordLookup, type LookupActor, type LookupRecorder } from './operator-lookup.js';

/**
 * The ledger desk's browsing reads (OPS-ledger-desk-01, J-ops-console-03 #1, #2, #4, #5): the transaction list with
 * filters and a cursor, the booking record that sits beside one transaction, the account address search with volumes,
 * and the book's counts. Reads, never posts; every one answers while the posting freeze is on.
 *
 * Who may read: `requireLookupAuthority` at the door (a founder's `admin:read` with a second factor, or a holder of a
 * scope that implies it). The list and the address search name customers' movements and accounts, so each writes one
 * `operator_access_log` row FIRST and is refused with nothing read when it cannot (migration 0028). The counts name no
 * one and write no row. Amounts leave as decimal strings; nothing here holds money in a `number`.
 */

/** One page of the desk, whatever is browsed. A page size, not a money magnitude. */
export const DESK_PAGE_SIZE = 50;

const decimal = z.string().regex(/^-?\d+(\.\d{1,18})?$/);
/** A log sequence the ledger can hold: Postgres `bigint`, so at most 9223372036854775807. */
const INT8_MAX = 9223372036854775807n;
const seqCursor = z
  .string()
  .regex(/^[1-9]\d{0,18}$/)
  .refine((v) => BigInt(v) <= INT8_MAX, { message: 'past the largest sequence the ledger can hold' });
const assetId = z.string().trim().min(1).max(32);

// ── #1 the transaction list ─────────────────────────────────────────────────────────────────────────────────────────

export const operatorTxListInputSchema = z
  .object({
    assetId: assetId.optional(),
    /** Half-open `[from, to)` on the ledger time a transaction was booked under. */
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    /** The `nextCursor` of the page before: rows older than it. */
    before: seqCursor.optional(),
  })
  .strict()
  .refine((q) => !q.from || !q.to || Date.parse(q.from) < Date.parse(q.to), { message: 'from must be before to', path: ['to'] });
export type OperatorTxListInput = z.infer<typeof operatorTxListInputSchema>;

export const operatorTxListOutputSchema = z.object({
  /**
   * How many transactions match the filters, counted by the ledger in the same snapshot as the first page. A later page
   * (one read with `before`) does not count again and answers null: the console keeps the first page's total.
   */
  total: z.string().regex(/^\d+$/).nullable(),
  rows: z.array(
    z.object({
      txId: z.string(),
      seq: z.string(),
      businessKey: z.string(),
      module: z.string(),
      reason: z.string(),
      postedAt: z.string().datetime(),
      assets: z.array(z.string()),
      postings: z.string().regex(/^[1-9]\d*$/),
    }),
  ),
  nextCursor: seqCursor.nullable(),
});
export type OperatorTxListOutput = z.infer<typeof operatorTxListOutputSchema>;

export const TX_LIST_ACTION = 'transactions.list' as const;

/** What the access row names as the target of a list: the filters, in a fixed order. */
export function txListTarget(input: OperatorTxListInput): string {
  return `asset=${input.assetId ?? '*'} from=${input.from ?? '*'} to=${input.to ?? '*'} before=${input.before ?? '*'}`;
}

export async function listOperatorTransactions(sql: Sql, input: OperatorTxListInput): Promise<OperatorTxListOutput> {
  const q = operatorTxListInputSchema.parse(input);
  const asset = q.assetId ?? null;
  const from = q.from ? new Date(q.from) : null;
  const to = q.to ? new Date(q.to) : null;
  const before = q.before ?? null;
  // One read-only snapshot, so the total and the first page are the same book. Only the first page counts.
  return sql.begin('isolation level repeatable read read only', async (tx) => {
    const match = (withCursor: boolean) => tx`
      ${asset === null ? tx`TRUE` : tx`EXISTS (SELECT 1 FROM ledger_entries m WHERE m.tx_id = t.id AND m.asset_id = ${asset})`}
      AND ${from === null ? tx`TRUE` : tx`t.posted_at >= ${from}`}
      AND ${to === null ? tx`TRUE` : tx`t.posted_at < ${to}`}
      AND ${withCursor && before !== null ? tx`t.seq < ${before}::bigint` : tx`TRUE`}
    `;
    const counted =
      before === null ? (await tx<Array<{ n: string }>>`SELECT count(*)::text AS n FROM ledger_tx t WHERE ${match(false)}`)[0] : null;
    const rows = await tx<
      Array<{
        id: string;
        seq: string;
        idempotency_key: string;
        module: string;
        reason: string;
        posted_at: Date;
        assets: string[];
        postings: string;
      }>
    >`
      SELECT t.id, t.seq::text AS seq, t.idempotency_key, t.module, t.reason, t.posted_at,
             (SELECT array_agg(DISTINCT e.asset_id ORDER BY e.asset_id) FROM ledger_entries e WHERE e.tx_id = t.id) AS assets,
             (SELECT count(*)::text FROM ledger_entries e WHERE e.tx_id = t.id) AS postings
        FROM ledger_tx t
       WHERE ${match(true)}
       ORDER BY t.seq DESC
       LIMIT ${DESK_PAGE_SIZE + 1}
    `;
    const page = rows.slice(0, DESK_PAGE_SIZE);
    return {
      total: before === null ? (counted?.n ?? '0') : null,
      rows: page.map((r) => ({
        txId: r.id,
        seq: r.seq,
        businessKey: r.idempotency_key,
        module: r.module,
        reason: r.reason,
        postedAt: r.posted_at.toISOString(),
        assets: r.assets ?? [],
        postings: r.postings,
      })),
      nextCursor: rows.length > DESK_PAGE_SIZE ? (page.at(-1)?.seq ?? null) : null,
    };
  });
}

// ── #2 / #3 the booking record beside one transaction ───────────────────────────────────────────────────────────────

/**
 * Where one transaction sits in the ledger's log and what the ledger recorded when it booked it: its sequence in the
 * hash chain, the database's time for the booking (`bookedAt`: Postgres `now()` on the outbox row, the moment the
 * booking's database transaction began, before it waited for the chain lock; the transaction's `postedAt` is the
 * ledger process's clock after that lock, and is what the hash covers), the reference the request carried (its
 * correlation id, or the transaction id when it carried none), and the `tx.posted` event record written in the same
 * commit.
 */
export const bookingRecordSchema = z.object({
  seq: z.string().regex(/^\d+$/),
  bookedAt: z.string().datetime().nullable(),
  reference: z.string().nullable(),
  event: z
    .object({
      id: z.string(),
      subject: z.literal('intafaced.ledger.tx.posted'),
      recordedAt: z.string().datetime(),
      publishedAt: z.string().datetime().nullable(),
    })
    .nullable(),
});
export type BookingRecord = z.infer<typeof bookingRecordSchema>;

export async function readBookingRecord(sql: Sql, txId: string): Promise<BookingRecord | null> {
  const [row] = await sql<
    Array<{ seq: string; outbox_id: string | null; correlation_id: string | null; created_at: Date | null; published_at: Date | null }>
  >`
    SELECT t.seq::text AS seq, o.id AS outbox_id, o.correlation_id, o.created_at, o.published_at
      FROM ledger_tx t LEFT JOIN ledger_tx_outbox o ON o.tx_id = t.id
     WHERE t.id = ${txId}
  `;
  if (!row) return null;
  return {
    seq: row.seq,
    bookedAt: row.created_at ? row.created_at.toISOString() : null,
    reference: row.correlation_id,
    event:
      row.outbox_id && row.created_at
        ? {
            id: row.outbox_id,
            subject: 'intafaced.ledger.tx.posted',
            recordedAt: row.created_at.toISOString(),
            publishedAt: row.published_at ? row.published_at.toISOString() : null,
          }
        : null,
  };
}

// ── #4 the account address search ───────────────────────────────────────────────────────────────────────────────────

/**
 * An account's address is `<owner type>:<owner id>`, the two parts of its identity an operator reads off a posting
 * (`house:fees:trade`, `treasury:rail:card-sandbox`, `user:4d2e…`). A search names a whole owner type and at least the
 * first character of the owner id, so it never lists every account of a type by accident.
 */
const ADDRESS_PREFIX = new RegExp(`^(${OWNER_TYPES.join('|')}):(.{1,128})$`);

export const operatorAccountSearchInputSchema = z
  .object({
    prefix: z.string().trim().regex(ADDRESS_PREFIX),
    /** The `nextCursor` of the page before. */
    after: z.string().uuid().optional(),
  })
  .strict();
export type OperatorAccountSearchInput = z.infer<typeof operatorAccountSearchInputSchema>;

export const operatorAccountSearchOutputSchema = z.object({
  prefix: z.string(),
  accounts: z.array(
    z.object({
      accountId: z.string(),
      address: z.string(),
      ownerType: z.enum(OWNER_TYPES),
      ownerId: z.string(),
      assetId: z.string(),
      kind: z.string(),
      purpose: z.string(),
      /** Every debit booked to the account (debits raise a balance in this book). */
      debits: decimal,
      /** Every credit booked to the account. */
      credits: decimal,
      /** `debits − credits`, derived here from the two volumes. */
      balance: decimal,
      postings: z.string().regex(/^\d+$/),
    }),
  ),
  nextCursor: z.string().uuid().nullable(),
});
export type OperatorAccountSearchOutput = z.infer<typeof operatorAccountSearchOutputSchema>;

export const ACCOUNT_SEARCH_ACTION = 'accounts.search' as const;

/** Postgres LIKE with the prefix taken literally. */
function likePrefix(text: string): string {
  return `${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export async function searchOperatorAccounts(sql: Sql, input: OperatorAccountSearchInput): Promise<OperatorAccountSearchOutput> {
  const { prefix, after } = operatorAccountSearchInputSchema.parse(input);
  const [, ownerType, ownerIdPrefix] = ADDRESS_PREFIX.exec(prefix)!;
  // Ordered by owner id then account id, so a cursor names one place in the list and a page never repeats a row.
  const rows = await sql<
    Array<{
      id: string;
      owner_type: string;
      owner_id: string;
      asset_id: string;
      kind: string;
      purpose: string;
      debits: string;
      credits: string;
      postings: string;
    }>
  >`
    WITH page AS (
      SELECT a.id, a.owner_type::text AS owner_type, a.owner_id, a.asset_id, a.kind::text AS kind, a.purpose
        FROM accounts a
       WHERE a.owner_type = ${ownerType!}::owner_type
         AND a.owner_id LIKE ${likePrefix(ownerIdPrefix!)}
         AND ${after === undefined ? sql`TRUE` : sql`(a.owner_id, a.id) > (SELECT c.owner_id, c.id FROM accounts c WHERE c.id = ${after})`}
       ORDER BY a.owner_id, a.id
       LIMIT ${DESK_PAGE_SIZE + 1}
    )
    SELECT p.*,
           COALESCE(SUM(e.amount) FILTER (WHERE e.direction = 'debit'), 0)::text  AS debits,
           COALESCE(SUM(e.amount) FILTER (WHERE e.direction = 'credit'), 0)::text AS credits,
           count(e.id)::text AS postings
      FROM page p LEFT JOIN ledger_entries e ON e.account_id = p.id
     GROUP BY p.id, p.owner_type, p.owner_id, p.asset_id, p.kind, p.purpose
     ORDER BY p.owner_id, p.id
  `;
  const page = rows.slice(0, DESK_PAGE_SIZE);
  return {
    prefix,
    accounts: page.map((r) => {
      const debits = parseStoredAmount(r.debits, 'ledger_entries.amount');
      const credits = parseStoredAmount(r.credits, 'ledger_entries.amount');
      return {
        accountId: r.id,
        address: `${r.owner_type}:${r.owner_id}`,
        ownerType: r.owner_type as (typeof OWNER_TYPES)[number],
        ownerId: r.owner_id,
        assetId: r.asset_id,
        kind: r.kind,
        purpose: r.purpose,
        debits: formatAmount(debits),
        credits: formatAmount(credits),
        balance: formatAmount(debits - credits),
        postings: r.postings,
      };
    }),
    nextCursor: rows.length > DESK_PAGE_SIZE ? (page.at(-1)?.id ?? null) : null,
  };
}

// ── #5 the book's counts ────────────────────────────────────────────────────────────────────────────────────────────

export const operatorStatsOutputSchema = z.object({
  transactions: z.string().regex(/^\d+$/),
  postings: z.string().regex(/^\d+$/),
  accounts: z.string().regex(/^\d+$/),
  /** Assets with at least one account. */
  assets: z.string().regex(/^\d+$/),
  /** The newest transaction's sequence and ledger time; null on an empty book. */
  lastSeq: z.string().nullable(),
  lastPostedAt: z.string().datetime().nullable(),
  /** The database time the counts were read at. */
  asOf: z.string().datetime(),
});
export type OperatorStatsOutput = z.infer<typeof operatorStatsOutputSchema>;

export async function readOperatorStats(sql: Sql): Promise<OperatorStatsOutput> {
  return sql.begin('isolation level repeatable read read only', async (tx) => {
    const [row] = await tx<
      Array<{
        transactions: string;
        postings: string;
        accounts: string;
        assets: string;
        last_seq: string | null;
        last_posted_at: Date | null;
        as_of: Date;
      }>
    >`
      SELECT (SELECT count(*) FROM ledger_tx)::text                       AS transactions,
             (SELECT count(*) FROM ledger_entries)::text                  AS postings,
             (SELECT count(*) FROM accounts)::text                        AS accounts,
             (SELECT count(DISTINCT asset_id) FROM accounts)::text        AS assets,
             (SELECT max(seq) FROM ledger_tx)::text                       AS last_seq,
             (SELECT posted_at FROM ledger_tx ORDER BY seq DESC LIMIT 1)  AS last_posted_at,
             clock_timestamp()                                            AS as_of
    `;
    return {
      transactions: row!.transactions,
      postings: row!.postings,
      accounts: row!.accounts,
      assets: row!.assets,
      lastSeq: row!.last_seq,
      lastPostedAt: row!.last_posted_at ? row!.last_posted_at.toISOString() : null,
      asOf: row!.as_of.toISOString(),
    };
  });
}

// ── the recorded doors ──────────────────────────────────────────────────────────────────────────────────────────────

/** What a recorded desk read needs: somewhere to write the access row, and the unrecorded read behind it. */
export interface DeskReader extends LookupRecorder {
  readTransactionPage(input: OperatorTxListInput): Promise<OperatorTxListOutput>;
  readAccountPage(input: OperatorAccountSearchInput): Promise<OperatorAccountSearchOutput>;
}

/** The list, recorded under the person before it is read. */
export async function operatorTxList(reader: DeskReader, actor: LookupActor, input: OperatorTxListInput): Promise<OperatorTxListOutput> {
  const q = operatorTxListInputSchema.parse(input);
  await recordLookup(reader, actor, { ownerType: 'transactions', ownerId: txListTarget(q), action: TX_LIST_ACTION });
  return reader.readTransactionPage(q);
}

/** The address search, recorded under the person before it is read. */
export async function operatorAccountSearch(
  reader: DeskReader,
  actor: LookupActor,
  input: OperatorAccountSearchInput,
): Promise<OperatorAccountSearchOutput> {
  const q = operatorAccountSearchInputSchema.parse(input);
  await recordLookup(reader, actor, { ownerType: 'address_prefix', ownerId: q.prefix, action: ACCOUNT_SEARCH_ACTION });
  return reader.readAccountPage(q);
}
