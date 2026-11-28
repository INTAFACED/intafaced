import type { Sql } from 'postgres';
import { z } from 'zod';
import {
  journalTradeFiguresSchema,
  replayBarSchema,
  replayStopSchema,
  type JournalTradeFigures,
  type ReplayBar,
  type ReplayStop,
} from '@intafaced/contracts/trade-journal-procedures';

/**
 * The journal's own record of the person's closed perp trades (trade-journal.ts, J-portfolio-18 #7), held in
 * `trade.user_venue_journal_trades` (drizzle/20261128110000_user_venue_journal_trades.sql). A copy of what the venue
 * reported, so a trade stays whole after the venue stops returning its fills and candles: no balance, no post, nothing
 * sent to the venue. Beside each trade, what its replay needs (J-charts-desk-20 #3), in
 * `trade.user_venue_journal_replays` (drizzle/20261128120000_user_venue_journal_replays.sql): its market's 1-minute bars
 * from 10 before the entry bar to the close, and where its stop stood, so a trade the venue no longer returns still replays.
 */

export interface JournalBook {
  readonly venueId: string;
  readonly owner: string;
  readonly subAccount: string | null;
}

export interface StoredJournalTrade {
  readonly trade: JournalTradeFigures;
  readonly storedAt: Date;
}

/** What the journal keeps to replay one trade: its market's bars around it and where its stop stood. */
export interface KeptReplay {
  readonly tradeId: string;
  /** False when the trade was worked with its candles missing; such a row is replaced once by a complete one. */
  readonly complete: boolean;
  readonly interval: string;
  /** Oldest first. */
  readonly bars: readonly ReplayBar[];
  /** The stop it opened with, then each later one, oldest first. */
  readonly stops: readonly ReplayStop[];
}

export interface StoredReplay extends KeptReplay {
  readonly storedAt: Date;
}

export interface TradeJournalStore {
  /**
   * Keep each trade once, keyed by its first fill. A trade kept with its candles missing is replaced when `trades` holds
   * it complete; a complete one is never changed.
   */
  keep(book: JournalBook, trades: readonly JournalTradeFigures[], at: Date): Promise<void>;
  /** The kept trades closed at or after `since`, newest closed first, at most `limit`. */
  list(book: JournalBook, since: Date, limit: number): Promise<StoredJournalTrade[]>;
  /** Keep each trade's replay once, as `keep` keeps the trade: an incomplete one is replaced when a complete one comes. */
  keepReplays(book: JournalBook, replays: readonly KeptReplay[], at: Date): Promise<void>;
  /** The kept replay of one trade, or null when none was kept. */
  replayOf(book: JournalBook, tradeId: string): Promise<StoredReplay | null>;
}

const bookId = (b: JournalBook) => `${b.venueId}\n${b.owner}\n${b.subAccount ?? ''}`;

export class InMemoryTradeJournalStore implements TradeJournalStore {
  readonly rows = new Map<string, Map<string, StoredJournalTrade>>();
  async keep(book: JournalBook, trades: readonly JournalTradeFigures[], at: Date) {
    const rows = this.rows.get(bookId(book)) ?? new Map<string, StoredJournalTrade>();
    this.rows.set(bookId(book), rows);
    for (const trade of trades) {
      const was = rows.get(trade.tradeId);
      if (!was || (!was.trade.excursion.complete && trade.excursion.complete)) rows.set(trade.tradeId, { trade, storedAt: at });
    }
  }
  async list(book: JournalBook, since: Date, limit: number) {
    return [...(this.rows.get(bookId(book))?.values() ?? [])]
      .filter((r) => Date.parse(r.trade.closedAt) >= since.getTime())
      .sort((a, b) => Date.parse(b.trade.closedAt) - Date.parse(a.trade.closedAt))
      .slice(0, limit);
  }
  readonly replays = new Map<string, Map<string, StoredReplay>>();
  async keepReplays(book: JournalBook, replays: readonly KeptReplay[], at: Date) {
    const rows = this.replays.get(bookId(book)) ?? new Map<string, StoredReplay>();
    this.replays.set(bookId(book), rows);
    for (const r of replays) {
      const was = rows.get(r.tradeId);
      if (!was || (!was.complete && r.complete)) rows.set(r.tradeId, { ...r, storedAt: at });
    }
  }
  async replayOf(book: JournalBook, tradeId: string) {
    return this.replays.get(bookId(book))?.get(tradeId) ?? null;
  }
}

