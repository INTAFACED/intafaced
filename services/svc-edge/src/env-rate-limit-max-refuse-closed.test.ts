/**
 * Unit card — svc-edge EDGE_RATE_LIMIT_MAX unset refuse (no invented 300)
 *
 * 1. Promise: unset / blank EDGE_RATE_LIMIT_MAX refuses boot (never invent 300).
 *    Owner-explicit 300 is a published cap. WINDOW_MS is a required pair
 *    (see env-rate-limit-window-refuse-closed.test.ts).
 * 2. Break: env.ts `.default(300)` makes a blank host env look published as a
 *    300/min public ceiling (also published via RATE_LIMITS / capabilities).
 * 3. Done bar: production env.ts loadEnv (not a forked slice) refuses unset
 *    and blank; explicit 300 parses; source has no `.default(300)`.
 * 4. Class N
 * 5. Paths: env.ts via loadEnv at import (same as boot)
 * 6. RED: git-default 300 returns, or unset/blank parses as 300
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const SECRET = 's'.repeat(32);

/** Minimum boot env so assertions are about the throttle budget. */
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
 * production `.default(300)` returned.
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

describe('svc-edge EDGE_RATE_LIMIT_MAX refuse-closed', () => {
  it('the loaded env refuses an out-of-range value and keeps an in-range one', async () => {
    for (const refused of ['0', '-1', '2.5', 'many']) {
      await expect(loadWith({ EDGE_RATE_LIMIT_MAX: refused }), refused).rejects.toThrow(/EDGE_RATE_LIMIT_MAX/);
    }
    expect((await loadWith({ EDGE_RATE_LIMIT_MAX: '1' })).EDGE_RATE_LIMIT_MAX).toBe(1);
  });

  it('unset EDGE_RATE_LIMIT_MAX refuses (no invent 300)', async () => {
    await expect(loadWith({ EDGE_RATE_LIMIT_MAX: undefined })).rejects.toThrow(/EDGE_RATE_LIMIT_MAX/);
  });

  it('blank EDGE_RATE_LIMIT_MAX refuses', async () => {
    await expect(loadWith({ EDGE_RATE_LIMIT_MAX: '' })).rejects.toThrow(/EDGE_RATE_LIMIT_MAX/);
  });

  it('explicit 300 is owner-published (not invented)', async () => {
    const parsed = await loadWith({ EDGE_RATE_LIMIT_MAX: '300' });
    expect(parsed.EDGE_RATE_LIMIT_MAX).toBe(300);
  });
});
