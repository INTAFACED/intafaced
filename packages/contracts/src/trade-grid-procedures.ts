import { z } from 'zod';
import { defineProcedure, type Refusals } from './procedure.js';

/**
 * svc-trade's spot grid on the person's own venue account (J-copy-bots-otc-14; svc-trade src/grid/venue-grid.ts). The
 * grid's older doors (`bots.grid.create`, `get`, `list`, `stop`, `withdrawProfit`) are still hand-written in its router;
 * each new one is a record here, mounted with `mountRecord`.
 */

const base = { service: 'svc-trade', module: 'trade', transport: 'trpc' } as const;
const WRITE = { caller: 'scope', scope: 'trade:write', module: 'trade' } as const;

const decimal = z.string().regex(/^-?[0-9]+(\.[0-9]+)?$/);
const status = z.enum(['signing', 'initializing', 'running', 'paused_range', 'stopped']);

/** A venue grid as the person reads it: every figure a decimal string, read from the venue's own record. */
export const venueGridSchema = z.object({
  botId: z.string(),
  clientRequestId: z.string(),
  symbol: z.string(),
  baseAsset: z.string(),
  quoteAsset: z.string(),
  lowerPrice: decimal,
  upperPrice: decimal,
  gridCount: z.number().int(),
  investment: decimal,
  reinitCount: z.number().int(),
  status,
  statusReason: z.string().nullable(),
  reserve: z.null(),
  levels: z.array(
    z.object({
      index: z.number().int(),
      price: decimal,
      qty: decimal,
      hold: decimal,
      openOrder: z.object({ side: z.enum(['buy', 'sell']), orderId: z.string(), clientOrderId: z.string() }).nullable(),
    }),
  ),
  orders: z.array(
    z.object({
      clientOrderId: z.string(),
      orderId: z.string(),
      levelIndex: z.number().int(),
      side: z.enum(['buy', 'sell']),
      cycle: z.number().int(),
      price: decimal,
      qty: decimal,
      holdAmount: decimal,
      status: z.enum(['open', 'filled', 'partial', 'cancelled']),
      pairProfit: decimal.nullable(),
    }),
  ),
  gridProfit: decimal,
  withdrawableProfit: decimal,
  closedPairs: z.number().int(),
  gridApr: z.union([
    z.object({ state: z.literal('under_a_day'), percent: z.null() }),
    z.object({ state: z.literal('set'), percent: decimal }),
  ]),
  createdAt: z.string(),
  venue: z.object({
    id: z.string(),
    name: z.string(),
    test: z.boolean(),
    owner: z.string(),
    agentAddress: z.string(),
    agentName: z.string(),
  }),
  /** The grid agent permission the person's wallet is asked to sign, while the bot is signing. */
  next: z
    .object({
      actionKey: z.string(),
      digest: z.string(),
      typedData: z.object({
        domain: z.record(z.string(), z.union([z.string(), z.number()])),
        types: z.record(z.string(), z.array(z.object({ name: z.string(), type: z.string() }))),
        primaryType: z.string(),
        message: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
      }),
    })
    .nullable(),
  fees: z.array(z.object({ asset: z.string(), venueFee: decimal, builderFee: decimal })),
});

const refuse = (map: Record<string, 'NOT_FOUND' | 'CONFLICT' | 'BAD_REQUEST' | 'FORBIDDEN' | 'SERVICE_UNAVAILABLE'>): Refusals =>
  Object.freeze(map);

/** The wallet's signature of a venue grid's agent permission, sent once under its key; the grid then places its first buys. */
export const GRID_SUBMIT_PERMISSION = defineProcedure({
  ...base,
  name: 'trade.bots.grid.submitPermission',
  kind: 'mutation',
  path: 'bots.grid.submitPermission',
  access: WRITE,
  refusals: refuse({
    'trade.grid_not_found': 'NOT_FOUND',
    'trade.bots_grid_not_signing': 'CONFLICT',
    'trade.grid_unavailable': 'SERVICE_UNAVAILABLE',
    'trade.bots_grid_agent_key_unset': 'BAD_REQUEST',
    'trade.bots_grid_venue_unreadable': 'SERVICE_UNAVAILABLE',
  }),
  input: z.object({
    botId: z.string().min(1).max(64),
    actionKey: z.string().min(3).max(200),
    signature: z.object({
      digest: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
      signedBy: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    }),
  }),
  output: venueGridSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        botId: '0f6c0b6e-1c2d-5e3f-8a4b-5c6d7e8f9a0b',
        actionKey: 'grid-agent:0x1111111111111111111111111111111111111111:0x2222222222222222222222222222222222222222',
        signature: {
          digest: `0x${'ab'.repeat(32)}`,
          signature: `0x${'cd'.repeat(65)}`,
          signedBy: '0x1111111111111111111111111111111111111111',
        },
      },
    },
    { verdict: 'refuse', input: { botId: 'x', actionKey: 'grid-agent:x', signature: { digest: '0x1', signature: '0x', signedBy: 'me' } } },
    { verdict: 'refuse', input: {} },
  ],
});

