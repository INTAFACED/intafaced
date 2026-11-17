/**
 * Unit card — PROTOCOL_CHAIN_ID unset/blank must not echo Anvil 31337 as live
 *
 * 1. Promise: blank/unset PROTOCOL_CHAIN_ID refuses boot (typed error). An
 *    operator-set id (including 31337) is that chain, not an invented default.
 * 2. Break: z.coerce.number().int().positive().default(31337) stamps Anvil
 *    when the operator never named a chain — fixture id looks live.
 *    Compose ${PROTOCOL_CHAIN_ID:-31337} does the same in the fleet.
 * 3. Done bar: production env.ts loadEnv (not a forked slice) refuses unset
 *    and blank; source has no .default(31337); compose passes PROTOCOL_CHAIN_ID
 *    with empty default. AMM quote/create feeBps has no .default(30).
 * 4. Class M
 * 5. Paths: env.ts via loadEnv at import (same as boot); docker-compose.apps.yml
 *    svc-protocol block; router.ts feeBps inputs
 * 6. RED: default 31337 returns, unset parses as 31337, blank parses as 0/31337,
 *    compose interpolates :-31337, or feeBps defaults to 30
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
  PROTOCOL_CHAIN_ID: '1',
  PROTOCOL_RPC_URL: 'http://127.0.0.1:8545',
  PROTOCOL_ENTRYPOINT_ADDRESS: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
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

describe('svc-protocol PROTOCOL_CHAIN_ID refuse-closed', () => {
  it('env.ts has no Anvil 31337 default', () => {
    const envTs = readFileSync(join(HERE, 'env.ts'), 'utf8');
    expect(envTs).not.toMatch(/PROTOCOL_CHAIN_ID:[\s\S]*?\.default\(31337\)/);
    expect(envTs).toMatch(/PROTOCOL_CHAIN_ID is unset — will not echo Anvil 31337 as live/);
  });

  it('compose does not interpolate :-31337 on svc-protocol', () => {
    const compose = readFileSync(COMPOSE, 'utf8');
    const block = composeServiceBlock(compose, 'svc-protocol');
    expect(block).toMatch(/PROTOCOL_CHAIN_ID:\s*\$\{PROTOCOL_CHAIN_ID:-\}/);
    expect(block).not.toMatch(/PROTOCOL_CHAIN_ID:.*31337/);
  });

  it('router does not git-default AMM feeBps to 30', () => {
    const routerTs = readFileSync(join(HERE, 'router.ts'), 'utf8');
    expect(routerTs).not.toMatch(/feeBps:[\s\S]{0,80}\.default\(\s*30\s*\)/);
    expect(routerTs).toMatch(/feeBps is unset — will not invent 30 bps/);
  });

  it('unset PROTOCOL_CHAIN_ID refuses (no silent Anvil)', async () => {
    await expect(loadWith({ PROTOCOL_CHAIN_ID: undefined })).rejects.toThrow(/PROTOCOL_CHAIN_ID/);
  });

  it('blank PROTOCOL_CHAIN_ID refuses', async () => {
    await expect(loadWith({ PROTOCOL_CHAIN_ID: '' })).rejects.toThrow(/PROTOCOL_CHAIN_ID/);
  });

  it('whitespace PROTOCOL_CHAIN_ID refuses', async () => {
    await expect(loadWith({ PROTOCOL_CHAIN_ID: '   ' })).rejects.toThrow(/PROTOCOL_CHAIN_ID/);
  });

  it('garbage PROTOCOL_CHAIN_ID refuses', async () => {
    await expect(loadWith({ PROTOCOL_CHAIN_ID: 'anvil' })).rejects.toThrow(/PROTOCOL_CHAIN_ID/);
  });

  it('explicit chain id is operator-set, including Anvil when named', async () => {
    const one = await loadWith({ PROTOCOL_CHAIN_ID: '1' });
    expect(one.PROTOCOL_CHAIN_ID).toBe(1);
    const anvil = await loadWith({ PROTOCOL_CHAIN_ID: '31337' });
    expect(anvil.PROTOCOL_CHAIN_ID).toBe(31337);
  });
});
