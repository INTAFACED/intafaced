import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { requireScope, type Principal } from '@intafaced/auth';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { ledgerLinesInRange, LedgerRangeTooLargeError, type LedgerLine, type LedgerPages } from './ledger-history.js';

/**
 * Statement export (J-cex-spot-07 #5): one file of a person's orders, trades and ledger lines for a date range.
 *
 * A request names the range and a request key. The first request with a key creates the job and builds its file; asking
 * again with the same key answers the same job (and the same file), never a second one, and the same key for another
 * range is refused. The range is half-open, [from, to), and must be over when asked, so the file it lists cannot change:
 * an order counts by when it was placed, a trade by when it filled, a ledger line by when it was posted.
 *
 * Reads only. Orders and fills are this service's own rows; ledger lines come from svc-ledger's history door for the
 * person's own accounts. Nothing here posts, holds or releases.
 */

/** Database-protection bounds, not commercial limits: a year per file, and at most this many rows of each kind. */
export const STATEMENT_WINDOW_MAX_MS = 366 * 24 * 60 * 60 * 1000;
export const STATEMENT_ROWS_MAX = 10_000;

export const STATEMENT_CODES = {
  rangeInvalid: 'trade.statement_range_invalid',
  rangeNotOver: 'trade.statement_range_not_over',
  rangeTooWide: 'trade.statement_range_too_wide',
  keyInvalid: 'trade.statement_key_invalid',
  keyReused: 'trade.statement_key_reused',
  notFound: 'trade.statement_not_found',
  notFinished: 'trade.statement_not_finished',
  tooLarge: 'trade.statement_too_large',
} as const;

export type StatementCode = (typeof STATEMENT_CODES)[keyof typeof STATEMENT_CODES];

export class StatementError extends Error {
  constructor(
    message: string,
    readonly code: StatementCode,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = 'StatementError';
  }
}

export type StatementStatus = 'pending' | 'finished' | 'failed';

export interface StatementJob {
  readonly id: string;
  readonly requestKey: string;
  readonly from: string;
  readonly to: string;
  readonly status: StatementStatus;
  readonly rows: { readonly orders: number; readonly trades: number; readonly ledger: number } | null;
  readonly sha256: string | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly finishedAt: string | null;
}

export interface StatementRequest {
  readonly from?: unknown;
  readonly to?: unknown;
  readonly requestKey?: unknown;
}

const REQUEST_KEY = /^[A-Za-z0-9:._-]{8,128}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type JobRow = {
  id: string;
  request_key: string;
  range_from: Date;
  range_to: Date;
  status: StatementStatus;
  file: string | null;
  sha256: string | null;
  order_rows: number | null;
  trade_rows: number | null;
  ledger_rows: number | null;
  error_code: string | null;
  created_at: Date;
  finished_at: Date | null;
};

type OrderLine = {
  id: string;
  market_id: string;
  client_order_id: string | null;
  side: string;
  type: string;
  status: string;
  price: string | null;
  qty: string;
  filled_qty: string;
  created_at: Date;
};

type FillLine = {
  id: string;
  order_id: string;
  market_id: string;
  side: string;
  liquidity: string;
  price: string;
  qty: string;
  fee_asset: string;
  fee_amount: string;
  ts: Date;
};

/** The file's columns. Every row says which record it is; a column a record does not have is empty. */
export const STATEMENT_COLUMNS = [
  'record',
  'id',
  'time',
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
  'ledger_ref',
  'reason',
  'order_id',
  'client_order_id',
] as const;

type Column = (typeof STATEMENT_COLUMNS)[number];

export function parseStatementRequest(input: StatementRequest, now: Date): { from: Date; to: Date; requestKey: string } {
  const { from, to, requestKey } = input;
  if (typeof requestKey !== 'string' || !REQUEST_KEY.test(requestKey)) {
    throw new StatementError('requestKey must be 8 to 128 letters, digits, ":", ".", "_" or "-"', STATEMENT_CODES.keyInvalid, 400);
  }
  if (typeof from !== 'string' || typeof to !== 'string' || !ISO_INSTANT.test(from) || !ISO_INSTANT.test(to)) {
    throw new StatementError('from and to must be ISO 8601 instants', STATEMENT_CODES.rangeInvalid, 400);
  }
  const start = new Date(from);
  const end = new Date(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    throw new StatementError('to must be after from', STATEMENT_CODES.rangeInvalid, 400);
  }
  if (end > now) {
    throw new StatementError('the range must be over: to cannot be in the future', STATEMENT_CODES.rangeNotOver, 400);
  }
  if (end.getTime() - start.getTime() > STATEMENT_WINDOW_MAX_MS) {
    throw new StatementError('a statement covers at most 366 days', STATEMENT_CODES.rangeTooWide, 400);
  }
  return { from: start, to: end, requestKey };
}

