/**
 * Unit card — INDEXER_RPC_URL unset/blank must not invent http://evm:8545 as live
 *
 * 1. Promise: blank/unset INDEXER_RPC_URL refuses boot (typed error).
 *    An operator-set URL (including http://evm:8545) is that endpoint, not an
 *    invented default. This mill does not invent an RPC.
 * 2. Break: z.string().default('') plus compose ${INDEXER_RPC_URL:-http://evm:8545}
 *    stamps a live RPC when the operator never named one — blank host looks live
 *    while env pretended NullChainSource.
 * 3. Done bar: production env.ts loadEnv (not a forked slice) refuses unset
 *    and blank; source has no .default('') and no evm:8545 default; compose
 *    passes INDEXER_RPC_URL with empty default.
 * 4. Class M
 * 5. Paths: env.ts via loadEnv at import (same as boot); docker-compose.apps.yml
 *    svc-indexer block
 * 6. RED: default empty/evm:8545 returns, unset/blank parse as live RPC,
 *    or compose interpolates :-http://evm:8545
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { composeServiceBlock } from '@intafaced/config/compose';

const HERE = dirname(fileURLToPath(import.meta.url));
const SECRET = 's'.repeat(32);
const COMPOSE = resolve(HERE, '../../../docker-compose.apps.yml');
const OWNER_RPC = 'http://evm:8545';
const OTHER_RPC = 'http://127.0.0.1:8545';

const BASE_ENV = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  DATABASE_POOL_MAX: '10',
  EDGE_PRINCIPAL_SECRET: SECRET,
  INDEXER_CHAIN_ID: '1',
  INDEXER_RPC_URL: OTHER_RPC,
  INDEXER_VENUE_ADDRESS: '0x1111111111111111111111111111111111111111',
  INDEXER_START_HEIGHT: '0',
  INDEXER_FINALITY_DEPTH: '64',
  INDEXER_BATCH_SIZE: '200',
};

async function loadWith(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('INDEXER_CHAIN_ID', undefined);
  vi.stubEnv('INDEXER_RPC_URL', undefined);
  vi.stubEnv('INDEXER_VENUE_ADDRESS', undefined);
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

describe('svc-indexer INDEXER_RPC_URL refuse-closed', () => {
  it('env.ts has no empty or evm:8545 git-default', () => {
    const envTs = readFileSync(join(HERE, 'env.ts'), 'utf8');
    expect(envTs).not.toMatch(/INDEXER_RPC_URL:\s*z\.string\(\)\.default\(''\)/);
    expect(envTs).not.toMatch(/INDEXER_RPC_URL:[\s\S]*?\.default\(['"]http:\/\/evm:8545['"]\)/);
    expect(envTs).toMatch(/INDEXER_RPC_URL is unset — will not invent http:\/\/evm:8545 as live/);
  });

  it('compose does not interpolate :-http://evm:8545', () => {
    const compose = readFileSync(COMPOSE, 'utf8');
    const block = composeServiceBlock(compose, 'svc-indexer');
    expect(block).toMatch(/INDEXER_RPC_URL:\s*\$\{INDEXER_RPC_URL:-\}/);
    expect(block).not.toMatch(/INDEXER_RPC_URL:.*evm:8545/);
  });

  it('unset INDEXER_RPC_URL refuses (no silent evm:8545)', async () => {
    await expect(loadWith({ INDEXER_RPC_URL: undefined })).rejects.toThrow(/INDEXER_RPC_URL/);
  });

  it('blank INDEXER_RPC_URL refuses', async () => {
    await expect(loadWith({ INDEXER_RPC_URL: '' })).rejects.toThrow(/INDEXER_RPC_URL/);
  });

  it('whitespace INDEXER_RPC_URL refuses', async () => {
    await expect(loadWith({ INDEXER_RPC_URL: '   ' })).rejects.toThrow(/INDEXER_RPC_URL/);
  });

  it('explicit RPC is operator-set, including http://evm:8545 when named', async () => {
    const local = await loadWith({ INDEXER_RPC_URL: OTHER_RPC });
    expect(local.INDEXER_RPC_URL).toBe(OTHER_RPC);
    const composeEvm = await loadWith({ INDEXER_RPC_URL: OWNER_RPC });
    expect(composeEvm.INDEXER_RPC_URL).toBe(OWNER_RPC);
  });
});
