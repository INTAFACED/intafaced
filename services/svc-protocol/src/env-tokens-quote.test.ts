/**
 * PROTOCOL_TOKENS_QUOTE_TOKEN is an owner setting with no default: blank or zero is null (the token pages refuse
 * protocol.tokens_quote_unset), and anything else that is not an address refuses boot instead of reading as unset.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const BASE_ENV = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  DATABASE_POOL_MAX: '10',
  EDGE_PRINCIPAL_SECRET: 's'.repeat(32),
  PROTOCOL_CHAIN_ID: '1',
  PROTOCOL_RPC_URL: 'http://127.0.0.1:8545',
  PROTOCOL_ENTRYPOINT_ADDRESS: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
};

async function loadWith(quote: string | undefined) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  for (const [key, value] of Object.entries({ ...BASE_ENV, PROTOCOL_TOKENS_QUOTE_TOKEN: quote })) vi.stubEnv(key, value);
  return (await import('./env.js')).env;
}

afterEach(() => vi.unstubAllEnvs());

describe('PROTOCOL_TOKENS_QUOTE_TOKEN', () => {
  it.each([undefined, '', '  ', `0x${'0'.repeat(40)}`])('%j is unset', async (quote) => {
    expect((await loadWith(quote)).PROTOCOL_TOKENS_QUOTE_TOKEN).toBeNull();
  });

  it('an address is that address', async () => {
    const address = '0x00000000000000000000000000000000000b0b00';
    expect((await loadWith(address)).PROTOCOL_TOKENS_QUOTE_TOKEN).toBe(address);
  });

  it.each(['0x00000000000000000000000000000000000b0b0', '00000000000000000000000000000000000b0b00', 'TESTB'])(
    'a malformed %j refuses boot, never reads as unset',
    async (quote) => {
      await expect(loadWith(quote)).rejects.toThrow(/PROTOCOL_TOKENS_QUOTE_TOKEN/);
    },
  );
});
