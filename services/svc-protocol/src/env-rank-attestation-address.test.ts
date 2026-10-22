/**
 * RC-identity-16 — PROTOCOL_RANK_ATTESTATION_ADDRESS: blank/unset stays unset (refused at call time as
 * protocol.attestation_registry_unset), never an invented 0x0 or default; malformed refuses boot.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const BASE_ENV = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  DATABASE_POOL_MAX: '10',
  EDGE_PRINCIPAL_SECRET: 's'.repeat(32),
  PROTOCOL_CHAIN_ID: '84532',
  PROTOCOL_RPC_URL: 'http://127.0.0.1:8545',
  PROTOCOL_ENTRYPOINT_ADDRESS: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
};

async function loadWith(value: string | undefined) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  for (const [key, v] of Object.entries(BASE_ENV)) vi.stubEnv(key, v);
  vi.stubEnv('PROTOCOL_RANK_ATTESTATION_ADDRESS', value);
  const module = await import('./env.js');
  return module.env;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('PROTOCOL_RANK_ATTESTATION_ADDRESS', () => {
  it('unset stays undefined', async () => {
    expect((await loadWith(undefined)).PROTOCOL_RANK_ATTESTATION_ADDRESS).toBeUndefined();
  });

  it('blank (compose ${VAR:-}) stays undefined', async () => {
    expect((await loadWith('')).PROTOCOL_RANK_ATTESTATION_ADDRESS).toBeUndefined();
    expect((await loadWith('   ')).PROTOCOL_RANK_ATTESTATION_ADDRESS).toBeUndefined();
  });

  it('a malformed address refuses boot', async () => {
    await expect(loadWith('0x1234')).rejects.toThrow();
    await expect(loadWith('not-an-address')).rejects.toThrow();
  });

  it('a real address is kept as given', async () => {
    const addr = '0x1111111111111111111111111111111111111111';
    expect((await loadWith(addr)).PROTOCOL_RANK_ATTESTATION_ADDRESS).toBe(addr);
  });
});
