/**
 * Durable block/RFQ quote store.
 *
 * Quotes are firm numbers as built — never a new mid, size, price, or expiry.
 */

import type { Sql } from 'postgres';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import {
  BlockRfqError,
  parseRequiredCapacity,
  parseRequiredFirmness,
  type BlockQuote,
  type BlockQuoteCapacity,
  type BlockQuoteFirmness,
  type BlockQuoteLifecycle,
  type BlockRfqSide,
} from './block-rfq.js';

export interface BlockQuoteStore {
  save(quote: BlockQuote): Promise<void>;
  load(quoteId: string): Promise<BlockQuote | null>;
}

export class MemoryBlockQuoteStore implements BlockQuoteStore {
  private readonly byId = new Map<string, BlockQuote>();

  async save(quote: BlockQuote): Promise<void> {
    this.byId.set(quote.quoteId, { ...quote });
  }

  async load(quoteId: string): Promise<BlockQuote | null> {
    const row = this.byId.get(quoteId);
    return row ? { ...row } : null;
  }
}

type QuoteRow = {
  quote_id: string;
  maker_id: string;
  taker_id: string;
  side: BlockRfqSide;
  asset: string;
  fiat_currency: string;
  size: string;
  price: string;
  notional: string;
  created_at: Date | string;
  expires_at: Date | string;
  lifecycle: BlockQuoteLifecycle;
  accepted_at: Date | string | null;
  fill_price: string | null;
  capacity: BlockQuoteCapacity | string | null;
  firmness: BlockQuoteFirmness | string | null;
};

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function rowToQuote(row: QuoteRow): BlockQuote {
  return {
    quoteId: row.quote_id,
    makerId: row.maker_id,
    takerId: row.taker_id,
    side: row.side,
    asset: row.asset,
    fiatCurrency: row.fiat_currency,
    size: parseAmount(row.size),
    price: parseAmount(row.price),
    notional: parseAmount(row.notional),
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
    lifecycle: row.lifecycle,
    acceptedAt: row.accepted_at == null ? null : iso(row.accepted_at),
    fillPrice: row.fill_price == null ? null : parseAmount(row.fill_price),
    capacity: parseRequiredCapacity(row.capacity),
    firmness: parseRequiredFirmness({ firmness: row.firmness }),
    bookFill: false,
  };
}

export class SqlBlockQuoteStore implements BlockQuoteStore {
  constructor(private readonly sql: Sql) {}

  async save(quote: BlockQuote): Promise<void> {
    // Accept and expire decide in memory, then save. The update applies only
    // while the stored lifecycle is still open, so a firm fill stays put and
    // an expired quote stays expired.
    const written = await this.sql<{ quote_id: string }[]>`
      INSERT INTO p2p.block_quotes (
        quote_id, maker_id, taker_id, side, asset, fiat_currency,
        size, price, notional, created_at, expires_at, lifecycle,
        accepted_at, fill_price, capacity, firmness, updated_at
      ) VALUES (
        ${quote.quoteId},
        ${quote.makerId},
        ${quote.takerId},
        ${quote.side},
        ${quote.asset},
        ${quote.fiatCurrency},
        ${formatAmount(quote.size)},
        ${formatAmount(quote.price)},
        ${formatAmount(quote.notional)},
        ${quote.createdAt},
        ${quote.expiresAt},
        ${quote.lifecycle},
        ${quote.acceptedAt},
        ${quote.fillPrice == null ? null : formatAmount(quote.fillPrice)},
        ${quote.capacity},
        ${quote.firmness},
        now()
      )
      ON CONFLICT (quote_id) DO UPDATE SET
        lifecycle = EXCLUDED.lifecycle,
        accepted_at = EXCLUDED.accepted_at,
        fill_price = EXCLUDED.fill_price,
        updated_at = now()
      WHERE p2p.block_quotes.lifecycle = 'open'
        AND ROW(p2p.block_quotes.maker_id, p2p.block_quotes.taker_id, p2p.block_quotes.side,
                p2p.block_quotes.asset, p2p.block_quotes.fiat_currency, p2p.block_quotes.size,
                p2p.block_quotes.price, p2p.block_quotes.notional, p2p.block_quotes.created_at,
                p2p.block_quotes.expires_at, p2p.block_quotes.capacity, p2p.block_quotes.firmness)
            IS NOT DISTINCT FROM
            ROW(EXCLUDED.maker_id, EXCLUDED.taker_id, EXCLUDED.side, EXCLUDED.asset, EXCLUDED.fiat_currency,
                EXCLUDED.size, EXCLUDED.price, EXCLUDED.notional, EXCLUDED.created_at, EXCLUDED.expires_at,
                EXCLUDED.capacity, EXCLUDED.firmness)
      RETURNING quote_id
    `;
    if (written.length > 0) return;
    const current = await this.load(quote.quoteId);
    if (current?.lifecycle === 'open') throw new BlockRfqError('Block/RFQ original terms conflict', 'p2p.rfq_terms_conflict');
    if (current?.lifecycle === 'bound') {
      throw new BlockRfqError(
        'A bound block/RFQ cannot expire — that would unwind a firm accept into a book fill',
        'p2p.rfq_already_bound',
      );
    }
    throw new BlockRfqError('Block/RFQ quote expired — refuse rather than requote', 'p2p.rfq_expired');
  }

  async load(quoteId: string): Promise<BlockQuote | null> {
    const rows = await this.sql<QuoteRow[]>`
      SELECT
        quote_id, maker_id, taker_id, side, asset, fiat_currency,
        size::text, price::text, notional::text,
        created_at, expires_at, lifecycle,
        accepted_at, fill_price::text,
        capacity::text, firmness::text
      FROM p2p.block_quotes
      WHERE quote_id = ${quoteId}
    `;
    if (!rows[0]) return null;
    return rowToQuote(rows[0]);
  }
}
