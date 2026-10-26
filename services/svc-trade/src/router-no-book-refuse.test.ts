/**
 * A market whose matching engine holds no book (its 404) answers the tRPC order door with the named refusal
 * `trade.no_book` (NOT_FOUND), as the REST and ccxt doors do, never an unmapped 500 "Request failed".
 */
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTradeRouter } from './router.js';
import { MatchingNoBookError, MatchingUnavailableError } from './spot/matching-client.js';
import type { TradeService } from './spot/trade-service.js';

const SECRET = 'a-trade-no-book-refuse-test-edge-secret';
const USER = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';
const MARKET_ID = '44444444-4444-4444-8444-444444444444';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-trade' });

function caller(trade: TradeService) {
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
  return createTradeRouter(trade).createCaller(
    edgeContext({
      headers: {
        'x-intafaced-principal': raw,
        'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'SG'),
        'x-intafaced-region': 'SG',
      },
      id: 'req-no-book',
    }),
  );
}

const marketBuy = { symbol: 'BTC-USDT', side: 'buy' as const, type: 'market' as const, qty: '1', clientOrderId: 'no-book-1' };

describe('tRPC orders.create on a market with no matching book', () => {
  it('refuses NOT_FOUND with trade.no_book, not a 500', async () => {
    const trade = {
      placeOrder: async () => {
        throw new MatchingNoBookError(MARKET_ID);
      },
    } as unknown as TradeService;
    await expect(caller(trade).orders.create(marketBuy)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      cause: { code: 'trade.no_book' },
    });
  });

  it('leaves any other matching failure as it was', async () => {
    const trade = {
      placeOrder: async () => {
        throw new MatchingUnavailableError('matching down');
      },
    } as unknown as TradeService;
    await expect(caller(trade).orders.create(marketBuy)).rejects.not.toMatchObject({ code: 'NOT_FOUND' });
  });
});
