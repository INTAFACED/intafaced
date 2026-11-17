/**
 * Unit card — INDEXER_FINALITY_DEPTH unset/blank must not publish prune bound 64
 *
 * 1. Promise: blank/unset INDEXER_FINALITY_DEPTH refuses boot (typed error).
 *    An operator-set depth (including 64) is that prune bound, not an invented
 *    default. This mill does not invent a depth.
 * 2. Break: z.coerce.number().int().min(1).max(10_000).default(64) stamps a
 *    prune horizon when the operator never named one — git-default looks
 *    published. Compose ${INDEXER_FINALITY_DEPTH:-64} does the same in the fleet.
 * 3. Done bar: production env.ts loadEnv (not a forked slice) refuses unset
 *    and blank; source has no .default(64); compose passes INDEXER_FINALITY_DEPTH
 *    with empty default. Named indexer sockets (clob-contracts, indexer-stream,
 *    evm-rpc) are unrelated — this is not a §13 prune socket.
 * 4. Class M
 * 5. Paths: env.ts via loadEnv at import (same as boot); docker-compose.apps.yml
 *    svc-indexer block
 * 6. RED: default 64 returns, unset parses as 64, blank parses as 0/64,
 *    or compose interpolates :-64
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
  INDEXER_FINALITY_DEPTH: '32',
  INDEXER_BATCH_SIZE: '200',
};

async function loadWith(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('INDEXER_CHAIN_ID', undefined);
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

describe('svc-indexer INDEXER_FINALITY_DEPTH refuse-closed', () => {
  it('env.ts has no git-default 64 prune bound', () => {
    const envTs = readFileSync(join(HERE, 'env.ts'), 'utf8');
    expect(envTs).not.toMatch(/INDEXER_FINALITY_DEPTH:[\s\S]*?\.default\(64\)/);
    expect(envTs).toMatch(/INDEXER_FINALITY_DEPTH is unset — will not publish prune bound 64 as live/);
  });

  it('compose does not interpolate :-64', () => {
    const compose = readFileSync(COMPOSE, 'utf8');
    const block = composeServiceBlock(compose, 'svc-indexer');
    expect(block).toMatch(/INDEXER_FINALITY_DEPTH:\s*\$\{INDEXER_FINALITY_DEPTH:-\}/);
    expect(block).not.toMatch(/INDEXER_FINALITY_DEPTH:.*:-64/);
  });

  it('unset INDEXER_FINALITY_DEPTH refuses (no silent prune 64)', async () => {
    await expect(loadWith({ INDEXER_FINALITY_DEPTH: undefined })).rejects.toThrow(/INDEXER_FINALITY_DEPTH/);
  });

  it('blank INDEXER_FINALITY_DEPTH refuses', async () => {
    await expect(loadWith({ INDEXER_FINALITY_DEPTH: '' })).rejects.toThrow(/INDEXER_FINALITY_DEPTH/);
  });

  it('whitespace INDEXER_FINALITY_DEPTH refuses', async () => {
    await expect(loadWith({ INDEXER_FINALITY_DEPTH: '   ' })).rejects.toThrow(/INDEXER_FINALITY_DEPTH/);
  });

  it('garbage INDEXER_FINALITY_DEPTH refuses', async () => {
    await expect(loadWith({ INDEXER_FINALITY_DEPTH: 'deep' })).rejects.toThrow(/INDEXER_FINALITY_DEPTH/);
  });

  it('zero INDEXER_FINALITY_DEPTH refuses', async () => {
    await expect(loadWith({ INDEXER_FINALITY_DEPTH: '0' })).rejects.toThrow(/INDEXER_FINALITY_DEPTH/);
  });

  it('explicit depth is operator-set, including 64 when named', async () => {
    const thirtyTwo = await loadWith({ INDEXER_FINALITY_DEPTH: '32' });
    expect(thirtyTwo.INDEXER_FINALITY_DEPTH).toBe(32);
    const owner64 = await loadWith({ INDEXER_FINALITY_DEPTH: '64' });
    expect(owner64.INDEXER_FINALITY_DEPTH).toBe(64);
  });
});
