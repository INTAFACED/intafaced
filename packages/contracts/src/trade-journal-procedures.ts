import { z } from 'zod';
import { defineProcedure, type Refusals } from './procedure.js';

/**
 * THE PERPS TRADE JOURNAL: every closed perpetual trade on the person's own venue account, recorded with no
 * entry by hand (svc-trade src/venue/trade-journal.ts). Read only: nothing is sent to the venue, nothing is stored, and
 * the ledger posts nothing. Every figure is the venue's own (its fills, its order history, its candles), worked here.
 *
 * - A trade runs from flat to flat on one market: entry is the average price of the fills that opened or added, exit of
 *   those that reduced or closed; size is everything opened. A fill that flips the position closes one trade and opens
 *   the next, its fee split by amount.
 * - The planned stop and target are the first stop-loss and take-profit trigger orders on the market set at entry: the
 *   ones attached to an opening order, else the first placed while the trade was open. None: `null`, never guessed.
 * - R = net result over the planned risk (|entry − stop| × size); `null` with no stop.
 * - MAE and MFE (worst and best price reached while open) come from the venue's candles over the trade's window, at the
 *   finest interval that covers it (`candleInterval`), with the entry and exit prices themselves.
 * - Disciplined: the result had the trade left at its planned stop or target, whichever price the venue's candles reached
 *   first from entry (both in one candle: the stop), with the trade's own fees. `unresolved` while neither has been
 *   reached; `no_plan` with neither set.
 * - Keeping my rules (J-portfolio-19): the trade's result had the person kept the rules they set before it, changing only
 *   a trade that broke one, never guessing a better entry or exit. A trade opened while their daily loss limit set to
 *   warn stood reached (the warning svc-trade gave on that opening order) counts 0 (`left_out`). A trade whose stop was
 *   moved further from the entry than the stop it opened with, and whose price then reached that first stop, counts as
 *   stopped there: minus 1R less the trade's own fees, 1R being |entry − first stop| × size (`capped` when that is no
 *   worse than what it made, `stopped` when it made more: a widened stop that won is never credited). A widened stop
 *   whose first stop was never reached, a trade opened with no stop, and one that kept its stop and limit count what
 *   they made.
 */

const base = { service: 'svc-trade', module: 'trade', transport: 'trpc' } as const;
const READ = { caller: 'scope', scope: 'trade:read', module: 'trade' } as const;

const decimal = z.string().regex(/^-?[0-9]+(\.[0-9]+)?$/);

/** The most closed trades one read returns, newest closed first. */
export const TRADE_JOURNAL_MAX_TRADES = 100;
/** How far back one read may start: the venue keeps a bounded fill history, and candles are read per trade. */
export const TRADE_JOURNAL_MAX_DAYS = 90;

export const DISCIPLINED_EXITS = ['stop', 'target', 'unresolved', 'no_plan'] as const;

/** How a trade counts on the "keeping my rules" line (the record's comment defines each). */
export const RULES_VERDICTS = ['kept', 'no_stop', 'widened_unreached', 'capped', 'stopped', 'left_out'] as const;
export type RulesVerdict = (typeof RULES_VERDICTS)[number];

export const journalTradeSchema = z.object({
  /** The first opening fill's venue id: stable for the trade. */
  tradeId: z.string().min(1),
  symbol: z.string().min(1),
  side: z.enum(['long', 'short']),
  openedAt: z.string(),
  closedAt: z.string(),
  entryPrice: decimal,
  exitPrice: decimal,
  /** Everything opened, in base units. */
  size: decimal,
  /** The venue's fee and our builder fee on every fill of the trade. */
  fees: decimal,
  feeAsset: z.string().min(1),
  /** Price result before fees: what was received for the base sold, less what was paid for the base bought. */
  grossPnl: decimal,
  netPnl: decimal,
  plannedStop: decimal.nullable(),
  plannedTarget: decimal.nullable(),
  /** Net result over the planned risk, to four places; `null` with no planned stop. */
  rMultiple: decimal.nullable(),
  /** The worst price reached while open, and how far against the entry it was, per unit (never below zero). */
  maePrice: decimal,
  mae: decimal,
  /** The best price reached while open, and how far in favour of the entry it was, per unit (never below zero). */
  mfePrice: decimal,
  mfe: decimal,
  /** The candle interval MAE, MFE and the disciplined exit were read at. */
  candleInterval: z.string().min(1),
  disciplined: z.object({
    exit: z.enum(DISCIPLINED_EXITS),
    /** The planned level it would have left at; `null` when `unresolved` or `no_plan`. */
    exitPrice: decimal.nullable(),
    netPnl: decimal.nullable(),
  }),
  /** The trade on the "keeping my rules" line (J-portfolio-19). */
  rules: z.object({
    verdict: z.enum(RULES_VERDICTS),
    /** What it counts on the rules line. */
    netPnl: decimal,
    /** 1R: |entry − the stop it opened with| × size; `null` with no stop. */
    oneR: decimal.nullable(),
    /** The furthest stop it was moved to past its first; `null` when never widened. */
    widenedStop: decimal.nullable(),
    /** The warning given on its opening order when the daily loss limit stood reached; `null` otherwise. */
    dailyLoss: z.object({ limit: decimal, loss: decimal, asset: z.string(), warnedAt: z.string() }).nullable(),
  }),
  fillIds: z.array(z.string()),
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
  /** Every closed trade's net result, and the disciplined one over the trades that have one (named by `disciplinedCount`). */
  totals: z.object({
    count: z.number().int(),
    netPnl: decimal,
    disciplinedCount: z.number().int(),
    actualNetPnlOfDisciplined: decimal,
    disciplinedNetPnl: decimal,
    /** Every closed trade on the "keeping my rules" line; less `netPnl`, the gap between the two lines. */
    rulesNetPnl: decimal,
  }),
});
export type TradeJournal = z.infer<typeof tradeJournalSchema>;

