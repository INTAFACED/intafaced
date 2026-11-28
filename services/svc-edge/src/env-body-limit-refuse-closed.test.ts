/**
 * Unit card — svc-edge EDGE_BODY_LIMIT_BYTES unset refuse (no invented 1048576)
 *
 * 1. Promise: unset / blank EDGE_BODY_LIMIT_BYTES refuses boot (never invent
 *    1048576). Owner-explicit 1048576 is a published ceiling.
 * 2. Break: env.ts `.default(1_048_576)` / compose `:-1048576` makes a blank
 *    host env look published as a 1 MiB public body budget.
 * 3. Done bar: production env.ts loadEnv (not a forked slice) refuses unset
 *    and blank; explicit 1048576 parses; source has no `.default(1_048_576)`.
 * 4. Class N
 * 5. Paths: env.ts via loadEnv at import (same as boot)
 * 6. RED: git-default 1048576 returns, or unset/blank parses as 1048576
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const SECRET = 's'.repeat(32);

/** Minimum boot env so assertions are about the body budget. */
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
 * production `.default(1_048_576)` returned.
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

describe('svc-edge EDGE_BODY_LIMIT_BYTES refuse-closed', () => {
  it('the loaded env refuses an out-of-range value and keeps an in-range one', async () => {
    for (const refused of ['1023', '33554433', '1048576.5', '1mb']) {
      await expect(loadWith({ EDGE_BODY_LIMIT_BYTES: refused }), refused).rejects.toThrow(/EDGE_BODY_LIMIT_BYTES/);
    }
    expect((await loadWith({ EDGE_BODY_LIMIT_BYTES: '1024' })).EDGE_BODY_LIMIT_BYTES).toBe(1024);
    expect((await loadWith({ EDGE_BODY_LIMIT_BYTES: '33554432' })).EDGE_BODY_LIMIT_BYTES).toBe(32 * 1024 * 1024);
  });

  it('unset EDGE_BODY_LIMIT_BYTES refuses (no invent 1048576)', async () => {
    await expect(loadWith({ EDGE_BODY_LIMIT_BYTES: undefined })).rejects.toThrow(/EDGE_BODY_LIMIT_BYTES/);
  });

  it('blank EDGE_BODY_LIMIT_BYTES refuses', async () => {
    await expect(loadWith({ EDGE_BODY_LIMIT_BYTES: '' })).rejects.toThrow(/EDGE_BODY_LIMIT_BYTES/);
  });

  it('explicit 1048576 is owner-published (not invented)', async () => {
    const parsed = await loadWith({ EDGE_BODY_LIMIT_BYTES: '1048576' });
    expect(parsed.EDGE_BODY_LIMIT_BYTES).toBe(1_048_576);
  });
});
