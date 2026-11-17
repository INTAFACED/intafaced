import { describe, expect, it, vi } from 'vitest';
import {
  CRYPTO_NATIVE_WATCHER_ID,
  CryptoChainWatcher,
  MemoryChainWatcherCursorStore,
  PostgresChainWatcherCursorStore,
  compareChainWatcherCursor,
  cursorOf,
  parseWatcherBlockNumber,
  type ChainWatcherChain,
  type WatcherSql,
} from './chain-watcher.js';
import type { FinalizedInbound } from './evm-chain.js';

/**
 * M226-03: failed webhook must not permanently drop finalization.
 * markFinalizedEmitted runs only after 2xx/202.
 *
 * Durable cursor: last-seen (block, hash, log index) survives a crash so
 * replay does not POST the same inbound twice (and therefore cannot
 * double-credit). Nothing here invents a deposit.
 */
describe('CryptoChainWatcher — delivery mark-after-success', () => {
  const secret = 'x'.repeat(32);
  const transfer = {
    txHash: '0xdead' as `0x${string}`,
    assetId: 'USDT',
    amount: 1_000_000n,
    from: '0x1111111111111111111111111111111111111111',
    confirmations: 6,
  };
  const address = '0x2222222222222222222222222222222222222222';
  const item: FinalizedInbound = { address, transfer, blockNumber: 100n, logIndex: 3 };

  function chainDouble(marked: string[], drain: () => FinalizedInbound[]): ChainWatcherChain {
    return {
      refresh: vi.fn(async () => undefined),
      drainFinalized: vi.fn(drain),
      markFinalizedEmitted: vi.fn((addr: string) => {
        marked.push(addr.toLowerCase());
      }),
    };
  }

  it('does not mark when webhook rejects; marks after success on retry', async () => {
    const marked: string[] = [];
    let drainCalls = 0;
    const chain = chainDouble(marked, () => {
      drainCalls += 1;
      if (marked.includes(address.toLowerCase())) return [];
      return [item];
    });

    let attempt = 0;
    const fetchImpl = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) return new Response('nope', { status: 500 });
      return new Response('ok', { status: 200 });
    });

    const watcher = new CryptoChainWatcher({
      chain,
      secret,
      webhookUrl: 'http://127.0.0.1:9/webhooks/crypto-native',
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(await watcher.tick()).toBe(1);
    expect(chain.markFinalizedEmitted).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    expect(await watcher.tick()).toBe(1);
    expect(chain.markFinalizedEmitted).toHaveBeenCalledWith(address);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    expect(await watcher.tick()).toBe(0);
    expect(drainCalls).toBeGreaterThanOrEqual(3);
  });

  it('treats 202 as success for mark', async () => {
    const marked: string[] = [];
    const chain = chainDouble(marked, () => (marked.length ? [] : [item]));
    const watcher = new CryptoChainWatcher({
      chain,
      secret,
      webhookUrl: 'http://127.0.0.1:9/webhooks/crypto-native',
      fetchImpl: (async () => new Response('', { status: 202 })) as typeof fetch,
    });
    await watcher.tick();
    expect(chain.markFinalizedEmitted).toHaveBeenCalledOnce();
  });

  it('POSTs amount as a decimal string, never a number', async () => {
    const marked: string[] = [];
    const chain = chainDouble(marked, () => (marked.length ? [] : [item]));
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(typeof body.amount).toBe('string');
      expect(body.amount).toBe('0.000000000001');
      return new Response('ok', { status: 200 });
    });
    const watcher = new CryptoChainWatcher({
      chain,
      secret,
      webhookUrl: 'http://127.0.0.1:9/webhooks/crypto-native',
      fetchImpl: fetchImpl as typeof fetch,
    });
    await watcher.tick();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('does not POST when drainFinalized is empty — never invents a deposit', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 200 }));
    const watcher = new CryptoChainWatcher({
      chain: chainDouble([], () => []),
      secret,
      webhookUrl: 'http://127.0.0.1:9/webhooks/crypto-native',
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(await watcher.tick()).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('CryptoChainWatcher — durable cursor; crash replay does not double-credit', () => {
  const secret = 'x'.repeat(32);
  const transfer = {
    txHash: '0xabc' as `0x${string}`,
    assetId: 'USDT',
    amount: 5_000_000n,
    from: '0x1111111111111111111111111111111111111111',
    confirmations: 12,
  };
  const address = '0x3333333333333333333333333333333333333333';
  const item: FinalizedInbound = { address, transfer, blockNumber: 42n, logIndex: 7 };

  it('persists last-seen block/hash/logIndex after a successful POST', async () => {
    const store = new MemoryChainWatcherCursorStore();
    const marked: string[] = [];
    const chain: ChainWatcherChain = {
      refresh: async () => undefined,
      drainFinalized: () => (marked.length ? [] : [item]),
      markFinalizedEmitted: (addr) => {
        marked.push(addr.toLowerCase());
      },
    };
    const watcher = new CryptoChainWatcher({
      chain,
      secret,
      webhookUrl: 'http://127.0.0.1:9/webhooks/crypto-native',
      cursorStore: store,
      fetchImpl: (async () => new Response('ok', { status: 200 })) as typeof fetch,
    });
    await watcher.tick();
    expect(await store.load(CRYPTO_NATIVE_WATCHER_ID)).toEqual({
      blockNumber: '42',
      txHash: '0xabc',
      logIndex: 7,
    });
  });

  it('does not persist the cursor when the webhook rejects', async () => {
    const store = new MemoryChainWatcherCursorStore();
    const chain: ChainWatcherChain = {
      refresh: async () => undefined,
      drainFinalized: () => [item],
      markFinalizedEmitted: vi.fn(),
    };
    const watcher = new CryptoChainWatcher({
      chain,
      secret,
      webhookUrl: 'http://127.0.0.1:9/webhooks/crypto-native',
      cursorStore: store,
      fetchImpl: (async () => new Response('nope', { status: 500 })) as typeof fetch,
    });
    await watcher.tick();
    expect(await store.load(CRYPTO_NATIVE_WATCHER_ID)).toBeNull();
    expect(chain.markFinalizedEmitted).not.toHaveBeenCalled();
  });

  it('a new watcher sharing the store does not POST the same inbound again', async () => {
    const store = new MemoryChainWatcherCursorStore();
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 200 }));
    const makeChain = (): { chain: ChainWatcherChain; marked: string[] } => {
      const marked: string[] = [];
      return {
        marked,
        chain: {
          refresh: async () => undefined,
          drainFinalized: () => (marked.length ? [] : [item]),
          markFinalizedEmitted: (addr) => {
            marked.push(addr.toLowerCase());
          },
        },
      };
    };

    const first = makeChain();
    await new CryptoChainWatcher({
      chain: first.chain,
      secret,
      webhookUrl: 'http://127.0.0.1:9/webhooks/crypto-native',
      cursorStore: store,
      fetchImpl: fetchImpl as typeof fetch,
    }).tick();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Crash: new process, empty in-memory mark set, durable cursor survives.
    const replay = makeChain();
    await new CryptoChainWatcher({
      chain: replay.chain,
      secret,
      webhookUrl: 'http://127.0.0.1:9/webhooks/crypto-native',
      cursorStore: store,
      fetchImpl: fetchImpl as typeof fetch,
    }).tick();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(replay.marked).toContain(address.toLowerCase());
  });

  it('refuses a non-decimal blockNumber rather than coercing a JSON number', () => {
    expect(() => parseWatcherBlockNumber('42.5')).toThrow(/decimal string/);
    expect(() => parseWatcherBlockNumber('0x10')).toThrow(/decimal string/);
    expect(parseWatcherBlockNumber('42')).toBe(42n);
    expect(compareChainWatcherCursor(cursorOf(item), { blockNumber: '42', txHash: '0xabc', logIndex: 7 })).toBe(0);
  });
});

