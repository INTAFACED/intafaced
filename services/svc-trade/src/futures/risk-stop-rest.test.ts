/**
 * The pre-liquidation stop's doors (D-margin-04): who may call them, what reaches the service, and the level law that
 * needs no database. The stop's money behaviour is `risk-stop.money.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { Principal } from '@intafaced/auth';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client';
import { FuturesError } from './position-service.js';
import { RISK_STOP_PATH, registerRiskStopRest } from './risk-stop-rest.js';
import { RISK_STOP_INVALID, levelFromPercent, percentOf, riskStopReached, type RiskStopService } from './risk-stop.js';

const EDGE_SECRET = 'risk-stop-edge-secret-at-least-32-chars';
const USER = '11111111-1111-4111-8111-111111111111';
const POSITION = '33333333-3333-4333-8333-333333333333';
const url = RISK_STOP_PATH.replace(':id', POSITION);

function headers(scopes: string[]): Record<string, string> {
  const principal = {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes,
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

function door(calls: unknown[]): Pick<RiskStopService, 'get' | 'set'> {
  return {
    get: async (userId, positionId) => {
      calls.push(['get', userId, positionId]);
      return { positionId, status: 'none' } as Awaited<ReturnType<RiskStopService['get']>>;
    },
    set: async (userId, positionId, input) => {
      calls.push(['set', userId, positionId, input]);
      if (input.level === '100') throw new FuturesError('at or above 100%', RISK_STOP_INVALID, 400);
      return { positionId, status: 'armed', level: input.level } as Awaited<ReturnType<RiskStopService['set']>>;
    },
  };
}

function app(calls: unknown[]) {
  const server = Fastify();
  registerRiskStopRest(server, { edgeSecret: EDGE_SECRET, serviceName: 'svc-trade', stops: door(calls) });
  return server;
}

describe('pre-liquidation stop doors', () => {
  it('an unsigned call and a session without the scope are refused and the service is not called', async () => {
    const calls: unknown[] = [];
    const server = app(calls);
    expect((await server.inject({ method: 'GET', url })).statusCode).toBe(401);
    const read = await server.inject({ method: 'GET', url, headers: headers(['trade:write']) });
    expect(read.statusCode).toBe(403);
    const write = await server.inject({
      method: 'PUT',
      url,
      headers: headers(['trade:read']),
      payload: { level: '50', clientRequestId: 'a' },
    });
    expect(write.statusCode).toBe(403);
    expect(write.json()).toMatchObject({ error: 'trade.permission_denied' });
    expect(calls).toEqual([]);
    await server.close();
  });

  it('a read and a set reach the service for the signed user; a set with no level is refused in words', async () => {
    const calls: unknown[] = [];
    const server = app(calls);
    expect((await server.inject({ method: 'GET', url, headers: headers(['trade:read']) })).json()).toMatchObject({ status: 'none' });
    const set = await server.inject({
      method: 'PUT',
      url,
      headers: headers(['trade:write']),
      payload: { level: '50', clientRequestId: 'a' },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toMatchObject({ status: 'armed', level: '50' });
    const missing = await server.inject({ method: 'PUT', url, headers: headers(['trade:write']), payload: { clientRequestId: 'b' } });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ error: RISK_STOP_INVALID });
    const refused = await server.inject({
      method: 'PUT',
      url,
      headers: headers(['trade:write']),
      payload: { level: '100', clientRequestId: 'c' },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: RISK_STOP_INVALID, message: 'at or above 100%' });
    expect(calls).toEqual([
      ['get', USER, POSITION],
      ['set', USER, POSITION, { level: '50', clientRequestId: 'a' }],
      ['set', USER, POSITION, { level: '100', clientRequestId: 'c' }],
    ]);
    await server.close();
  });
});

describe('the level law', () => {
  it('a percent strictly between 0 and 100 becomes an exact ratio, and back', () => {
    expect(levelFromPercent('50')).toBe(parseAmount('0.5'));
    expect(levelFromPercent('62.5')).toBe(parseAmount('0.625'));
    expect(levelFromPercent('99.9999999999999999')).toBe(parseAmount('0.999999999999999999'));
    expect(percentOf(levelFromPercent('62.5'))).toBe('62.5');
    for (const bad of ['0', '100', '100.5', '-5', '', '5e1', 'abc', '12.34567890123456789']) {
      expect(() => levelFromPercent(bad), bad).toThrow(FuturesError);
    }
    expect(() => levelFromPercent(50)).toThrow(FuturesError);
    expect(() => levelFromPercent(null)).toThrow(FuturesError);
  });

  it('reached at or past the level, and when equity is gone; not when the ratio is only unknown', () => {
    const level = parseAmount('0.5');
    expect(riskStopReached({ marginRatio: parseAmount('0.5'), ratioReason: null }, level)).toBe(true);
    expect(riskStopReached({ marginRatio: parseAmount('0.499999999999999999'), ratioReason: null }, level)).toBe(false);
    expect(riskStopReached({ marginRatio: null, ratioReason: 'equity_not_positive' }, level)).toBe(true);
    expect(riskStopReached({ marginRatio: null, ratioReason: 'mark_missing' }, level)).toBe(false);
  });
});