/**
 * A grid's exits as saved (svc-trade grid-service.ts `GridExitsView`; CB-bots-03). `rsi.source` is null: no RSI source
 * is connected, so the RSI exit reads Not set and can't be saved.
 */
export const gridExitsSchema = z.object({
  stopBelow: decimal.nullable(),
  stopAbove: decimal.nullable(),
  rsi: z.object({ source: z.null() }),
});

const exitPrice = z.string().max(64).optional().nullable();

/**
 * Save a running grid's exits (J-copy-bots-otc-15 #3): stop once the best bid falls to `stopBelow` or the best ask rises
 * to `stopAbove`; a blank price clears it. Any RSI value is refused: no RSI source is connected.
 */
export const GRID_SET_EXITS = defineProcedure({
  ...base,
  name: 'trade.bots.grid.setExits',
  kind: 'mutation',
  path: 'bots.grid.setExits',
  access: WRITE,
  refusals: refuse({
    'trade.grid_not_found': 'NOT_FOUND',
    'trade.grid_not_running': 'CONFLICT',
    'trade.grid_unavailable': 'SERVICE_UNAVAILABLE',
    'trade.bots_grid_rsi_source_not_set': 'BAD_REQUEST',
    'trade.bots_grid_exit_price_invalid': 'BAD_REQUEST',
    'trade.bots_verification_insufficient': 'FORBIDDEN',
    'trade.bots_verification_level_not_set': 'FORBIDDEN',
  }),
  input: z.object({
    botId: z.string().min(1).max(64),
    stopBelow: exitPrice,
    stopAbove: exitPrice,
    rsiBelow: exitPrice,
    rsiAbove: exitPrice,
  }),
  output: gridExitsSchema,
  samples: [
    { verdict: 'accept', input: { botId: '0f6c0b6e-1c2d-5e3f-8a4b-5c6d7e8f9a0b', stopBelow: '58000', stopAbove: null } },
    { verdict: 'accept', input: { botId: '0f6c0b6e-1c2d-5e3f-8a4b-5c6d7e8f9a0b', rsiBelow: '30' } },
    { verdict: 'refuse', input: { botId: '' } },
    { verdict: 'refuse', input: {} },
  ],
});

/**
 * Earn on a grid's idle funds (J-copy-bots-otc-15 #5). It goes only through the bank's earn door; while that door is not
 * wired, turning it on is refused `trade.bots_grid_idle_yield_unwired` and nothing is moved or saved.
 */
export const GRID_SET_IDLE_YIELD = defineProcedure({
  ...base,
  name: 'trade.bots.grid.setIdleYield',
  kind: 'mutation',
  path: 'bots.grid.setIdleYield',
  access: WRITE,
  refusals: refuse({
    'trade.grid_not_found': 'NOT_FOUND',
    'trade.grid_not_running': 'CONFLICT',
    'trade.grid_unavailable': 'SERVICE_UNAVAILABLE',
    'trade.bots_grid_idle_yield_unwired': 'BAD_REQUEST',
    'trade.bots_verification_insufficient': 'FORBIDDEN',
    'trade.bots_verification_level_not_set': 'FORBIDDEN',
  }),
  input: z.object({ botId: z.string().min(1).max(64), on: z.boolean() }),
  output: z.object({ on: z.literal(false) }),
  samples: [
    { verdict: 'accept', input: { botId: '0f6c0b6e-1c2d-5e3f-8a4b-5c6d7e8f9a0b', on: true } },
    { verdict: 'refuse', input: { botId: '0f6c0b6e-1c2d-5e3f-8a4b-5c6d7e8f9a0b' } },
    { verdict: 'refuse', input: {} },
  ],
});
