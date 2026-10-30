/**
 * D-swap-11 price settings: blank stays blank (amm.prices refuses protocol.price_settings_unset), and a malformed value
 * refuses boot by name instead of reading as blank.
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
const USD = '0x000000000000000000000000000000000000D011';

async function loadWith(overrides: Record<string, string | undefined>) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) vi.stubEnv(key, value);
  return (await import('./env.js')).env;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('svc-protocol price settings', () => {
  it('blank reads as unset, never a default list or minimum', async () => {
    const env = await loadWith({ PROTOCOL_PRICE_USD_TOKENS: '', PROTOCOL_PRICE_MIN_RESERVE_USD: '' });
    expect(env.PROTOCOL_PRICE_USD_TOKENS).toBeNull();
    expect(env.PROTOCOL_PRICE_MIN_RESERVE_USD).toBeNull();
  });

  it('reads the owner values, addresses lower-cased', async () => {
    const env = await loadWith({ PROTOCOL_PRICE_USD_TOKENS: ` ${USD} `, PROTOCOL_PRICE_MIN_RESERVE_USD: '1000' });
    expect([...(env.PROTOCOL_PRICE_USD_TOKENS ?? [])]).toEqual([USD.toLowerCase()]);
    expect(env.PROTOCOL_PRICE_MIN_RESERVE_USD).toBe(1000n);
  });

  it.each([`${USD},0x123`, 'not-an-address'])('a malformed reference list %s refuses boot by name', async (raw) => {
    await expect(loadWith({ PROTOCOL_PRICE_USD_TOKENS: raw })).rejects.toThrow(/PROTOCOL_PRICE_USD_TOKENS/);
  });

  it.each(['0', '1,000', '1000.0', '-5'])('a malformed minimum %s refuses boot by name', async (raw) => {
    await expect(loadWith({ PROTOCOL_PRICE_MIN_RESERVE_USD: raw })).rejects.toThrow(/PROTOCOL_PRICE_MIN_RESERVE_USD/);
  });
});
