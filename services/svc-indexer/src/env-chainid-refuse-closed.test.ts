/**
 * Unit card — INDEXER_CHAIN_ID unset/blank must not echo Anvil 31337 as live
 *
 * 1. Promise: blank/unset INDEXER_CHAIN_ID refuses boot (typed error). An
 *    operator-set id (including 31337) is that chain, not an invented default.
 * 2. Break: z.coerce.number().int().positive().default(31337) stamps Anvil
 *    when the operator never named a chain — fixture id looks live.
 *    Compose ${PROTOCOL_CHAIN_ID:-31337} does the same in the fleet.
 * 3. Done bar: production env.ts loadEnv (not a forked slice) refuses unset
 *    and blank; source has no .default(31337); compose passes PROTOCOL_CHAIN_ID
 *    with empty default. Fixture ABI ≠ live CLOB is #3955.
 * 4. Class M
 * 5. Paths: env.ts via loadEnv at import (same as boot); docker-compose.apps.yml
 *    svc-indexer block
 * 6. RED: default 31337 returns, unset parses as 31337, blank parses as 0/31337,
 *    or compose interpolates :-31337
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
  INDEXER_BATCH_SIZE: '200',
};

async function loadWith(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('INDEXER_CHAIN_ID', undefined);
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) {
    vi.stubEnv(key, value);
  }
  const module = await import('./env.js');
  return module.env;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('svc-indexer INDEXER_CHAIN_ID refuse-closed', () => {
  it('env.ts has no Anvil 31337 default', () => {
    const envTs = readFileSync(join(HERE, 'env.ts'), 'utf8');
    expect(envTs).not.toMatch(/INDEXER_CHAIN_ID:[\s\S]*?\.default\(31337\)/);
    expect(envTs).toMatch(/INDEXER_CHAIN_ID is unset — will not echo Anvil 31337 as live/);
  });

  it('compose does not interpolate :-31337', () => {
    const compose = readFileSync(COMPOSE, 'utf8');
    const block = composeServiceBlock(compose, 'svc-indexer');
    expect(block).toMatch(/INDEXER_CHAIN_ID:\s*\$\{PROTOCOL_CHAIN_ID:-\}/);
    expect(block).not.toMatch(/INDEXER_CHAIN_ID:.*31337/);
  });

  it('unset INDEXER_CHAIN_ID refuses (no silent Anvil)', async () => {
    await expect(loadWith({ INDEXER_CHAIN_ID: undefined })).rejects.toThrow(/INDEXER_CHAIN_ID/);
  });

  it('blank INDEXER_CHAIN_ID refuses', async () => {
    await expect(loadWith({ INDEXER_CHAIN_ID: '' })).rejects.toThrow(/INDEXER_CHAIN_ID/);
  });

  it('whitespace INDEXER_CHAIN_ID refuses', async () => {
    await expect(loadWith({ INDEXER_CHAIN_ID: '   ' })).rejects.toThrow(/INDEXER_CHAIN_ID/);
  });

  it('garbage INDEXER_CHAIN_ID refuses', async () => {
    await expect(loadWith({ INDEXER_CHAIN_ID: 'anvil' })).rejects.toThrow(/INDEXER_CHAIN_ID/);
  });

  it('explicit chain id is operator-set, including Anvil when named', async () => {
    const one = await loadWith({ INDEXER_CHAIN_ID: '1' });
    expect(one.INDEXER_CHAIN_ID).toBe(1);
    const anvil = await loadWith({ INDEXER_CHAIN_ID: '31337' });
    expect(anvil.INDEXER_CHAIN_ID).toBe(31337);
  });
});
