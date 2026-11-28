import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { EDGE_API_KEY_RATE_BUCKET, EDGE_RATE_COST } from './hardening.js';
import {
  GATEWAY_DIALECTS,
  GATEWAY_KEY_PLANE,
  decideGateway,
  doorForPath,
  envMismatchBody,
  envMismatchCodeOf,
  hostEnvironment,
  normalizeHost,
  parseSandboxHosts,
  quotaRefuseBody,
  requiredScopeFor,
  sandboxOf,
  scopeRefuseBody,
} from './gateway-plane.js';
import { loadEdgeEnv } from './testing/env-load-fixture.js';
import { KeyBuckets } from './rate-bucket.js';

const LIMIT = { tier: 'base', burst: 10, refillPerMinute: 600, user: { burst: 100, refillPerMinute: 6000 } } as const;
const COSTS = [{ route: '* /api/**', cost: 1 }] as const;

const USER = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: USER,
    userId: USER,
    scopes: ['trade:read'],
    tier: 'none',
    mfa: false,
    sid: SESSION,
    expiresAt: new Date(Date.now() + 60_000),
    kid: 'key-1',
    key_env: 'live',
    ...overrides,
  };
}

describe('api.gateway plane', () => {
  it('names identity.apikeys as the only key plane — no second table', async () => {
    expect(GATEWAY_KEY_PLANE).toBe('identity.apikeys');
    // The plane decides and shapes refusals; it has nothing that keeps, mints or stores a key of its own.
    const plane = await import('./gateway-plane.js');
    const keeping = Object.entries(plane).filter(
      ([name, value]) => typeof value === 'function' && /table|store|insert|persist|mint|create|issue/i.test(name),
    );
    expect(keeping).toEqual([]);
    // And nowhere to keep one: the edge process takes no database at all.
    expect(await loadEdgeEnv({ DATABASE_URL: 'postgres://edge:edge@127.0.0.1:5432/edge' })).not.toHaveProperty('DATABASE_URL');
  });

  it('keeps two dialects and does not invent a third error taxonomy', () => {
    expect(GATEWAY_DIALECTS).toEqual({ trade: 'ccxt', pay: 'pay' });
    expect(Object.keys(GATEWAY_DIALECTS)).toEqual(['trade', 'pay']);
    // Every refusal the plane sends, over keys, doors, methods, hosts and an exhausted bucket, is in one of the two
    // dialects or the shared edge vocabulary: CCXT PermissionDenied, tRPC FORBIDDEN, scope.denied, edge.rate_limited.
    const bodies: Record<string, unknown>[] = [];
    const paths = [
      '/api/v1/markets',
      '/api/trade/trpc/orders.create',
      '/api/pay/trpc/health',
      '/api/pay/v1/payments',
      '/api/identity/trpc/x',
    ];
    const keys = [
      principal({ scopes: [] }),
      principal({ scopes: ['trade:read', 'trade:write', 'pay:read', 'pay:write'] }),
      principal({ key_env: 'sandbox', scopes: ['pay:read', 'pay:write'] }),
      principal({ kid: undefined, key_env: undefined, scopes: [] }),
    ];
    const tight = { ...LIMIT, burst: 1, refillPerMinute: 1 };
    for (const pathname of paths) {
      for (const method of ['GET', 'POST']) {
        for (const key of keys) {
          for (const [keyRateLimit, costs] of [
            [LIMIT, COSTS],
            [tight, COSTS],
            [LIMIT, []],
            [null, COSTS],
          ] as const) {
            const buckets = new KeyBuckets();
            for (let n = 0; n < 3; n++) {
              const decided = decideGateway({
                pathname,
                method,
                principal: key,
                buckets,
                keyRateLimit,
                costs,
                now: 0,
                host: 'api.example',
                sandboxHosts: parseSandboxHosts('sandbox.example'),
              });
              if (!decided.allow) bodies.push(decided.body);
            }
          }
        }
      }
    }
    const codesOf = (body: Record<string, unknown>) => {
      const data = (body.error as { data?: Record<string, unknown> } | undefined)?.data ?? {};
      return [body.code, body.intafacedCode, data.code, data.intafacedCode].filter((c): c is string => typeof c === 'string');
    };
    const codes = new Set(bodies.flatMap(codesOf));
    expect(codes).toContain('PermissionDenied');
    expect(codes).toContain('FORBIDDEN');
    expect(codes).toContain('scope.denied');
    expect(codes).toContain('edge.rate_limited');
    for (const code of codes) {
      expect(code).not.toMatch(/^edge\.gateway_/);
      expect([
        'PermissionDenied',
        'FORBIDDEN',
        'scope.denied',
        'env.mismatch',
        'edge.rate_limited',
        'edge.cost_unset',
        'edge.limits_unset',
        'edge.api_key_bearer_required',
      ]).toContain(code);
    }
    expect(quotaRefuseBody(1)).toMatchObject({ code: 'edge.rate_limited' });
  });

  it('maps trade CCXT and pay prefixes; no invented data door', () => {
    expect(doorForPath('/api/v1/markets')).toBe('trade');
    expect(doorForPath('/api/trade/trpc/orders.create')).toBe('trade');
    expect(doorForPath('/api/pay/trpc/health')).toBe('pay');
    expect(doorForPath('/api/identity/trpc/apiKeys.create')).toBeNull();
    expect(doorForPath('/api/indexer/trpc/health')).toBeNull();
    expect(requiredScopeFor('trade', 'GET')).toBe('trade:read');
    expect(requiredScopeFor('trade', 'POST')).toBe('trade:write');
    expect(requiredScopeFor('pay', 'GET')).toBe('pay:read');
    expect(requiredScopeFor('pay', 'POST')).toBe('pay:write');
  });

  it('trade door without trade:read is CCXT PermissionDenied + scope.denied', () => {
    const decided = decideGateway({
      pathname: '/api/v1/markets',
      method: 'GET',
      principal: principal({ scopes: ['pay:read'] }),
      buckets: new KeyBuckets(),
      keyRateLimit: LIMIT,
      costs: COSTS,
      now: 0,
    });
    expect(decided.allow).toBe(false);
    if (decided.allow) return;
    expect(decided.status).toBe(403);
    expect(decided.body).toEqual(scopeRefuseBody('trade', 'trade:read'));
    expect(decided.body).toMatchObject({
      code: 'PermissionDenied',
      intafacedCode: 'scope.denied',
    });
  });

  it('pay door without pay:read is tRPC FORBIDDEN + scope.denied', () => {
    const decided = decideGateway({
      pathname: '/api/pay/trpc/health',
      method: 'GET',
      principal: principal({ scopes: ['trade:read'] }),
      buckets: new KeyBuckets(),
      keyRateLimit: LIMIT,
      costs: COSTS,
      now: 0,
    });
    expect(decided.allow).toBe(false);
    if (decided.allow) return;
    expect(decided.status).toBe(403);
    expect(decided.body).toEqual(scopeRefuseBody('pay', 'pay:read'));
    const body = decided.body as { error: { data: { intafacedCode: string } } };
    expect(body.error.data.intafacedCode).toBe('scope.denied');
    expect(body.error.data).toMatchObject({ code: 'FORBIDDEN', httpStatus: 403 });
  });

  it('both doors point a scope refusal at the permission table, and the link names no account', () => {
    const trade = scopeRefuseBody('trade', 'trade:write') as { docs: string; message: string };
    const pay = scopeRefuseBody('pay', 'pay:write') as { error: { message: string; data: { docs: string } } };
    expect(trade.docs).toBe('/developers/permissions');
    expect(pay.error.data.docs).toBe('/developers/permissions');
    expect(JSON.stringify([trade, pay])).not.toMatch(/kid|user|account/i);
  });

  it('same live key with both read scopes passes both doors at the live host', () => {
    const buckets = new KeyBuckets();
    const key = principal({ scopes: ['trade:read', 'pay:read'], key_env: 'live' });
    const trade = decideGateway({
      pathname: '/api/v1/markets',
      method: 'GET',
      principal: key,
      buckets,
      keyRateLimit: LIMIT,
      costs: COSTS,
      now: 1,
    });
    const pay = decideGateway({
      pathname: '/api/pay/trpc/health',
      method: 'GET',
      principal: key,
      buckets,
      keyRateLimit: LIMIT,
      costs: COSTS,
      now: 1,
    });
    expect(trade).toMatchObject({ allow: true, sandbox: false });
    expect(pay).toMatchObject({ allow: true, sandbox: false });
    // One bucket for the key across both doors: two calls of cost 1 out of a burst of 10.
    expect(pay).toMatchObject({ metered: { limit: 10, remaining: 8, cost: 1 } });
  });

  describe('environment rule: env.mismatch before any scope work', () => {
    const SANDBOX_HOSTS = parseSandboxHosts(' Sandbox.Example:443 , localhost:14500 ');
    const decide = (p: Principal | null, host: string | undefined, pathname = '/api/pay/v1/payments', method = 'GET') =>
      decideGateway({
        pathname,
        method,
        principal: p,
        buckets: new KeyBuckets(),
        keyRateLimit: LIMIT,
        costs: COSTS,
        now: 0,
        host,
        sandboxHosts: SANDBOX_HOSTS,
      });
    const expectMismatch = (decided: ReturnType<typeof decideGateway>) => {
      expect(decided.allow).toBe(false);
      if (decided.allow) return;
      expect(decided.status).toBe(403);
      expect(envMismatchCodeOf(decided.body)).toBe('env.mismatch');
    };
    const sandboxPay = principal({ key_env: 'sandbox', scopes: ['pay:read', 'pay:write'] });

    it('parses the host list trimmed, case-folded and default port dropped; blank is no sandbox host', () => {
      expect([...SANDBOX_HOSTS]).toEqual(['sandbox.example', 'localhost:14500']);
      expect(parseSandboxHosts(undefined).size).toBe(0);
      expect(parseSandboxHosts(' , ').size).toBe(0);
      expect(hostEnvironment('LOCALHOST:14500', SANDBOX_HOSTS)).toBe('sandbox');
      expect(hostEnvironment('127.0.0.1:14500', SANDBOX_HOSTS)).toBe('live');
      expect(hostEnvironment(undefined, SANDBOX_HOSTS)).toBe('live');
      expect(hostEnvironment('', SANDBOX_HOSTS)).toBe('live');
    });

    it('one spelling per host: a trailing root dot and a default port name the same environment', () => {
      expect(normalizeHost(' Sandbox.Example.:443 ')).toBe('sandbox.example');
      expect(normalizeHost('sandbox.example:80')).toBe('sandbox.example');
      expect(normalizeHost('sandbox.example:8443')).toBe('sandbox.example:8443');
      expect(normalizeHost('[::1]:443')).toBe('[::1]');
      expect(normalizeHost('[::1]:8080')).toBe('[::1]:8080');
      for (const host of ['sandbox.example', 'sandbox.example.', 'SANDBOX.EXAMPLE:443', 'sandbox.example.:443']) {
        expect(hostEnvironment(host, SANDBOX_HOSTS)).toBe('sandbox');
      }
      expect(hostEnvironment('sandbox.example:8443', SANDBOX_HOSTS)).toBe('live');
      expect(hostEnvironment('sandbox.example.evil', SANDBOX_HOSTS)).toBe('live');
    });

    it('each door refuses in its own dialect, all carrying env.mismatch', () => {
      expect(envMismatchBody('trade')).toMatchObject({ code: 'PermissionDenied', intafacedCode: 'env.mismatch' });
      expect(envMismatchBody('pay')).toMatchObject({
        error: { data: { code: 'FORBIDDEN', httpStatus: 403, intafacedCode: 'env.mismatch' } },
      });
      const edgeBody = envMismatchBody(null);
      expect(edgeBody.code).toBe('env.mismatch');
      expect(typeof edgeBody.error).toBe('string');
      expect(edgeBody.error).not.toBe('env.mismatch');
      const sandboxTrader = principal({ key_env: 'sandbox', scopes: ['trade:read'] });
      expect(decide(sandboxTrader, '127.0.0.1:14500', '/api/v1/account/balance')).toMatchObject({ body: envMismatchBody('trade') });
      expect(decide(sandboxPay, '127.0.0.1:14500')).toMatchObject({ body: envMismatchBody('pay') });
      expect(decide(sandboxPay, '127.0.0.1:14500', '/api/identity/trpc/apiKeys.list')).toMatchObject({ body: envMismatchBody(null) });
    });

    it('a sandbox key at the live host is env.mismatch, at both doors', () => {
      expectMismatch(decide(sandboxPay, '127.0.0.1:14500'));
      expectMismatch(decide(principal({ key_env: 'sandbox', scopes: ['trade:read'] }), '127.0.0.1:14500', '/api/v1/account/balance'));
    });

    it('a live key at the sandbox host is env.mismatch, at both doors', () => {
      expectMismatch(decide(principal({ key_env: 'live', scopes: ['pay:read'] }), 'localhost:14500'));
      expectMismatch(decide(principal({ key_env: 'live', scopes: ['trade:read'] }), 'localhost:14500', '/api/v1/account/balance'));
    });

    it('a key with no environment is live, never a sandbox key', () => {
      expectMismatch(decide(principal({ key_env: undefined, scopes: ['pay:read'] }), 'localhost:14500'));
      expect(decide(principal({ key_env: undefined, scopes: ['pay:read'] }), '127.0.0.1:14500')).toMatchObject({
        allow: true,
        sandbox: false,
      });
    });

    it('the mismatch comes before the scope check: a scopeless key learns nothing about scopes', () => {
      const scopeless = principal({ key_env: 'sandbox', scopes: [] });
      expectMismatch(decide(scopeless, '127.0.0.1:14500', '/api/pay/v1/payments', 'POST'));
      expectMismatch(decide(scopeless, '127.0.0.1:14500', '/api/v1/orders', 'POST'));
    });

    it('a mismatch spends no quota', () => {
      const buckets = new KeyBuckets();
      const key = principal({ key_env: 'sandbox', scopes: ['pay:read'] });
      const call = {
        pathname: '/api/pay/v1/payments',
        method: 'GET',
        principal: key,
        buckets,
        keyRateLimit: LIMIT,
        costs: COSTS,
        now: 0,
        sandboxHosts: SANDBOX_HOSTS,
      };
      decideGateway({ ...call, host: '127.0.0.1:14500' });
      expect(buckets.usage('key-1', USER, 0).state).toBe('none');
    });

    it('trade has no sandbox backing: a sandbox key at the trade door is refused even at the sandbox host', () => {
      const trader = principal({ key_env: 'sandbox', scopes: ['trade:read', 'trade:write'] });
      expectMismatch(decide(trader, 'localhost:14500', '/api/v1/account/balance'));
      expectMismatch(decide(trader, 'localhost:14500', '/api/trade/trpc/orders.create', 'POST'));
    });

    it('pay is sandbox-backed: a sandbox key at the sandbox host passes the pay door, marked sandbox', () => {
      expect(decide(sandboxPay, 'localhost:14500')).toMatchObject({ allow: true, sandbox: true });
      expect(decide(sandboxPay, 'sandbox.example:443', '/api/pay/v1/payments', 'POST')).toMatchObject({ allow: true, sandbox: true });
    });

    it('with no sandbox host set, every sandbox key is refused at every door', () => {
      const none = parseSandboxHosts('');
      for (const host of ['localhost:14500', '127.0.0.1:14500', undefined]) {
        for (const pathname of ['/api/pay/v1/payments', '/api/v1/account/balance']) {
          expectMismatch(
            decideGateway({
              pathname,
              method: 'GET',
              principal: sandboxPay,
              buckets: new KeyBuckets(),
              keyRateLimit: LIMIT,
              costs: COSTS,
              now: 0,
              host,
              sandboxHosts: none,
            }),
          );
        }
      }
    });

    it('a session is live: refused at the sandbox host, served at the live host', () => {
      const session = principal({ kid: undefined, key_env: undefined, scopes: [] });
      expectMismatch(decide(session, 'localhost:14500'));
      expect(decide(session, '127.0.0.1:14500').allow).toBe(true);
    });

    it('anonymous callers are not touched by the rule', () => {
      expect(decide(null, 'localhost:14500').allow).toBe(true);
      expect(decide(null, 'localhost:14500', '/api/identity/trpc/auth.login', 'POST').allow).toBe(true);
    });

    it('the rule holds off the trade/pay doors too: only the pay door serves a sandbox key', () => {
      const path = '/api/identity/trpc/apiKeys.list';
      expectMismatch(decide(sandboxPay, '127.0.0.1:14500', path));
      expectMismatch(decide(sandboxPay, 'localhost:14500', path));
      expectMismatch(decide(principal({ key_env: 'live', scopes: ['pay:read'] }), 'localhost:14500', path));
      expectMismatch(decide(principal({ kid: undefined, key_env: undefined, scopes: [] }), 'localhost:14500', path));
      expect(decide(principal({ key_env: 'live', scopes: ['pay:read'] }), '127.0.0.1:14500', path)).toEqual({
        allow: true,
        sandbox: false,
      });
      expect(decide(principal({ kid: undefined, key_env: undefined, scopes: [] }), '127.0.0.1:14500', path).allow).toBe(true);
    });

    it('CORS preflight is not refused (it carries no credentials)', () => {
      expect(decide(sandboxPay, '127.0.0.1:14500', '/api/pay/v1/payments', 'OPTIONS').allow).toBe(true);
    });
  });

  it('interactive sessions (no kid) are not this plane', () => {
    const decided = decideGateway({
      pathname: '/api/pay/trpc/health',
      method: 'GET',
      principal: principal({ kid: undefined, scopes: [] }),
      buckets: new KeyBuckets(),
      keyRateLimit: LIMIT,
      costs: COSTS,
      now: 0,
    });
    expect(decided.allow).toBe(true);
  });

  it('a key past its burst is edge.rate_limited with reason, retry-after and the cost — existing edge code', () => {
    const buckets = new KeyBuckets();
    const key = principal({ scopes: ['trade:read'] });
    const call = (now: number) =>
      decideGateway({
        pathname: '/api/v1/markets',
        method: 'GET',
        principal: key,
        buckets,
        keyRateLimit: { tier: 'base', burst: 1, refillPerMinute: 60, user: { burst: 10, refillPerMinute: 600 } },
        costs: COSTS,
        now,
      });
    const first = call(0);
    const second = call(1);
    expect(first.allow).toBe(true);
    expect(second.allow).toBe(false);
    if (second.allow) return;
    expect(second.status).toBe(429);
    expect(second.body.code).toBe('edge.rate_limited');
    expect(second.body).toMatchObject(quotaRefuseBody(1, 'global', 1));
    expect(second.body).toMatchObject({
      reason: 'global',
      retryAfterSeconds: 1,
      remaining: 0,
      bucket: EDGE_API_KEY_RATE_BUCKET,
      cost: EDGE_RATE_COST,
      docs: '/developers/rate-limits',
    });
    expect(second.limited).toEqual({ reason: 'global', limit: 1, cost: 1, retryAfterSeconds: 1 });
    // One token refills in a second at 60 a minute.
    expect(call(1001).allow).toBe(true);
  });

  it('a key with no limit stated, or a call with no cost in the table, is refused and nothing is counted', () => {
    const buckets = new KeyBuckets();
    const key = principal({ scopes: ['trade:read'] });
    const base = { pathname: '/api/v1/markets', method: 'GET', principal: key, buckets, now: 0 };
    expect(decideGateway({ ...base, keyRateLimit: null, costs: COSTS })).toMatchObject({
      allow: false,
      status: 503,
      body: { code: 'edge.limits_unset' },
    });
    // A key's exchanged access token sent as the bearer: its limit was not read on this request, so it is refused as
    // such, never as "not set".
    expect(decideGateway({ ...base, keyRateLimit: undefined, costs: COSTS })).toMatchObject({
      allow: false,
      status: 401,
      body: { code: 'edge.api_key_bearer_required' },
    });
    const uncosted = decideGateway({ ...base, keyRateLimit: LIMIT, costs: [{ route: 'GET /api/pay/**', cost: 1 }] });
    expect(uncosted).toMatchObject({ allow: false, status: 503, body: { code: 'edge.cost_unset' } });
    expect(decideGateway({ ...base, keyRateLimit: LIMIT, costs: [] })).toMatchObject({ body: { code: 'edge.cost_unset' } });
    expect(buckets.usage('key-1', USER, 0).state).toBe('none');
  });

  it('sandbox flag is key_env, never a silent upgrade of live', () => {
    expect(sandboxOf(principal({ key_env: 'sandbox' }))).toBe(true);
    expect(sandboxOf(principal({ key_env: 'live' }))).toBe(false);
    expect(sandboxOf(principal({ key_env: undefined }))).toBe(false);
    expect(sandboxOf(null)).toBe(false);
  });
});
