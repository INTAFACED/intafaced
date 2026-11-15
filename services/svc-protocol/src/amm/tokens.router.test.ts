import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import {
  createEdgeContext,
  TOKEN_NOT_LISTED,
  TOKEN_UNSUPPORTED,
  TOKENS_BLOCK_AHEAD,
  TOKENS_BLOCK_TOO_OLD,
  TOKENS_PAST_BLOCKS_KEPT,
} from '@intafaced/contracts';
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
    ['brief', (tokens: Tokens) => tokens.brief()],
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

describe('protocol.tokens with a token claiming more decimals than the pages take', () => {
  const QUOTE = '0x00000000000000000000000000000000000b0b00' as Address;
  const POOL = '0x00000000000000000000000000000000000000b1' as Address;
  const tokensWith = (decimalsOf: (token: Address) => number) =>
    createTokensRouter({
      chain: {
        headBlock: async () => 9n,
        factoryPools: async () => [POOL],
        poolSnapshot: async () => ({ token0: TOKEN, token1: QUOTE, feeBps: 30, reserve0: 1n, reserve1: 1n, blockTimestampLast: 0 }),
        tokenBasics: async (token: Address) => ({ name: 'T', symbol: 'T', decimals: decimalsOf(token) }),
        poolCreatedLogs: async () => [],
        poolLogs: async () => ({ syncs: [], swaps: [] }),
        blockTimes: async (blocks: bigint[]) => new Map(blocks.map((b) => [b, 100])),
      } as unknown as TokenLogsChain,
      factory: () => FACTORY as Address,
      quoteToken: () => QUOTE,
      toTrpcError: (err) => err as never,
    }).createCaller(anonymous());
  const unsupported = expect.stringMatching(new RegExp(`^${TOKEN_UNSUPPORTED.replace('.', '\\.')}: `));

  it('refuses its page by that code, not as a token in no pool', async () => {
    const tokens = tokensWith((token) => (token.toLowerCase() === TOKEN.toLowerCase() ? 77 : 18));
    await expect(tokens.page({ address: TOKEN })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: unsupported });
  });

  it('refuses every read by that code when it is the quote token', async () => {
    const tokens = tokensWith((token) => (token.toLowerCase() === QUOTE.toLowerCase() ? 77 : 18));
    await expect(tokens.list({ window: '1h' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: unsupported });
  });
});

describe('protocol.tokens.list at a stated block', () => {
  const QUOTE = '0x00000000000000000000000000000000000b0b00' as Address;
  const POOL = '0x00000000000000000000000000000000000000b1' as Address;
  const HEAD = 500n;
  /** A chain whose every read records the block it was asked at, so a test can show which block the list read. */
  function tokensAt() {
    const asked: bigint[] = [];
    const at = (block: bigint) => (asked.push(block), block);
    const tokens = createTokensRouter({
      chain: {
        headBlock: async () => HEAD,
        factoryPools: async (_f: Address, _l: number, block: bigint) => (at(block), [POOL]),
        poolSnapshot: async (_p: Address, block: bigint) => (
          at(block),
          { token0: TOKEN, token1: QUOTE, feeBps: 30, reserve0: 1n, reserve1: 1n, blockTimestampLast: 0 }
        ),
        tokenBasics: async () => ({ name: 'T', symbol: 'T', decimals: 18 }),
        poolCreatedLogs: async (_f: Address, toBlock: bigint) => (at(toBlock), []),
        poolLogs: async (_p: Address[], toBlock: bigint) => (at(toBlock), { syncs: [], swaps: [] }),
        blockTimes: async (blocks: bigint[]) => new Map(blocks.map((b) => [b, Number(b) * 2])),
      } as unknown as TokenLogsChain,
      factory: () => FACTORY as Address,
      quoteToken: () => QUOTE,
      toTrpcError: (err) => err as never,
    }).createCaller(anonymous());
    return { asked, tokens };
  }
  const refusal = (code: string) => expect.stringMatching(new RegExp(`^${code.replace('.', '\\.')}: `));

  it('reads at the head block without one, as before', async () => {
    const { asked, tokens } = tokensAt();
    const list = await tokens.list({ window: '24h' });
    expect(list.blockNumber).toBe(HEAD.toString());
    expect(list.asOf).toBe(Number(HEAD) * 2);
    expect(new Set(asked)).toEqual(new Set([HEAD]));
  });

  it('reads every figure at a stated past block, not at the head', async () => {
    const { asked, tokens } = tokensAt();
    const list = await tokens.list({ window: '24h', blockNumber: '497' });
    expect(list.blockNumber).toBe('497');
    expect(list.asOf).toBe(497 * 2);
    expect(asked.length).toBeGreaterThan(0);
    expect(new Set(asked)).toEqual(new Set([497n]));
  });

  it('reads the oldest block it keeps, and the head block when it is stated', async () => {
    const { tokens } = tokensAt();
    const oldest = (HEAD - TOKENS_PAST_BLOCKS_KEPT).toString();
    expect((await tokens.list({ window: '1h', blockNumber: oldest })).blockNumber).toBe(oldest);
    expect((await tokens.list({ window: '1h', blockNumber: HEAD.toString() })).blockNumber).toBe(HEAD.toString());
  });

  it('refuses a block above the head by its code and reads nothing at it', async () => {
    const { asked, tokens } = tokensAt();
    await expect(tokens.list({ window: '24h', blockNumber: (HEAD + 1n).toString() })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: refusal(TOKENS_BLOCK_AHEAD),
    });
    expect(asked).toEqual([]);
  });

  it('refuses a block older than the node keeps by its code and reads nothing at it', async () => {
    const { asked, tokens } = tokensAt();
    await expect(tokens.list({ window: '24h', blockNumber: (HEAD - TOKENS_PAST_BLOCKS_KEPT - 1n).toString() })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: refusal(TOKENS_BLOCK_TOO_OLD),
    });
    expect(asked).toEqual([]);
  });

  it('refuses a block that is not a whole number at the wire', async () => {
    const { tokens } = tokensAt();
    for (const blockNumber of ['-1', '1.5', '0x10', ''])
      await expect(tokens.list({ window: '24h', blockNumber })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
