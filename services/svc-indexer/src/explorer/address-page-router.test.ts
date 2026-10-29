/**
 * Unit card — indexer.explorer.address.{summary, holdings, internal, balanceAt} (J-dex-protocol-09 #5)
 *
 * 1. Promise: the summary and holdings are the node's own answers at the newest canonical block indexed; a token that
 *    did not answer is null, never zero; a zero balance is no holding; no price source means every holding is unpriced.
 *    Internal moves page newest first and name the untraced blocks. A past balance is read at a stored block (by height
 *    or the end of a UTC day); a point outside the indexed blocks says so with the indexed range. Lost state and a dead
 *    node refuse with their own codes. Unwired refuses; another network reads empty.
 * 2. Break: a guessed zero, an invented price, a balance read at a block the indexer does not hold, a hidden gap.
 * 3. Done bar: the tests below.
 */
import { describe, expect, it } from 'vitest';
import { createEdgeContext } from '@intafaced/contracts';
import { MemoryChainSource } from '../chain/memory-source.js';
import { ChainUnavailableError } from '../chain/evm/availability.js';
import { StateUnavailableError, STATE_UNAVAILABLE } from '../chain/evm/address-state.js';
import { Indexer } from '../indexer.js';
import { MemoryProjectionStore } from '../projection/memory-store.js';
import { createIndexerRouter, type IndexerRouterDeps } from '../router.js';
import { CHAIN_ID } from '../testing/conformance.js';
import { userCopy } from '../user-copy.js';
import { INDEXER_EXPLORER_LIST_LIMIT_UNSET, INDEXER_EXPLORER_UNWIRED, memoryExplorerSource, parseExplorerListLimit } from './blocks.js';
import { endOfUtcDay, type AddressInternalFact, type AddressPageSource, type TokenFact } from './address.js';

const edgeContext = createEdgeContext({ secret: 'an-indexer-address-page-test-edge-secret', serviceName: 'svc-indexer' });
const anonymous = () => edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' });
const hex = (n: number, bytes: number) => `0x${n.toString(16).padStart(bytes * 2, '0')}`;
const ME = hex(0xab, 20);
const FWD = hex(0xfe, 20);
const [T1, T2, T3] = [hex(1, 20), hex(2, 20), hex(3, 20)] as [string, string, string];
const TOKENS: TokenFact[] = [
  { address: T1, symbol: 'TESTA', name: 'Test A', decimals: 6 },
  { address: T2, symbol: null, name: null, decimals: null },
  { address: T3, symbol: 'ZERO', name: 'Zero', decimals: 18 },
];
const INTERNAL: AddressInternalFact[] = [3, 2, 1].map((height) => ({
  hash: hex(height, 32),
  blockHeight: height,
  index: 0,
  timestamp: 1_700_000_000 + height,
  calls: [{ path: '0', kind: 'call' as const, from: FWD, to: ME, valueWei: 25n * 10n ** 16n }],
}));

interface Seen {
  account: Array<[string, number]>;
  balance: Array<[string, number]>;
  tokens: Array<[readonly string[], string, number]>;
}

function page(seen: Seen, over: Partial<AddressPageSource['state']> = {}): AddressPageSource {
  return {
    reads: {
      internal: async ({ cursor, limit }) =>
        INTERNAL.filter((r) => cursor === undefined || r.blockHeight < cursor.height).slice(0, limit + 1),
      traceGaps: async () => ({ blocks: 2, fromHeight: 1, toHeight: 2, reasons: ['indexer.trace_unavailable'] }),
      tokens: async ({ limit }) => TOKENS.slice(0, limit + 1),
      blockBefore: async (time) => (time.getTime() > 1_700_000_001_000 ? { height: 1, timestamp: 1_700_000_001 } : null),
      blockAt: async (height) => (height >= 0 && height <= 2 ? { height, timestamp: 1_700_000_000 + height } : null),
      earliestHeight: async () => 0,
    },
    state: {
      account: async (address, height) => {
        seen.account.push([address, height]);
        return { balanceWei: 10n ** 18n + 1n, isContract: false };
      },
      balance: async (address, height) => {
        seen.balance.push([address, height]);
        return 5n * 10n ** 17n;
      },
      tokenBalances: async (tokens, address, height) => {
        seen.tokens.push([tokens, address, height]);
        return tokens.map((t) => (t === T1 ? 1_500_000n : t === T2 ? null : 0n));
      },
      ...over,
    },
  };
}