const Row = z.object({ trade: journalTradeFiguresSchema, stored_at: z.date() });
const ReplayRow = z.object({
  trade_id: z.string(),
  complete: z.boolean(),
  bar_interval: z.string(),
  bars: z.array(replayBarSchema),
  stops: z.array(replayStopSchema),
  stored_at: z.date(),
});

export class SqlTradeJournalStore implements TradeJournalStore {
  constructor(private readonly sql: Sql) {}

  async keep(book: JournalBook, trades: readonly JournalTradeFigures[], at: Date) {
    for (const t of trades)
      await this.sql`
        INSERT INTO trade.user_venue_journal_trades
          (venue_id, owner, sub_account, trade_id, symbol, closed_at, complete, trade, stored_at)
        VALUES (${book.venueId}, ${book.owner}, ${book.subAccount ?? ''}, ${t.tradeId}, ${t.symbol}, ${new Date(t.closedAt)},
          ${t.excursion.complete}, ${JSON.stringify(t)}::text::jsonb, ${at})
        ON CONFLICT (venue_id, owner, sub_account, trade_id) DO UPDATE SET
          complete = EXCLUDED.complete, trade = EXCLUDED.trade, stored_at = EXCLUDED.stored_at
        WHERE NOT trade.user_venue_journal_trades.complete AND EXCLUDED.complete`;
  }

  async list(book: JournalBook, since: Date, limit: number) {
    const rows = Row.array().parse(
      await this.sql`
      SELECT trade, stored_at FROM trade.user_venue_journal_trades
      WHERE venue_id = ${book.venueId} AND owner = ${book.owner} AND sub_account = ${book.subAccount ?? ''} AND closed_at >= ${since}
      ORDER BY closed_at DESC, trade_id DESC
      LIMIT ${limit}`,
    );
    return rows.map((r) => ({ trade: r.trade, storedAt: r.stored_at }));
  }

  async keepReplays(book: JournalBook, replays: readonly KeptReplay[], at: Date) {
    for (const r of replays)
      await this.sql`
        INSERT INTO trade.user_venue_journal_replays
          (venue_id, owner, sub_account, trade_id, complete, bar_interval, bars, stops, stored_at)
        VALUES (${book.venueId}, ${book.owner}, ${book.subAccount ?? ''}, ${r.tradeId}, ${r.complete}, ${r.interval},
          ${JSON.stringify(r.bars)}::text::jsonb, ${JSON.stringify(r.stops)}::text::jsonb, ${at})
        ON CONFLICT (venue_id, owner, sub_account, trade_id) DO UPDATE SET
          complete = EXCLUDED.complete, bar_interval = EXCLUDED.bar_interval, bars = EXCLUDED.bars, stops = EXCLUDED.stops,
          stored_at = EXCLUDED.stored_at
        WHERE NOT trade.user_venue_journal_replays.complete AND EXCLUDED.complete`;
  }

  async replayOf(book: JournalBook, tradeId: string) {
    const [row] = ReplayRow.array().parse(
      await this.sql`
      SELECT trade_id, complete, bar_interval, bars, stops, stored_at FROM trade.user_venue_journal_replays
      WHERE venue_id = ${book.venueId} AND owner = ${book.owner} AND sub_account = ${book.subAccount ?? ''} AND trade_id = ${tradeId}`,
    );
    return row
      ? {
          tradeId: row.trade_id,
          complete: row.complete,
          interval: row.bar_interval,
          bars: row.bars,
          stops: row.stops,
          storedAt: row.stored_at,
        }
      : null;
  }
}
