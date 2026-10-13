import { NextRequest } from 'next/server';
import { NextURL } from 'next/dist/server/web/next-url';
import { afterEach, describe, expect, it } from 'vitest';
import { middleware } from './middleware';

/**
 * Next's middleware adapter re-parses every redirect Location with `new NextURL(location, { headers, nextConfig })`
 * and no base (next/dist/server/web/adapter.js). A relative Location throws "Invalid URL" there and the page answers 500,
 * which unit tests that call `middleware()` directly cannot see. This replays that parse on every gate redirect.
 */
const saved = { modules: process.env.ADMIN_MODULES, origin: process.env.ADMIN_ORIGIN };
afterEach(() => {
  for (const [key, value] of [
    ['ADMIN_MODULES', saved.modules],
    ['ADMIN_ORIGIN', saved.origin],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const paths = ['/', '/tools', '/ledger', '/accounts', '/launch', '/jurisdiction', '/%74ools', '/%2574ools', '/crm/%2e%2e/tools'];

describe('gate redirect survives Next adapter Location parsing', () => {
  for (const origin of [undefined, 'https://console.example']) {
    it(`ADMIN_ORIGIN=${origin ?? 'unset'}: every redirect Location parses without a base and lands on /crm`, () => {
      process.env.ADMIN_MODULES = 'crm';
      if (origin === undefined) delete process.env.ADMIN_ORIGIN;
      else process.env.ADMIN_ORIGIN = origin;
      for (const path of paths) {
        const res = middleware(new NextRequest(`http://admin.internal:3100${path}`));
        expect(res.status, path).toBe(307);
        const location = res.headers.get('location');
        expect(location, path).toBeTruthy();
        const parsed = new NextURL(location!, { headers: {} });
        expect(parsed.pathname, path).toBe('/crm');
        expect(parsed.origin, path).toBe(origin ?? 'http://admin.internal:3100');
      }
    });
  }

  it('a relative Location is exactly what the adapter rejects (guards the premise of this test)', () => {
    expect(() => new NextURL('/crm', { headers: {} })).toThrow();
  });
});
