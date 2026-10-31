import { z } from 'zod';
import { decimalString } from './instruments.js';

/**
 * Wire types for Predict's outcome-market catalogue (MC-predict-01, J-more-catalogue-15 #1 to #3), version 1: the shapes
 * svc-trade's `GET /api/v1/outcomes/markets` moves to from today's bare array (the list, filtered, capped and paged) and its
 * new `GET /api/v1/outcomes/markets/:marketId` (one market with its rules, timeline of moves and clarifications). A market is metadata over two instruments of the one order book
 * (`<id>:YES`, `<id>:NO`); it holds no value and no second book. A price is only what the book's last trade carried, as a
 * decimal string; a market with no trade has none. Publishing waits for the owner's determination decision (E-1) and
 * refuses `owner.decision` until then; no sample market exists, and a TEST market exists only through the publish path.
 */
export const OUTCOME_MARKETS_CONTRACT_VERSION = 1 as const;

/** Where a market is in its life (ENGINE PM-2). `draft` is never listed to a customer. */
export const OUTCOME_MARKET_STATUSES = ['draft', 'open', 'halted', 'closed', 'determined', 'settling', 'settled', 'voided'] as const;
export type OutcomeMarketStatus = (typeof OUTCOME_MARKET_STATUSES)[number];

/** A move on the market's append-only timeline, each stored with its time and actor. */
export const OUTCOME_MARKET_MOVES = ['created', 'published', 'halted', 'resumed', 'closed', 'determined', 'settled', 'voided'] as const;
export type OutcomeMarketMove = (typeof OUTCOME_MARKET_MOVES)[number];

/** `at_time` closes at its stored close time; `on_outcome` has none and closes by an operator `close` move. */
export const OUTCOME_CLOSE_MODES = ['at_time', 'on_outcome'] as const;
export type OutcomeCloseMode = (typeof OUTCOME_CLOSE_MODES)[number];

/** List orders. Trending is the trade count of the one book over the stored window; nothing is ordered by returns. */
export const OUTCOME_MARKET_SORTS = ['closing_soon', 'newest', 'trending'] as const;
export type OutcomeMarketSort = (typeof OUTCOME_MARKET_SORTS)[number];

export const OUTCOME_MARKET_REFUSALS = [
  // Already sent by svc-trade's outcome doors (services/svc-trade/src/outcomes/outcome-market.ts, outcomes-rest.ts).
  'trade.outcome_id_invalid',
  'trade.outcome_question_invalid',
  'trade.outcome_close_at_invalid',
  'trade.outcome_settlement_asset_unset',
  /** A market whose settlement source is blank is never published; the screen says "not set". */
  'trade.outcome_settlement_source_unset',
  'trade.outcome_market_closed',
  'trade.outcome_order_invalid',
  // New with the stored catalogue.
  /** The owner has not published the list's page size: the list refuses rather than pick one. */
  'trade.outcome_markets_list_limit_unset',
  /** The asked page is larger than the owner's page size. */
  'trade.outcome_markets_list_limit_exceeded',
  'trade.outcome_market_not_found',
  /** A market whose rules text is blank is never published; the screen says "not set". */
  'trade.outcome_rules_unset',
  /** The market's Yes or No instrument is not registered against matching (MC-predict-02). */
  'trade.outcome_instrument_unregistered',
  /** The move is not allowed from the market's current status. */
  'trade.outcome_move_invalid',
  /** The market moved since the operator read it: the expected ordinal is stale, or that ordinal holds a different move. */
  'trade.outcome_move_stale',
  'trade.outcome_list_cursor_invalid',
  /** Publishing waits for the owner's decision on who determines a result (ENGINE E-1): the publish door's answer today. */
  'owner.decision',
] as const;
export type OutcomeMarketRefusal = (typeof OUTCOME_MARKET_REFUSALS)[number];

