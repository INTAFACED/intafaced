import { parseAmount, type Amount } from '@intafaced/ledger-client/money';
import type { SimMarketConfig } from '../simulator.js';

/**
 * One TEST instrument the stack's venue lists: its market, and the TEST makers' ladder `seed` rests on it, five levels a
 * side around `mid`, `step` apart (none when absent). Each lives in its own file in this folder, named
 * `<order>-<symbol>.ts`; `../instruments.ts` loads them in file-name order. Every figure and word is TEST.
 */
export interface TestInstrument {
  readonly market: SimMarketConfig;
  readonly ladder?: { readonly mid: Amount; readonly step: Amount };
}

/**
 * The rules the TEST venue publishes on its cash spot markets (J-cex-spot-04 #2): the smallest order value, a price band
 * around the middle of its own book, and the most open orders one account may hold, in the shape a real venue publishes
 * them (Hyperliquid publishes a 10-unit quote minimum on spot and 1000 open orders per account by default). TEST figures,
 * set loose so no journey's TEST order on the shared markets meets them: 1 USDC, 95% (9500 bps) of the book's middle,
 * 1000 orders. A journey that proves the rules lists a market of its own (`/test/market-add`) with its own figures.
 */
export const TEST_SPOT_RULES = {
  minOrderNotional: parseAmount('1'),
  priceBandBps: parseAmount('9500'),
  maxOpenOrders: 1000,
} as const;

/** The venue itself as the lister of its own markets (the BTC markets). */
export const VENUE_LISTED = { kind: 'venue', name: 'TEST venue simulator' } as const;
