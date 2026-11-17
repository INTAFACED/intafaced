/**
 * Unit card — INDEXER_START_HEIGHT unset/blank must not publish genesis-0 as
 * the venue deployment block
 *
 * 1. Promise: blank/unset INDEXER_START_HEIGHT refuses boot (typed error).
 *    An operator-set height (including 0 for anvil) is that start, not an
 *    invented default. This mill does not invent a height.
 * 2. Break: z.coerce.number().int().min(0).default(0) stamps genesis when the
 *    operator never named a deploy block — git-default looks published.
 *    Compose ${INDEXER_START_HEIGHT:-0} does the same in the fleet.
 * 3. Done bar: production env.ts loadEnv (not a forked slice) refuses unset
 *    and blank; source has no .default(0); compose passes INDEXER_START_HEIGHT
 *    with empty default.
 * 4. Class M
 * 5. Paths: env.ts via loadEnv at import (same as boot); docker-compose.apps.yml
 *    svc-indexer block
 * 6. RED: default 0 returns, unset parses as 0, blank parses as 0,
 *    or compose interpolates :-0
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { composeServiceBlock } from '@intafaced/config/compose';

const HERE = dirname(fileURLToPath(import.meta.url));
const SECRET = 's'.repeat(32);
const COMPOSE = resolve(HERE, '../../../docker-compose.apps.yml');

const BASE_ENV = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  DATABASE_POOL_MAX: '10',
  EDGE_PRINCIPAL_SECRET: SECRET,
  INDEXER_CHAIN_ID: '1',
  INDEXER_RPC_URL: 'http://127.0.0.1:8545',
  INDEXER_VENUE_ADDRESS: '0x1111111111111111111111111111111111111111',
  INDEXER_START_HEIGHT: '5',
  INDEXER_FINALITY_DEPTH: '64',
  INDEXER_BATCH_SIZE: '200',
};

async function loadWith(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('INDEXER_CHAIN_ID', undefined);
  vi.stubEnv('INDEXER_START_HEIGHT', undefined);
  vi.stubEnv('INDEXER_FINALITY_DEPTH', undefined);
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) {
    vi.stubEnv(key, value);
  }
  const module = await import('./env.js');
  return module.env;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('svc-indexer INDEXER_START_HEIGHT refuse-closed', () => {
  it('env.ts has no git-default 0 deploy block', () => {
    const envTs = readFileSync(join(HERE, 'env.ts'), 'utf8');
    expect(envTs).not.toMatch(/INDEXER_START_HEIGHT:[\s\S]*?\.default\(0\)/);
    expect(envTs).toMatch(/INDEXER_START_HEIGHT is unset — will not publish genesis-0 as the venue deployment block/);
  });

  it('compose does not interpolate :-0', () => {
    const compose = readFileSync(COMPOSE, 'utf8');
    const block = composeServiceBlock(compose, 'svc-indexer');
    expect(block).toMatch(/INDEXER_START_HEIGHT:\s*\$\{INDEXER_START_HEIGHT:-\}/);
    expect(block).not.toMatch(/INDEXER_START_HEIGHT:.*:-0/);
  });

  it('unset INDEXER_START_HEIGHT refuses (no silent genesis-0)', async () => {
    await expect(loadWith({ INDEXER_START_HEIGHT: undefined })).rejects.toThrow(/INDEXER_START_HEIGHT/);
  });

  it('blank INDEXER_START_HEIGHT refuses', async () => {
    await expect(loadWith({ INDEXER_START_HEIGHT: '' })).rejects.toThrow(/INDEXER_START_HEIGHT/);
  });

  it('whitespace INDEXER_START_HEIGHT refuses', async () => {
    await expect(loadWith({ INDEXER_START_HEIGHT: '   ' })).rejects.toThrow(/INDEXER_START_HEIGHT/);
  });

  it('garbage INDEXER_START_HEIGHT refuses', async () => {
    await expect(loadWith({ INDEXER_START_HEIGHT: 'genesis' })).rejects.toThrow(/INDEXER_START_HEIGHT/);
  });

  it('negative INDEXER_START_HEIGHT refuses', async () => {
    await expect(loadWith({ INDEXER_START_HEIGHT: '-1' })).rejects.toThrow(/INDEXER_START_HEIGHT/);
  });

  it('explicit height is operator-set, including 0 when named', async () => {
    const five = await loadWith({ INDEXER_START_HEIGHT: '5' });
    expect(five.INDEXER_START_HEIGHT).toBe(5);
    const anvilZero = await loadWith({ INDEXER_START_HEIGHT: '0' });
    expect(anvilZero.INDEXER_START_HEIGHT).toBe(0);
  });
});