/** Engineering bounds on the wire, not owner values. */
export const OUTCOME_QUESTION_MAX = 300;
export const OUTCOME_RULES_MAX = 20_000;
export const OUTCOME_CLARIFICATION_MAX = 4_000;
export const OUTCOME_TAG_MAX = 40;
export const OUTCOME_TAGS_MAX = 8;
export const OUTCOME_SEARCH_MAX = 120;

const marketId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'a market id is lower-case letters, digits and dashes')
  // `positions` and `settings` are reserved under /predict, so they are never a market's id.
  .refine((id) => id !== 'positions' && id !== 'settings', 'that id is reserved');
export const outcomeMarketIdSchema = marketId;

const tag = z.string().trim().min(1).max(OUTCOME_TAG_MAX);
const iso = z.string().datetime({ offset: true });

/** An at_time market has a close time; an on_outcome market has none. */
const closeMatchesMode = (m: { closeMode: OutcomeCloseMode; closeAt: string | null }) =>
  (m.closeMode === 'at_time') === (m.closeAt !== null);
const CLOSE_MODE_MESSAGE = 'an at_time market has a close time and an on_outcome market has none';

/** The refinements below pin the symbols to `<id>:YES` and `<id>:NO`. */
export const outcomeInstrumentsSchema = z.tuple([
  z.object({ outcome: z.literal('yes'), symbol: z.string() }),
  z.object({ outcome: z.literal('no'), symbol: z.string() }),
]);

/** One market as the catalogue lists it. */
export const outcomeMarketSummarySchema = z
  .object({
    id: marketId,
    kind: z.literal('outcome'),
    question: z.string().min(1).max(OUTCOME_QUESTION_MAX),
    category: tag.nullable(),
    tags: z.array(tag).max(OUTCOME_TAGS_MAX),
    closeMode: z.enum(OUTCOME_CLOSE_MODES),
    /** Set exactly when `closeMode` is `at_time`; an `on_outcome` market has none and the screen invents none. */
    closeAt: iso.nullable(),
    settlementAssetId: z.string().min(1),
    settlementSource: z.string().min(1).nullable(),
    status: z.enum(OUTCOME_MARKET_STATUSES),
    collateralization: z.literal('full'),
    instruments: outcomeInstrumentsSchema,
    /** The Yes instrument's last trade on the one book, or null: "no trades yet", never a made-up price. */
    lastPrice: decimalString.nullable(),
    /** Trades on the one book over the stored trending window (a count, not money). */
    tradeCount: z.number().int().nonnegative(),
    publishedAt: iso.nullable(),
  })
  .refine(closeMatchesMode, { message: CLOSE_MODE_MESSAGE })
  // Only a draft may lack its source or publish time: publish refuses a blank source.
  .refine((m) => m.status === 'draft' || (m.settlementSource !== null && m.publishedAt !== null), {
    message: 'a published market has its settlement source and publish time',
  })
  .refine((m) => m.instruments[0].symbol === `${m.id}:YES` && m.instruments[1].symbol === `${m.id}:NO`, {
    message: "a market's instruments are <id>:YES and <id>:NO",
  });
export type OutcomeMarketSummary = z.infer<typeof outcomeMarketSummarySchema>;

export const outcomeTimelineEntrySchema = z.object({
  ordinal: z.number().int().positive(),
  move: z.enum(OUTCOME_MARKET_MOVES),
  at: iso,
  /** The operator who made the move; null only for a move the service made by itself (a close at the stored time). */
  actorId: z.string().min(1).nullable(),
});
export type OutcomeTimelineEntry = z.infer<typeof outcomeTimelineEntrySchema>;

/** A note the markets team adds after publish. It never edits the rules text, which stays as published. */
export const outcomeClarificationSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1).max(OUTCOME_CLARIFICATION_MAX),
  at: iso,
});
export type OutcomeClarification = z.infer<typeof outcomeClarificationSchema>;

