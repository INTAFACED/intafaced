/**
 * Unit card — compose does not invent Anvil CREATE factory quartet
 *
 * 1. Promise: host `.env` can pin factory / implementation / token-factory /
 *    AMM. Blank stays unset so env.ts default 0x0 applies (not configured).
 * 2. Break: compose `:-0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512` (and the
 *    other three Anvil CREATE addrs) publishes a disposable chain as this
 *    venue when the operator never named one.
 * 3. Done bar: docker-compose.apps.yml svc-protocol has empty pass-through
 *    `${VAR:-}` for the quartet. env.ts still defaults 0x0; compose `''`
 *    parses as that default. Owner-set addresses pass through.
 * 4. Class N
 * 5. Paths: docker-compose.apps.yml (svc-protocol block) + env.ts
 * 6. RED: pin fails if compose interpolates any of the four Anvil CREATE addrs
 * 7. Collision: PROTOCOL_CHAIN_ID / PROTOCOL_RPC_URL / PROTOCOL_ENTRYPOINT_ADDRESS
 *    — this pin empty-passes them (no invented 31337 / evm:8545 / EntryPoint).
 *    Does not invent chainId. Does not mill nginx.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { composeServiceBlock } from '@intafaced/config/compose';

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPOSE = resolve(HERE, '../../../docker-compose.apps.yml');
const SECRET = 's'.repeat(32);
const ZERO = '0x0000000000000000000000000000000000000000';
const ANVIL_FACTORY = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';
const ANVIL_IMPLEMENTATION = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const ANVIL_TOKEN_FACTORY = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0';
const ANVIL_AMM = '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9';
const OWNER = '0x1111111111111111111111111111111111111111';

const KEYS = [
  'PROTOCOL_FACTORY_ADDRESS',
  'PROTOCOL_IMPLEMENTATION_ADDRESS',
  'PROTOCOL_TOKEN_FACTORY_ADDRESS',
  'PROTOCOL_AMM_FACTORY_ADDRESS',
] as const;

const BASE_ENV = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  DATABASE_POOL_MAX: '10',
  EDGE_PRINCIPAL_SECRET: SECRET,
  PROTOCOL_CHAIN_ID: '1',
  PROTOCOL_RPC_URL: 'http://127.0.0.1:8545',
  PROTOCOL_ENTRYPOINT_ADDRESS: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
};

function protocolComposeBlock(): string {
  const compose = readFileSync(COMPOSE, 'utf8');
  return composeServiceBlock(compose, 'svc-protocol');
}

function countAssignments(source: string, name: string): number {
  const re = new RegExp(`^\\s*${name}:`, 'gm');
  return source.match(re)?.length ?? 0;
}

async function loadWith(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('PROTOCOL_CHAIN_ID', undefined);
  vi.stubEnv('PROTOCOL_RPC_URL', undefined);
  vi.stubEnv('PROTOCOL_ENTRYPOINT_ADDRESS', undefined);
  for (const key of KEYS) vi.stubEnv(key, undefined);
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) {
    vi.stubEnv(key, value);
  }
  const module = await import('./env.js');
  return module.env;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('compose factory quartet empty pass-through (no invented Anvil CREATE)', () => {
  const compose = readFileSync(COMPOSE, 'utf8');
  const envTs = readFileSync(join(HERE, 'env.ts'), 'utf8');
  const block = protocolComposeBlock();

  it('env.ts still defaults factory quartet to 0x0 (not Anvil CREATE)', () => {
    expect(envTs).toMatch(/evmAddress\.default\('0x0000000000000000000000000000000000000000'\)/);
    expect(envTs).not.toMatch(ANVIL_FACTORY);
    expect(envTs).not.toMatch(ANVIL_IMPLEMENTATION);
    expect(envTs).not.toMatch(ANVIL_TOKEN_FACTORY);
    expect(envTs).not.toMatch(ANVIL_AMM);
  });

  it('compose svc-protocol block empty-passes each factory addr once', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-protocol/);
    for (const key of KEYS) {
      const line = new RegExp(`^\\s+${key}:\\s*\\$\\{${key}:-\\}\\s*$`, 'm');
      expect(block.match(line), `${key} must be \${${key}:-}`).toHaveLength(1);
      expect(countAssignments(compose, key), `${key} must appear once`).toBe(1);
      expect(countAssignments(block, key), `${key} must appear once on svc-protocol`).toBe(1);
    }
  });

  it('compose pin must not contain Anvil CREATE addrs', () => {
    expect(block).not.toMatch(ANVIL_FACTORY);
    expect(block).not.toMatch(ANVIL_IMPLEMENTATION);
    expect(block).not.toMatch(ANVIL_TOKEN_FACTORY);
    expect(block).not.toMatch(ANVIL_AMM);
    expect(block).not.toMatch(/PROTOCOL_FACTORY_ADDRESS:.*:-0x/);
    expect(block).not.toMatch(/PROTOCOL_IMPLEMENTATION_ADDRESS:.*:-0x/);
    expect(block).not.toMatch(/PROTOCOL_TOKEN_FACTORY_ADDRESS:.*:-0x/);
    expect(block).not.toMatch(/PROTOCOL_AMM_FACTORY_ADDRESS:.*:-0x/);
  });

  it('does not restamp chainId / rpc / entrypoint, or invent 31337', () => {
    expect(block).toMatch(/PROTOCOL_CHAIN_ID:\s*\$\{PROTOCOL_CHAIN_ID:-\}/);
    expect(block).toMatch(/PROTOCOL_RPC_URL:\s*\$\{PROTOCOL_RPC_URL:-\}/);
    expect(block).toMatch(/PROTOCOL_ENTRYPOINT_ADDRESS:\s*\$\{PROTOCOL_ENTRYPOINT_ADDRESS:-\}/);
    expect(block).not.toMatch(/PROTOCOL_CHAIN_ID:.*31337/);
  });
});

describe('factory quartet blank uses env 0x0 (compose empty string)', () => {
  it('unset quartet is 0x0', async () => {
    const parsed = await loadWith({});
    expect(parsed.PROTOCOL_FACTORY_ADDRESS).toBe(ZERO);
    expect(parsed.PROTOCOL_IMPLEMENTATION_ADDRESS).toBe(ZERO);
    expect(parsed.PROTOCOL_TOKEN_FACTORY_ADDRESS).toBe(ZERO);
    expect(parsed.PROTOCOL_AMM_FACTORY_ADDRESS).toBe(ZERO);
  });

  it('blank quartet is 0x0 (not Anvil CREATE, does not refuse boot)', async () => {
    const parsed = await loadWith({
      PROTOCOL_FACTORY_ADDRESS: '',
      PROTOCOL_IMPLEMENTATION_ADDRESS: '',
      PROTOCOL_TOKEN_FACTORY_ADDRESS: '',
      PROTOCOL_AMM_FACTORY_ADDRESS: '',
    });
    expect(parsed.PROTOCOL_FACTORY_ADDRESS).toBe(ZERO);
    expect(parsed.PROTOCOL_IMPLEMENTATION_ADDRESS).toBe(ZERO);
    expect(parsed.PROTOCOL_TOKEN_FACTORY_ADDRESS).toBe(ZERO);
    expect(parsed.PROTOCOL_AMM_FACTORY_ADDRESS).toBe(ZERO);
  });

  it('explicit owner addresses pass through', async () => {
    const parsed = await loadWith({
      PROTOCOL_FACTORY_ADDRESS: OWNER,
      PROTOCOL_IMPLEMENTATION_ADDRESS: OWNER,
      PROTOCOL_TOKEN_FACTORY_ADDRESS: OWNER,
      PROTOCOL_AMM_FACTORY_ADDRESS: OWNER,
    });
    expect(parsed.PROTOCOL_FACTORY_ADDRESS).toBe(OWNER);
    expect(parsed.PROTOCOL_IMPLEMENTATION_ADDRESS).toBe(OWNER);
    expect(parsed.PROTOCOL_TOKEN_FACTORY_ADDRESS).toBe(OWNER);
    expect(parsed.PROTOCOL_AMM_FACTORY_ADDRESS).toBe(OWNER);
  });

  it('explicit Anvil CREATE is operator-set, not a default', async () => {
    const parsed = await loadWith({
      PROTOCOL_FACTORY_ADDRESS: ANVIL_FACTORY,
      PROTOCOL_IMPLEMENTATION_ADDRESS: ANVIL_IMPLEMENTATION,
      PROTOCOL_TOKEN_FACTORY_ADDRESS: ANVIL_TOKEN_FACTORY,
      PROTOCOL_AMM_FACTORY_ADDRESS: ANVIL_AMM,
    });
    expect(parsed.PROTOCOL_FACTORY_ADDRESS).toBe(ANVIL_FACTORY);
    expect(parsed.PROTOCOL_IMPLEMENTATION_ADDRESS).toBe(ANVIL_IMPLEMENTATION);
    expect(parsed.PROTOCOL_TOKEN_FACTORY_ADDRESS).toBe(ANVIL_TOKEN_FACTORY);
    expect(parsed.PROTOCOL_AMM_FACTORY_ADDRESS).toBe(ANVIL_AMM);
  });

  it('garbage factory address refuses boot (does not invent Anvil CREATE or 0x0)', async () => {
    await expect(loadWith({ PROTOCOL_FACTORY_ADDRESS: 'anvil' })).rejects.toThrow(/PROTOCOL_FACTORY_ADDRESS/);
  });
});
