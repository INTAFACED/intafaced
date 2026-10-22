/**
 * D26-P1-T1b public door — margin call fires, is delivered, observable on REST.
 *
 * Break class: tick reports margin_call but GET /positions/:id/margin-call 404s
 * (transport never wrote) · or REST invents a call the tick never raised.
 */
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { Principal } from '@intafaced/auth';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client';
import { registerPrivateRest, type PrivateRestDeps } from '../private-rest.js';
import { durableMarginCallNotifier, memoryMarginCallStore, presentMarginCallWire } from './margin-call-transport.js';
import {
  memoryLiquidationAttemptStore,
  runLiquidationTick,
  type LiquidationPositionRow,
  type QuotedMarkSource,
} from './liquidation-tick.js';
import { memoryAcceptedMarkStore } from './accepted-mark.js';
import type { FuturesLadderPolicy } from './maintenance-ladder.js';
import type { LedgerClient } from '@intafaced/ledger-client';

const SECRET = 'a-trade-margin-call-public-door-edge-secret';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const POSITION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AT = new Date('2026-08-12T12:00:00.000Z');
const amt = (s: string) => parseAmount(s);

const POLICY: FuturesLadderPolicy = {
  tiers: [{ uptoDepthBps: Number.MAX_SAFE_INTEGER, maintenanceBps: 500 }],
  marginCallBps: 12_000,
  targetBps: 15_000,
  maxTrancheBps: 2_500,
};

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: USER,
    userId: USER,
    sid: '33333333-3333-4333-8333-333333333333',
    scopes: ['trade:read', 'trade:write'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as Principal;
}

function signedHeaders(p: Principal = principal()): Record<string, string> {
  const raw = encodePrincipal(p);
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
    'x-intafaced-region': 'DE',
  };
}

function marginCallLong(): LiquidationPositionRow {
  return {
    positionId: POSITION_ID,
    userId: USER,
    side: 'long',
    size: amt('10'),
    entryPrice: amt('100'),
    margin: amt('100'),
    marginAsset: 'USDT',
    marketId: 'm1',
    symbol: 'BTC/USDT-PERP',
  };
}

function quotedAt(price: string): QuotedMarkSource {
  return {
    async markPrice() {
      return price;
    },
    async quote({ marketId, symbol }) {
      return { marketId, symbol, price: amt(price), asOf: AT, quality: 'mid' };
    },
  };
}

function baseDeps(overrides: Partial<PrivateRestDeps> = {}): PrivateRestDeps {
  return {
    edgeSecret: SECRET,
    icebergDisplayRule: null,
    serviceName: 'svc-trade',
    openOrders: async () => [],
    orderHistory: async () => [],
    getOrder: async () => {
      throw new Error('unused');
    },
    placeOrder: async () => {
      throw new Error('unused');
    },
    cancelOrder: async () => {
      throw new Error('unused');
    },
    cancelAllOrders: async () => [],
    massCancelOrders: async () => [],
    myFills: async () => [],
    marketBySymbol: async () => null,
    marketById: async () => null,
    markets: async () => [],
    userBalances: async () => [],
    listPositions: async () => [],
    listClosedPositions: async () => [],
    getPosition: async () => {
      throw new Error('unused');
    },
    openPosition: async () => {
      throw new Error('unused');
    },
    closePosition: async () => {
      throw new Error('unused');
    },
    setLeverage: async () => {
      throw new Error('unused');
    },
    addIsolatedMargin: async () => {
      throw new Error('unused');
    },
    reduceIsolatedMargin: async () => {
      throw new Error('unused');
    },
    getOpenMarginCall: async () => null,
    getAdlDisclosure: async () => ({
      version: 'DIRECTION-2026-07-31:34',
      copy: 'stub',
      acknowledged: false,
      acknowledgedAt: null,
    }),
    ackAdlDisclosure: async () => ({
      version: 'DIRECTION-2026-07-31:34',
      copy: 'stub',
      acknowledged: true,
      acknowledgedAt: new Date(0).toISOString(),
    }),
    listAdlDisclosureEvents: async () => [],
    ...overrides,
  };
}

