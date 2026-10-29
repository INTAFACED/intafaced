import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { EDGE_API_KEY_RATE_BUCKET, EDGE_RATE_COST } from './hardening.js';
import {
  GATEWAY_DIALECTS,
  GATEWAY_KEY_PLANE,
  createQuotaStore,
  decideGateway,
  doorForPath,
  envMismatchBody,
  hostEnvironment,
  parseSandboxHosts,
  quotaRefuseBody,
  requiredScopeFor,
  sandboxOf,
  scopeRefuseBody,
  takeQuota,
} from './gateway-plane.js';

const HERE = dirname(fileURLToPath(import.meta.url));
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
  it('names identity.apikeys as the only key plane — no second table', () => {
    expect(GATEWAY_KEY_PLANE).toBe('identity.apikeys');
    const src = readFileSync(join(HERE, 'gateway-plane.ts'), 'utf8');
    expect(src).not.toMatch(/createTable|pgTable|api_keys_v2|gateway_keys/i);
    expect(src).toMatch(/identity\.apikeys/);
  });

  it('keeps two dialects and does not invent a third error taxonomy', () => {
    expect(GATEWAY_DIALECTS).toEqual({ trade: 'ccxt', pay: 'pay' });
    expect(Object.keys(GATEWAY_DIALECTS)).toEqual(['trade', 'pay']);
    const src = readFileSync(join(HERE, 'gateway-plane.ts'), 'utf8');
    expect(src).toMatch(/PermissionDenied/);
    expect(src).toMatch(/intafacedCode: 'scope\.denied'/);
    expect(src).toMatch(/edge\.rate_limited/);
    expect(src).not.toMatch(/edge\.gateway_/);
    expect(src).not.toMatch(/unifiedError|third.?taxonom/i);
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
      quota: createQuotaStore(),
      now: 0,
      max: 10,
      windowMs: 60_000,
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
      quota: createQuotaStore(),
      now: 0,
      max: 10,
      windowMs: 60_000,
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
    const quota = createQuotaStore();
    const key = principal({ scopes: ['trade:read', 'pay:read'], key_env: 'live' });
    const trade = decideGateway({
      pathname: '/api/v1/markets',
      method: 'GET',
      principal: key,
      quota,
      now: 1,
      max: 10,
      windowMs: 60_000,
    });
    const pay = decideGateway({
      pathname: '/api/pay/trpc/health',
      method: 'GET',
      principal: key,
      quota,
      now: 1,
      max: 10,
      windowMs: 60_000,
    });
    expect(trade).toEqual({ allow: true, sandbox: false });
    expect(pay).toEqual({ allow: true, sandbox: false });
  });

  describe('environment rule: env.mismatch before any scope work', () => {
    const SANDBOX_HOSTS = parseSandboxHosts(' Sandbox.Example:443 , localhost:14500 ');
    const decide = (p: Principal | null, host: string | undefined, pathname = '/api/pay/v1/payments', method = 'GET') =>
      decideGateway({
        pathname,
        method,
        principal: p,
        quota: createQuotaStore(),
        now: 0,
        max: 10,
        windowMs: 60_000,
        host,
        sandboxHosts: SANDBOX_HOSTS,
      });
    const expectMismatch = (decided: ReturnType<typeof decideGateway>) => {
      expect(decided.allow).toBe(false);
      if (decided.allow) return;
      expect(decided.status).toBe(403);
      expect(decided.body).toEqual(envMismatchBody());
      expect(decided.body.code).toBe('env.mismatch');
      expect(typeof decided.body.error).toBe('string');
      expect(decided.body.error).not.toBe('env.mismatch');
    };
    const sandboxPay = principal({ key_env: 'sandbox', scopes: ['pay:read', 'pay:write'] });

    it('parses the host list trimmed and case-folded; blank is no sandbox host', () => {
      expect([...SANDBOX_HOSTS]).toEqual(['sandbox.example:443', 'localhost:14500']);
      expect(parseSandboxHosts(undefined).size).toBe(0);
      expect(parseSandboxHosts(' , ').size).toBe(0);
      expect(hostEnvironment('LOCALHOST:14500', SANDBOX_HOSTS)).toBe('sandbox');
      expect(hostEnvironment('127.0.0.1:14500', SANDBOX_HOSTS)).toBe('live');
      expect(hostEnvironment(undefined, SANDBOX_HOSTS)).toBe('live');
      expect(hostEnvironment('', SANDBOX_HOSTS)).toBe('live');
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
      expect(decide(principal({ key_env: undefined, scopes: ['pay:read'] }), '127.0.0.1:14500')).toEqual({ allow: true, sandbox: false });
    });

    it('the mismatch comes before the scope check: a scopeless key learns nothing about scopes', () => {
      const scopeless = principal({ key_env: 'sandbox', scopes: [] });
      expectMismatch(decide(scopeless, '127.0.0.1:14500', '/api/pay/v1/payments', 'POST'));
      expectMismatch(decide(scopeless, '127.0.0.1:14500', '/api/v1/orders', 'POST'));
    });

    it('a mismatch spends no quota', () => {
      const quota = createQuotaStore();
      const key = principal({ key_env: 'sandbox', scopes: ['pay:read'] });
      const call = {
        pathname: '/api/pay/v1/payments',
        method: 'GET',
        principal: key,
        quota,
        now: 0,
        max: 10,
        windowMs: 60_000,
        sandboxHosts: SANDBOX_HOSTS,
      };
      decideGateway({ ...call, host: '127.0.0.1:14500' });
      expect(quota.size).toBe(0);
    });

    it('trade has no sandbox backing: a sandbox key at the trade door is refused even at the sandbox host', () => {
      const trader = principal({ key_env: 'sandbox', scopes: ['trade:read', 'trade:write'] });
      expectMismatch(decide(trader, 'localhost:14500', '/api/v1/account/balance'));
      expectMismatch(decide(trader, 'localhost:14500', '/api/trade/trpc/orders.create', 'POST'));
    });

    it('pay is sandbox-backed: a sandbox key at the sandbox host passes the pay door, marked sandbox', () => {
      expect(decide(sandboxPay, 'localhost:14500')).toEqual({ allow: true, sandbox: true });
      expect(decide(sandboxPay, 'sandbox.example:443', '/api/pay/v1/payments', 'POST')).toEqual({ allow: true, sandbox: true });
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
              quota: createQuotaStore(),
              now: 0,
              max: 10,
              windowMs: 60_000,
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

    it('anonymous callers and non-door paths are not touched by the rule', () => {
      expect(decide(null, 'localhost:14500').allow).toBe(true);
      expect(decide(sandboxPay, '127.0.0.1:14500', '/api/identity/trpc/apiKeys.list').allow).toBe(true);
    });

    it('CORS preflight is not refused (it carries no credentials)', () => {
      expect(decide(sandboxPay, '127.0.0.1:14500', '/api/pay/v1/payments', 'OPTIONS').allow).toBe(true);
    });

    it('index.ts passes the raw Host header and the parsed EDGE_SANDBOX_HOSTS', () => {
      const src = readFileSync(join(HERE, 'index.ts'), 'utf8');
      expect(src).toMatch(/host: req\.headers\.host,/);
      expect(src).toMatch(/parseSandboxHosts\(env\.EDGE_SANDBOX_HOSTS\)/);
      expect(src).not.toMatch(/x-forwarded-host/i);
    });
  });

  it('interactive sessions (no kid) are not this plane', () => {
    const decided = decideGateway({
      pathname: '/api/pay/trpc/health',
      method: 'GET',
      principal: principal({ kid: undefined, scopes: [] }),
      quota: createQuotaStore(),
      now: 0,
      max: 1,
      windowMs: 60_000,
    });
    expect(decided.allow).toBe(true);
  });

  it('quota past the budget is edge.rate_limited — existing edge code', () => {
    const quota = createQuotaStore();
    const key = principal({ scopes: ['trade:read'] });
    const first = decideGateway({
      pathname: '/api/v1/markets',
      method: 'GET',
      principal: key,
      quota,
      now: 0,
      max: 1,
      windowMs: 60_000,
    });
    const second = decideGateway({
      pathname: '/api/v1/markets',
      method: 'GET',
      principal: key,
      quota,
      now: 1,
      max: 1,
      windowMs: 60_000,
    });
    expect(first.allow).toBe(true);
    expect(second.allow).toBe(false);
    if (second.allow) return;
    expect(second.status).toBe(429);
    expect(second.body.code).toBe('edge.rate_limited');
    expect(second.body).toMatchObject(quotaRefuseBody(second.body.retryAfterSeconds as number));
    expect(second.body).toMatchObject({
      remaining: 0,
      bucket: EDGE_API_KEY_RATE_BUCKET,
      cost: EDGE_RATE_COST,
    });
  });

  it('sandbox flag is key_env, never a silent upgrade of live', () => {
    expect(sandboxOf(principal({ key_env: 'sandbox' }))).toBe(true);
    expect(sandboxOf(principal({ key_env: 'live' }))).toBe(false);
    expect(sandboxOf(principal({ key_env: undefined }))).toBe(false);
    expect(sandboxOf(null)).toBe(false);
  });

  it('takeQuota resets after the window', () => {
    const store = createQuotaStore();
    expect(takeQuota(store, 'k', 0, 1, 10)).toEqual({ ok: true });
    expect(takeQuota(store, 'k', 5, 1, 10).ok).toBe(false);
    expect(takeQuota(store, 'k', 10, 1, 10)).toEqual({ ok: true });
  });

  it('index.ts consults this plane after principal exchange', () => {
    const src = readFileSync(join(HERE, 'index.ts'), 'utf8');
    expect(src).toMatch(/decideGateway/);
    expect(src).toMatch(/from '\.\/gateway-plane\.js'/);
    expect(src).toMatch(/x-intafaced-key-env/);
  });
});
