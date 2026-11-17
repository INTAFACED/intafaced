/**
 * Unit card — INDEXER_BATCH_SIZE unset/blank must not publish blocks-per-pass 200
 *
 * 1. Promise: blank/unset INDEXER_BATCH_SIZE refuses boot (typed error).
 *    An operator-set size (including 200) is that pass bound, not an invented
 *    default. This mill does not invent a batch size.
 * 2. Break: z.coerce.number().int().min(1).max(10_000).default(200) stamps a
 *    blocks-per-pass bound when the operator never named one — git-default
 *    looks published. Compose ${INDEXER_BATCH_SIZE:-200} does the same in the fleet.
 * 3. Done bar: production env.ts loadEnv (not a forked slice) refuses unset
 *    and blank; source has no .default(200); compose passes INDEXER_BATCH_SIZE
 *    with empty default.
 * 4. Class M
 * 5. Paths: env.ts via loadEnv at import (same as boot); docker-compose.apps.yml
 *    svc-indexer block
 * 6. RED: default 200 returns, unset parses as 200, blank parses as 0/200,
 *    or compose interpolates :-200
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
  INDEXER_START_HEIGHT: '0',
  INDEXER_FINALITY_DEPTH: '64',
  INDEXER_BATCH_SIZE: '50',
};

async function loadWith(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('INDEXER_CHAIN_ID', undefined);
  vi.stubEnv('INDEXER_START_HEIGHT', undefined);
  vi.stubEnv('INDEXER_FINALITY_DEPTH', undefined);
  vi.stubEnv('INDEXER_BATCH_SIZE', undefined);
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) {
    vi.stubEnv(key, value);
  }
  const module = await import('./env.js');
  return module.env;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('svc-indexer INDEXER_BATCH_SIZE refuse-closed', () => {
  it('env.ts has no git-default 200 blocks-per-pass', () => {
    const envTs = readFileSync(join(HERE, 'env.ts'), 'utf8');
    expect(envTs).not.toMatch(/INDEXER_BATCH_SIZE:[\s\S]*?\.default\(200\)/);
    expect(envTs).toMatch(/INDEXER_BATCH_SIZE is unset — will not publish blocks-per-pass 200 as live/);
  });

  it('compose does not interpolate :-200', () => {
    const compose = readFileSync(COMPOSE, 'utf8');
    const block = composeServiceBlock(compose, 'svc-indexer');
    expect(block).toMatch(/INDEXER_BATCH_SIZE:\s*\$\{INDEXER_BATCH_SIZE:-\}/);
    expect(block).not.toMatch(/INDEXER_BATCH_SIZE:.*:-200/);
  });

  it('unset INDEXER_BATCH_SIZE refuses (no silent blocks-per-pass 200)', async () => {
    await expect(loadWith({ INDEXER_BATCH_SIZE: undefined })).rejects.toThrow(/INDEXER_BATCH_SIZE/);
  });

  it('blank INDEXER_BATCH_SIZE refuses', async () => {
    await expect(loadWith({ INDEXER_BATCH_SIZE: '' })).rejects.toThrow(/INDEXER_BATCH_SIZE/);
  });

  it('whitespace INDEXER_BATCH_SIZE refuses', async () => {
    await expect(loadWith({ INDEXER_BATCH_SIZE: '   ' })).rejects.toThrow(/INDEXER_BATCH_SIZE/);
  });

  it('garbage INDEXER_BATCH_SIZE refuses', async () => {
    await expect(loadWith({ INDEXER_BATCH_SIZE: 'all' })).rejects.toThrow(/INDEXER_BATCH_SIZE/);
  });

  it('zero INDEXER_BATCH_SIZE refuses', async () => {
    await expect(loadWith({ INDEXER_BATCH_SIZE: '0' })).rejects.toThrow(/INDEXER_BATCH_SIZE/);
  });

  it('explicit size is operator-set, including 200 when named', async () => {
    const fifty = await loadWith({ INDEXER_BATCH_SIZE: '50' });
    expect(fifty.INDEXER_BATCH_SIZE).toBe(50);
    const owner200 = await loadWith({ INDEXER_BATCH_SIZE: '200' });
    expect(owner200.INDEXER_BATCH_SIZE).toBe(200);
  });
});
