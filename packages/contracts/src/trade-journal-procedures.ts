import { z } from 'zod';
import { defineProcedure, type Refusals } from './procedure.js';

/**
 * THE PERPS TRADE JOURNAL (J-portfolio-18): every closed perpetual trade on the person's own venue account, recorded
 * with no entry by hand (svc-trade src/venue/trade-journal.ts). Nothing is sent to the venue and the ledger posts
 * nothing; each closed trade worked from the venue's fills, funding, order history and candles is kept in the journal's
 * own record (`trade.user_venue_journal_trades`), so a trade stays whole after the venue stops returning its history.
 *
 * - A trade runs from flat to flat on one market: entry is the size-weighted average price of the fills that opened or
 *   added, exit of those that reduced or closed; `size` is the largest size held. A fill that flips the position closes
 *   one trade and opens the next, its amount, fees and the venue's realised result split between them by size.
 * - Net result: the venue's realised result, less the venue's fee and our builder fee, plus or minus the funding the
 *   venue booked on the position while it was open, each part as the venue reports it. A closing fill the venue reports
 *   no realised result for leaves `realisedPnl` and `netPnl` null, never 0.
 * - The planned stop and target are the stop-loss and take-profit trigger orders the trade opened with: attached to the
 *   order of its first fill, else placed before its second fill. None: `null`, never guessed.
 * - 1R = |entry − stop| × the largest size; R = net result ÷ 1R, to four places. No stop: `rMissing: 'no_stop_when_opened'`.
 * - MAE and MFE: the worst and best price the venue's 1-minute candles reached over the trade's time, in price, dollars
 *   (per unit × the largest size) and percent of the entry. Candles missing (a fill's minute has no candle, or one that
 *   does not hold the fill's price): `excursion.complete` false and both null.
 * - Disciplined: the result had the trade left at its planned stop or target, whichever price the venue's candles reached
 *   first from entry (both in one candle: the stop), with the trade's own fees. `unresolved` while neither has been
 *   reached; `no_plan` with neither set.
 */

const base = { service: 'svc-trade', module: 'trade', transport: 'trpc' } as const;
const READ = { caller: 'scope', scope: 'trade:read', module: 'trade' } as const;

const decimal = z.string().regex(/^-?[0-9]+(\.[0-9]+)?$/);

/** The most closed trades one read returns, newest closed first. */
export const TRADE_JOURNAL_MAX_TRADES = 100;
/** How far back one read may start: the venue keeps a bounded fill history, and candles are read per trade. */
export const TRADE_JOURNAL_MAX_DAYS = 90;

export const DISCIPLINED_EXITS = ['stop', 'target', 'unresolved', 'no_plan'] as const;
export const R_MISSING = ['no_stop_when_opened', 'no_result'] as const;

/** One fill, or the part of a flipping fill, inside one trade, as the venue reports it. */
export const journalFillSchema = z.object({
  fillId: z.string().min(1),
  filledAt: z.string(),
  side: z.enum(['buy', 'sell']),
  price: decimal,
  amount: decimal,
  venueFee: decimal,
  builderFee: decimal,
  feeAsset: z.string().min(1),
  /** True when it opened or added to the position; false when it reduced or closed it. */
  opening: z.boolean(),
  /** The part of a flipping fill: the fill's amount, fees and realised result are split by size. */
  split: z.boolean(),
});

const excursionSchema = z.object({
  price: decimal,
  /** How far from the entry, per unit (never below zero). */
  perUnit: decimal,
  /** Per unit × the largest size. */
  usd: decimal,
  /** Per unit ÷ the entry × 100, to two places. */
  pct: decimal,
});

