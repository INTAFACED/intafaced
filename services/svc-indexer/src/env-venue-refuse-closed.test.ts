/**
 * Unit card — INDEXER_VENUE_ADDRESS unset/blank must not invent fixture CLOB
 *
 * 1. Promise: blank/unset INDEXER_VENUE_ADDRESS refuses boot (typed error).
 *    An operator-set address (including the Anvil fixture 0x0116…) is that
 *    venue, not an invented default. This mill does not invent a CLOB.
 * 2. Break: optional transform to DEV_VENUE_ADDRESS when APP_ENV≠prod stamps
 *    the disposable fixture when the operator never named a venue — fixture
 *    CLOB dressed as live. Prod empty → 0x0 is the same lie with a different
 *    costume.
 * 3. Done bar: production env.ts loadEnv (not a forked slice) refuses unset
 *    and blank; source has no DEV_VENUE_ADDRESS / ZERO_VENUE_ADDRESS fallback;
 *    compose passes INDEXER_VENUE_ADDRESS with empty default.
 * 4. Class M
 * 5. Paths: env.ts via loadEnv at import (same as boot); docker-compose.apps.yml
 *    svc-indexer block
 * 6. RED: default fixture/zero returns, unset/blank parse as 0x0116… or 0x0,
 *    or compose interpolates a venue address
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { composeServiceBlock } from '@intafaced/config/compose';

const HERE = dirname(fileURLToPath(import.meta.url));
const SECRET = 's'.repeat(32);
const COMPOSE = resolve(HERE, '../../../docker-compose.apps.yml');
const FIXTURE = '0x0116686E2291dbd5e317F47faDBFb43B599786Ef';
const OTHER = '0x1111111111111111111111111111111111111111';
const ZERO = '0x0000000000000000000000000000000000000000';

const BASE_ENV = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  DATABASE_POOL_MAX: '10',
  EDGE_PRINCIPAL_SECRET: SECRET,
  INDEXER_CHAIN_ID: '1',
  INDEXER_RPC_URL: 'http://127.0.0.1:8545',
  INDEXER_VENUE_ADDRESS: OTHER,
  INDEXER_START_HEIGHT: '0',
  INDEXER_FINALITY_DEPTH: '64',
  INDEXER_BATCH_SIZE: '200',
};

async function loadWith(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('APP_ENV', undefined);
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

describe('svc-indexer INDEXER_VENUE_ADDRESS refuse-closed', () => {
  it('env.ts has no fixture CLOB or zero-address fallback', () => {
    const envTs = readFileSync(join(HERE, 'env.ts'), 'utf8');
    expect(envTs).not.toMatch(/INDEXER_VENUE_ADDRESS:[\s\S]*?DEV_VENUE_ADDRESS/);
    expect(envTs).not.toMatch(/INDEXER_VENUE_ADDRESS:[\s\S]*?ZERO_VENUE_ADDRESS/);
    expect(envTs).toMatch(
      /INDEXER_VENUE_ADDRESS is unset — will not publish fixture CLOB 0x0116686E2291dbd5e317F47faDBFb43B599786Ef as venue/,
    );
  });

  it('compose empty-passes INDEXER_VENUE_ADDRESS', () => {
    const compose = readFileSync(COMPOSE, 'utf8');
    const block = composeServiceBlock(compose, 'svc-indexer');
    expect(block).toMatch(/INDEXER_VENUE_ADDRESS:\s*\$\{INDEXER_VENUE_ADDRESS:-\}/);
    expect(block).not.toMatch(/INDEXER_VENUE_ADDRESS:.*0x0116/);
  });

  it('unset INDEXER_VENUE_ADDRESS refuses (no silent fixture CLOB)', async () => {
    await expect(loadWith({ INDEXER_VENUE_ADDRESS: undefined })).rejects.toThrow(/INDEXER_VENUE_ADDRESS/);
  });

  it('blank INDEXER_VENUE_ADDRESS refuses', async () => {
    await expect(loadWith({ INDEXER_VENUE_ADDRESS: '' })).rejects.toThrow(/INDEXER_VENUE_ADDRESS/);
  });

  it('whitespace INDEXER_VENUE_ADDRESS refuses', async () => {
    await expect(loadWith({ INDEXER_VENUE_ADDRESS: '   ' })).rejects.toThrow(/INDEXER_VENUE_ADDRESS/);
  });

  it('garbage INDEXER_VENUE_ADDRESS refuses', async () => {
    await expect(loadWith({ INDEXER_VENUE_ADDRESS: 'clob' })).rejects.toThrow(/INDEXER_VENUE_ADDRESS/);
  });

  it('non-prod blank still refuses (no APP_ENV fixture fallthrough)', async () => {
    await expect(loadWith({ APP_ENV: 'dev', INDEXER_VENUE_ADDRESS: '' })).rejects.toThrow(/INDEXER_VENUE_ADDRESS/);
  });

  it('explicit venue is operator-set, including fixture and zero when named', async () => {
    const other = await loadWith({ INDEXER_VENUE_ADDRESS: OTHER });
    expect(other.INDEXER_VENUE_ADDRESS).toBe(OTHER);
    const fixture = await loadWith({ INDEXER_VENUE_ADDRESS: FIXTURE });
    expect(fixture.INDEXER_VENUE_ADDRESS).toBe(FIXTURE);
    const zero = await loadWith({ INDEXER_VENUE_ADDRESS: ZERO });
    expect(zero.INDEXER_VENUE_ADDRESS).toBe(ZERO);
  });
});