async function caller(
  over: Partial<IndexerRouterDeps> = {},
  heads = 3,
  state: Partial<AddressPageSource['state']> = {},
  time = (h: number) => 1_700_000_000 + h,
) {
  const seen: Seen = { account: [], balance: [], tokens: [] };
  const store = new MemoryProjectionStore(CHAIN_ID);
  let parent = hex(0, 32);
  for (let h = 0; h < heads; h++) {
    const hash = hex(0x100 + h, 32);
    await store.applyBlock({ chainId: CHAIN_ID, height: h, hash, parentHash: parent, timestamp: time(h), events: [] });
    parent = hash;
  }
  const indexer = new Indexer({
    source: new MemoryChainSource(CHAIN_ID),
    store,
    finalityDepth: 2,
    ingestEnabled: () => true,
    startHeight: 0,
  });
  const api = createIndexerRouter({
    store,
    indexer,
    chainId: CHAIN_ID,
    finalityDepth: 2,
    ingestEnabled: () => true,
    chainSource: 'memory',
    explorer: memoryExplorerSource(parseExplorerListLimit('10'), []),
    addressPage: page(seen, state),
    ...over,
  }).createCaller(anonymous());
  return { api, seen };
}

const input = { chainId: CHAIN_ID, address: ME.toUpperCase().replace('0X', '0x') };

describe('indexer.explorer.address.summary', () => {
  it("reads the node's balance and kind at the newest canonical block indexed", async () => {
    const { api, seen } = await caller();
    const out = await api.explorer.address.summary(input);
    expect(out).toMatchObject({ kind: 'account', balance: '1000000000000000001', asOfHeight: 2 });
    expect(seen.account).toEqual([[ME, 2]]);
  });

  it('reads a contract as a contract', async () => {
    const { api } = await caller({}, 3, { account: async () => ({ balanceWei: 0n, isContract: true }) });
    expect(await api.explorer.address.summary(input)).toMatchObject({ kind: 'contract', balance: '0' });
  });

  it('reads nothing before the first block or on another network', async () => {
    const empty = await caller({}, 0);
    expect(await empty.api.explorer.address.summary(input)).toMatchObject({ kind: null, balance: null, asOfHeight: null });
    expect(empty.seen.account).toEqual([]);
    const { api, seen } = await caller();
    expect(await api.explorer.address.summary({ ...input, chainId: CHAIN_ID + 1 })).toMatchObject({ kind: null, balance: null });
    expect(seen.account).toEqual([]);
  });

  it('refuses lost state and a dead node with their own codes, never a zero', async () => {
    const lost = await caller({}, 3, {
      account: async (_a, height) => {
        throw new StateUnavailableError(height);
      },
    });
    await expect(lost.api.explorer.address.summary(input)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: userCopy(STATE_UNAVAILABLE),
      cause: { code: STATE_UNAVAILABLE },
    });
    const dead = await caller({}, 3, {
      account: async () => {
        throw new ChainUnavailableError('indexer.chain_unreachable', 'no answer');
      },
    });
    await expect(dead.api.explorer.address.summary(input)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      cause: { code: 'indexer.chain_unreachable' },
    });
  });

  it('refuses unwired', async () => {
    const { api } = await caller({ addressPage: undefined });
    await expect(api.explorer.address.summary(input)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: userCopy(INDEXER_EXPLORER_UNWIRED),
    });
  });
});

describe('indexer.explorer.address.holdings', () => {
  it("lists each token's own balance at the head; null where the contract did not answer; no zero; every holding that answered is unpriced", async () => {
    const { api, seen } = await caller();
    const out = await api.explorer.address.holdings(input);
    expect(out.rows).toEqual([
      { token: { address: T1, symbol: 'TESTA', decimals: 6 }, balance: '1500000', price: null },
      { token: { address: T2, symbol: null, decimals: null }, balance: null, price: null },
    ]);
    expect(out).toMatchObject({ unpriced: 1, more: false, asOfHeight: 2 });
    expect(seen.tokens).toEqual([[[T1, T2, T3], ME, 2]]);
  });

  it('is owner-bounded: the window cuts the tokens read and says more', async () => {
    const { api, seen } = await caller({ explorer: memoryExplorerSource(parseExplorerListLimit('1'), []) });
    const out = await api.explorer.address.holdings(input);
    expect(out.rows.map((r) => r.token.address)).toEqual([T1]);
    expect(out.more).toBe(true);
    expect(seen.tokens[0]?.[0]).toEqual([T1]);
  });

  it('refuses a blank owner window with its code', async () => {
    const { api } = await caller({ explorer: memoryExplorerSource(parseExplorerListLimit(''), []) });
    await expect(api.explorer.address.holdings(input)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: userCopy(INDEXER_EXPLORER_LIST_LIMIT_UNSET),
    });
  });
});

