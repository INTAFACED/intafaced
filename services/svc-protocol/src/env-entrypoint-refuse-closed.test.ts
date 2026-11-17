/**
 * Unit card — PROTOCOL_ENTRYPOINT_ADDRESS unset/blank must not invent Ethereum EntryPoint
 *
 * 1. Promise: blank/unset PROTOCOL_ENTRYPOINT_ADDRESS refuses boot (typed
 *    error). An operator-set address (including Ethereum's v0.7 singleton) is
 *    that venue's EntryPoint, not an invented default.
 * 2. Break: evmAddress.default('0x0000000071727De22E5E9d8BAf0edAc6f37da032')
 *    stamps Ethereum's EntryPoint when the operator never named one —
 *    unpublished looks live. Compose ${PROTOCOL_ENTRYPOINT_ADDRESS:-0x0000…032}
 *    does the same in the fleet.
 * 3. Done bar: production env.ts loadEnv (not a forked slice) refuses unset
 *    and blank; source has no .default(canonical EntryPoint); compose passes
 *    PROTOCOL_ENTRYPOINT_ADDRESS with empty default. Other protocol addrs stay
 *    0x0/unset defaults.
 * 4. Class M
 * 5. Paths: env.ts via loadEnv at import (same as boot); docker-compose.apps.yml
 *    svc-protocol block
 * 6. RED: default canonical returns, unset/blank parse as Ethereum EntryPoint,
 *    or compose interpolates :-0x0000000071727De22E5E9d8BAf0edAc6f37da032
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { composeServiceBlock } from '@intafaced/config/compose';

const HERE = dirname(fileURLToPath(import.meta.url));
const SECRET = 's'.repeat(32);
const COMPOSE = resolve(HERE, '../../../docker-compose.apps.yml');
const CANONICAL = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
const OTHER = '0x1111111111111111111111111111111111111111';

const BASE_ENV = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  DATABASE_POOL_MAX: '10',
  EDGE_PRINCIPAL_SECRET: SECRET,
  PROTOCOL_CHAIN_ID: '1',
  PROTOCOL_RPC_URL: 'http://127.0.0.1:8545',
  PROTOCOL_ENTRYPOINT_ADDRESS: CANONICAL,
};

async function loadWith(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('PROTOCOL_CHAIN_ID', undefined);
  vi.stubEnv('PROTOCOL_RPC_URL', undefined);
  vi.stubEnv('PROTOCOL_ENTRYPOINT_ADDRESS', undefined);
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) {
    vi.stubEnv(key, value);
  }
  const module = await import('./env.js');
  return module.env;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('svc-protocol PROTOCOL_ENTRYPOINT_ADDRESS refuse-closed', () => {
  it('env.ts has no canonical Ethereum EntryPoint default', () => {
    const envTs = readFileSync(join(HERE, 'env.ts'), 'utf8');
    expect(envTs).not.toMatch(/PROTOCOL_ENTRYPOINT_ADDRESS:[\s\S]*?\.default\(\s*'0x0000000071727De22E5E9d8BAf0edAc6f37da032'\s*\)/);
    expect(envTs).toMatch(
      /PROTOCOL_ENTRYPOINT_ADDRESS is unset — will not publish Ethereum EntryPoint 0x0000000071727De22E5E9d8BAf0edAc6f37da032 as this venue/,
    );
  });

  it('compose empty-passes PROTOCOL_ENTRYPOINT_ADDRESS on svc-protocol', () => {
    const compose = readFileSync(COMPOSE, 'utf8');
    const block = composeServiceBlock(compose, 'svc-protocol');
    expect(block).toMatch(/PROTOCOL_ENTRYPOINT_ADDRESS:\s*\$\{PROTOCOL_ENTRYPOINT_ADDRESS:-\}/);
    expect(block).not.toMatch(/PROTOCOL_ENTRYPOINT_ADDRESS:.*0x0000000071727De22E5E9d8BAf0edAc6f37da032/);
  });

  it('other protocol addresses keep 0x0 defaults', () => {
    const envTs = readFileSync(join(HERE, 'env.ts'), 'utf8');
    expect(envTs).toMatch(/evmAddress\.default\('0x0000000000000000000000000000000000000000'\)/);
    expect(envTs).toMatch(/PROTOCOL_FACTORY_ADDRESS: evmAddressDefaultZero/);
    expect(envTs).toMatch(/PROTOCOL_IMPLEMENTATION_ADDRESS: evmAddressDefaultZero/);
    expect(envTs).toMatch(/PROTOCOL_AMM_FACTORY_ADDRESS: evmAddressDefaultZero/);
    expect(envTs).toMatch(/PROTOCOL_TOKEN_FACTORY_ADDRESS: evmAddressDefaultZero/);
  });

  it('unset PROTOCOL_ENTRYPOINT_ADDRESS refuses (no silent Ethereum EntryPoint)', async () => {
    await expect(loadWith({ PROTOCOL_ENTRYPOINT_ADDRESS: undefined })).rejects.toThrow(/PROTOCOL_ENTRYPOINT_ADDRESS/);
  });

  it('blank PROTOCOL_ENTRYPOINT_ADDRESS refuses', async () => {
    await expect(loadWith({ PROTOCOL_ENTRYPOINT_ADDRESS: '' })).rejects.toThrow(/PROTOCOL_ENTRYPOINT_ADDRESS/);
  });

  it('whitespace PROTOCOL_ENTRYPOINT_ADDRESS refuses', async () => {
    await expect(loadWith({ PROTOCOL_ENTRYPOINT_ADDRESS: '   ' })).rejects.toThrow(/PROTOCOL_ENTRYPOINT_ADDRESS/);
  });

  it('garbage PROTOCOL_ENTRYPOINT_ADDRESS refuses', async () => {
    await expect(loadWith({ PROTOCOL_ENTRYPOINT_ADDRESS: 'entrypoint' })).rejects.toThrow(/PROTOCOL_ENTRYPOINT_ADDRESS/);
  });

  it('explicit EntryPoint is operator-set, including Ethereum v0.7 when named', async () => {
    const canonical = await loadWith({ PROTOCOL_ENTRYPOINT_ADDRESS: CANONICAL });
    expect(canonical.PROTOCOL_ENTRYPOINT_ADDRESS).toBe(CANONICAL);
    const other = await loadWith({ PROTOCOL_ENTRYPOINT_ADDRESS: OTHER });
    expect(other.PROTOCOL_ENTRYPOINT_ADDRESS).toBe(OTHER);
  });
});
