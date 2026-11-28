import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadEdgeEnv } from './testing/env-load-fixture.js';

/**
 * Blast-radius pin: the internet-facing process must not accept secrets that
 * would let a compromised edge call the money plane or open a data store.
 *
 * Nothing used to assert this. The property held only because a human reading
 * `env.ts` noticed the omissions — and a future merge could silently add
 * `INTERNAL_SERVICE_SECRET` without a failing suite (audit 2026-08-08).
 *
 * Each test loads the real `env.ts` the way the process does, with the host env
 * it names, and reads what the process would hold.
 */

const FORBIDDEN = {
  DATABASE_URL: 'postgres://edge:edge@127.0.0.1:5432/edge',
  NATS_URL: 'nats://127.0.0.1:4222',
  INTERNAL_SERVICE_SECRET: 'internal-service-secret-the-edge-must-not-hold',
};
const OWNERSHIP = 'identity-ownership-secret-at-least-32-chars';

afterEach(() => vi.unstubAllEnvs());

describe('svc-edge env schema blast radius', () => {
  it('does not accept DATABASE_URL, NATS_URL, or INTERNAL_SERVICE_SECRET', async () => {
    // Set in the host env, none of them reaches the process: the schema has no key for them.
    const env = await loadEdgeEnv(FORBIDDEN);
    for (const key of Object.keys(FORBIDDEN)) expect(env, key).not.toHaveProperty(key);
    expect(Object.values(env)).not.toContain(FORBIDDEN.INTERNAL_SERVICE_SECRET);
  });

  it('exposes EDGE_BODY_LIMIT_BYTES so the budget is operator-visible', async () => {
    expect((await loadEdgeEnv({ EDGE_BODY_LIMIT_BYTES: '2097152' })).EDGE_BODY_LIMIT_BYTES).toBe(2_097_152);
  });

  it('does not git-default EDGE_BODY_LIMIT_BYTES to 1048576', async () => {
    for (const blank of [undefined, '']) {
      await expect(loadEdgeEnv({ EDGE_BODY_LIMIT_BYTES: blank })).rejects.toThrow(/EDGE_BODY_LIMIT_BYTES/);
    }
    await expect(loadEdgeEnv({ EDGE_BODY_LIMIT_BYTES: '1023' })).rejects.toThrow(/EDGE_BODY_LIMIT_BYTES/);
    await expect(loadEdgeEnv({ EDGE_BODY_LIMIT_BYTES: String(32 * 1024 * 1024 + 1) })).rejects.toThrow(/EDGE_BODY_LIMIT_BYTES/);
    expect((await loadEdgeEnv({ EDGE_BODY_LIMIT_BYTES: '1024' })).EDGE_BODY_LIMIT_BYTES).toBe(1024);
  });

  it('may hold IDENTITY_OWNERSHIP_SECRET for session live-check, never INTERNAL_SERVICE_SECRET', async () => {
    const env = await loadEdgeEnv({ ...FORBIDDEN, IDENTITY_OWNERSHIP_SECRET: OWNERSHIP });
    expect(env.IDENTITY_OWNERSHIP_SECRET).toBe(OWNERSHIP);
    expect(env).not.toHaveProperty('INTERNAL_SERVICE_SECRET');
    expect((await loadEdgeEnv()).IDENTITY_OWNERSHIP_SECRET).toBeUndefined();
    await expect(loadEdgeEnv({ IDENTITY_OWNERSHIP_SECRET: 'too-short' })).rejects.toThrow(/IDENTITY_OWNERSHIP_SECRET/);
  });

  it('may hold MATCHING_URL for halt-all consume, never INTERNAL_SERVICE_SECRET', async () => {
    const env = await loadEdgeEnv({ ...FORBIDDEN, MATCHING_URL: 'http://svc-matching:4020' });
    expect(env.MATCHING_URL).toBe('http://svc-matching:4020');
    expect(env).not.toHaveProperty('INTERNAL_SERVICE_SECRET');
    expect((await loadEdgeEnv()).MATCHING_URL).toBeUndefined();
  });

  it('does not git-default EDGE_RATE_LIMIT_MAX to 300', async () => {
    await expect(loadEdgeEnv({ EDGE_RATE_LIMIT_MAX: undefined })).rejects.toThrow(/EDGE_RATE_LIMIT_MAX/);
    await expect(loadEdgeEnv({ EDGE_RATE_LIMIT_MAX: '0' })).rejects.toThrow(/EDGE_RATE_LIMIT_MAX/);
    expect((await loadEdgeEnv({ EDGE_RATE_LIMIT_MAX: '1' })).EDGE_RATE_LIMIT_MAX).toBe(1);
  });

  it('does not git-default EDGE_RATE_LIMIT_WINDOW_MS to 60000', async () => {
    await expect(loadEdgeEnv({ EDGE_RATE_LIMIT_WINDOW_MS: undefined })).rejects.toThrow(/EDGE_RATE_LIMIT_WINDOW_MS/);
    await expect(loadEdgeEnv({ EDGE_RATE_LIMIT_WINDOW_MS: '999' })).rejects.toThrow(/EDGE_RATE_LIMIT_WINDOW_MS/);
    await expect(loadEdgeEnv({ EDGE_RATE_LIMIT_WINDOW_MS: '3600001' })).rejects.toThrow(/EDGE_RATE_LIMIT_WINDOW_MS/);
    expect((await loadEdgeEnv({ EDGE_RATE_LIMIT_WINDOW_MS: '3600000' })).EDGE_RATE_LIMIT_WINDOW_MS).toBe(3_600_000);
  });
});
