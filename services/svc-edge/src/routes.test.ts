import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isS2sPath, readyRoutes, resolve, resolveUpstreamBase, UPSTREAMS } from './routes.js';

describe('route resolution', () => {
  it('maps a prefix to its upstream and strips the prefix from the path', () => {
    const r = resolve('/api/trade/trpc/orders.create');
    expect(r?.upstream.prefix).toBe('/api/trade');
    expect(r?.path).toBe('/trpc/orders.create');
  });

  /**
   * Public KB doors (#2078 wire) land on svc-support `/trpc/{list,search,get}Kb`
   * after the edge strips `/api/support`. preservePath would miss the mount.
   */
  it('strips /api/ops so CRM trpc lands on /trpc/* (module stays core-ops)', () => {
    const ops = UPSTREAMS.find((u) => u.prefix === '/api/ops');
    expect(ops?.envVar).toBe('OPS_URL');
    expect(ops?.module).toBe('core-ops');
    expect(ops?.preservePath).toBeFalsy();
    expect(resolve('/api/ops/trpc/contacts')?.path).toBe('/trpc/contacts');
    expect(resolve('/api/ops/trpc/revenue')?.path).toBe('/trpc/revenue');
    expect(resolve('/api/ops/trpc/projects.create')?.path).toBe('/trpc/projects.create');
  });

  it('strips /api/support so public KB trpc lands on /trpc/*', () => {
    const support = UPSTREAMS.find((u) => u.prefix === '/api/support');
    expect(support?.envVar).toBe('SUPPORT_URL');
    expect(support?.preservePath).toBeFalsy();

    expect(resolve('/api/support/trpc/listKb')?.path).toBe('/trpc/listKb');
    expect(resolve('/api/support/trpc/searchKb')?.path).toBe('/trpc/searchKb');
    expect(resolve('/api/support/trpc/getKb')?.path).toBe('/trpc/getKb');
  });

  /**
   * Merchant public REST lives at edge `/api/pay/v1/*`. The pay upstream has
   * NO preservePath, so the edge strips `/api/pay` and svc-pay must mount at
   * `/v1/*` — not `/api/pay/v1/*`. If this ever flips to preservePath, trpc and
   * webhooks break the other way. Contract enforced both sides: see
   * `services/svc-pay/src/public-rest.ts` `BASE = '/v1'`.
   */
  it('strips /api/pay so merchant REST lands on /v1/* (svc-pay BASE contract)', () => {
    const pay = UPSTREAMS.find((u) => u.prefix === '/api/pay');
    expect(pay, 'pay upstream must exist').toBeDefined();
    expect(pay?.preservePath, 'pay must strip prefix — preservePath breaks trpc/webhooks').toBeFalsy();

    const rest = resolve('/api/pay/v1/payments');
    expect(rest?.upstream.prefix).toBe('/api/pay');
    expect(rest?.path).toBe('/v1/payments');

    const openapi = resolve('/api/pay/v1/openapi.json');
    expect(openapi?.path).toBe('/v1/openapi.json');

    // Sibling mounts still strip correctly — the BASE fix must not tempt preservePath.
    expect(resolve('/api/pay/trpc/payment.create')?.path).toBe('/trpc/payment.create');
    expect(resolve('/api/pay/webhooks/crypto')?.path).toBe('/webhooks/crypto');
    expect(resolve('/api/pay/checkout')?.path).toBe('/checkout');
  });

  it('resolves a bare prefix to the upstream root', () => {
    expect(resolve('/api/identity')?.path).toBe('/');
  });

  it('preserves the full path for public CCXT REST (/api/v1 → trade)', () => {
    const markets = resolve('/api/v1/markets');
    expect(markets?.upstream.prefix).toBe('/api/v1');
    expect(markets?.upstream.envVar).toBe('TRADE_URL');
    expect(markets?.upstream.preservePath).toBe(true);
    expect(markets?.path).toBe('/api/v1/markets');

    const book = resolve('/api/v1/orderbook/BTC%2FUSDT');
    expect(book?.path).toBe('/api/v1/orderbook/BTC%2FUSDT');
  });

  it('does not let /api/v1 steal /api/trade (longer prefix wins)', () => {
    const r = resolve('/api/trade/trpc/markets.list');
    expect(r?.upstream.prefix).toBe('/api/trade');
    expect(r?.path).toBe('/trpc/markets.list');
  });

  /**
   * The property that keeps the edge from being a proxy for the whole internal
   * network. Anything unlisted must 404 — never fall through to a default.
   */
  it('refuses an unknown prefix', () => {
    for (const path of ['/api/ledger/trpc/post', '/api/matching/markets', '/api/unknown', '/internal/jobs/x', '/']) {
      expect(resolve(path), path).toBeNull();
    }
  });

  it('does not route to svc-ledger or svc-matching at all', () => {
    // Both serve service-to-service HTTP behind a shared secret (#50, #55).
    // No browser has business reaching either — `ledger.post` moves value on a
    // module's own authority, which is why no user token carries `ledger:write`.
    const prefixes = UPSTREAMS.map((u) => u.prefix);
    expect(prefixes).not.toContain('/api/ledger');
    expect(prefixes).not.toContain('/api/matching');
  });

  it('matches on a segment boundary, so one prefix cannot swallow another', () => {
    // `/api/identity-admin` must not be captured by `/api/identity` if such a
    // route is ever added. Longest-prefix-wins plus a boundary check.
    expect(resolve('/api/identityadmin/x')).toBeNull();
    expect(resolve('/api/identity-admin/x')).toBeNull();
  });

  it('declares no duplicate prefixes', () => {
    const prefixes = UPSTREAMS.map((u) => u.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it('gives every upstream an env var so nothing is hardcoded per environment', () => {
    for (const u of UPSTREAMS) {
      expect(u.envVar, u.prefix).toMatch(/^[A-Z0-9_]+_URL$/);
      expect(u.devUrl).toMatch(/^http:\/\/localhost:\d+$/);
    }
  });
});

describe('service /internal/ is not a public path', () => {
  it('names the stripped path the door must refuse', () => {
    expect(isS2sPath('/internal/jobs/run-due-subscriptions')).toBe(true);
    expect(isS2sPath('/internal/stake/u')).toBe(true);
    expect(isS2sPath('/internal/rank/u/perks')).toBe(true);
    expect(isS2sPath('/internal')).toBe(true);
    expect(isS2sPath('/trpc/payment.create')).toBe(false);
    expect(isS2sPath('/v1/payments')).toBe(false);
    expect(isS2sPath('/webhooks/crypto')).toBe(false);
    expect(isS2sPath('/checkout')).toBe(false);
    expect(isS2sPath('/internalist')).toBe(false);
  });

  it('resolves pay/identity/token/academy/support internals to a service remainder', () => {
    for (const path of [
      '/api/pay/internal/jobs/run-due-subscriptions',
      '/api/identity/internal/rank/u/perks',
      '/api/token/internal/emissions/mint-next',
      '/api/academy/internal/anything',
      '/api/support/internal/anything',
    ]) {
      const r = resolve(path);
      expect(r, path).not.toBeNull();
      expect(isS2sPath(r!.path), path).toBe(true);
    }
  });

  it('mounts mining submitShare behind the edge', () => {
    const resolved = resolve('/api/mining/submitShare');
    expect(resolved?.upstream.module).toBe('mining-pool');
    expect(resolved?.path).toBe('/submitShare');
  });
});

describe('unwired upstreams refuse in staging/prod, fall back in dev', () => {
  const pay = UPSTREAMS.find((u) => u.prefix === '/api/pay')!;

  it('uses the env URL when set, in every APP_ENV', () => {
    const env = (name: string) => (name === 'PAY_URL' ? 'http://pay.internal:4006/' : undefined);
    expect(resolveUpstreamBase(pay, env, 'prod')).toEqual({ base: 'http://pay.internal:4006' });
    expect(resolveUpstreamBase(pay, env, 'dev')).toEqual({ base: 'http://pay.internal:4006' });
  });

  it('does not silently hit localhost when PAY_URL is unset in prod', () => {
    expect(resolveUpstreamBase(pay, () => undefined, 'prod')).toEqual({ unwired: true });
    expect(resolveUpstreamBase(pay, () => undefined, 'staging')).toEqual({ unwired: true });
  });

  it('keeps the local default in dev/test so a laptop still boots', () => {
    expect(resolveUpstreamBase(pay, () => undefined, 'dev')).toEqual({ base: 'http://localhost:4006' });
    expect(resolveUpstreamBase(pay, () => undefined, 'test')).toEqual({ base: 'http://localhost:4006' });
  });

  it('lists configured vs absent on /ready without leaking URLs or saying wired', () => {
    const table = readyRoutes((name) => (name === 'PAY_URL' || name === 'IDENTITY_URL' ? 'http://secret.internal' : undefined));
    const byPrefix = Object.fromEntries(table.map((r) => [r.prefix, r]));
    expect(byPrefix['/api/pay']?.configured).toBe(true);
    expect(byPrefix['/api/identity']?.configured).toBe(true);
    expect(byPrefix['/api/academy']?.configured).toBe(false);
    expect(byPrefix['/api/support']?.configured).toBe(false);
    expect(JSON.stringify(table)).not.toContain('secret.internal');
    expect(JSON.stringify(table)).not.toMatch(/wired/i);
  });
});

/**
 * README route table drift was the residual that made the wall look incomplete:
 * code forwarded /api/v1, dex, indexer, market, … while the doc listed nine rows.
 * Pin the prefixes into the README so the next table edit fails the suite.
 */
describe('README route table stays honest with UPSTREAMS', () => {
  it('lists every prefix the edge actually forwards', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const readme = readFileSync(join(here, '..', 'README.md'), 'utf8');
    for (const u of UPSTREAMS) {
      expect(readme, u.prefix).toContain(`| \`${u.prefix}\``);
    }
  });
});
