/**
 * Test-only doors. Not imported by production modules.
 *
 * The futures tests ask the service's real doors what they offer: the tRPC router's mounted procedures, and the
 * private REST app built from its own `registerPrivateRest` with only the deps a test hands it. A test that asks
 * "is this mounted, and what does it answer" calls these instead of reading the router's or the app's source.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import type { AnyRouter } from '@trpc/server';
import type { Principal } from '@intafaced/auth';
import { loadEnv } from '@intafaced/config';
import { partial } from '@intafaced/service-kit/testing';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts/edge';
import { tradeEnvSchema, type Env } from '../../env.js';
import { registerPrivateRest, type PrivateRestDeps } from '../../private-rest.js';
import { registerPublicRest, type PublicRestDeps } from '../../public-rest.js';
import { createTradeRouter } from '../../router.js';
import type { TradeService } from '../../spot/trade-service.js';
import { PositionService, type PositionRow, type PositionServiceDeps } from '../position-service.js';
import { memoryMarkBook } from '../mark-source.js';

export const DOOR_SECRET = 'futures-doors-test-harness-edge-secret';
export const DOOR_USER_ID = '11111111-1111-4111-8111-111111111111';

/** Every procedure path the trade router mounts (`orders.create`, …), with no optional desk wired. */
export function tradeRouterPaths(): string[] {
  const router: AnyRouter = createTradeRouter({} as TradeService);
  return Object.keys(router._def.procedures as Record<string, unknown>).sort();
}

/** A caller of the trade router as an anonymous public client (no principal), with no optional desk wired. */
export function publicTradeCaller(trade: TradeService = {} as TradeService) {
  const context = createEdgeContext({ secret: DOOR_SECRET, serviceName: 'svc-trade' });
  return createTradeRouter(trade).createCaller(context({ headers: {}, id: 'req-futures-door' }));
}

/**
 * The service's env as its own schema parses it, with `unset` keys removed from the process env and `set` keys given.
 * What the host reads for a variable nobody set is the schema's answer here.
 */
export function tradeEnvWith(set: Record<string, string> = {}, unset: readonly string[] = []): Env {
  const source: Record<string, unknown> = { ...process.env };
  for (const key of [...unset, ...Object.keys(set)]) delete source[key];
  Object.assign(source, set);
  return loadEnv(tradeEnvSchema, source);
}

export const DOOR_MARKET_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
export const DOOR_NOW = new Date('2026-09-03T00:00:00.000Z');

/** One stored open futures row as `SELECT p.*, m.symbol, m.contract_size` returns it. */
export function storedPositionRow(over: Partial<PositionRow> = {}): PositionRow {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    user_id: DOOR_USER_ID,
    market_id: DOOR_MARKET_ID,
    side: 'long',
    status: 'open',
    margin_mode: 'isolated',
    size: '1',
    entry_price: '50000',
    leverage: '10',
    client_open_id: 'open-1',
    margin_initial: '5000',
    margin_current: '5000',
    margin_asset: 'USDT',
    funding_paid: '0',
    liq_price: null,
    opened_at: new Date('2026-09-02T00:00:00.000Z'),
    closed_at: null,
    symbol: 'BTC/USDT-PERP',
    accepted_mark: '50000',
    accepted_mark_at: new Date('2026-09-02T00:00:00.000Z'),
    closing_reason: null,
    updated_at: new Date('2026-09-02T00:00:00.000Z'),
    contract_size: null,
    margin_adjust_seq: 0,
    margin_adjust_request: null,
    ...over,
  };
}

/**
 * The position service over stored rows, with no database: the position read answers `rows`, the fill sums answer
 * none, and every other query fails the test. Marks come from a mark book the test feeds; the ladder is the caller's.
 */