export class StatementExports {
  constructor(
    private readonly sql: Sql,
    private readonly ledger: LedgerPages,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Create the job for this key (or find it), build its file if it is not built yet, and answer it. */
  async request(principal: Principal, input: StatementRequest): Promise<StatementJob> {
    requireScope(principal, 'trade:read');
    const { from, to, requestKey } = parseStatementRequest(input, this.now());
    await this.sql`
      INSERT INTO trade.statement_exports (user_id, request_key, range_from, range_to)
      VALUES (${principal.userId}, ${requestKey}, ${from}, ${to})
      ON CONFLICT (user_id, request_key) DO NOTHING
    `;
    const [row] = await this.sql<JobRow[]>`
      SELECT * FROM trade.statement_exports WHERE user_id = ${principal.userId} AND request_key = ${requestKey}
    `;
    if (!row) throw new Error('statement job vanished after insert');
    if (row.range_from.getTime() !== from.getTime() || row.range_to.getTime() !== to.getTime()) {
      throw new StatementError(
        'this requestKey already names a statement for another range; use a new key',
        STATEMENT_CODES.keyReused,
        409,
      );
    }
    // A job left pending (a crash mid-build, or a request racing this one) is built here; the first to finish wins.
    if (row.status === 'pending') await this.build(principal.userId, row);
    return present(await this.row(principal.userId, row.id));
  }

  async get(principal: Principal, id: string): Promise<StatementJob> {
    requireScope(principal, 'trade:read');
    return present(await this.own(principal.userId, id));
  }

  async file(principal: Principal, id: string): Promise<{ csv: string; sha256: string; filename: string }> {
    requireScope(principal, 'trade:read');
    const row = await this.own(principal.userId, id);
    if (row.status !== 'finished' || row.file === null || row.sha256 === null) {
      throw new StatementError(`statement ${id} is ${row.status}; it has no file`, STATEMENT_CODES.notFinished, 409);
    }
    const day = (d: Date) => d.toISOString().slice(0, 10);
    return { csv: row.file, sha256: row.sha256, filename: `statement-${day(row.range_from)}-${day(row.range_to)}.csv` };
  }

  private async own(userId: string, id: string): Promise<JobRow> {
    if (!JOB_ID.test(id)) throw new StatementError(`no statement ${id}`, STATEMENT_CODES.notFound, 404);
    const [row] = await this.sql<JobRow[]>`SELECT * FROM trade.statement_exports WHERE id = ${id} AND user_id = ${userId}`;
    // Another person's statement reads as not found, never as forbidden: its existence is not theirs to learn.
    if (!row) throw new StatementError(`no statement ${id}`, STATEMENT_CODES.notFound, 404);
    return row;
  }

  private async row(userId: string, id: string): Promise<JobRow> {
    const [row] = await this.sql<JobRow[]>`SELECT * FROM trade.statement_exports WHERE id = ${id} AND user_id = ${userId}`;
    if (!row) throw new Error(`statement job ${id} vanished`);
    return row;
  }

  private async build(userId: string, job: JobRow): Promise<void> {
    const range = { from: job.range_from, to: job.range_to };
    let built: { csv: string; orders: number; trades: number; ledger: number };
    try {
      built = await this.compose(userId, range);
    } catch (err) {
      if (err instanceof StatementTooLarge || err instanceof LedgerRangeTooLargeError) {
        await this.sql`
          UPDATE trade.statement_exports
             SET status = 'failed', error_code = ${STATEMENT_CODES.tooLarge}, finished_at = ${this.now()}
           WHERE id = ${job.id} AND status = 'pending'
        `;
        return;
      }
      // Anything else (the ledger unreachable) leaves the job pending: the same request builds it again.
      throw err;
    }
    const sha256 = createHash('sha256').update(built.csv, 'utf8').digest('hex');
    await this.sql`
      UPDATE trade.statement_exports
         SET status = 'finished', file = ${built.csv}, sha256 = ${sha256},
             order_rows = ${built.orders}, trade_rows = ${built.trades}, ledger_rows = ${built.ledger},
             finished_at = ${this.now()}
       WHERE id = ${job.id} AND status = 'pending'
    `;
  }

  private async compose(userId: string, range: { from: Date; to: Date }) {
    const orders = await this.sql<OrderLine[]>`
      SELECT id, market_id, client_order_id, side, type, status, price::text AS price, qty::text AS qty,
             filled_qty::text AS filled_qty, created_at
        FROM trade.orders
       WHERE user_id = ${userId} AND created_at >= ${range.from} AND created_at < ${range.to}
       ORDER BY created_at, id
       LIMIT ${STATEMENT_ROWS_MAX + 1}
    `;
    if (orders.length > STATEMENT_ROWS_MAX) throw new StatementTooLarge();
    const fills = await this.sql<FillLine[]>`
      SELECT id, order_id, market_id, side, liquidity, price::text AS price, qty::text AS qty, fee_asset,
             fee_amount::text AS fee_amount, ts
        FROM trade.fills
       WHERE user_id = ${userId} AND ts >= ${range.from} AND ts < ${range.to}
       ORDER BY ts, id
       LIMIT ${STATEMENT_ROWS_MAX + 1}
    `;
    if (fills.length > STATEMENT_ROWS_MAX) throw new StatementTooLarge();
    const lines = await ledgerLinesInRange(this.ledger, userId, range, STATEMENT_ROWS_MAX);
    const marketIds = [...new Set([...orders.map((o) => o.market_id), ...fills.map((f) => f.market_id)])];
    const symbols = new Map<string, string>();
    if (marketIds.length > 0) {
      const rows = await this.sql<
        { id: string; symbol: string }[]
      >`SELECT id, symbol FROM trade.markets WHERE id IN ${this.sql(marketIds)}`;
      for (const r of rows) symbols.set(r.id, r.symbol);
    }
    return { csv: statementCsv(orders, fills, lines, symbols), orders: orders.length, trades: fills.length, ledger: lines.length };
  }
}

class StatementTooLarge extends Error {}

const amount = (v: string | null) => (v === null ? '' : formatAmount(parseAmount(v)));

/** The file: a header, then orders, trades and ledger lines, each oldest first. */
export function statementCsv(
  orders: readonly OrderLine[],
  fills: readonly FillLine[],
  lines: readonly LedgerLine[],
  symbols: ReadonlyMap<string, string>,
): string {
  const out = [STATEMENT_COLUMNS.join(',')];
  const row = (cells: Partial<Record<Column, string>>) => out.push(STATEMENT_COLUMNS.map((c) => csvCell(cells[c] ?? '')).join(','));
  for (const o of orders) {
    row({
      record: 'order',
      id: o.id,
      time: o.created_at.toISOString(),
      market: symbols.get(o.market_id) ?? o.market_id,
      side: o.side,
      type: o.type,
      status: o.status,
      price: amount(o.price),
      amount: amount(o.qty),
      filled: amount(o.filled_qty),
      client_order_id: o.client_order_id ?? '',
    });
  }
  for (const f of fills) {
    row({
      record: 'trade',
      id: f.id,
      time: f.ts.toISOString(),
      market: symbols.get(f.market_id) ?? f.market_id,
      side: f.side,
      type: f.liquidity,
      price: amount(f.price),
      amount: amount(f.qty),
      fee: amount(f.fee_amount),
      fee_asset: f.fee_asset,
      order_id: f.order_id,
    });
  }
  for (const l of lines) {
    row({
      record: 'ledger',
      id: l.entryId,
      time: l.postedAt.toISOString(),
      amount: l.amount,
      asset: l.assetId,
      direction: l.direction === 'debit' ? 'in' : 'out',
      ledger_ref: l.txId,
      reason: l.reason,
      order_id: l.orderId ?? '',
    });
  }
  return `${out.join('\n')}\n`;
}

/** RFC 4180 quoting, and a leading formula character neutralised so a spreadsheet shows the text instead of running it. */
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) && !/^-\d/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function present(row: JobRow): StatementJob {
  return {
    id: row.id,
    requestKey: row.request_key,
    from: row.range_from.toISOString(),
    to: row.range_to.toISOString(),
    status: row.status,
    rows:
      row.status === 'finished' && row.order_rows !== null && row.trade_rows !== null && row.ledger_rows !== null
        ? { orders: row.order_rows, trades: row.trade_rows, ledger: row.ledger_rows }
        : null,
    sha256: row.sha256,
    error: row.error_code,
    createdAt: row.created_at.toISOString(),
    finishedAt: row.finished_at === null ? null : row.finished_at.toISOString(),
  };
}
