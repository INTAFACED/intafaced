/**
 * Unit card — compose stack passes emissions kill + auto-tick into svc-token
 *
 * 1. Promise: host `.env` can kill minting and keep auto-tick OFF in the live
 *    container (env.ts already declares EMISSIONS_ENABLED / AUTO_TICK / TICK_MS).
 * 2. Break: compose booted token with only TOKEN_ASSET_ID → operator flags are
 *    a no-op and the container keeps schema defaults forever.
 * 3. Done bar: docker-compose.apps.yml svc-token has
 *    EMISSIONS_ENABLED: ${EMISSIONS_ENABLED:-true}
 *    EMISSIONS_EPOCH_MS: ${EMISSIONS_EPOCH_MS:-86400000}   (owner-present 1 day, 2026-10-14)
 *    EMISSIONS_AUTO_TICK: ${EMISSIONS_AUTO_TICK:-false}
 *    EMISSIONS_TICK_MS: ${EMISSIONS_TICK_MS:-}
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-token block only)
 * 6. RED: pin fails if any unique key drops, AUTO_TICK default flips true,
 *    or YIELD_DISTRIBUTION_CRON_HOURS is invented on this block
 * 7. Collision: other compose PRs — this pin only reads svc-token
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { composeServiceBlock } from '@intafaced/config/compose';

const COMPOSE = resolve(import.meta.dirname, '../../../docker-compose.apps.yml');

const REQUIRED: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://pin:pin@127.0.0.1:9/pin',
  DATABASE_POOL_MAX: '1',
  EDGE_PRINCIPAL_SECRET: 'svc-token-env-pin-edge-secret-00000000001',
  INTERNAL_SERVICE_SECRET: 'svc-token-env-pin-internal-secret-000001',
};

/** svc-token's own env loader, run fresh with exactly these variables over the required ones. */
async function loadTokenEnv(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const [key, value] of Object.entries({ ...REQUIRED, ...overrides })) vi.stubEnv(key, value);
  const module = await import('./env.js');
  return module.env;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

function tokenServiceBlock(source: string): string {
  return composeServiceBlock(source, 'svc-token');
}

const ENABLED = /EMISSIONS_ENABLED:\s*\$\{EMISSIONS_ENABLED:-true\}/;
const AUTO_TICK = /EMISSIONS_AUTO_TICK:\s*\$\{EMISSIONS_AUTO_TICK:-false\}/;
const EPOCH_MS = /EMISSIONS_EPOCH_MS:\s*\$\{EMISSIONS_EPOCH_MS:-86400000\}/;
const TICK_MS = /EMISSIONS_TICK_MS:\s*\$\{EMISSIONS_TICK_MS:-\}/;

