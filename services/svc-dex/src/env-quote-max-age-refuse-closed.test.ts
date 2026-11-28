/**
 * Unit card — QUOTE_MAX_AGE_MS refuse-closed
 *
 * 1. Promise: blank / unset is unpublished (undefined). Owner-explicit 2000
 *    parses as 2000. Garbage / 99 / over-max refuse boot. env.ts has no .default(2000).
 * 2. Break: z.coerce.number().default(2000) makes blank look published.
 * 3. Done bar: production env.ts loadEnv (not a forked slice) + source pin.
 * 4. Class M
 * 5. Paths: env.ts via loadEnv at import (same as boot)
 * 6. RED: unset parses as 2000, or .default(2_000) / .default(2000) returns
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
  vi.stubEnv('QUOTE_MAX_AGE_MS', undefined);
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) {
    vi.stubEnv(key, value);
  }
  const module = await import('./env.js');
  return module.env;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('QUOTE_MAX_AGE_MS refuse-closed', () => {
  it('unset is unpublished (not 2000)', async () => {
    const parsed = await loadWith({});
    expect(parsed.QUOTE_MAX_AGE_MS).toBeUndefined();
  });

  it('blank is unpublished (not 2000)', async () => {
    const parsed = await loadWith({ QUOTE_MAX_AGE_MS: '' });
    expect(parsed.QUOTE_MAX_AGE_MS).toBeUndefined();
  });

  it('whitespace is unpublished (not 2000)', async () => {
    const parsed = await loadWith({ QUOTE_MAX_AGE_MS: '   ' });
    expect(parsed.QUOTE_MAX_AGE_MS).toBeUndefined();
  });

  it('owner-explicit 2000 is allowed', async () => {
    const parsed = await loadWith({ QUOTE_MAX_AGE_MS: '2000' });
    expect(parsed.QUOTE_MAX_AGE_MS).toBe(2000);
  });

  it('garbage refuses boot (does not invent a freshness window)', async () => {
    await expect(loadWith({ QUOTE_MAX_AGE_MS: 'garbage' })).rejects.toThrow(/QUOTE_MAX_AGE_MS/);
  });

  it('99 refuses boot (below published floor)', async () => {
    await expect(loadWith({ QUOTE_MAX_AGE_MS: '99' })).rejects.toThrow(/QUOTE_MAX_AGE_MS/);
  });
});
