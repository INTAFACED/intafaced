/**
 * Unit card — INDEXER_TX_DROP_WINDOW_SECONDS plumbing (D-explorer-02)
 *
 * 1. Promise: env passes the owner value raw; blank boots but a vanished
 *    pending hash refuses indexer.tx_drop_window_unset; compose interpolates empty.
 * 2. Break: `.default(60)` or `${...:-60}` makes an invented window look chosen.
 * 3. Done bar: the tests below.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INDEXER_TX_DROP_WINDOW_UNSET, parseTxDropWindow } from './tx.js';

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

describe('INDEXER_TX_DROP_WINDOW_SECONDS plumbing', () => {
  it('owner value passes through', async () => {
    const env = await loadWith({ INDEXER_TX_DROP_WINDOW_SECONDS: '120' });
    expect(parseTxDropWindow(env.INDEXER_TX_DROP_WINDOW_SECONDS)).toEqual({ ok: true, seconds: 120 });
  });
  it.each([undefined, ''])('blank/unset %j boots but the decision refuses', async (raw) => {
    const env = await loadWith({ INDEXER_TX_DROP_WINDOW_SECONDS: raw });
    expect(parseTxDropWindow(env.INDEXER_TX_DROP_WINDOW_SECONDS)).toEqual({ ok: false, code: INDEXER_TX_DROP_WINDOW_UNSET });
  });
  it('env.ts has no default and compose interpolates empty', () => {
    expect(readFileSync(join(HERE, '..', 'env.ts'), 'utf8')).not.toMatch(/INDEXER_TX_DROP_WINDOW_SECONDS:[^\n]*\.default\(/);
    const compose = readFileSync(COMPOSE, 'utf8');
    expect(compose).toMatch(/INDEXER_TX_DROP_WINDOW_SECONDS:\s*\$\{INDEXER_TX_DROP_WINDOW_SECONDS:-\}/);
  });
});
