/**
 * Unit card — D-explorer-03 address transactions and token search (J-dex-protocol-09 #4)
 *
 * 1. Promise: an ERC-20 Transfer log is read as one transfer with its full uint256 amount; ERC-721's four-topic
 *    Transfer and malformed words are not. Direction is in, out or self for the page's address. The router lists the
 *    address's transactions owner-bounded with a cursor, amounts as raw decimal strings, another network empty; the
 *    token search lists every contract sharing a symbol, one row each. Unwired and a blank limit refuse by code.
 * 2. Break: an NFT read as a token transfer, an amount through a float, two same-symbol tokens merged, an invented page.
 * 3. Done bar: the tests below, and the Postgres twin in projection/postgres-store.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { createEdgeContext } from '@intafaced/contracts';
import { MemoryChainSource } from '../chain/memory-source.js';
import { Indexer } from '../indexer.js';
import { MemoryProjectionStore } from '../projection/memory-store.js';
import { createIndexerRouter, type IndexerRouterDeps } from '../router.js';
import { CHAIN_ID } from '../testing/conformance.js';
import { userCopy } from '../user-copy.js';
import { INDEXER_EXPLORER_LIST_LIMIT_UNSET, INDEXER_EXPLORER_UNWIRED, memoryExplorerSource, parseExplorerListLimit } from './blocks.js';
import { directionOf, ERC20_TRANSFER_TOPIC, transferOf, type AddressTxFact, type TokenFact } from './address.js';

const edgeContext = createEdgeContext({ secret: 'an-indexer-explorer-address-test-edge-secret', serviceName: 'svc-indexer' });
const anonymous = () => edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' });
const hex = (n: number, bytes: number) => `0x${n.toString(16).padStart(bytes * 2, '0')}`;
const word = (address: string) => `0x${'00'.repeat(12)}${address.slice(2)}`;

const ME = hex(0xab, 20);
const OTHER = hex(0xcd, 20);
const TOKEN = hex(0x0a, 20);

describe('transferOf', () => {
  const log = {
    logIndex: 4,
    address: TOKEN.toUpperCase().replace('0X', '0x'),
    topics: [ERC20_TRANSFER_TOPIC, word(OTHER), word(ME)],
    data: `0x${'ff'.repeat(32)}`,
  };

  it('reads an ERC-20 Transfer with its full uint256 amount', () => {
    expect(transferOf(log)).toEqual({ logIndex: 4, token: TOKEN, from: OTHER, to: ME, amount: 2n ** 256n - 1n });
  });

  it('does not read an ERC-721 Transfer, another event or a malformed word as a token transfer', () => {
    expect(transferOf({ ...log, topics: [...log.topics, word(OTHER)], data: '0x' })).toBeNull();
    expect(transferOf({ ...log, topics: [`0x${'ee'.repeat(32)}`, word(OTHER), word(ME)] })).toBeNull();
    expect(transferOf({ ...log, topics: [ERC20_TRANSFER_TOPIC, `0x${'11'.repeat(32)}`, word(ME)] })).toBeNull();
    expect(transferOf({ ...log, data: '0x01' })).toBeNull();
  });
});

describe('directionOf', () => {
  it('is in, out or self for the address the page is about', () => {
    expect(directionOf({ from: OTHER, to: ME }, ME.toUpperCase())).toBe('in');
    expect(directionOf({ from: ME, to: OTHER }, ME)).toBe('out');
    expect(directionOf({ from: ME, to: ME }, ME)).toBe('self');
  });
});

const row = (height: number, index: number, over: Partial<AddressTxFact> = {}): AddressTxFact => ({
  hash: hex(height * 100 + index, 32),
  blockHeight: height,
  blockHash: hex(height, 32),
  index,
  timestamp: 1_700_000_000 + height,
  from: OTHER,
  to: ME,
  status: 'success',
  revertReason: null,
  transfers: [],
  ...over,
});
const ROWS = [
  row(3, 0, {
    to: TOKEN,
    transfers: [
      {
        token: { address: TOKEN, symbol: 'TESTA', name: 'Test A', decimals: 6 },
        from: OTHER,
        to: ME,
        amount: 12_345_678_901_234_567_890_123n,
      },
      { token: { address: TOKEN, symbol: null, name: null, decimals: null }, from: ME, to: ME, amount: 1n },
    ],
  }),
  row(2, 1, { status: 'failed', revertReason: 'InsufficientOut', from: ME, to: OTHER }),
  row(1, 0),
];
const SAME: TokenFact[] = [
  { address: hex(1, 20), symbol: 'SAME', name: 'One', decimals: 18 },
  { address: hex(2, 20), symbol: 'same', name: null, decimals: null },
];

async function caller(over: Partial<IndexerRouterDeps> = {}, limit = '2') {
  const store = new MemoryProjectionStore(CHAIN_ID);
  await store.applyBlock({
    chainId: CHAIN_ID,
    height: 0,
    hash: hex(0x100, 32),
    parentHash: hex(0, 32),
    timestamp: 1_700_000_000,
    events: [],
  });
  const indexer = new Indexer({
    source: new MemoryChainSource(CHAIN_ID),
    store,
    finalityDepth: 2,
    ingestEnabled: () => true,
    startHeight: 0,
  });
  return createIndexerRouter({
    store,
    indexer,
    chainId: CHAIN_ID,
    finalityDepth: 2,
    ingestEnabled: () => true,
    chainSource: 'memory',
    explorer: memoryExplorerSource(parseExplorerListLimit(limit), []),
    address: {
      txs: async ({ cursor, limit: n }) =>
        ROWS.filter(
          (r) => cursor === undefined || r.blockHeight < cursor.height || (r.blockHeight === cursor.height && r.index < cursor.index),
        ).slice(0, n + 1),
      tokensBySymbol: async ({ symbol, limit: n }) => SAME.filter((t) => t.symbol?.toLowerCase() === symbol.toLowerCase()).slice(0, n + 1),
    },
    ...over,
  }).createCaller(anonymous());
}

describe('indexer.explorer.address.txs', () => {
  it('pages newest first with a cursor, amounts as raw decimal strings and a direction per transfer', async () => {
    const api = await caller();
    const first = await api.explorer.address.txs({ chainId: CHAIN_ID, address: ME.toUpperCase().replace('0X', '0x') });
    expect(first.rows.map((r) => r.hash)).toEqual([ROWS[0]?.hash, ROWS[1]?.hash]);
    expect(first.rows[0]?.transfers).toEqual([
      { token: { address: TOKEN, symbol: 'TESTA', decimals: 6 }, amount: '12345678901234567890123', direction: 'in' },
      { token: { address: TOKEN, symbol: null, decimals: null }, amount: '1', direction: 'self' },
    ]);
    expect(first.rows[1]).toMatchObject({ status: 'failed', revertReason: 'InsufficientOut', chainId: CHAIN_ID });
    expect(first.nextCursor).toEqual({ height: 2, index: 1, hash: ROWS[1]?.hash });
    expect(first.asOfHeight).toBe(0);
    const second = await api.explorer.address.txs({ chainId: CHAIN_ID, address: ME, cursor: first.nextCursor ?? undefined });
    expect(second.rows.map((r) => r.hash)).toEqual([ROWS[2]?.hash]);
    expect(second.nextCursor).toBeNull();
  });

  it('clamps a larger caller limit to the owner limit and reads another network as empty', async () => {
    const api = await caller();
    expect((await api.explorer.address.txs({ chainId: CHAIN_ID, address: ME, limit: 50 })).rows).toHaveLength(2);
    const elsewhere = await api.explorer.address.txs({ chainId: CHAIN_ID + 1, address: ME });
    expect(elsewhere).toMatchObject({ rows: [], nextCursor: null, asOfHeight: null });
  });

  it('refuses a blank owner limit and an unwired read by their codes', async () => {
    await expect((await caller({}, '')).explorer.address.txs({ chainId: CHAIN_ID, address: ME })).rejects.toThrow(
      userCopy(INDEXER_EXPLORER_LIST_LIMIT_UNSET),
    );
    await expect((await caller({ address: undefined })).explorer.address.txs({ chainId: CHAIN_ID, address: ME })).rejects.toThrow(
      userCopy(INDEXER_EXPLORER_UNWIRED),
    );
  });

  it('refuses an address that is not 40 hex digits', async () => {
    await expect((await caller()).explorer.address.txs({ chainId: CHAIN_ID, address: '0x1234' })).rejects.toThrow();
  });
});

describe('indexer.explorer.tokens.bySymbol', () => {
  it('lists every contract sharing a symbol, one row each, never merged', async () => {
    const answer = await (await caller()).explorer.tokens.bySymbol({ chainId: CHAIN_ID, symbol: 'Same' });
    expect(answer.rows).toEqual(SAME.map((t) => ({ ...t, chainId: CHAIN_ID })));
    expect(answer.more).toBe(false);
  });

  it('says more when the owner window cut the list, and reads another network as empty', async () => {
    const cut = await (await caller({}, '1')).explorer.tokens.bySymbol({ chainId: CHAIN_ID, symbol: 'SAME' });
    expect(cut.rows).toHaveLength(1);
    expect(cut.more).toBe(true);
    expect((await (await caller()).explorer.tokens.bySymbol({ chainId: CHAIN_ID + 1, symbol: 'SAME' })).rows).toEqual([]);
  });

  it('refuses a blank owner limit by its code', async () => {
    await expect((await caller({}, '')).explorer.tokens.bySymbol({ chainId: CHAIN_ID, symbol: 'SAME' })).rejects.toThrow(
      userCopy(INDEXER_EXPLORER_LIST_LIMIT_UNSET),
    );
  });

  it('counts the symbol limit in characters, so 32 emoji pass and a 33-character symbol is refused', async () => {
    const read = await caller();
    await expect(read.explorer.tokens.bySymbol({ chainId: CHAIN_ID, symbol: '\u{1F600}'.repeat(32) })).resolves.toMatchObject({ rows: [] });
    await expect(read.explorer.tokens.bySymbol({ chainId: CHAIN_ID, symbol: 'X'.repeat(33) })).rejects.toThrow();
    await expect(read.explorer.tokens.bySymbol({ chainId: CHAIN_ID, symbol: '   ' })).rejects.toThrow();
  });
});