export function positionsOver(
  rows: readonly PositionRow[],
  deps: { ladder?: PositionServiceDeps['ladder']; marks?: ReturnType<typeof memoryMarkBook> } = {},
) {
  const marks = deps.marks ?? memoryMarkBook();
  const queries: string[] = [];
  const sql = Object.assign(
    (strings: TemplateStringsArray | readonly string[]) => {
      if (!Array.isArray(strings) || !('raw' in strings)) return strings; // sql(ids): an IN list fragment
      const text = (strings as TemplateStringsArray).join('?');
      queries.push(text);
      if (/FROM trade\.positions p/.test(text)) return Promise.resolve(rows.map((r) => ({ ...r })));
      if (/FROM trade\.futures_order_fills/.test(text)) return Promise.resolve([]);
      return Promise.reject(new Error(`positionsOver: unexpected query ${text.slice(0, 120)}`));
    },
    { begin: () => Promise.reject(new Error('positionsOver: no transactions')) },
  );
  const service = new PositionService(sql as never, {} as never, {
    marks: marks.source(),
    profitSource: null,
    now: () => DOOR_NOW,
    ...(deps.ladder ? { ladder: deps.ladder } : {}),
  });
  const feed = (price: string) => marks.set({ marketId: DOOR_MARKET_ID, price, quality: 'mid', asOfMs: DOOR_NOW.getTime() });
  return { service, marks, feed, queries };
}

/**
 * Fresh stand-ins for the two classes the boot hitches wrap (`installPreTradeCredit*`, `installPositionMode*`,
 * `installCollateralHaircut*`). Each records what reached the original method, and what else was asked of it, so a
 * test installs the real hitch on it and asserts what the hitch let through, refused, or changed.
 */
export function hitchDoubles(markets: Record<string, { kind: 'spot' | 'futures' }> = {}) {
  const opened: unknown[] = [];
  const placed: unknown[] = [];
  const other: string[] = [];
  class Positions {
    async open(input: unknown) {
      opened.push(input);
      return { opened: true };
    }
    async readAccountMode() {
      return { mode: null };
    }
    async writeAccountMode() {
      other.push('writeAccountMode');
    }
    async closeAll() {
      other.push('closeAll');
    }
  }
  class Trades {
    async placeOrder(_principal: unknown, input: unknown) {
      placed.push(input);
      return { placed: true };
    }
    async marketById(id: string) {
      return markets[id] ?? null;
    }
    async marketBySymbol(symbol: string) {
      return markets[symbol] ?? null;
    }
    async cancelAll() {
      other.push('cancelAll');
    }
  }
  return { Positions, Trades, opened, placed, other };
}

/** Signed edge headers for one trading user with read and write scopes. */
export function doorHeaders(userId: string = DOOR_USER_ID): Record<string, string> {
  const principal = {
    sub: userId,
    userId,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['trade:read', 'trade:write'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
  const encoded = encodePrincipal(principal);
  return {
    'x-intafaced-principal': encoded,
    'x-intafaced-principal-sig': signPrincipalHeader(encoded, DOOR_SECRET, 'DE'),
    'x-intafaced-region': 'DE',
  };
}

/** The public REST app as `registerPublicRest` builds it, over no markets unless the test names some. */
export async function publicRestDoor(deps: Partial<PublicRestDeps> = {}): Promise<FastifyInstance> {
  const app = Fastify();
  registerPublicRest(app, {
    markets: async () => [],
    marketBySymbol: async () => null,
    depth: async () => ({ bids: [], asks: [], sequence: 0 }),
    publicTape: async () => [],
    candles: async () => [],
    now: () => 1_700_000_000_000,
    ...deps,
  });
  await app.ready();
  return app;
}

/** The private REST app as `registerPrivateRest` builds it, with only the deps the test names. */
export async function privateRestDoor(deps: Partial<PrivateRestDeps> = {}): Promise<FastifyInstance> {
  const app = Fastify();
  registerPrivateRest(app, partial<PrivateRestDeps>({ edgeSecret: DOOR_SECRET, serviceName: 'svc-trade', ...deps }));
  await app.ready();
  return app;
}