/** A closed trade's figures, as the journal's record keeps them. */
export const journalTradeFiguresSchema = z.object({
  /** The first opening fill's venue id: stable for the trade. */
  tradeId: z.string().min(1),
  symbol: z.string().min(1),
  side: z.enum(['long', 'short']),
  openedAt: z.string(),
  closedAt: z.string(),
  entryPrice: decimal,
  exitPrice: decimal,
  /** The largest size held, in base units. */
  size: decimal,
  fills: z.array(journalFillSchema).min(2),
  feeAsset: z.string().min(1),
  /** The venue's realised result on the closing fills; null when it reported none on one of them. */
  realisedPnl: decimal.nullable(),
  venueFees: decimal,
  builderFees: decimal,
  /** The funding the venue booked on the position while it was open (paid: below zero), and in how many payments. */
  funding: decimal,
  fundingPayments: z.number().int().min(0),
  /** realisedPnl − venueFees − builderFees + funding; null with realisedPnl. */
  netPnl: decimal.nullable(),
  plannedStop: decimal.nullable(),
  plannedTarget: decimal.nullable(),
  /** 1R in dollars: |entry − stop| × size. */
  risk: decimal.nullable(),
  rMultiple: decimal.nullable(),
  rMissing: z.enum(R_MISSING).nullable(),
  excursion: z.object({
    interval: z.literal('1m'),
    complete: z.boolean(),
    mae: excursionSchema.nullable(),
    mfe: excursionSchema.nullable(),
  }),
  disciplined: z.object({
    exit: z.enum(DISCIPLINED_EXITS),
    /** The planned level it would have left at; `null` when `unresolved` or `no_plan`. */
    exitPrice: decimal.nullable(),
    netPnl: decimal.nullable(),
  }),
});
export type JournalTradeFigures = z.infer<typeof journalTradeFiguresSchema>;

export const journalTradeSchema = journalTradeFiguresSchema.extend({
  /** When the journal first stored this trade (or last completed it). */
  storedAt: z.string(),
  /** `venue`: the venue still returns the trade's fills; `record`: shown from the journal's own record alone. */
  source: z.enum(['venue', 'record']),
});
export type JournalTrade = z.infer<typeof journalTradeSchema>;

export const tradeJournalSchema = z.object({
  venue: z.object({ id: z.string(), name: z.string(), test: z.boolean() }),
  owner: z.string(),
  subAccount: z.string().nullable(),
  since: z.string(),
  /** The venue's own time for its fills read. */
  asOf: z.string(),
  /** Newest closed first, at most `TRADE_JOURNAL_MAX_TRADES`. */
  trades: z.array(journalTradeSchema),
  /**
   * Every closed trade's net result over the trades that have one (`netUnknown` counts the rest), and the disciplined one
   * over the trades that have one (named by `disciplinedCount`).
   */
  totals: z.object({
    count: z.number().int(),
    netPnl: decimal,
    netUnknown: z.number().int(),
    disciplinedCount: z.number().int(),
    actualNetPnlOfDisciplined: decimal,
    disciplinedNetPnl: decimal,
  }),
});
export type TradeJournal = z.infer<typeof tradeJournalSchema>;

const refuse = (map: Record<string, 'BAD_REQUEST' | 'FORBIDDEN' | 'SERVICE_UNAVAILABLE'>): Refusals => Object.freeze(map);

const OWNER = '0x1111111111111111111111111111111111111111';

/** `journal.closedTrades`: the closed perpetual trades of one of the person's venue accounts since `since`. */
export const TRADE_JOURNAL_CLOSED_TRADES = defineProcedure({
  ...base,
  name: 'trade.journal.closedTrades',
  kind: 'query',
  path: 'journal.closedTrades',
  access: READ,
  refusals: refuse({
    'trade.journal_unavailable': 'SERVICE_UNAVAILABLE',
    'trade.journal_request_invalid': 'BAD_REQUEST',
    'trade.venue_sub_account_not_own': 'FORBIDDEN',
  }),
  input: z.object({
    owner: z.string().max(64),
    subAccount: z.string().max(128).nullable().optional(),
    since: z.string().datetime(),
    limit: z.number().int().min(1).max(TRADE_JOURNAL_MAX_TRADES),
  }),
  output: tradeJournalSchema,
  samples: [
    { verdict: 'accept', input: { owner: OWNER, since: '2026-11-01T00:00:00.000Z', limit: 50 } },
    { verdict: 'refuse', input: { owner: OWNER, since: 'yesterday', limit: 50 } },
    { verdict: 'refuse', input: { owner: OWNER, since: '2026-11-01T00:00:00.000Z', limit: 0 } },
    { verdict: 'refuse', input: {} },
  ],
});
