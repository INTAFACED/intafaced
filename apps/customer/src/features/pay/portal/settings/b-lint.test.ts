import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createApiClient } from '../../../../shared/api';
import { settingsBApi, settingsBTools } from './b-client';
import { analyticsApi } from './analytics/client';
import { developersApi } from './developers/client';
import { reportsApi } from './reports/client';
import { analyticsMessages } from './analytics/copy';
import { developersMessages } from './developers/copy';
import { reportsMessages } from './reports/copy';

/** The same word rules as `portal/copy-lint.test.ts`, applied to the three catalogs that file does not list. */
const catalogs = { developers: developersMessages, reports: reportsMessages, analytics: analyticsMessages };
const banned: Array<[string, RegExp]> = [
  ['a work-package code', /\bW\d+[a-z]?\d?\b/],
  ['"backend"', /\bback-?end\b/i],
  ['"stub"', /\bstubs?\b/i],
  ['"cursor"', /\bcursors?\b/i],
  ['"server"', /\bservers?\b/i],
  ['"contract"', /\bcontracts?\b/i],
  ['"loaded"', /\bloaded\b/i],
  ['"procedure"', /\bprocedures?\b/i],
  ['"projection"', /\bprojections?\b/i],
  ['"fixture"', /\bfixtures?\b/i],
  ['"arrives"', /\barrives?\b/i],
  ['"coming soon"', /coming soon/i],
  ['a snake_case word', /\b[a-z]+(?:_[a-z0-9]+)+\b/],
  ['a service code', /\bpay\.[a-z_]+/],
];
const root = fileURLToPath(new URL('.', import.meta.url));
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return files(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
const own = ['developers', 'reports', 'analytics'].flatMap((d) => files(join(root, d))).filter((f) => !/\.test\./.test(f));

describe('copy for the developers, reports and analytics pages', () => {
  const entries = Object.entries(catalogs).flatMap(([ns, messages]) =>
    Object.entries(messages).map(([key, text]) => [`${ns}.${key}`, text] as const),
  );
  it('has words', () => expect(entries.length).toBeGreaterThan(300));
  it('uses no engineer words', () => {
    const offenders: string[] = [];
    for (const [id, text] of entries) {
      const words = text.replace(/\{[A-Za-z]+\}/g, '');
      for (const [name, pattern] of banned) if (pattern.test(words)) offenders.push(`${id} has ${name}: ${text}`);
    }
    expect(offenders).toEqual([]);
  });
  it('has no key that nothing refers to', () => {
    const text = own.map((f) => readFileSync(f, 'utf8')).join('\n');
    const prefixes = [...text.matchAll(/`([A-Za-z0-9_]+)\$\{/g)].map((m) => m[1]!);
    const used = (key: string) => new RegExp(`['"\`]${key}['"\`]`).test(text) || prefixes.some((p) => key.startsWith(p));
    const dead = Object.entries(catalogs).flatMap(([ns, m]) =>
      Object.keys(m)
        .filter((k) => !used(k))
        .map((k) => `${ns}.${k}`),
    );
    expect(dead).toEqual([]);
  });
});

/** Every call the three clients make, as the wire carries it: the service, the procedure and what it sends. */
async function everyCall() {
  const calls: { module: string; procedure: string; body: string }[] = [];
  const api = createApiClient({
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input), 'http://127.0.0.1');
      const trpc = url.pathname.match(/^\/api\/([a-z0-9-]+)\/trpc\/(.+)$/);
      calls.push({
        module: trpc?.[1] ?? url.pathname,
        procedure: decodeURIComponent(trpc?.[2] ?? ''),
        body: `${typeof init?.body === 'string' ? init.body : ''}${url.search}`,
      });
      return new Response(JSON.stringify({ error: { message: 'TEST: no service' } }), { status: 503 });
    },
  });
  const client = settingsBApi(api, '11111111-1111-4111-8111-111111111111');
  const parts = [developersApi, reportsApi, analyticsApi].map((part) => Object.keys(part(settingsBTools(api, null))));
  expect(Object.keys(client).sort(), 'the client is the three parts and nothing else').toEqual(parts.flat().sort());
  // Each call once, with TEST arguments; a key request even asks for a live key, which the portal must never send.
  const signal = new AbortController().signal;
  const asks: Record<string, unknown[]> = {
    keyCreate: [{ name: 'TEST key', scopes: [], mode: 'live' }],
    deliveryAttempts: ['TEST-id', signal],
    analyticsDeclines: ['TEST-id', signal],
    ...Object.fromEntries(
      ['keysList', 'webhookHealth', 'webhookPolicy', 'webhookCatalogue', 'webhookGuide', 'reportPeople'].map((n) => [n, [signal]]),
    ),
  };
  for (const [name, call] of Object.entries(client) as [string, (...args: unknown[]) => Promise<unknown>][]) {
    const before = calls.length;
    await call(...(asks[name] ?? ['TEST-id', []])).catch((error: unknown) => {
      throw new Error(`${name}: ${String(error)}`);
    });
    expect(calls.length - before, `${name} makes one call`).toBe(1);
  }
  return calls;
}

describe('what these pages may call', () => {
  it('names only merchant-scoped and own-key procedures', async () => {
    const calls = await everyCall();
    const names = calls.map((c) => c.procedure);
    expect(names.length).toBeGreaterThanOrEqual(20);
    for (const call of calls) {
      expect(call.procedure).toMatch(
        /^(merchantOps\.(webhooks\.|exports\.|team\.list)|merchantAnalytics\.(volume|fees|declines)|merchantMetrics\.series|apiKeys\.(list|create|revoke)|setApiKeyRequestSigning|rotateSigningSecret|bindApiKeyIpAllowlist|unbindApiKeyIpAllowlist)/,
      );
      // The key and signing calls go to the sign-in service, the merchant calls to pay: no other service.
      expect(call.module, call.procedure).toBe(
        /^(apiKeys\.|setApiKey|rotateSigning|bindApiKey|unbindApiKey)/.test(call.procedure) ? 'identity' : 'pay',
      );
      expect(`${call.procedure} ${call.body}`).not.toMatch(/admin:|operator|killswitch/i);
      expect(`${call.procedure} ${call.body}`).not.toMatch(new RegExp(['founder', 'Admin'].join(''), 'i'));
    }
  });
  it('never mints a live key from the portal', async () => {
    const created = (await everyCall()).filter((c) => c.procedure === 'apiKeys.create');
    expect(created).toHaveLength(1);
    expect(created[0]!.body).toMatch(/"mode":"sandbox"/);
    expect(created[0]!.body).not.toMatch(/"mode":"live"/);
  });
});

describe('secrets', () => {
  it('are never written to storage, the address or the console', () => {
    const text = own.map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(text).not.toMatch(/localStorage|sessionStorage|indexedDB|console\.(log|info|debug)/);
  });
});
