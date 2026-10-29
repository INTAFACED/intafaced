import type { Amount } from '@intafaced/ledger-client';
import type { AlgoPlaceGrant } from '../algo/durable-principal.js';
import type { GridLevelPlan } from './plan.js';

/**
 * running: places buys below the mark and sells one level above each filled buy.
 * paused_range: the mark left the bounds; no new buy is placed (open orders stay and may still fill).
 * initialization_failed: a level could not be placed at create; placed levels were cancelled and the reserve released.
 * stopped: the owner stopped it; nothing new is placed.
 */
export type GridStatus = 'running' | 'paused_range' | 'initialization_failed' | 'stopped';

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

export type GridOrderStatus = 'open' | 'filled' | 'cancelled';

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
