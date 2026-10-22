/**
 * RC-identity-16 — PROTOCOL_RANK_ATTESTATION_FROM_BLOCK: owner-set start block of the Revoked-log scan. Blank/unset
 * stays unset (verify of an empty record refuses protocol.attestation_from_block_unset), never a default 0; a value
 * that is not a block number refuses boot; compose and .env.example pass it through blank.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const BASE_ENV = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  DATABASE_POOL_MAX: '10',
  EDGE_PRINCIPAL_SECRET: 's'.repeat(32),
  PROTOCOL_CHAIN_ID: '84532',
  PROTOCOL_RPC_URL: 'http://127.0.0.1:8545',
  PROTOCOL_ENTRYPOINT_ADDRESS: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
};
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

async function loadWith(value: string | undefined) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  for (const [key, v] of Object.entries(BASE_ENV)) vi.stubEnv(key, v);
  vi.stubEnv('PROTOCOL_RANK_ATTESTATION_FROM_BLOCK', value);
  const module = await import('./env.js');
  return module.env;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('PROTOCOL_RANK_ATTESTATION_FROM_BLOCK', () => {
  it('unset or blank stays undefined, never 0', async () => {
    expect((await loadWith(undefined)).PROTOCOL_RANK_ATTESTATION_FROM_BLOCK).toBeUndefined();
    expect((await loadWith('')).PROTOCOL_RANK_ATTESTATION_FROM_BLOCK).toBeUndefined();
    expect((await loadWith('   ')).PROTOCOL_RANK_ATTESTATION_FROM_BLOCK).toBeUndefined();
  });

  it('a block number is kept as a bigint', async () => {
    expect((await loadWith('18234567')).PROTOCOL_RANK_ATTESTATION_FROM_BLOCK).toBe(18234567n);
    expect((await loadWith('0')).PROTOCOL_RANK_ATTESTATION_FROM_BLOCK).toBe(0n);
  });

  it('anything but a block number refuses boot', async () => {
    for (const bad of ['-1', '1.5', '0x10', 'latest', '1e6']) {
      await expect(loadWith(bad)).rejects.toThrow();
    }
  });

  it('compose and .env.example pass it through blank, with no default', () => {
    const compose = readFileSync(join(root, 'docker-compose.apps.yml'), 'utf8');
    expect(compose).toContain('PROTOCOL_RANK_ATTESTATION_FROM_BLOCK: ${PROTOCOL_RANK_ATTESTATION_FROM_BLOCK:-}');
    expect(compose).toContain('PROTOCOL_RANK_ATTESTATION_ADDRESS: ${PROTOCOL_RANK_ATTESTATION_ADDRESS:-}');
    const example = readFileSync(join(root, '.env.example'), 'utf8');
    expect(example).toMatch(/^PROTOCOL_RANK_ATTESTATION_FROM_BLOCK=$/m);
  });
});
