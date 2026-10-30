import type { Amount } from '@intafaced/ledger-client';
import type { AlgoPlaceGrant } from '../algo/durable-principal.js';
import type { GridLevelPlan } from './plan.js';

/**
 * initializing: create is placing the first levels; the tick leaves it alone so the two never place the same order at once.
 * running: places buys below the mark and sells one level above each filled buy.
 * paused_range: the mark left the bounds; no new buy is placed (open orders stay and may still fill).
 * initialization_failed: a level could not be placed at create; placed levels are cancelled and the reserve released.
 * stopped: the owner stopped it; nothing new is placed.
 * A stopped or failed bot whose reserve is not yet released is still winding down: the tick cancels what is left open.
 */
export type GridStatus = 'initializing' | 'running' | 'paused_range' | 'initialization_failed' | 'stopped';

export interface GridBot {
  readonly botId: string;
  readonly userId: string;
  readonly clientRequestId: string;
  /** sha256 of the create body: the same key with a different body is a conflict, never a second bot. */
  readonly requestHash: string;
  readonly marketId: string;
  readonly symbol: string;
  readonly baseAsset: string;
  readonly quoteAsset: string;
  readonly lowerPrice: Amount;
  readonly upperPrice: Amount;
  readonly gridCount: number;
  readonly investment: Amount;
  /** The plan fixed at create (grid/plan.ts). */
  readonly levels: readonly GridLevelPlan[];
  readonly status: GridStatus;
  readonly statusReason: string | null;
  readonly placeGrant: AlgoPlaceGrant;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * The most this bot may use of the owner's free quote balance. A svc-trade limit row, not a ledger hold: nothing posts
 * when it is held or released, and every level order takes its own order hold through the trade recipes.
 * Business key `bots.grid.reserve:<botId>`.
 */
export interface GridReserve {
  readonly reserveKey: string;
  readonly botId: string;
  readonly userId: string;
  readonly asset: string;
  readonly amount: Amount;
  readonly heldAt: Date;
  readonly releasedAt: Date | null;
}

/** partial: a sell that ended with only part of its quantity filled. Its pair is not closed and states no profit. */
export type GridOrderStatus = 'open' | 'filled' | 'partial' | 'cancelled';

/** One level order. A level's buy and the sell one level above it share a cycle; a closed sell closes the pair. */
export interface GridOrder {
  /** `grid:<botId>:<level>:b<cycle>` or `:s<cycle>`; the trade order's clientOrderId, so a retry is the same order. */
  readonly clientOrderId: string;
  readonly botId: string;
  /** The level whose buy opened the pair. A sell sits one level above it. */
  readonly levelIndex: number;
  readonly side: 'buy' | 'sell';
  readonly cycle: number;
  readonly orderId: string;
  readonly price: Amount;
  readonly qty: Amount;
  /** The order hold the trade service reported when it was placed. */
  readonly holdAmount: Amount;
  readonly status: GridOrderStatus;
  /** On a filled sell: the pair's quote proceeds net of both legs' fees, less the buy's quote cost. */
  readonly pairProfit: Amount | null;
  readonly placedAt: Date;
  readonly closedAt: Date | null;
}

export const gridReserveKey = (botId: string): string => `bots.grid.reserve:${botId}`;
export const gridBusinessId = (botId: string): string => `grid:${botId}`;
export const gridClientOrderId = (botId: string, level: number, side: 'buy' | 'sell', cycle: number): string =>
  `grid:${botId}:${level}:${side === 'buy' ? 'b' : 's'}${cycle}`;

/**
 * One applied profit withdrawal (CB-bots-05): it lowered the bot's reserve row by `amount`, under the owner's reserve
 * lock, and posted no ledger row. Profit here is what the reserve still holds over the investment. The cap fields are
 * the owner's daily cap for the asset and, after this withdrawal, what the owner has used of it today (UTC) and what is left.
 * Business key `bots.grid.withdraw:<botId>:<requestId>`.
 */
export interface GridWithdrawal {
  readonly withdrawalId: string;
  readonly botId: string;
  readonly userId: string;
  readonly requestId: string;
  /** sha256 of bot, asset and amount: the same key with a different body is a conflict, never a second withdrawal. */
  readonly requestHash: string;
  readonly asset: string;
  readonly amount: Amount;
  readonly profitBefore: Amount;
  readonly profitAfter: Amount;
  readonly reserveBefore: Amount;
  readonly reserveAfter: Amount;
  readonly dailyCap: Amount;
  readonly capUsed: Amount;
  readonly capRemaining: Amount;
  /** The identity step-up approval this withdrawal consumed. An id, never a secret. */
  readonly stepUpEventId: string;
  readonly appliedAt: Date;
}

export const gridWithdrawalKey = (botId: string, requestId: string): string => `bots.grid.withdraw:${botId}:${requestId}`;