describe('compose emissions kill and auto-tick for svc-token', () => {
  const block = tokenServiceBlock(readFileSync(COMPOSE, 'utf8'));

  it('the env loader defaults the flags this pin tracks: kill on, auto-tick, yield and buyback off, one-day epoch, no tick or cron', async () => {
    const unset = await loadTokenEnv({
      EMISSIONS_ENABLED: undefined,
      EMISSIONS_AUTO_TICK: undefined,
      EMISSIONS_EPOCH_MS: undefined,
      EMISSIONS_TICK_MS: undefined,
      YIELD_JOB_ENABLED: undefined,
      YIELD_DISTRIBUTION_CRON_HOURS: undefined,
      BUYBACK_JOB_ENABLED: undefined,
    });
    expect(unset.EMISSIONS_ENABLED).toBe(true);
    expect(unset.EMISSIONS_AUTO_TICK).toBe(false);
    // Owner-present 1 day (Nitro, 2026-10-14) is the ONLY emission magnitude defaulted here.
    expect(unset.EMISSIONS_EPOCH_MS).toBe(86_400_000);
    expect(unset.EMISSIONS_TICK_MS).toBeUndefined();
    expect(unset.YIELD_JOB_ENABLED).toBe(false);
    expect(unset.YIELD_DISTRIBUTION_CRON_HOURS).toBeUndefined();
    expect(unset.BUYBACK_JOB_ENABLED).toBe(false);

    // A blank compose pass-through is "not set", not 0; a host value is used as given.
    expect((await loadTokenEnv({ EMISSIONS_EPOCH_MS: '' })).EMISSIONS_EPOCH_MS).toBe(86_400_000);
    await expect(loadTokenEnv({ EMISSIONS_EPOCH_MS: '0' })).rejects.toThrow(/EMISSIONS_EPOCH_MS/);
    const set = await loadTokenEnv({
      EMISSIONS_ENABLED: 'false',
      EMISSIONS_AUTO_TICK: 'true',
      EMISSIONS_EPOCH_MS: '3600000',
      EMISSIONS_TICK_MS: '60000',
      YIELD_JOB_ENABLED: 'on',
      YIELD_DISTRIBUTION_CRON_HOURS: '168',
      BUYBACK_JOB_ENABLED: 'yes',
    });
    expect(set).toMatchObject({
      EMISSIONS_ENABLED: false,
      EMISSIONS_AUTO_TICK: true,
      EMISSIONS_EPOCH_MS: 3_600_000,
      EMISSIONS_TICK_MS: '60000',
      YIELD_JOB_ENABLED: true,
      YIELD_DISTRIBUTION_CRON_HOURS: '168',
      BUYBACK_JOB_ENABLED: true,
    });
  });

  it('wires unique host pass-through keys (auto-tick default false)', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-token/);
    expect(block).toMatch(ENABLED);
    expect(block).toMatch(AUTO_TICK);
    expect(block).toMatch(TICK_MS);
    expect(block).toMatch(EPOCH_MS);
    expect(block.match(/^\s+EMISSIONS_EPOCH_MS:\s*\$\{EMISSIONS_EPOCH_MS:-86400000\}\s*$/gm)).toHaveLength(1);
    expect(block.match(/^\s+EMISSIONS_ENABLED:\s*\$\{EMISSIONS_ENABLED:-true\}\s*$/gm)).toHaveLength(1);
    expect(block.match(/^\s+EMISSIONS_AUTO_TICK:\s*\$\{EMISSIONS_AUTO_TICK:-false\}\s*$/gm)).toHaveLength(1);
    expect(block.match(/^\s+EMISSIONS_TICK_MS:\s*\$\{EMISSIONS_TICK_MS:-\}\s*$/gm)).toHaveLength(1);
    expect(block).not.toMatch(/EMISSIONS_TICK_MS:\s*\$\{EMISSIONS_TICK_MS:-86400000\}/);
    expect(block).not.toMatch(/EMISSIONS_AUTO_TICK:\s*\$\{EMISSIONS_AUTO_TICK:-true\}/);
  });

  it('does not open yield cron or invent a curve on the compose block', () => {
    expect(block).toMatch(/YIELD_JOB_ENABLED:\s*\$\{YIELD_JOB_ENABLED:-false\}/);
    expect(block).not.toMatch(/YIELD_JOB_ENABLED:\s*\$\{YIELD_JOB_ENABLED:-true\}/);
    expect(block).toMatch(/BUYBACK_JOB_ENABLED:\s*\$\{BUYBACK_JOB_ENABLED:-false\}/);
    expect(block).not.toMatch(/BUYBACK_JOB_ENABLED:\s*\$\{BUYBACK_JOB_ENABLED:-true\}/);
    expect(block).toMatch(/TRADE_URL:\s*http:\/\/svc-trade:4004/);
    expect(block).not.toMatch(/^\s+YIELD_DISTRIBUTION_CRON_HOURS:/m);
    expect(block).not.toMatch(/HALVING/i);
    expect(block).not.toMatch(/MINTER_ADDRESS/i);
  });
});
