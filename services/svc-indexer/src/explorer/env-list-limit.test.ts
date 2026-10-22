/**
 * Unit card — INDEXER_EXPLORER_LIST_LIMIT plumbing (D-explorer-01)
 *
 * 1. Promise: env passes the owner value raw; blank/unset boots but the list
 *    refuses `indexer.explorer_list_limit_unset`; compose has an empty default.
 * 2. Break: `.default(50)` or `${...:-50}` makes an invented page size look chosen.
 * 3. Done bar: the tests below.
 * 4. Class M
 * 5. Paths: env.ts, docker-compose.apps.yml svc-indexer block
 * 6. RED: env key absent.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INDEXER_EXPLORER_LIST_LIMIT_UNSET, parseExplorerListLimit } from './blocks.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SECRET = 's'.repeat(32);
const COMPOSE = resolve(HERE, '../../../../docker-compose.apps.yml');

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
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) vi.stubEnv(key, value);
  return (await import('../env.js')).env;
}

afterEach(() => vi.unstubAllEnvs());

describe('INDEXER_EXPLORER_LIST_LIMIT plumbing', () => {
  it('owner value passes through and is served', async () => {
    const env = await loadWith({ INDEXER_EXPLORER_LIST_LIMIT: '25' });
    expect(parseExplorerListLimit(env.INDEXER_EXPLORER_LIST_LIMIT)).toEqual({ ok: true, limit: 25 });
  });
  it.each([undefined, ''])('blank/unset %j boots but the list refuses', async (raw) => {
    const env = await loadWith({ INDEXER_EXPLORER_LIST_LIMIT: raw });
    expect(parseExplorerListLimit(env.INDEXER_EXPLORER_LIST_LIMIT)).toEqual({ ok: false, code: INDEXER_EXPLORER_LIST_LIMIT_UNSET });
  });
  it('env.ts has no default and compose interpolates empty', () => {
    expect(readFileSync(join(HERE, '..', 'env.ts'), 'utf8')).not.toMatch(/INDEXER_EXPLORER_LIST_LIMIT:[^\n]*\.default\(/);
    const compose = readFileSync(COMPOSE, 'utf8');
    expect(compose).toMatch(/INDEXER_EXPLORER_LIST_LIMIT:\s*\$\{INDEXER_EXPLORER_LIST_LIMIT:-\}/);
  });
});
