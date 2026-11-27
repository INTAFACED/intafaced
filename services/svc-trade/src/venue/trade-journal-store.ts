import type { Sql } from 'postgres';
import { z } from 'zod';
import { journalTradeFiguresSchema, type JournalTradeFigures } from '@intafaced/contracts/trade-journal-procedures';

/**
 * The journal's own record of the person's closed perp trades (trade-journal.ts, J-portfolio-18 #7), held in
 * `trade.user_venue_journal_trades` (drizzle/20261128100000_user_venue_journal_trades.sql). A copy of what the venue
 * reported, so a trade stays whole after the venue stops returning its fills and candles: no balance, no post, nothing
 * sent to the venue.
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

export interface TradeJournalStore {
  /**
   * Keep each trade once, keyed by its first fill. A trade kept with its candles missing is replaced when `trades` holds
   * it complete; a complete one is never changed.
   */
  keep(book: JournalBook, trades: readonly JournalTradeFigures[], at: Date): Promise<void>;
  /** The kept trades closed at or after `since`, newest closed first, at most `limit`. */
  list(book: JournalBook, since: Date, limit: number): Promise<StoredJournalTrade[]>;
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
}

const Row = z.object({ trade: journalTradeFiguresSchema, stored_at: z.date() });

export class SqlTradeJournalStore implements TradeJournalStore {
  constructor(private readonly sql: Sql) {}

  async keep(book: JournalBook, trades: readonly JournalTradeFigures[], at: Date) {
    for (const t of trades)
      await this.sql`
        INSERT INTO trade.user_venue_journal_trades
          (venue_id, owner, sub_account, trade_id, symbol, closed_at, complete, trade, stored_at)
        VALUES (${book.venueId}, ${book.owner}, ${book.subAccount ?? ''}, ${t.tradeId}, ${t.symbol}, ${new Date(t.closedAt)},
          ${t.excursion.complete}, ${this.sql.json(t as never)}, ${at})
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
}
