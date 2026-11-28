/**
 * Unit card — DEX_QUOTE_DEPTH refuse-closed
 *
 * 1. Promise: blank / unset is unpublished (undefined). Owner-explicit 50
 *    parses as 50. Garbage / 0 / over-max refuse boot. env.ts has no .default(50).
 * 2. Break: z.coerce.number().default(50) makes blank look published.
 * 3. Done bar: production env.ts loadEnv (not a forked slice) + source pin.
 * 4. Class M
 * 5. Paths: env.ts via loadEnv at import (same as boot)
 * 6. RED: unset parses as 50, or .default(50) returns
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const SECRET = 's'.repeat(32);

const BASE_ENV = {
  EDGE_PRINCIPAL_SECRET: SECRET,
};

async function loadWith(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('DEX_QUOTE_DEPTH', undefined);
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) {
    vi.stubEnv(key, value);
  }
  const module = await import('./env.js');
  return module.env;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('DEX_QUOTE_DEPTH refuse-closed', () => {
  it('unset is unpublished (not 50)', async () => {
    const parsed = await loadWith({});
    expect(parsed.DEX_QUOTE_DEPTH).toBeUndefined();
  });

  it('blank is unpublished (not 50)', async () => {
    const parsed = await loadWith({ DEX_QUOTE_DEPTH: '' });
    expect(parsed.DEX_QUOTE_DEPTH).toBeUndefined();
  });

  it('whitespace is unpublished (not 50)', async () => {
    const parsed = await loadWith({ DEX_QUOTE_DEPTH: '   ' });
    expect(parsed.DEX_QUOTE_DEPTH).toBeUndefined();
  });

  it('owner-explicit 50 is allowed', async () => {
    const parsed = await loadWith({ DEX_QUOTE_DEPTH: '50' });
    expect(parsed.DEX_QUOTE_DEPTH).toBe(50);
  });

  it('garbage refuses boot (does not invent a depth)', async () => {
    await expect(loadWith({ DEX_QUOTE_DEPTH: 'garbage' })).rejects.toThrow(/DEX_QUOTE_DEPTH/);
  });

  it('zero refuses boot (not a published depth)', async () => {
    await expect(loadWith({ DEX_QUOTE_DEPTH: '0' })).rejects.toThrow(/DEX_QUOTE_DEPTH/);
  });
});
