/**
 * U7 wire proof: `convert.quote` takes `quoteQty` (a spend) or `qty` (a base
 * amount) over the real tRPC door and hands the service exact bigints.
 */
import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client';
import { createTradeRouter } from '../router.js';
import type { TradeService } from '../spot/trade-service.js';

const EDGE_SECRET = 'a-convert-quote-qty-router-edge-secret-32';
const USER = '11111111-1111-4111-8111-111111111111';
const SESSION = '33333333-3333-4333-8333-333333333333';
const edgeContext = createEdgeContext({ secret: EDGE_SECRET, serviceName: 'svc-trade' });

function headers(): Record<string, string> {
  const principal = {
    sub: USER,
    userId: USER,
    sid: SESSION,
    scopes: ['trade:read', 'trade:write'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
  const raw = encodePrincipal(principal);
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, EDGE_SECRET, 'DE'),
    'x-intafaced-region': 'DE',
  };
}

const WIRE_QUOTE = {
  quoteId: 'q-1',
  symbol: 'BTC/USDT',
  side: 'buy',
  requestedQty: '0.0997',
  filledQty: '0.0997',
  bookNotional: '9.9700000',
  userNotional: '9.994925',
  avgPrice: '100.25',
  fullyFilled: true,
  convertSpreadBps: 25,
  expiresAt: '2026-10-14T00:00:15.000Z',
  source: { kind: 'book', symbol: 'BTC/USDT', asOf: '2026-10-14T00:00:00.000Z' },
  inAsset: 'USDT',
  outAsset: 'BTC',
  inAmount: '9.994925',
  outAmount: '0.0997',
};

async function call(input: Record<string, unknown>) {
  const convertQuote = vi.fn(async () => WIRE_QUOTE);
  const router = createTradeRouter({ convertQuote } as unknown as TradeService);
  const app = Fastify({ logger: false });
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router,
      createContext: ({ req }) => edgeContext({ headers: req.headers, id: req.id }),
    } satisfies FastifyTRPCPluginOptions<typeof router>['trpcOptions'],
  });
  await app.ready();
  const res = await app.inject({
    method: 'GET',
    url: `/trpc/convert.quote?input=${encodeURIComponent(JSON.stringify(input))}`,
    headers: headers(),
  });
  await app.close();
  return { convertQuote, statusCode: res.statusCode, body: res.json() as { result?: { data?: typeof WIRE_QUOTE } } };
}

describe('convert.quote wire — quoteQty (U7)', () => {
  it('passes a spend as exact bigint quoteQty and no qty', async () => {
    const { convertQuote, statusCode, body } = await call({ symbol: 'BTC/USDT', side: 'buy', quoteQty: '10' });
    expect(statusCode).toBe(200);
    expect(convertQuote).toHaveBeenCalledWith(expect.anything(), {
      symbol: 'BTC/USDT',
      side: 'buy',
      qty: undefined,
      quoteQty: parseAmount('10'),
    });
    expect(body.result?.data?.inAmount).toBe('9.994925');
  });

  it('keeps the base-amount shape unchanged', async () => {
    const { convertQuote, statusCode } = await call({ symbol: 'BTC/USDT', side: 'buy', qty: '0.5' });
    expect(statusCode).toBe(200);
    expect(convertQuote).toHaveBeenCalledWith(expect.anything(), {
      symbol: 'BTC/USDT',
      side: 'buy',
      qty: parseAmount('0.5'),
      quoteQty: undefined,
    });
  });

  it('rejects a malformed spend before the service is called', async () => {
    const { convertQuote, statusCode } = await call({ symbol: 'BTC/USDT', side: 'buy', quoteQty: '-1' });
    expect(statusCode).toBe(400);
    expect(convertQuote).not.toHaveBeenCalled();
  });
});
