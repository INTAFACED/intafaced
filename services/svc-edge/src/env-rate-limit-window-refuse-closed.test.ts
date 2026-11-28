/**
 * Unit card — svc-edge EDGE_RATE_LIMIT_WINDOW_MS unset refuse (no invented 60000)
 *
 * 1. Promise: unset / blank EDGE_RATE_LIMIT_WINDOW_MS refuses boot (never invent
 *    60000). Owner-explicit 60000 is a published window. Pair with MAX: both
 *    required, neither invented.
 * 2. Break: env.ts `.default(60_000)` / compose `:-60000` makes a blank host
 *    env look published as a 60s stuffing interval next to a refuse-closed max.
 * 3. Done bar: production env.ts loadEnv (not a forked slice) refuses unset
 *    and blank; explicit 60000 parses; source has no `.default(60_000)`.
 * 4. Class N
 * 5. Paths: env.ts via loadEnv at import (same as boot)
 * 6. RED: git-default 60000 returns, or unset/blank parses as 60000
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const SECRET = 's'.repeat(32);

/** Minimum boot env so assertions are about the throttle window. */
const BASE_ENV = {
  JWT_ACCESS_SECRET: SECRET,
  EDGE_PRINCIPAL_SECRET: SECRET,
  EDGE_RATE_LIMIT_MAX: '300',
  EDGE_RATE_LIMIT_WINDOW_MS: '60000',
  EDGE_BODY_LIMIT_BYTES: '1048576',
};

/**
 * Load production env.ts the way the process does.
 *
 * `vi.resetModules` + explicit clears are load-bearing: env.ts calls
 * `loadEnv(process.env)` at import. A forked Zod slice would stay green if
 * production `.default(60_000)` returned.
 */
async function loadWith(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('EDGE_RATE_LIMIT_MAX', undefined);
  vi.stubEnv('EDGE_RATE_LIMIT_WINDOW_MS', undefined);
  vi.stubEnv('EDGE_BODY_LIMIT_BYTES', undefined);
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) {
    vi.stubEnv(key, value);
  }
  const module = await import('./env.js');
  return module.env;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('svc-edge EDGE_RATE_LIMIT_WINDOW_MS refuse-closed', () => {
  it('the loaded env refuses an out-of-range value and keeps an in-range one', async () => {
    for (const refused of ['999', '3600001', '60000.5', 'a minute']) {
      await expect(loadWith({ EDGE_RATE_LIMIT_WINDOW_MS: refused }), refused).rejects.toThrow(/EDGE_RATE_LIMIT_WINDOW_MS/);
    }
    expect((await loadWith({ EDGE_RATE_LIMIT_WINDOW_MS: '1000' })).EDGE_RATE_LIMIT_WINDOW_MS).toBe(1000);
    expect((await loadWith({ EDGE_RATE_LIMIT_WINDOW_MS: '3600000' })).EDGE_RATE_LIMIT_WINDOW_MS).toBe(3_600_000);
  });

  it('unset EDGE_RATE_LIMIT_WINDOW_MS refuses (no invent 60000)', async () => {
    await expect(loadWith({ EDGE_RATE_LIMIT_WINDOW_MS: undefined })).rejects.toThrow(/EDGE_RATE_LIMIT_WINDOW_MS/);
  });

  it('blank EDGE_RATE_LIMIT_WINDOW_MS refuses', async () => {
    await expect(loadWith({ EDGE_RATE_LIMIT_WINDOW_MS: '' })).rejects.toThrow(/EDGE_RATE_LIMIT_WINDOW_MS/);
  });

  it('explicit 60000 is owner-published (not invented)', async () => {
    const parsed = await loadWith({ EDGE_RATE_LIMIT_WINDOW_MS: '60000' });
    expect(parsed.EDGE_RATE_LIMIT_WINDOW_MS).toBe(60_000);
  });
});
