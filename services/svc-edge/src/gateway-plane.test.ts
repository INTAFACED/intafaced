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
    key_env: 'sandbox',
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

  it('same key with both read scopes passes both doors', () => {
    const quota = createQuotaStore();
    const key = principal({ scopes: ['trade:read', 'pay:read'], key_env: 'sandbox' });
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
    expect(trade).toEqual({ allow: true, sandbox: true });
    expect(pay).toEqual({ allow: true, sandbox: true });
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
