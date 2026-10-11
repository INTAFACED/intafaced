/**
 * Blank / whitespace DEX_CLOB_FEE_BPS must not become a published 0 bps
 * schedule. With DEX_CLOB_SETTLEMENT_COST set, production loadEnv refuses.
 * An explicit integer bps the schema already accepts still loads.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const SECRET = 's'.repeat(32);

const BASE_ENV = {
  EDGE_PRINCIPAL_SECRET: SECRET,
};

async function loadWith(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('DEX_CLOB_FEE_BPS', undefined);
  vi.stubEnv('DEX_CLOB_SETTLEMENT_COST', undefined);
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...overrides })) {
    vi.stubEnv(key, value);
  }
  const module = await import('./env.js');
  return module.env;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('DEX_CLOB_FEE_BPS blank refuse-closed', () => {
  it('refuses a blank or whitespace fee when settlement cost is set, and still loads an explicit bps', async () => {
    await expect(loadWith({ DEX_CLOB_FEE_BPS: '   ', DEX_CLOB_SETTLEMENT_COST: '1.25' })).rejects.toThrow(/DEX_CLOB_FEE_BPS/);
    await expect(loadWith({ DEX_CLOB_FEE_BPS: '', DEX_CLOB_SETTLEMENT_COST: '1.25' })).rejects.toThrow(/DEX_CLOB_FEE_BPS/);
    await expect(loadWith({ DEX_CLOB_FEE_BPS: '\t', DEX_CLOB_SETTLEMENT_COST: '0' })).rejects.toThrow(/DEX_CLOB_FEE_BPS/);

    const explicit = await loadWith({ DEX_CLOB_FEE_BPS: '10', DEX_CLOB_SETTLEMENT_COST: '0' });
    expect(explicit.DEX_CLOB_FEE_BPS).toBe(10);
    expect(explicit.DEX_CLOB_SETTLEMENT_COST).toBe('0');

    const explicitZero = await loadWith({ DEX_CLOB_FEE_BPS: '0', DEX_CLOB_SETTLEMENT_COST: '0' });
    expect(explicitZero.DEX_CLOB_FEE_BPS).toBe(0);
  }, 20_000);
});