describe('D26-P1-T1b public doors — margin call observable', () => {
  it('tick → durable deliver → GET /positions/:id/margin-call returns delivered call', async () => {
    const store = memoryMarginCallStore();
    const ledger: Pick<LedgerClient, 'post' | 'balance'> = {
      async post() {
        throw new Error('must not post on margin-call');
      },
      async balance() {
        // Ample, so the tick plans against the row's own margin (the ledger-pot divergence guard takes min(row, pot)).
        return { account: {} as never, accountId: 'x', amount: 1_000_000n * 10n ** 18n };
      },
    };

    const tick = await runLiquidationTick({
      marks: quotedAt('95'),
      positions: {
        async listOpen() {
          return [marginCallLong()];
        },
      },
      closer: {
        async markLiquidated() {
          throw new Error('must not close on margin-call');
        },
      },
      attempts: memoryLiquidationAttemptStore(),
      acceptedMarks: memoryAcceptedMarkStore(),
      ledger,
      now: () => AT,
      notifyMarginCall: durableMarginCallNotifier(store),
      ladder: {
        depth: {
          async depthNotional() {
            return amt('1000000');
          },
        },
        reducer: {
          async reduce() {
            throw new Error('must not reduce on margin-call');
          },
        },
        policy: POLICY,
      },
    });

    expect(tick.items[0]!.outcome).toBe('margin_call');
    expect(tick.items[0]!.delivered).toBe(true);

    const app = Fastify();
    registerPrivateRest(
      app,
      baseDeps({
        getOpenMarginCall: async (p, positionId) => {
          const row = await store.getOpenForPosition(positionId);
          if (!row || row.userId !== p.userId) return null;
          return presentMarginCallWire(row);
        },
      }),
    );
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/positions/${POSITION_ID}/margin-call`,
      headers: signedHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      positionId: string;
      delivered: boolean;
      deliveredAt: string;
      healthBps: number;
      sequence: number;
    };
    expect(body.positionId).toBe(POSITION_ID);
    expect(body.delivered).toBe(true);
    expect(body.deliveredAt).toBe(AT.toISOString());
    expect(body.sequence).toBe(1);
    expect(body.healthBps).toBeGreaterThan(0);

    await app.close();
  });

  it('GET 404 when no call was delivered (honest empty)', async () => {
    const app = Fastify();
    registerPrivateRest(app, baseDeps());
    await app.ready();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/positions/${POSITION_ID}/margin-call`,
      headers: signedHeaders(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('trade.margin_call_not_found');
    await app.close();
  });

  it('GET 404 for another user — no cross-principal leak', async () => {
    const store = memoryMarginCallStore();
    await durableMarginCallNotifier(store).notifyMarginCall({
      positionId: POSITION_ID,
      userId: USER,
      marketId: 'm1',
      healthBps: 10_500,
      at: AT,
    });

    const app = Fastify();
    registerPrivateRest(
      app,
      baseDeps({
        getOpenMarginCall: async (p, positionId) => {
          const row = await store.getOpenForPosition(positionId);
          if (!row || row.userId !== p.userId) return null;
          return presentMarginCallWire(row);
        },
      }),
    );
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/positions/${POSITION_ID}/margin-call`,
      headers: signedHeaders(principal({ userId: OTHER, sub: OTHER })),
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('anonymous caller never reaches the store', async () => {
    let read = false;
    const app = Fastify();
    registerPrivateRest(
      app,
      baseDeps({
        getOpenMarginCall: async () => {
          read = true;
          return null;
        },
      }),
    );
    await app.ready();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/positions/${POSITION_ID}/margin-call`,
    });
    expect(res.statusCode).toBe(401);
    expect(read).toBe(false);
    await app.close();
  });
});