/** One market with everything its page shows: what is measured, its rules, the moves and the clarifications. */
export const outcomeMarketDetailSchema = z
  .object({
    market: outcomeMarketSummarySchema,
    /** The rules as published; null while unset (the screen says "not set"). */
    rulesText: z.string().min(1).max(OUTCOME_RULES_MAX).nullable(),
    rulesVersion: z.number().int().nonnegative(),
    /** Oldest first. */
    timeline: z.array(outcomeTimelineEntrySchema),
    /** Newest first. */
    clarifications: z.array(outcomeClarificationSchema),
  })
  // Publish refuses blank rules, so only a draft has none.
  .refine((d) => d.market.status === 'draft' || d.rulesText !== null, { message: 'a published market has its rules text' });
export type OutcomeMarketDetail = z.infer<typeof outcomeMarketDetailSchema>;

/** The list read's query. `limit` is required and may not exceed the owner's page size. */
export const outcomeMarketListQuerySchema = z
  .object({
    category: tag.optional(),
    tag: tag.optional(),
    q: z.string().trim().min(1).max(OUTCOME_SEARCH_MAX).optional(),
    status: z.enum(OUTCOME_MARKET_STATUSES).exclude(['draft']).optional(),
    sort: z.enum(OUTCOME_MARKET_SORTS).optional(),
    // A query string carries digits; a JSON body carries a number. Nothing else is read as a limit.
    limit: z.union([
      z.number().int().positive(),
      z
        .string()
        .regex(/^[1-9]\d{0,5}$/)
        .transform(Number),
    ]),
    /** The `nextCursor` of the previous page, as the service wrote it. */
    cursor: z.string().min(1).max(200).optional(),
  })
  .strict();
export type OutcomeMarketListQuery = z.infer<typeof outcomeMarketListQuerySchema>;

export const outcomeMarketListSchema = z.object({
  markets: z.array(outcomeMarketSummarySchema),
  /** Where the next page starts, or null when this page holds the last match. */
  nextCursor: z.string().min(1).max(200).nullable(),
});
export type OutcomeMarketList = z.infer<typeof outcomeMarketListSchema>;

/**
 * An operator's draft (founder session, dual control, audited). A draft is never listed; publishing it waits for E-1.
 * Every field the owner or markets team has not written stays blank and refuses at publish, never a default.
 */
export const outcomeMarketDraftInputSchema = z
  .object({
    id: marketId,
    question: z.string().trim().min(1).max(OUTCOME_QUESTION_MAX),
    category: tag.nullable(),
    tags: z.array(tag).max(OUTCOME_TAGS_MAX),
    closeMode: z.enum(OUTCOME_CLOSE_MODES),
    closeAt: iso.nullable(),
    settlementAssetId: z.string().trim().min(1),
    settlementSource: z.string().trim().min(1).nullable(),
    rulesText: z.string().trim().min(1).max(OUTCOME_RULES_MAX).nullable(),
  })
  .strict()
  .refine(closeMatchesMode, { message: CLOSE_MODE_MESSAGE });
export type OutcomeMarketDraftInput = z.infer<typeof outcomeMarketDraftInputSchema>;

/**
 * A move on a market, stored at ordinal `expectedOrdinal + 1` under `outcomes:move:<market>:<ordinal>`. The same move sent
 * again at that ordinal returns the first result; a different move at an ordinal already taken refuses
 * `trade.outcome_move_stale`, never another move's result.
 */
export const outcomeMarketMoveInputSchema = z
  .object({
    marketId: marketId,
    move: z.enum(['published', 'halted', 'resumed', 'closed']),
    /** The last ordinal on the timeline the operator read; a stale one refuses `trade.outcome_move_stale`. */
    expectedOrdinal: z.number().int().positive(),
  })
  .strict();
export type OutcomeMarketMoveInput = z.infer<typeof outcomeMarketMoveInputSchema>;

export const outcomeClarificationInputSchema = z
  .object({
    marketId: marketId,
    text: z.string().trim().min(1).max(OUTCOME_CLARIFICATION_MAX),
    /** The business key of this note, so a retry after a lost reply writes it once. */
    clarificationId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  })
  .strict();
export type OutcomeClarificationInput = z.infer<typeof outcomeClarificationInputSchema>;
