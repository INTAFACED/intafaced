import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { Principal } from '@intafaced/auth';
import { attachConvertRestRoutes, type ConvertRestPort } from './convert-rest.js';
import { TradeError } from '../spot/types.js';

const USER = '11111111-1111-4111-8111-111111111111';
const who = { userId: USER, sub: USER, scopes: ['trade:read', 'trade:write'] } as unknown as Principal;

const quote = {
  quoteId: 'cq-1',
  symbol: 'BTC/USDT',
  side: 'buy',
  inAsset: 'USDT',
  outAsset: 'BTC',
  inAmount: '9.99',
  outAmount: '0.0001',
  avgPrice: '99900',
  convertSpreadBps: 20,
  expiresAt: '2026-11-06T06:00:15.000Z',
};
const fill = {
  ...quote,
  fillId: 'cf-1',
  fillPrice: '99900',
  settledAt: '2026-11-06T06:00:05.000Z',
};

function app(port: Partial<ConvertRestPort>, opts: { scopes?: string[]; jurisdiction?: boolean } = {}) {
  const server = Fastify();
  const principal = { ...who, scopes: opts.scopes ?? who.scopes } as Principal;
  attachConvertRestRoutes(server, port as ConvertRestPort, {
    requirePrincipal: () => principal,
    requireTradeJurisdiction: (_req, reply) => {
      if (opts.jurisdiction === false) {
        void reply.code(403).send({ intafacedCode: 'jurisdiction.denied' });
        return false;
      }
      return true;
    },
  });
  return server;
}

describe('convert API (J-cex-spot-11 #12)', () => {
  it('a quote pays with the quote asset as a spend, and says it holds nothing', async () => {
    const asked: unknown[] = [];
    const server = app({
      convertRoute: async () => ({ kind: 'direct', symbol: 'BTC/USDT', side: 'buy' }),
      convertQuote: (async (_p: Principal, input: unknown) => {
        asked.push(input);
        return quote;
      }) as unknown as ConvertRestPort['convertQuote'],
    });
    const res = await server.inject({ method: 'POST', url: '/api/v1/convert/quote', payload: { from: 'USDT', to: 'BTC', amount: '10' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ quoteId: 'cq-1', fromAsset: 'USDT', toAsset: 'BTC', fromAmount: '9.99', held: false });
    expect(asked).toEqual([{ symbol: 'BTC/USDT', side: 'buy', quoteQty: 10n * 10n ** 18n }]);
  });

  it('a coin paid for a dollar is a sell of that coin amount', async () => {
    const asked: unknown[] = [];
    const server = app({
      convertRoute: async () => ({ kind: 'direct', symbol: 'BTC/USDT', side: 'sell' }),
      convertQuote: (async (_p: Principal, input: unknown) => {
        asked.push(input);
        return quote;
      }) as unknown as ConvertRestPort['convertQuote'],
    });
    await server.inject({ method: 'POST', url: '/api/v1/convert/quote', payload: { from: 'BTC', to: 'USDT', amount: '0.5' } });
    expect(asked).toEqual([{ symbol: 'BTC/USDT', side: 'sell', qty: 5n * 10n ** 17n }]);
  });

  it('a route refusal answers its code and asks for no price', async () => {
    let quoted = false;
    const server = app({
      convertRoute: async () => {
        throw new TradeError('two legs not built', 'trade.convert_two_leg_unbuilt', { from: 'EUR', to: 'BTC' });
      },
      convertQuote: (async () => {
        quoted = true;
        return quote;
      }) as unknown as ConvertRestPort['convertQuote'],
    });
    const res = await server.inject({ method: 'POST', url: '/api/v1/convert/quote', payload: { from: 'EUR', to: 'BTC', amount: '10' } });
    expect(res.statusCode).toBe(501);
    expect(res.json()).toMatchObject({ intafacedCode: 'trade.convert_two_leg_unbuilt' });
    expect(quoted).toBe(false);
  });

  it('a malformed amount is refused before any route or price is asked', async () => {
    const server = app({});
    const res = await server.inject({ method: 'POST', url: '/api/v1/convert/quote', payload: { from: 'USDT', to: 'BTC', amount: 10 } });
    expect(res.statusCode).toBe(400);
  });

  it('a key without trade:write is refused', async () => {
    const server = app({}, { scopes: ['trade:read'] });
    const res = await server.inject({ method: 'POST', url: '/api/v1/convert/accept', payload: { quoteId: 'cq-1' } });
    expect(res.statusCode).toBe(403);
  });

  it('an accept outside the trade jurisdiction is refused and nothing is accepted', async () => {
    let accepted = 0;
    const server = app(
      {
        convertAccept: (async () => {
          accepted += 1;
          return fill;
        }) as unknown as ConvertRestPort['convertAccept'],
      },
      { jurisdiction: false },
    );
    const res = await server.inject({ method: 'POST', url: '/api/v1/convert/accept', payload: { quoteId: 'cq-1' } });
    expect(res.statusCode).toBe(403);
    expect(accepted).toBe(0);
  });

  it('the same quote id twice at once: the second waits for the first, and both answer the one conversion', async () => {
    const order: string[] = [];
    let settled = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const server = app({
      convertAccept: (async () => {
        if (!settled) {
          order.push('settle');
          await gate;
          settled = true;
        } else order.push('replay');
        return fill;
      }) as unknown as ConvertRestPort['convertAccept'],
    });
    const a = server.inject({ method: 'POST', url: '/api/v1/convert/accept', payload: { quoteId: 'cq-1' } });
    const b = server.inject({ method: 'POST', url: '/api/v1/convert/accept', payload: { quoteId: 'cq-1' } });
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(['settle']);
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(order).toEqual(['settle', 'replay']);
    expect(ra.json().fillId).toBe('cf-1');
    expect(rb.json().fillId).toBe('cf-1');
  });

  it('a settle refusal answers its code', async () => {
    const server = app({
      convertAccept: (async () => {
        throw new TradeError('expired', 'trade.convert_quote_expired');
      }) as unknown as ConvertRestPort['convertAccept'],
    });
    const res = await server.inject({ method: 'POST', url: '/api/v1/convert/accept', payload: { quoteId: 'cq-1' } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ intafacedCode: 'trade.convert_quote_expired' });
  });
});
