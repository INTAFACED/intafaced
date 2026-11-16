import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { requireScope, type Principal } from '@intafaced/auth';
import { formatAmount } from '@intafaced/ledger-client/money';
import type { UserVenue, UserVenueAccount } from '@intafaced/venue-contracts';
import {
  csvCell,
  parseStatementRequest,
  STATEMENT_CODES,
  STATEMENT_JOBS_PER_DAY,
  STATEMENT_ROWS_MAX,
  StatementError,
  type StatementStatus,
} from '../statements/statement-export.js';

/**
 * The statement export on the launch model (J-cex-spot-07 #5): one file of a venue account's orders, trades and money
 * movements for a date range, read from the venue's own records, never our ledger (which holds none of the person's
 * money). Orders are the venue's order history (placed in the range), trades its fills (filled in the range), money
 * movements its credits into the account (deposits and transfers in, by when the venue credited them) and the account's
 * withdrawals signed through us (by when the venue took them).
 *
 * A request names the venue account, the range and a request key. The first request with a key creates the job and
 * builds its file; asking again with the same key answers the same job and the same file, never a second one; the same
 * key for another range or account is refused. The range is half-open, [from, to), and must be over when asked
 * (`parseStatementRequest`). Reads only: nothing is posted, held, signed or sent. A venue that keeps no order history
 * refuses the job before it is created (`not_offered`), and a withdrawal whose time the venue does not report fails the
 * job (`trade.statement_source_incomplete`) instead of leaving it out.
 */

export const VENUE_STATEMENT_INCOMPLETE = 'trade.statement_source_incomplete' as const;

/** What the job reads: the venue and the person's withdrawals signed through our door (their nonces). */
export interface VenueStatementSource {
  readonly venue: UserVenue;
  readonly account: UserVenueAccount;
  readonly withdrawalNonces: readonly string[];
}

export interface VenueStatementJob {
  readonly id: string;
  readonly requestKey: string;
  readonly venueId: string;
  readonly owner: string;
  readonly from: string;
  readonly to: string;
  readonly status: StatementStatus;
  readonly rows: { readonly orders: number; readonly trades: number; readonly movements: number } | null;
  readonly sha256: string | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly finishedAt: string | null;
}

/** The file's columns. Every row says which record it is and where it comes from; a column a record lacks is empty. */
export const VENUE_STATEMENT_COLUMNS = [
  'record',
  'id',
  'time',
  'source',
  'market',
  'side',
  'type',
  'status',
  'price',
  'amount',
  'filled',
  'asset',
  'direction',
  'fee',
  'fee_asset',
  'source_ref',
  'order_id',
] as const;
type Column = (typeof VENUE_STATEMENT_COLUMNS)[number];

class Incomplete extends Error {}
class TooLarge extends Error {}

const inRange = (at: Date, r: { from: Date; to: Date }) => at.getTime() >= r.from.getTime() && at.getTime() < r.to.getTime();
const money = (v: bigint | null | undefined) => (v === null || v === undefined ? '' : formatAmount(v));