const refuse = (map: Record<string, 'BAD_REQUEST' | 'FORBIDDEN' | 'NOT_FOUND' | 'SERVICE_UNAVAILABLE'>): Refusals => Object.freeze(map);

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

/**
 * THE REPLAY OF ONE JOURNAL TRADE (J-charts-desk-20): the closed trade as the journal reads it, the stop it opened with
 * and each later one with the time it was placed, and its market's bars from the venue at the finest interval whose bars
 * from 10 bars before the entry bar up to now fit in one read. `startIndex` is where the replay starts (10 bars before
 * `entryIndex`, the bar the entry falls in, or the first bar when fewer were kept). When the venue no longer returns a bar
 * at or before the entry, `bars` says so (`none`): a chart is never made up. Read only, as the journal is.
 */
export const REPLAY_BARS_BEFORE_ENTRY = 10;

export const replayBarSchema = z.object({
  openAt: z.string(),
  openPrice: decimal,
  highPrice: decimal,
  lowPrice: decimal,
  closePrice: decimal,
  baseVolume: decimal,
});

export const tradeReplaySchema = z.object({
  venue: z.object({ id: z.string(), name: z.string(), test: z.boolean() }),
  trade: journalTradeSchema,
  /** Where the trade's stop stood: the stop it opened with, then each later one, from the time it was placed. */
  stops: z.array(z.object({ price: decimal, placedAt: z.string() })),
  interval: z.string().min(1),
  bars: z.discriminatedUnion('source', [
    z.object({
      source: z.literal('venue'),
      /** The venue's own time for its candles read. */
      asOf: z.string(),
      candles: z.array(replayBarSchema).min(1),
      entryIndex: z.number().int().min(0),
      startIndex: z.number().int().min(0),
    }),
    z.object({ source: z.literal('none') }),
  ]),
});
export type TradeReplay = z.infer<typeof tradeReplaySchema>;

/** `journal.replay`: one closed trade of the person's journal, with its stops over time and its market's bars. */
export const TRADE_JOURNAL_REPLAY = defineProcedure({
  ...base,
  name: 'trade.journal.replay',
  kind: 'query',
  path: 'journal.replay',
  access: READ,
  refusals: refuse({
    'trade.journal_unavailable': 'SERVICE_UNAVAILABLE',
    'trade.journal_request_invalid': 'BAD_REQUEST',
    'trade.journal_trade_unknown': 'NOT_FOUND',
    'trade.venue_sub_account_not_own': 'FORBIDDEN',
  }),
  input: z.object({
    owner: z.string().max(64),
    subAccount: z.string().max(128).nullable().optional(),
    since: z.string().datetime(),
    tradeId: z.string().min(1).max(128),
  }),
  output: tradeReplaySchema,
  samples: [
    { verdict: 'accept', input: { owner: OWNER, since: '2026-11-01T00:00:00.000Z', tradeId: 'fill-1' } },
    { verdict: 'refuse', input: { owner: OWNER, since: '2026-11-01T00:00:00.000Z', tradeId: '' } },
    { verdict: 'refuse', input: { owner: OWNER, since: 'yesterday', tradeId: 'fill-1' } },
  ],
});
