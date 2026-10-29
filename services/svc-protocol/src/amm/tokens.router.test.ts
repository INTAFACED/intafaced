import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { createEdgeContext, TOKEN_NOT_LISTED } from '@intafaced/contracts';
import { createProtocolRouter, type ProtocolRouterDeps } from '../router.js';
import { createTokensRouter } from './tokens-router.js';
import type { TokenLogsChain } from './token-reader.js';

const edge = createEdgeContext({ secret: 'a-protocol-tokens-test-edge-secret-length', serviceName: 'svc-protocol' });
const anonymous = () => edge({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-tokens' });
const FACTORY = '0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9';
const TOKEN = '0x00000000000000000000000000000000000a11ce';

/** The protocol router with a chain client that counts every read, so a refusal can show it read nothing. */
function caller(overrides: Partial<ProtocolRouterDeps>) {
  const reads = { count: 0 };
  const client = new Proxy({}, { get: () => () => (reads.count++, Promise.reject(new Error('no chain read expected'))) });
  const deps = {
    chain: { config: { chainId: 84532, rpcUrl: 'http://127.0.0.1:1' }, client },
    registry: {},
    relay: {},
    relayEnabled: () => false,
    ammFactoryAddress: () => FACTORY,
    tokensQuoteToken: () => '0x00000000000000000000000000000000000b0b00',
    ...overrides,
  } as unknown as ProtocolRouterDeps;
  return { reads, tokens: createProtocolRouter(deps).createCaller(anonymous()).tokens };
}
type Tokens = ReturnType<typeof caller>['tokens'];

describe('protocol.tokens with a blank owner setting', () => {
  it.each([
    ['list', (tokens: Tokens) => tokens.list({ window: '1h' })],
    ['page', (tokens: Tokens) => tokens.page({ address: TOKEN })],
    ['leaderboard', (tokens: Tokens) => tokens.leaderboard()],
  ])('%s refuses a blank quote token by its code and reads nothing from the chain', async (_name, call) => {
    const { reads, tokens } = caller({ tokensQuoteToken: () => null });
    await expect(call(tokens)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringMatching(/^protocol\.tokens_quote_unset: /),
    });
    expect(reads.count).toBe(0);
  });

  it('refuses an unset factory by its code before the quote token is asked for', async () => {
    let asked = 0;
    const { reads, tokens } = caller({
      ammFactoryAddress: () => '0x0000000000000000000000000000000000000000',
      tokensQuoteToken: () => (asked++, null),
    });
    await expect(tokens.list({ window: '24h' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringMatching(/^protocol\.amm_factory_unset: /),
    });
    expect(asked).toBe(0);
    expect(reads.count).toBe(0);
  });
});

describe('protocol.tokens.page for an address in no pool', () => {
  it('refuses by its code before any holder read, so no full-history scan runs for an arbitrary contract', async () => {
    const QUOTE = '0x00000000000000000000000000000000000b0b00' as Address;
    const POOL = '0x00000000000000000000000000000000000000b1' as Address;
    const holderReads: string[] = [];
    const chain = {
      headBlock: async () => 9n,
      factoryPools: async () => [POOL],
      poolSnapshot: async () => ({ token0: TOKEN, token1: QUOTE, feeBps: 30, reserve0: 1n, reserve1: 1n, blockTimestampLast: 0 }),
      tokenBasics: async () => ({ name: 'T', symbol: 'T', decimals: 18 }),
      poolCreatedLogs: async () => [],
      poolLogs: async () => ({ syncs: [], swaps: [] }),
      blockTimes: async (blocks: bigint[]) => new Map(blocks.map((b) => [b, 100])),
      transferLogs: async (token: Address) => (holderReads.push(`transfers:${token}`), []),
      totalSupply: async (token: Address) => (holderReads.push(`supply:${token}`), 0n),
      balanceOf: async (token: Address) => (holderReads.push(`balance:${token}`), 0n),
    } as unknown as TokenLogsChain;
    const tokens = createTokensRouter({
      chain,
      factory: () => FACTORY as Address,
      quoteToken: () => QUOTE,
      toTrpcError: (err) => err as never,
    }).createCaller(anonymous());
    await expect(tokens.page({ address: '0x000000000000000000000000000000000000beef' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringMatching(new RegExp(`^${TOKEN_NOT_LISTED.replace('.', '\\.')}: `)),
    });
    expect(holderReads).toEqual([]);
  });
});