describe('PostgresChainWatcherCursorStore — monotonic save (fake SQL)', () => {
  function fakeSql(): WatcherSql & { rows: Map<string, { last_block: string; last_tx_hash: string; last_log_index: number }> } {
    const rows = new Map<string, { last_block: string; last_tx_hash: string; last_log_index: number }>();
    const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?').toLowerCase();
      if (text.includes('insert into pay.chain_watcher_cursors')) {
        const id = String(values[0]);
        const block = String(values[1]);
        const hash = String(values[2]);
        const logIndex = Number(values[3]);
        const existing = rows.get(id);
        const incoming = { last_block: block, last_tx_hash: hash, last_log_index: logIndex };
        if (!existing) {
          rows.set(id, incoming);
          return [];
        }
        const advance =
          BigInt(block) > BigInt(existing.last_block) ||
          (block === existing.last_block && logIndex > existing.last_log_index) ||
          (block === existing.last_block && logIndex === existing.last_log_index && hash > existing.last_tx_hash);
        if (advance) rows.set(id, incoming);
        return [];
      }
      if (text.includes('select last_block')) {
        const id = String(values[0]);
        const v = rows.get(id);
        return v === undefined ? [] : [v];
      }
      throw new Error(`fakeSql unhandled: ${text}`);
    }) as unknown as WatcherSql & {
      rows: Map<string, { last_block: string; last_tx_hash: string; last_log_index: number }>;
    };
    sql.rows = rows;
    return sql;
  }

  it('loads what it saved and ignores a rewind', async () => {
    const store = new PostgresChainWatcherCursorStore(fakeSql());
    await store.save('crypto-native', { blockNumber: '10', txHash: '0xaaa', logIndex: 2 });
    await store.save('crypto-native', { blockNumber: '9', txHash: '0xbbb', logIndex: 99 });
    expect(await store.load('crypto-native')).toEqual({
      blockNumber: '10',
      txHash: '0xaaa',
      logIndex: 2,
    });
    await store.save('crypto-native', { blockNumber: '10', txHash: '0xccc', logIndex: 3 });
    expect(await store.load('crypto-native')).toEqual({
      blockNumber: '10',
      txHash: '0xccc',
      logIndex: 3,
    });
  });
});
