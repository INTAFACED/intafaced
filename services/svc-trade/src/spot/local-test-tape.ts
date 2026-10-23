/**
 * LOCAL TEST tape history: re-stamp the timestamps of TEST trades so a fresh local stack has past candles.
 *
 * A wiped stack has no market history, so a chart asking for 200 fifteen-minute bars has nothing to show. The local
 * tooling places real TEST trades through the normal order path (ledger holds, engine match, fills, fees), each order
 * carrying a `LTEST-TAPE-` client id, and then asks this module to spread those fills back over past buckets. Only
 * `trade.fills.ts` changes. Price, quantity, fees, ledger postings and order rows stay exactly as the trade wrote them.
 *
 * It is refused everywhere except an explicit dev/test process with `TRADE_LOCAL_TEST_TAPE_RETIME=on`, and svc-trade
 * refuses to start when that flag is on anywhere else. It only touches a market whose every fill belongs to tape
 * orders, so a live print is never moved and the public tape's sequence order matches its time order.
 */
import type { Sql } from 'postgres';
import { z } from 'zod';
import { isExplicitDevOrTest } from '@intafaced/config';

export const LOCAL_TEST_TAPE_RETIME_ENV = 'TRADE_LOCAL_TEST_TAPE_RETIME' as const;
/** Every order of a tape trade, maker and taker, carries this client order id prefix. */
export const LOCAL_TEST_TAPE_CLIENT_ORDER_PREFIX = 'LTEST-TAPE-' as const;
/** History is spread over at most this far back. */
export const LOCAL_TEST_TAPE_MAX_AGE_MS = 31 * 24 * 60 * 60 * 1000;
/** Most trades one retime moves. */
export const LOCAL_TEST_TAPE_MAX_TRADES = 5000;

export type LocalTestTapeRefusal =
  | 'trade.local_test_tape_flag_invalid'
  | 'trade.local_test_tape_not_dev'
  | 'trade.local_test_tape_market_unknown'
  | 'trade.local_test_tape_empty'
  | 'trade.local_test_tape_too_many'
  | 'trade.local_test_tape_not_tape_only'
  | 'trade.local_test_tape_window_invalid';

export class LocalTestTapeError extends Error {
  constructor(
    readonly code: LocalTestTapeRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'LocalTestTapeError';
  }
}

/**
 * Reads the flag from the RAW env (unset APP_ENV is NOT dev). Unset, blank or `off` is off. `on` is on, and throws
 * outside explicit dev/test. Any other value throws: a typo must not leave an operator guessing which way it went.
 */
export function localTestTapeRetimeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env[LOCAL_TEST_TAPE_RETIME_ENV]?.trim().toLowerCase() ?? '';
  if (raw === '' || raw === 'off') return false;
  if (raw !== 'on') {
    throw new LocalTestTapeError('trade.local_test_tape_flag_invalid', `${LOCAL_TEST_TAPE_RETIME_ENV} must be unset, off or on`);
  }
  if (!isExplicitDevOrTest(env.APP_ENV)) {
    throw new LocalTestTapeError(
      'trade.local_test_tape_not_dev',
      `${LOCAL_TEST_TAPE_RETIME_ENV}=on is a local test stand-in and is refused unless APP_ENV is dev or test (got ${JSON.stringify(env.APP_ENV ?? null)})`,
    );
  }
  return true;
}

export const localTestTapeRetimeSchema = z
  .object({
    marketId: z.string().uuid(),
    /** The first trade's new time, epoch ms. */
    startMs: z.number().int().positive(),
    /** Gap between consecutive trades, ms. One second to one day. */
    stepMs: z
      .number()
      .int()
      .min(1_000)
      .max(24 * 60 * 60 * 1000),
  })
  .strict();
export type LocalTestTapeRetime = z.infer<typeof localTestTapeRetimeSchema>;

export type LocalTestTapeRetimeResult = {
  readonly marketId: string;
  /** Matches moved, one per engine sequence. */
  readonly trades: number;
  /** Fill rows moved (maker and taker legs). */
  readonly fills: number;
  readonly firstTs: string;
  readonly lastTs: string;
};

/**
 * Gives the market's tape trades, in engine sequence order, the times `startMs + i * stepMs`. Both legs of a match
 * share its sequence, so they move together. Running it again with the same input writes the same times.
 */
export async function retimeLocalTestTape(
  sql: Sql,
  input: LocalTestTapeRetime,
  now: Date = new Date(),
): Promise<LocalTestTapeRetimeResult> {
  return sql.begin('isolation level serializable', async (tx) => {
    const market = await tx<Array<{ id: string }>>`SELECT id FROM trade.markets WHERE id = ${input.marketId}`;
    if (market.length === 0) throw new LocalTestTapeError('trade.local_test_tape_market_unknown', 'No such market');

    const [foreign] = await tx<Array<{ n: string }>>`
      SELECT count(*)::text AS n
        FROM trade.fills f
        JOIN trade.orders o ON o.id = f.order_id
        LEFT JOIN trade.orders c ON c.id = f.counter_order_id
       WHERE f.market_id = ${input.marketId}
         AND (
           o.seeded OR o.client_order_id IS NULL OR left(o.client_order_id, ${LOCAL_TEST_TAPE_CLIENT_ORDER_PREFIX.length}) <> ${LOCAL_TEST_TAPE_CLIENT_ORDER_PREFIX}
           OR c.id IS NULL OR c.seeded OR c.client_order_id IS NULL
           OR left(c.client_order_id, ${LOCAL_TEST_TAPE_CLIENT_ORDER_PREFIX.length}) <> ${LOCAL_TEST_TAPE_CLIENT_ORDER_PREFIX}
         )`;
    if (Number(foreign?.n ?? '0') > 0) {
      throw new LocalTestTapeError(
        'trade.local_test_tape_not_tape_only',
        'The market has fills that are not TEST tape trades; retime only a fresh market',
      );
    }

    const sequences = await tx<Array<{ sequence: number }>>`
      SELECT DISTINCT sequence FROM trade.fills WHERE market_id = ${input.marketId} ORDER BY sequence`;
    if (sequences.length === 0) throw new LocalTestTapeError('trade.local_test_tape_empty', 'The market has no tape trades');
    if (sequences.length > LOCAL_TEST_TAPE_MAX_TRADES) {
      throw new LocalTestTapeError('trade.local_test_tape_too_many', `At most ${LOCAL_TEST_TAPE_MAX_TRADES} tape trades per retime`);
    }

    const lastMs = input.startMs + (sequences.length - 1) * input.stepMs;
    if (input.startMs < now.getTime() - LOCAL_TEST_TAPE_MAX_AGE_MS || lastMs >= now.getTime()) {
      throw new LocalTestTapeError('trade.local_test_tape_window_invalid', 'Tape times must lie in the past and no more than 31 days back');
    }

    const seqs = sequences.map((s) => s.sequence);
    const times = seqs.map((_, i) => new Date(input.startMs + i * input.stepMs).toISOString());
    const moved = await tx`
      UPDATE trade.fills f
         SET ts = v.ts
        FROM (SELECT unnest(${seqs}::int[]) AS sequence, unnest(${times}::timestamptz[]) AS ts) v
       WHERE f.market_id = ${input.marketId} AND f.sequence = v.sequence`;

    return {
      marketId: input.marketId,
      trades: seqs.length,
      fills: moved.count,
      firstTs: times[0]!,
      lastTs: times[times.length - 1]!,
    };
  });
}
