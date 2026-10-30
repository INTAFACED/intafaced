import Fastify from 'fastify';
import { serviceAuthHeadersForBody, type ServiceName } from '@intafaced/contracts';
import { describe, expect, it, vi } from 'vitest';
import { InsufficientFundsError, parseAmount as amt } from '@intafaced/ledger-client';
import { BUYBACK_IOC_BUY_PATH, registerBuybackDoor } from './buyback-door.js';
import { TradeError } from './types.js';
import type { BuybackIocBuyResult } from './trade-service/buyback.js';

const SECRET = 'buyback-door-test-secret-0123456789abcdef';
const ORDER = '99999999-9999-4999-8999-999999999999';

/** TEST amounts only. */
const FILLED: BuybackIocBuyResult = { orderId: ORDER, status: 'cancelled', filledQty: amt('1'), held: amt('150'), spent: amt('100') };

function door(place = vi.fn(async () => FILLED)) {
  const app = Fastify({ logger: false });
  registerBuybackDoor(app, { internalSecret: SECRET, placeBuybackIocBuy: place });
  return { app, place };
}

const call = (app: ReturnType<typeof door>['app'], body: unknown, caller: ServiceName | null = 'svc-token') => {
  const payload = JSON.stringify(body);
  return app.inject({
    method: 'POST',
    url: BUYBACK_IOC_BUY_PATH,
    headers: { 'content-type': 'application/json', ...(caller ? serviceAuthHeadersForBody(caller, SECRET, payload) : {}) },
    payload,
  });
};

const BODY = { symbol: 'IFC/USDT', qty: '1.5', price: '100', clientOrderId: 'run-1' };

describe('the buyback IOC buy door', () => {
  it('places for the token service and answers in decimal strings', async () => {
    const { app, place } = door();
    const res = await call(app, BODY);
    expect(res.statusCode).toBe(200);
    expect(place).toHaveBeenCalledWith({ symbol: 'IFC/USDT', qty: amt('1.5'), price: amt('100'), clientOrderId: 'run-1' });
    expect(res.json()).toEqual({
      orderId: ORDER,
      status: 'cancelled',
      filledQty: '1',
      heldQuote: '150',
      spentQuote: '100',
      releasedQuote: '50',
    });
  });

  it('reports nothing released while the order is not terminal', async () => {
    const { app } = door(vi.fn(async () => ({ ...FILLED, status: 'open' as const })));
    expect((await call(app, BODY)).json().releasedQuote).toBe('0');
  });

  it('refuses a call with no service auth, and one from any other service', async () => {
    const { app, place } = door();
    expect((await call(app, BODY, null)).statusCode).toBe(401);
    const other = await call(app, BODY, 'svc-ops');
    expect(other.statusCode).toBe(403);
    expect(other.json().code).toBe('trade.buyback_forbidden');
    expect(place).not.toHaveBeenCalled();
  });

  it('refuses a body signed for another payload', async () => {
    const { app, place } = door();
    const res = await app.inject({
      method: 'POST',
      url: BUYBACK_IOC_BUY_PATH,
      headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-token', SECRET, JSON.stringify(BODY)) },
      payload: JSON.stringify({ ...BODY, qty: '15' }),
    });
    expect(res.statusCode).toBe(401);
    expect(place).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing price', { ...BODY, price: undefined }],
    ['a number price', { ...BODY, price: 100 }],
    ['a zero qty', { ...BODY, qty: '0' }],
    ['a negative qty', { ...BODY, qty: '-1' }],
    ['an exponent', { ...BODY, qty: '1e3' }],
    ['a padded symbol', { ...BODY, symbol: ' IFC/USDT' }],
    ['a blank run id', { ...BODY, clientOrderId: '' }],
    ['a padded run id', { ...BODY, clientOrderId: 'run-1 ' }],
    ['a run id over 64 chars', { ...BODY, clientOrderId: 'r'.repeat(65) }],
    ['an array body', [BODY]],
  ])('refuses %s with the typed code before placing', async (_name, body) => {
    const { app, place } = door();
    const res = await call(app, body);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('trade.buyback_invalid');
    expect(place).not.toHaveBeenCalled();
  });

  it.each([
    [new TradeError('house', 'trade.buyback_house_maker'), 409, 'trade.buyback_house_maker'],
    [new TradeError('conflict', 'trade.buyback_conflict'), 409, 'trade.buyback_conflict'],
    [new TradeError('in flight', 'trade.buyback_in_flight'), 409, 'trade.buyback_in_flight'],
    [new TradeError('book', 'trade.buyback_book_unreadable'), 503, 'trade.buyback_book_unreadable'],
    [new TradeError('halted', 'trade.spot_disabled'), 503, 'trade.spot_disabled'],
    [new InsufficientFundsError('rewards engine', 'USDT', '1', '0'), 400, 'ledger.insufficient_funds'],
  ])('answers a refusal with its typed code (%s)', async (err, status, code) => {
    const { app } = door(vi.fn(async () => Promise.reject(err)));
    const res = await call(app, BODY);
    expect(res.statusCode).toBe(status);
    expect(res.json().code).toBe(code);
  });

  it('lets an unrecognised failure surface as a server error rather than relabel it', async () => {
    const { app } = door(vi.fn(async () => Promise.reject(new Error('bug'))));
    expect((await call(app, BODY)).statusCode).toBe(500);
  });
});
