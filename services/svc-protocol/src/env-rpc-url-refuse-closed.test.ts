/**
 * Unit card — PROTOCOL_RPC_URL unset/blank must not invent http://evm:8545 as live
 *
 * 1. Promise: blank/unset PROTOCOL_RPC_URL refuses boot (typed error).
 *    An operator-set URL (including http://evm:8545) is that endpoint, not an
 *    invented default. This mill does not invent an RPC.
 * 2. Break: z.string().url().default('http://localhost:8545') plus compose
 *    ${PROTOCOL_RPC_URL:-http://evm:8545} stamps a live RPC when the operator
 *    never named one — unpublished looks like a chain.
 * 3. Done bar: production env.ts loadEnv (not a forked slice) refuses unset
 *    and blank; source has no .default(localhost:8545) and no evm:8545 default;
 *    compose passes PROTOCOL_RPC_URL with empty default.
 * 4. Class M
 * 5. Paths: env.ts via loadEnv at import (same as boot); docker-compose.apps.yml
 *    svc-protocol block
 * 6. RED: default localhost/evm:8545 returns, unset/blank parse as live RPC,
 *    or compose interpolates :-http://evm:8545
 * 7. Collision: PROTOCOL_CHAIN_ID already refuse-closed. Does not invent
 *    chainId. Does not mill nginx.
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
  PROTOCOL_CHAIN_ID: '1',
  PROTOCOL_RPC_URL: OTHER_RPC,
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

describe('svc-protocol PROTOCOL_RPC_URL refuse-closed', () => {
  it('env.ts has no localhost:8545 or evm:8545 git-default', () => {
    const envTs = readFileSync(join(HERE, 'env.ts'), 'utf8');
    expect(envTs).not.toMatch(/PROTOCOL_RPC_URL:\s*z\.string\(\)\.url\(\)\.default\('http:\/\/localhost:8545'\)/);
    expect(envTs).not.toMatch(/PROTOCOL_RPC_URL:[\s\S]*?\.default\(['"]http:\/\/evm:8545['"]\)/);
    expect(envTs).not.toMatch(/PROTOCOL_RPC_URL:[\s\S]*?\.default\(['"]http:\/\/localhost:8545['"]\)/);
    expect(envTs).toMatch(/PROTOCOL_RPC_URL is unset — will not invent http:\/\/evm:8545 as live/);
  });

  it('compose does not interpolate :-http://evm:8545', () => {
    const compose = readFileSync(COMPOSE, 'utf8');
    const block = composeServiceBlock(compose, 'svc-protocol');
    expect(block).toMatch(/PROTOCOL_RPC_URL:\s*\$\{PROTOCOL_RPC_URL:-\}/);
    expect(block).not.toMatch(/PROTOCOL_RPC_URL:.*evm:8545/);
    expect(block).toMatch(/PROTOCOL_CHAIN_ID:\s*\$\{PROTOCOL_CHAIN_ID:-\}/);
    expect(block).not.toMatch(/PROTOCOL_CHAIN_ID:.*31337/);
  });

  it('unset PROTOCOL_RPC_URL refuses (no silent evm:8545)', async () => {
    await expect(loadWith({ PROTOCOL_RPC_URL: undefined })).rejects.toThrow(/PROTOCOL_RPC_URL/);
  });

  it('blank PROTOCOL_RPC_URL refuses', async () => {
    await expect(loadWith({ PROTOCOL_RPC_URL: '' })).rejects.toThrow(/PROTOCOL_RPC_URL/);
  });

  it('whitespace PROTOCOL_RPC_URL refuses', async () => {
    await expect(loadWith({ PROTOCOL_RPC_URL: '   ' })).rejects.toThrow(/PROTOCOL_RPC_URL/);
  });

  it('garbage PROTOCOL_RPC_URL refuses', async () => {
    await expect(loadWith({ PROTOCOL_RPC_URL: 'not-a-url' })).rejects.toThrow(/PROTOCOL_RPC_URL/);
  });

  it('explicit RPC is operator-set, including http://evm:8545 when named', async () => {
    const local = await loadWith({ PROTOCOL_RPC_URL: OTHER_RPC });
    expect(local.PROTOCOL_RPC_URL).toBe(OTHER_RPC);
    const composeEvm = await loadWith({ PROTOCOL_RPC_URL: OWNER_RPC });
    expect(composeEvm.PROTOCOL_RPC_URL).toBe(OWNER_RPC);
  });
});