/** The file for one venue account and range, from the venue's own records: rows oldest first within each record kind. */
export async function composeVenueStatement(src: VenueStatementSource, range: { from: Date; to: Date }) {
  const { venue, account } = src;
  const name = venue.venue.displayName;
  if (!venue.orderHistory) throw new Incomplete(`${name} keeps no order history`);
  const orders = (await venue.orderHistory(account)).value
    .filter((r) => inRange(r.placedAt, range))
    .sort((a, b) => a.placedAt.getTime() - b.placedAt.getTime());
  const fills = (await venue.fills(account, range.from)).value
    .filter((f) => inRange(f.filledAt, range))
    .sort((a, b) => a.filledAt.getTime() - b.filledAt.getTime());
  const arrivals = venue.arrivals ? (await venue.arrivals(account)).value.filter((x) => inRange(x.arrivedAt, range)) : null;
  if (arrivals === null) throw new Incomplete(`${name} reports no credits into the account`);
  const withdrawals = [];
  for (const nonce of src.withdrawalNonces) {
    const w = (await venue.withdrawal(account, nonce)).value;
    if (!w) continue; // never taken by the venue: nothing moved
    if (!w.requestedAt) throw new Incomplete(`${name} does not report when withdrawal ${nonce} was taken`);
    if (inRange(w.requestedAt, range)) withdrawals.push({ ...w, requestedAt: w.requestedAt });
  }
  if (orders.length > STATEMENT_ROWS_MAX || fills.length > STATEMENT_ROWS_MAX || arrivals.length + withdrawals.length > STATEMENT_ROWS_MAX)
    throw new TooLarge();

  const out = [VENUE_STATEMENT_COLUMNS.join(',')];
  const row = (cells: Partial<Record<Column, string>>) => out.push(VENUE_STATEMENT_COLUMNS.map((c) => csvCell(cells[c] ?? '')).join(','));
  for (const { order: o, placedAt } of orders) {
    row({
      record: 'order',
      id: o.venueClientOrderId ?? o.venueOrderId ?? '',
      time: placedAt.toISOString(),
      source: name,
      market: o.symbol,
      side: o.side,
      type: o.type,
      status: o.status,
      price: money(o.price),
      amount: money(o.amount),
      filled: money(o.filled),
      source_ref: o.venueOrderId ?? '',
    });
  }
  for (const f of fills) {
    row({
      record: 'trade',
      id: f.fillId,
      time: f.filledAt.toISOString(),
      source: name,
      market: f.symbol,
      side: f.side,
      type: f.role,
      price: money(f.price),
      amount: money(f.amount),
      fee: money(f.venueFee + f.builderFee),
      fee_asset: f.feeAsset,
      source_ref: f.fillId,
      order_id: f.venueClientOrderId ?? '',
    });
  }
  const movements = [
    ...arrivals.map((x) => ({
      at: x.arrivedAt,
      cells: {
        record: x.kind,
        id: x.arrivalId,
        asset: x.asset,
        amount: money(x.amount),
        direction: 'in',
        status: 'credited',
        source_ref: x.arrivalId,
      },
    })),
    ...withdrawals.map((w) => ({
      at: w.requestedAt,
      cells: {
        record: 'withdrawal',
        id: w.nonce,
        asset: w.asset,
        amount: money(w.amount),
        direction: 'out',
        status: w.status,
        fee: w.fee.known ? money(w.fee.value) : '',
        fee_asset: w.fee.known ? w.asset : '',
        source_ref: w.txHash ?? w.nonce,
      },
    })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());
  for (const m of movements) row({ ...m.cells, time: m.at.toISOString(), source: name });
  return { csv: `${out.join('\n')}\n`, orders: orders.length, trades: fills.length, movements: movements.length };
}

type JobRow = {
  id: string;
  request_key: string;
  venue_id: string;
  owner: string;
  range_from: Date;
  range_to: Date;
  status: StatementStatus;
  file: string | null;
  sha256: string | null;
  order_rows: number | null;
  trade_rows: number | null;
  movement_rows: number | null;
  error_code: string | null;
  created_at: Date;
  finished_at: Date | null;
};

/** The venue statement jobs, in `trade.venue_statement_exports`. */
export class VenueStatements {
  constructor(
    private readonly sql: Sql,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async request(
    principal: Principal,
    input: { from?: unknown; to?: unknown; requestKey?: unknown },
    source: () => Promise<VenueStatementSource>,
  ): Promise<VenueStatementJob> {
    requireScope(principal, 'trade:read');
    const now = this.now();
    const { from, to, requestKey } = parseStatementRequest(input, now);
    const src = await source();
    if (!src.venue.orderHistory) {
      throw new StatementError(`${src.venue.venue.displayName} keeps no order history to list`, STATEMENT_CODES.rangeInvalid, 400);
    }
    const { venueId, owner } = src.account;
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const [count] = await this.sql<Array<{ started: number; known: boolean }>>`
      SELECT count(*) FILTER (WHERE created_at > ${since})::int AS started,
             bool_or(request_key = ${requestKey}) AS known
        FROM trade.venue_statement_exports
       WHERE user_id = ${principal.userId}
    `;
    if (!count?.known && (count?.started ?? 0) >= STATEMENT_JOBS_PER_DAY) {
      throw new StatementError(
        `at most ${STATEMENT_JOBS_PER_DAY} new statements a day; ask again with a key already used, or tomorrow`,
        STATEMENT_CODES.tooMany,
        429,
      );
    }
    await this.sql`
      INSERT INTO trade.venue_statement_exports (user_id, request_key, venue_id, owner, range_from, range_to, created_at)
      VALUES (${principal.userId}, ${requestKey}, ${venueId}, ${owner}, ${from}, ${to}, ${now})
      ON CONFLICT (user_id, request_key) DO NOTHING
    `;
    const [row] = await this.sql<JobRow[]>`
      SELECT * FROM trade.venue_statement_exports WHERE user_id = ${principal.userId} AND request_key = ${requestKey}
    `;
    if (!row) throw new Error('venue statement job vanished after insert');
    if (
      row.range_from.getTime() !== from.getTime() ||
      row.range_to.getTime() !== to.getTime() ||
      row.venue_id !== venueId ||
      row.owner !== owner
    ) {
      throw new StatementError(
        'this requestKey already names a statement for another range or account; use a new key',
        STATEMENT_CODES.keyReused,
        409,
      );
    }
    // A job left pending (a crash mid-build, the venue unreachable, a racing request) is built here; the first to finish wins.
    if (row.status === 'pending') await this.build(row, src);
    return present(await this.own(principal.userId, row.id));
  }

  async file(principal: Principal, id: string): Promise<{ csv: string; sha256: string; filename: string }> {
    requireScope(principal, 'trade:read');
    const row = await this.own(principal.userId, id);
    if (row.status !== 'finished' || row.file === null || row.sha256 === null) {
      throw new StatementError(`statement ${id} is ${row.status}; it has no file`, STATEMENT_CODES.notFinished, 409);
    }
    // The range's last day, included: `to` is the start of the day after it.
    const day = (d: Date) => d.toISOString().slice(0, 10);
    const last = new Date(row.range_to.getTime() - 1);
    return { csv: row.file, sha256: row.sha256, filename: `statement-${day(row.range_from)}-${day(last)}.csv` };
  }

  private async own(userId: string, id: string): Promise<JobRow> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
      throw new StatementError(`no statement ${id}`, STATEMENT_CODES.notFound, 404);
    const [row] = await this.sql<JobRow[]>`SELECT * FROM trade.venue_statement_exports WHERE id = ${id} AND user_id = ${userId}`;
    // Another person's statement reads as not found, never as forbidden.
    if (!row) throw new StatementError(`no statement ${id}`, STATEMENT_CODES.notFound, 404);
    return row;
  }

  private async build(job: JobRow, src: VenueStatementSource): Promise<void> {
    let built: Awaited<ReturnType<typeof composeVenueStatement>>;
    try {
      built = await composeVenueStatement(src, { from: job.range_from, to: job.range_to });
    } catch (err) {
      const code = err instanceof TooLarge ? STATEMENT_CODES.tooLarge : err instanceof Incomplete ? VENUE_STATEMENT_INCOMPLETE : null;
      if (code) {
        await this.sql`
          UPDATE trade.venue_statement_exports
             SET status = 'failed', error_code = ${code}, finished_at = ${this.now()}
           WHERE id = ${job.id} AND status = 'pending'
        `;
        return;
      }
      // Anything else (the venue unreachable) leaves the job pending: the same request builds it again.
      throw err;
    }
    const sha256 = createHash('sha256').update(built.csv, 'utf8').digest('hex');
    await this.sql`
      UPDATE trade.venue_statement_exports
         SET status = 'finished', file = ${built.csv}, sha256 = ${sha256},
             order_rows = ${built.orders}, trade_rows = ${built.trades}, movement_rows = ${built.movements},
             finished_at = ${this.now()}
       WHERE id = ${job.id} AND status = 'pending'
    `;
  }
}

function present(row: JobRow): VenueStatementJob {
  return {
    id: row.id,
    requestKey: row.request_key,
    venueId: row.venue_id,
    owner: row.owner,
    from: row.range_from.toISOString(),
    to: row.range_to.toISOString(),
    status: row.status,
    rows:
      row.status === 'finished' && row.order_rows !== null && row.trade_rows !== null && row.movement_rows !== null
        ? { orders: row.order_rows, trades: row.trade_rows, movements: row.movement_rows }
        : null,
    sha256: row.sha256,
    error: row.error_code,
    createdAt: row.created_at.toISOString(),
    finishedAt: row.finished_at === null ? null : row.finished_at.toISOString(),
  };
}
