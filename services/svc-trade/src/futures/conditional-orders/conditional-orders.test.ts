/**
 * Hermetic conditional-order law: required fields, trigger direction, trail,
 * the default-off job, scope, and the resting refusal. No database.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { Principal } from '@intafaced/auth';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { parseAmount as amt } from '@intafaced/ledger-client';
import { FuturesError } from '../position-service.js';
import { conditionalTriggerScheduled, startConditionalOrderJobs } from './job.js';
import { CONDITIONAL_ORDERS_PATH, RESTING_ORDERS_PATH, registerConditionalOrdersRest } from './rest.js';
import { FUTURES_RESTING_UNSUPPORTED, refuseFuturesRestingLimit } from './resting.js';
import { nextTrail, triggerCrossed, validateConditional } from './validate.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..', '..', '..');
const EDGE_SECRET = 'conditional-orders-edge-secret-at-least-32';
const USER = '11111111-1111-4111-8111-111111111111';

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

const base = {
  market: 'BTC/USDT:USDT',
  side: 'sell' as const,
  quantity: '1',
  clientOrderId: 'c-1',
};

describe('conditional order fields', () => {
  it('accepts each kind only with the fields that kind uses', () => {
    expect(validateConditional({ ...base, kind: 'stop_market', triggerPrice: '49000' }).kind).toBe('stop_market');
    expect(validateConditional({ ...base, kind: 'stop_limit', triggerPrice: '49000', limitPrice: '48900' }).limitPrice).toBeTruthy();
    expect(validateConditional({ ...base, kind: 'take_profit', triggerPrice: '51000' }).kind).toBe('take_profit');
    expect(validateConditional({ ...base, kind: 'trailing_stop', trailingDistance: '100' }).trailingDistance).toBeTruthy();
    expect(validateConditional({ ...base, kind: 'stop_market', triggerPrice: '49000' }).reduceOnly).toBe(true);
  });

  it('refuses a stop-limit with no limit price, and a field the kind cannot use', () => {
    expect(() => validateConditional({ ...base, kind: 'stop_limit', triggerPrice: '49000' })).toThrow(FuturesError);
    try {
      validateConditional({ ...base, kind: 'stop_limit', triggerPrice: '49000' });
    } catch (err) {
      expect(err).toMatchObject({ code: 'trade.conditional_field_required' });
      expect((err as Error).message).toMatch(/limitPrice/);
    }
    expect(() => validateConditional({ ...base, kind: 'stop_market', triggerPrice: '49000', trailingDistance: '10' })).toThrow(
      expect.objectContaining({ code: 'trade.conditional_field_unsupported' }),
    );
    expect(() => validateConditional({ ...base, kind: 'take_profit' })).toThrow(
      expect.objectContaining({ code: 'trade.conditional_field_required' }),
    );
    expect(() => validateConditional({ ...base, kind: 'trailing_stop' })).toThrow(
      expect.objectContaining({ code: 'trade.conditional_field_required' }),
    );
    expect(() => validateConditional({ ...base, kind: 'bracket', triggerPrice: '1' })).toThrow(
      expect.objectContaining({ code: 'trade.conditional_kind_unsupported' }),
    );
  });

  it('refuses reduceOnly false — an exit cannot open or enlarge', () => {
    expect(() => validateConditional({ ...base, kind: 'stop_market', triggerPrice: '49000', reduceOnly: false })).toThrow(
      expect.objectContaining({ code: 'trade.conditional_reduce_only_required' }),
    );
  });
});

describe('trigger and trail', () => {
  it('a sell stop fires at or below the trigger, and a sell take-profit fires at or above it', () => {
    expect(triggerCrossed({ kind: 'stop_market', side: 'sell', mark: amt('49000'), trigger: amt('49000') })).toBe(true);
    expect(triggerCrossed({ kind: 'stop_market', side: 'sell', mark: amt('49001'), trigger: amt('49000') })).toBe(false);
    expect(triggerCrossed({ kind: 'stop_limit', side: 'buy', mark: amt('51000'), trigger: amt('51000') })).toBe(true);
    expect(triggerCrossed({ kind: 'take_profit', side: 'sell', mark: amt('51000'), trigger: amt('51000') })).toBe(true);
    expect(triggerCrossed({ kind: 'take_profit', side: 'sell', mark: amt('50999'), trigger: amt('51000') })).toBe(false);
    expect(triggerCrossed({ kind: 'take_profit', side: 'buy', mark: amt('49000'), trigger: amt('49000') })).toBe(true);
  });

  it('a trailing stop moves only in the favourable direction', () => {
    const up = nextTrail({ side: 'sell', extreme: amt('50000'), mark: amt('51000'), distance: amt('1000') });
    expect(up.moved).toBe(true);
    expect(up.extreme).toBe(amt('51000'));
    expect(up.trigger).toBe(amt('50000'));
    const down = nextTrail({ side: 'sell', extreme: up.extreme, mark: amt('50500'), distance: amt('1000') });
    expect(down.moved).toBe(false);
    expect(down.extreme).toBe(amt('51000'));
    expect(down.trigger).toBe(amt('50000'));
    const buy = nextTrail({ side: 'buy', extreme: amt('50000'), mark: amt('49000'), distance: amt('1000') });
    expect(buy.moved).toBe(true);
    expect(buy.extreme).toBe(amt('49000'));
    const buyBack = nextTrail({ side: 'buy', extreme: buy.extreme, mark: amt('49500'), distance: amt('1000') });
    expect(buyBack.moved).toBe(false);
    expect(buyBack.extreme).toBe(amt('49000'));
  });
});

describe('conditional job flag', () => {
  it('ships default off and does not schedule when the flag or the interval is blank', () => {
    const env = readFileSync(join(root, 'services/svc-trade/src/env.ts'), 'utf8');
    const decl = /TRADE_FUTURES_CONDITIONAL_JOBS_ENABLED:\s*([\s\S]{0,220})/.exec(env);
    expect(decl?.[1]).toContain('.default(false)');
    expect(decl?.[1]).not.toContain('.default(true)');
    const index = readFileSync(join(root, 'services/svc-trade/src/index.ts'), 'utf8');
    expect(index).toMatch(/enabled:\s*env\.TRADE_FUTURES_CONDITIONAL_JOBS_ENABLED/);
    const compose = readFileSync(join(root, 'docker-compose.apps.yml'), 'utf8');
    expect(compose).toMatch(/TRADE_FUTURES_CONDITIONAL_JOBS_ENABLED:\s*\$\{TRADE_FUTURES_CONDITIONAL_JOBS_ENABLED:-false\}/);
    const off = startConditionalOrderJobs({ config: { enabled: false, intervalMs: 1_000 }, evaluate: async () => undefined });
    expect(off.host.list()).toEqual([]);
    off.stop();
    const blank = startConditionalOrderJobs({ config: { enabled: true, intervalMs: null }, evaluate: async () => undefined });
    expect(blank.host.list()).toEqual([]);
    blank.stop();
  });

  it('conditionalTriggerScheduled is true only when the flag is on and an interval is set', () => {
    expect(conditionalTriggerScheduled({ enabled: false, intervalMs: 5000 })).toBe(false);
    expect(conditionalTriggerScheduled({ enabled: true, intervalMs: null })).toBe(false);
    expect(conditionalTriggerScheduled({ enabled: true, intervalMs: 5000 })).toBe(true);
  });
});

describe('conditional order doors', () => {
  function door(calls: string[]) {
    return {
      create: async () => {
        calls.push('create');
        throw new Error('create should not run');
      },
      list: async () => {
        calls.push('list');
        return [];
      },
      get: async () => {
        calls.push('get');
        throw new FuturesError('missing', 'trade.conditional_not_found', 404);
      },
      cancel: async () => {
        calls.push('cancel');
        throw new Error('cancel should not run');
      },
      replaceProtection: async () => {
        calls.push('protect');
        throw new Error('protect should not run');
      },
      placeResting: async () => {
        calls.push('resting');
        return refuseFuturesRestingLimit({
          userId: USER,
          market: 'BTC/USDT:USDT',
          side: 'sell',
          quantity: '1',
          limitPrice: '49000',
          reduceOnly: true,
          clientOrderId: 'rest-1',
        });
      },
    };
  }

  it('a session without trade:write is refused and the service is not called', async () => {
    const calls: string[] = [];
    const app = Fastify();
    registerConditionalOrdersRest(app, { edgeSecret: EDGE_SECRET, serviceName: 'svc-trade', orders: door(calls) });
    const response = await app.inject({
      method: 'POST',
      url: CONDITIONAL_ORDERS_PATH,
      headers: headers(['trade:read']),
      payload: { ...base, kind: 'stop_market', triggerPrice: '49000' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'trade.permission_denied' });
    expect(calls).toEqual([]);
    await app.close();
  });

  it('a session without trade:read cannot list', async () => {
    const calls: string[] = [];
    const app = Fastify();
    registerConditionalOrdersRest(app, { edgeSecret: EDGE_SECRET, serviceName: 'svc-trade', orders: door(calls) });
    const response = await app.inject({
      method: 'GET',
      url: CONDITIONAL_ORDERS_PATH,
      headers: headers(['trade:write']),
    });
    expect(response.statusCode).toBe(403);
    expect(calls).toEqual([]);
    await app.close();
  });

  it('a resting futures order is the typed refusal', async () => {
    const calls: string[] = [];
    const app = Fastify();
    registerConditionalOrdersRest(app, { edgeSecret: EDGE_SECRET, serviceName: 'svc-trade', orders: door(calls) });
    const response = await app.inject({
      method: 'POST',
      url: RESTING_ORDERS_PATH,
      headers: headers(['trade:write']),
      payload: { clientOrderId: 'rest-1', type: 'limit', price: '49000', quantity: '1' },
    });
    expect(response.statusCode).toBe(501);
    expect(response.json()).toMatchObject({ error: FUTURES_RESTING_UNSUPPORTED });
    expect(calls).toEqual(['resting']);
    await app.close();
  });

  it('while futures orders go through the book the refusal is not mounted, so the book routes own the path', async () => {
    const calls: string[] = [];
    const app = Fastify();
    registerConditionalOrdersRest(app, { edgeSecret: EDGE_SECRET, serviceName: 'svc-trade', orders: door(calls), restingRefusal: false });
    app.post(RESTING_ORDERS_PATH, async () => ({ owner: 'book' }));
    await app.ready();
    const response = await app.inject({
      method: 'POST',
      url: RESTING_ORDERS_PATH,
      headers: headers(['trade:write']),
      payload: { clientOrderId: 'rest-1' },
    });
    expect(response.json()).toEqual({ owner: 'book' });
    expect(calls).toEqual([]);
    await app.close();
  });
});