describe('indexer.explorer.address.internal', () => {
  it('pages internal moves newest first with their values as wei strings, and names the untraced blocks', async () => {
    const { api } = await caller({ explorer: memoryExplorerSource(parseExplorerListLimit('2'), []) });
    const first = await api.explorer.address.internal(input);
    expect(first.rows.map((r) => r.blockHeight)).toEqual([3, 2]);
    expect(first.rows[0]?.calls).toEqual([{ path: '0', kind: 'call', from: FWD, to: ME, value: '250000000000000000' }]);
    expect(first.nextCursor).toEqual({ height: 2, index: 0, hash: hex(2, 32) });
    expect(first.gaps).toEqual({ blocks: 2, fromHeight: 1, toHeight: 2, reasons: ['indexer.trace_unavailable'] });
    const next = await api.explorer.address.internal({ ...input, cursor: first.nextCursor! });
    expect(next.rows.map((r) => r.blockHeight)).toEqual([1]);
    expect(next.nextCursor).toBeNull();
  });

  it('reads empty on another network, with no gaps of this one', async () => {
    const { api } = await caller();
    const out = await api.explorer.address.internal({ ...input, chainId: CHAIN_ID + 1 });
    expect(out).toMatchObject({
      rows: [],
      nextCursor: null,
      gaps: { blocks: 0, fromHeight: null, toHeight: null, reasons: [] },
      asOfHeight: null,
    });
  });
});

describe('indexer.explorer.address.balanceAt', () => {
  it('reads the balance at a stored block by height', async () => {
    const { api, seen } = await caller();
    expect(await api.explorer.address.balanceAt({ ...input, at: { height: 1 } })).toEqual({
      indexed: true,
      height: 1,
      timestamp: 1_700_000_001,
      balance: '500000000000000000',
    });
    expect(seen.balance).toEqual([[ME, 1]]);
  });

  it('reads the balance at the end of a UTC day: the last block before the next midnight', async () => {
    // Block 2 is after 2023-11-15T00:00Z, so the whole of 2023-11-14 is indexed.
    const { api, seen } = await caller({}, 3, {}, (h) => (h < 2 ? 1_700_000_000 + h : 1_700_010_000));
    expect(await api.explorer.address.balanceAt({ ...input, at: { date: '2023-11-14' } })).toMatchObject({ indexed: true, height: 1 });
    expect(seen.balance).toEqual([[ME, 1]]);
  });

  it('says a point outside the indexed blocks is not indexed, with the range, and reads nothing', async () => {
    const { api, seen } = await caller();
    expect(await api.explorer.address.balanceAt({ ...input, at: { date: '2001-01-01' } })).toEqual({
      indexed: false,
      after: false,
      earliestHeight: 0,
      latestHeight: 2,
    });
    expect(await api.explorer.address.balanceAt({ ...input, at: { height: 9 } })).toEqual({
      indexed: false,
      after: true,
      earliestHeight: 0,
      latestHeight: 2,
    });
    expect(seen.balance).toEqual([]);
  });

  it('a day not yet over in the index is not indexed after the newest block, never the newest balance', async () => {
    // The newest block (2) is at 2023-11-14T22:13:22Z: that day has not ended in the index, and later days are ahead.
    const { api, seen } = await caller();
    for (const date of ['2023-11-14', '2099-01-01']) {
      expect(await api.explorer.address.balanceAt({ ...input, at: { date } })).toEqual({
        indexed: false,
        after: true,
        earliestHeight: 0,
        latestHeight: 2,
      });
    }
    expect(seen.balance).toEqual([]);
  });

  it('refuses a height past what a safe integer holds, before any read', async () => {
    const { api, seen } = await caller();
    await expect(api.explorer.address.balanceAt({ ...input, at: { height: 1e300 } })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(seen.balance).toEqual([]);
  });

  it('refuses a date that does not exist', async () => {
    const { api } = await caller();
    await expect(api.explorer.address.balanceAt({ ...input, at: { date: '2026-02-30' } })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(api.explorer.address.balanceAt({ ...input, at: { date: 'yesterday' } })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('refuses lost state at that block with its code', async () => {
    const { api } = await caller({}, 3, {
      balance: async (_a, height) => {
        throw new StateUnavailableError(height);
      },
    });
    await expect(api.explorer.address.balanceAt({ ...input, at: { height: 0 } })).rejects.toMatchObject({
      cause: { code: STATE_UNAVAILABLE },
    });
  });
});

describe('endOfUtcDay', () => {
  it('is the next UTC midnight, and null for a date that does not exist', () => {
    expect(endOfUtcDay('2026-01-01')?.toISOString()).toBe('2026-01-02T00:00:00.000Z');
    expect(endOfUtcDay('2024-02-29')?.toISOString()).toBe('2024-03-01T00:00:00.000Z');
    expect(endOfUtcDay('2025-02-29')).toBeNull();
    expect(endOfUtcDay('2026-1-1')).toBeNull();
  });
});
