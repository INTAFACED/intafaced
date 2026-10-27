/**
 * D26-P1-T1g public doors — no silent ADL. The disclosure is product information:
 * no open waits on an ack (owner decision 2026-10-27, until launch prep).
 *
 * Break class: POST /positions refused for a missing ack · ADL reduce runs with
 * zero disclosure events · unconfigured policy invents a reduce.
 */
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { Principal } from '@intafaced/auth';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client';
import { registerPrivateRest, type PrivateRestDeps } from '../private-rest.js';
import { ADL_DISCLOSURE_VERSION, memoryAdlDisclosureStore, presentAdlDisclosureWire } from './adl-disclosure.js';
import {
  ADL_DISCLOSURE_BEFORE_ACTION,
  ADL_UNCONFIGURED,
  memoryAdlDisclosureEventStore,
  presentAdlActionDisclosureWire,
  runAdlLastResort,
} from './adl-last-resort.js';

const SECRET = 'a-trade-adl-disclosure-public-door-edge-secret';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const AT = new Date('2026-08-12T15:00:00.000Z');

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

function baseDeps(overrides: Partial<PrivateRestDeps> = {}): PrivateRestDeps {
  const acks = memoryAdlDisclosureStore();
  const events = memoryAdlDisclosureEventStore();
  return {
    edgeSecret: SECRET,
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
      return {
        id: 'pos-1',
        symbol: 'BTC/USDT-PERP',
        side: 'long',
        contracts: '1',
        entryPrice: '100',
        leverage: '2',
        marginMode: 'isolated',
        margin: '50',
        unrealizedPnl: '0',
        liquidationPrice: null,
        status: 'open',
      } as never;
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
    getAdlDisclosure: async (p) => presentAdlDisclosureWire(await acks.getAck(p.userId)),
    ackAdlDisclosure: async (p) => {
      const row = await acks.recordAck(p.userId, ADL_DISCLOSURE_VERSION, AT);
      return presentAdlDisclosureWire(row);
    },
    listAdlDisclosureEvents: async (p, limit) => {
      const rows = await events.listForUser(p.userId, limit);
      return rows.map(presentAdlActionDisclosureWire);
    },
    ...overrides,
  };
}

describe('D26-P1-T1g public doors — ADL disclosure as product information', () => {
  it('GET /futures/adl-disclosure returns copy + unacked', async () => {
    const app = Fastify();
    registerPrivateRest(app, baseDeps());
    await app.ready();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/futures/adl-disclosure',
      headers: signedHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { version: string; acknowledged: boolean; copy: string };
    expect(body.version).toBe(ADL_DISCLOSURE_VERSION);
    expect(body.acknowledged).toBe(false);
    expect(body.copy.toLowerCase()).toContain('last-resort');
    await app.close();
  });

  it('POST /positions without an ack opens: no open waits on the disclosure', async () => {
    const app = Fastify();
    registerPrivateRest(app, baseDeps());
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/positions',
      headers: signedHeaders(),
      payload: {
        symbol: 'BTC/USDT-PERP',
        side: 'long',
        size: '1',
        leverage: '2',
        marginMode: 'isolated',
        clientOpenId: 'open-1',
      },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('a voluntary ack is recorded and the open still succeeds', async () => {
    const app = Fastify();
    registerPrivateRest(app, baseDeps());
    await app.ready();
    const ack = await app.inject({
      method: 'POST',
      url: '/api/v1/futures/adl-disclosure/ack',
      headers: signedHeaders(),
      payload: {},
    });
    expect(ack.statusCode).toBe(200);
    expect(ack.json()).toMatchObject({ acknowledged: true, version: ADL_DISCLOSURE_VERSION });

    const open = await app.inject({
      method: 'POST',
      url: '/api/v1/positions',
      headers: signedHeaders(),
      payload: {
        symbol: 'BTC/USDT-PERP',
        side: 'long',
        size: '1',
        leverage: '2',
        marginMode: 'isolated',
        clientOpenId: 'open-2',
      },
    });
    expect(open.statusCode).toBe(200);
    await app.close();
  });

  it('ADL path with null policy refuses — no silent reduce; events stay empty', async () => {
    const acks = memoryAdlDisclosureStore();
    await acks.recordAck(OTHER, ADL_DISCLOSURE_VERSION, AT);
    const events = memoryAdlDisclosureEventStore();
    const reduces: string[] = [];
    const outcome = await runAdlLastResort({
      policy: null,
      bankrupt: {
        positionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        userId: USER,
        marketId: 'm1',
        side: 'long',
        uncoveredShortfall: parseAmount('10'),
      },
      candidates: [
        {
          positionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          userId: OTHER,
          marketId: 'm1',
          side: 'short',
          size: parseAmount('8'),
        },
      ],
      disclosureAcks: acks,
      events,
      reducer: {
        async reduce(input) {
          reduces.push(input.positionId);
        },
      },
      at: AT,
      newEventId: () => 'evt-silent-forbidden',
    });
    expect(outcome).toMatchObject({ action: 'refused', code: ADL_UNCONFIGURED });
    expect(reduces).toEqual([]);
    expect(await events.listForUser(OTHER, 500)).toEqual([]);
  });

  it('ADL reduce emits observable disclosure event before action (REST visible)', async () => {
    const acks = memoryAdlDisclosureStore();
    await acks.recordAck(OTHER, ADL_DISCLOSURE_VERSION, AT);
    const events = memoryAdlDisclosureEventStore();

    const outcome = await runAdlLastResort({
      policy: { maxReduceBps: 2_500 },
      bankrupt: {
        positionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        userId: USER,
        marketId: 'm1',
        side: 'long',
        uncoveredShortfall: parseAmount('10'),
      },
      candidates: [
        {
          positionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          userId: OTHER,
          marketId: 'm1',
          side: 'short',
          size: parseAmount('8'),
        },
      ],
      disclosureAcks: acks,
      events,
      reducer: {
        async reduce(input) {
          // By the time reduce runs, the event must already be listable.
          const seen = await events.listForUser(OTHER, 500);
          expect(seen).toHaveLength(1);
          expect(seen[0]!.eventId).toBe(input.disclosureEventId);
          expect(seen[0]!.beforeAction).toBe(true);
        },
      },
      at: AT,
      newEventId: () => 'evt-observable',
    });
    expect(outcome.action).toBe('reduced');
    if (outcome.action === 'reduced') {
      expect(outcome.code).toBe(ADL_DISCLOSURE_BEFORE_ACTION);
    }

    const app = Fastify();
    registerPrivateRest(
      app,
      baseDeps({
        listAdlDisclosureEvents: async (p, limit) => {
          const rows = await events.listForUser(p.userId, limit);
          return rows.map(presentAdlActionDisclosureWire);
        },
      }),
    );
    await app.ready();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/futures/adl-events?limit=500',
      headers: signedHeaders(principal({ userId: OTHER, sub: OTHER })),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { eventId: string; beforeAction: true }[];
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ eventId: 'evt-observable', beforeAction: true });
    await app.close();
  });
});
