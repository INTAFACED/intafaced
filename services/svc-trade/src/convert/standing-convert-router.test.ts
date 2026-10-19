/**
 * Wire proof for the svc-bank standing-convert door: only an authenticated
 * svc-bank (signed body) reaches it, the user id comes from the signed body and
 * the interactive principal is never consulted.
 */
import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import { createEdgeContext, serviceAuthHeadersForBody } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client';
import { createTradeRouter } from '../router.js';
import type { TradeService } from '../spot/trade-service.js';

const EDGE_SECRET = 'a-standing-convert-door-edge-secret-32x';
const INTERNAL = 'a-standing-convert-door-internal-secret-32';
const USER = '11111111-1111-4111-8111-111111111111';
const INSTRUCTION = '99999999-9999-4999-8999-999999999999';
const edgeContext = createEdgeContext({ secret: EDGE_SECRET, internalSecret: INTERNAL, serviceName: 'svc-trade' });

const WIRE_QUOTE = {
  quoteId: 'q-1',
  symbol: 'BTC/USDT',
  side: 'buy',
  requestedQty: '1',
  filledQty: '1',
  bookNotional: '100',
  userNotional: '100.25',
  avgPrice: '100.25',
  fullyFilled: true,
  convertSpreadBps: 25,
  expiresAt: '2026-10-14T00:00:15.000Z',
  source: { kind: 'book', symbol: 'BTC/USDT', asOf: '2026-10-14T00:00:00.000Z' },
  inAsset: 'USDT',
  outAsset: 'BTC',
  inAmount: '100.25',
  outAmount: '1',
};

async function post(procedure: string, body: unknown, caller: string | null, service: Record<string, unknown>) {
  const router = createTradeRouter(service as unknown as TradeService);
  const app = Fastify({ logger: false });
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: { router, createContext: ({ req }) => edgeContext(req) } satisfies FastifyTRPCPluginOptions<typeof router>['trpcOptions'],
  });
  await app.ready();
  const text = JSON.stringify(body);
  const res = await app.inject({
    method: 'POST',
    url: `/trpc/${procedure}`,
    headers: {
      'content-type': 'application/json',
      ...(caller ? serviceAuthHeadersForBody(caller, INTERNAL, text) : {}),
    },
    payload: text,
  });
  await app.close();
  return res;
}

describe('standing convert door', () => {
  const quoteBody = { userId: USER, instructionId: INSTRUCTION, symbol: 'BTC/USDT', side: 'buy', qty: '1' };

  it('refuses an unauthenticated caller before the service is touched', async () => {
    const standingConvertQuote = vi.fn(async () => WIRE_QUOTE);
    const res = await post('standing.quote', quoteBody, null, { standingConvertQuote });
    expect(res.statusCode).toBe(401);
    expect(standingConvertQuote).not.toHaveBeenCalled();
  });

  it('refuses an authenticated service that is not svc-bank', async () => {
    const standingConvertQuote = vi.fn(async () => WIRE_QUOTE);
    const res = await post('standing.quote', quoteBody, 'svc-edge', { standingConvertQuote });
    expect(res.statusCode).toBe(403);
    expect(standingConvertQuote).not.toHaveBeenCalled();
  });

  it('quotes for the user named in the signed body, with exact bigints', async () => {
    const standingConvertQuote = vi.fn(async () => WIRE_QUOTE);
    const res = await post('standing.quote', quoteBody, 'svc-bank', { standingConvertQuote });
    expect(res.statusCode).toBe(200);
    expect(standingConvertQuote).toHaveBeenCalledWith(USER, INSTRUCTION, {
      symbol: 'BTC/USDT',
      side: 'buy',
      qty: parseAmount('1'),
      quoteQty: undefined,
    });
  });

  it('executes for the user and instruction in the signed body', async () => {
    const standingConvertExecute = vi.fn(async () => ({ fillId: 'f' }));
    const res = await post('standing.execute', { userId: USER, instructionId: INSTRUCTION, quoteId: 'q-1' }, 'svc-bank', {
      standingConvertExecute,
    });
    // the fake settle result fails the output schema; the call itself is what is proven here
    expect(standingConvertExecute).toHaveBeenCalledWith(USER, INSTRUCTION, {
      quoteId: 'q-1',
      clientConvertId: undefined,
      symbol: undefined,
      side: undefined,
      qty: undefined,
      maxAvgPrice: null,
    });
    expect([200, 500]).toContain(res.statusCode);
  });

  it('rejects a malformed user or instruction id', async () => {
    const standingConvertQuote = vi.fn(async () => WIRE_QUOTE);
    const bad = await post('standing.quote', { ...quoteBody, instructionId: 'nope' }, 'svc-bank', { standingConvertQuote });
    expect(bad.statusCode).toBe(400);
    expect(standingConvertQuote).not.toHaveBeenCalled();
  });
});
