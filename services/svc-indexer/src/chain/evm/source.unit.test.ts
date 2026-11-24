import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import { EvmChainSource, assertLogsBoundToBlock } from './source.js';
import { ChainUnavailableError } from './availability.js';
import type { RawLog } from './decode.js';

/**
 * CONSTRUCTION AND DEAD-ENDPOINT REFUSALS — always on, no anvil.
 *
 * The live suite (`source.live.test.ts`) already asserts these shapes, but
 * only when a chain answers at boot. Without that gate, a dark or dead chain
 * would leave the promise unproven on every clean clone and every CI run that
 * does not bring anvil up first.
 *
 * These tests need no JSON-RPC answer:
 *   · empty URL / zero venue are pure constructor checks
 *   · a dead TCP port is enough to force `head()` / `blockAt()` through the real
 *     transport and prove the refusal is a throw, not `null`
 *   · getLogs answer binding is pure over log shapes
 */

const VENUE: Address = '0x1111111111111111111111111111111111111111';
const ZERO: Address = '0x0000000000000000000000000000000000000000';
const HASH: Hex = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER: Hex = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

/** A port nothing is listening on — bound to learn the number, then released. */
async function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'string' || address === null) {
        server.close();
        reject(new Error('no port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

function fakeLog(over: Partial<RawLog> = {}): RawLog {
  return {
    address: VENUE,
    blockHash: HASH,
    blockNumber: 7n,
    data: '0x',
    logIndex: 0,
    removed: false,
    topics: [],
    transactionHash: HASH,
    transactionIndex: 0,
    ...over,
  } as RawLog;
}

describe('EvmChainSource · refuse a dark chain at construct (no RPC)', () => {
  it('refuses an empty RPC URL with indexer.chain_not_configured', () => {
    expect(() => new EvmChainSource({ chainId: 31337, rpcUrl: '', venue: VENUE })).toThrow(ChainUnavailableError);
    try {
      new EvmChainSource({ chainId: 31337, rpcUrl: '', venue: VENUE });
    } catch (err) {
      expect(err).toMatchObject({ code: 'indexer.chain_not_configured' });
      expect((err as Error).message).toMatch(/RPC URL|NullChainSource/i);
    }
  });

  /**
   * `eth_getLogs` against 0x0 succeeds and returns [] forever. Without this
   * check the projection would stay empty and every read would report an empty
   * book with total confidence — the quietest failure available to a log decoder.
   */
  it('refuses a zero venue address with indexer.venue_unset, before any RPC', () => {
    expect(() => new EvmChainSource({ chainId: 31337, rpcUrl: 'http://127.0.0.1:8545', venue: ZERO })).toThrow(ChainUnavailableError);
    try {
      new EvmChainSource({ chainId: 31337, rpcUrl: 'http://127.0.0.1:8545', venue: ZERO });
    } catch (err) {
      expect(err).toMatchObject({ code: 'indexer.venue_unset' });
      expect((err as Error).message).toMatch(/zero address/i);
    }
  });
});

describe('EvmChainSource · dead endpoint throws, never null', () => {
  /**
   * The refusal that must never be `null`. A dead endpoint returning "no chain"
   * would be indistinguishable from `NullChainSource`: the loop would idle, the
   * cursor would freeze, and `book` would keep serving its last projection as
   * current with nothing anywhere saying otherwise.
   *
   * Uses a real TCP port with nothing listening — so the error classified is
   * one the network produced, not one a test wrote down.
   */
  it('throws indexer.chain_unreachable from head() when nothing answers', async () => {
    const port = await closedPort();
    const dead = new EvmChainSource({
      chainId: 31337,
      rpcUrl: `http://127.0.0.1:${port}`,
      venue: VENUE,
      requestTimeoutMs: 2_000,
    });

    await expect(dead.head()).rejects.toMatchObject({ code: 'indexer.chain_unreachable' });
    // Explicit: the promise rejects — it does not resolve to null.
    let resolved: unknown = 'did-not-settle';
    try {
      resolved = await dead.head();
    } catch (err) {
      expect(err).toBeInstanceOf(ChainUnavailableError);
      expect((err as ChainUnavailableError).code).toBe('indexer.chain_unreachable');
      resolved = 'threw';
    }
    expect(resolved).toBe('threw');
  }, 30_000);

  /**
   * Promise: README + source.ts — failures never come back as null.
   * head() is pinned; blockAt is the cold-start / catch-up path. If it
   * swallowed a dead RPC into null, cold start would idle forever as
   * "no block at startHeight yet" instead of recording chain_unreachable.
   */
  it('throws indexer.chain_unreachable from blockAt(0) when nothing answers', async () => {
    const port = await closedPort();
    const dead = new EvmChainSource({
      chainId: 31337,
      rpcUrl: `http://127.0.0.1:${port}`,
      venue: VENUE,
      requestTimeoutMs: 2_000,
    });

    await expect(dead.blockAt(0)).rejects.toMatchObject({ code: 'indexer.chain_unreachable' });
    let resolved: unknown = 'did-not-settle';
    try {
      resolved = await dead.blockAt(0);
    } catch (err) {
      expect(err).toBeInstanceOf(ChainUnavailableError);
      expect((err as ChainUnavailableError).code).toBe('indexer.chain_unreachable');
      resolved = 'threw';
    }
    expect(resolved).toBe('threw');
  }, 30_000);
});

/**
 * A node that answers, with no code at the venue, and getLogs [] forever.
 *
 * This is the suiteDeployed-worse shape: eth_getLogs succeeds with an empty
 * array. Without #verifyVenue the adapter would return a block with events: []
 * and the projection would paint a confident empty book. Always-on — no anvil.
 */
function missingVenueBlock() {
  return {
    number: '0x1',
    hash: HASH,
    parentHash: OTHER,
    timestamp: '0x64',
    transactions: [],
    miner: ZERO,
    nonce: '0x0000000000000000',
    sha3Uncles: HASH,
    logsBloom: `0x${'0'.repeat(512)}`,
    stateRoot: HASH,
    receiptsRoot: HASH,
    transactionsRoot: HASH,
    difficulty: '0x0',
    gasLimit: '0x1c9c380',
    gasUsed: '0x0',
    extraData: '0x',
    mixHash: HASH,
    size: '0x200',
    totalDifficulty: '0x0',
    uncles: [],
    baseFeePerGas: '0x1',
  };
}

function rpcResultFor(method: string, chainId: string): unknown {
  if (method === 'eth_chainId') return chainId;
  if (method === 'eth_blockNumber') return '0x1';
  if (method === 'eth_getCode') return '0x';
  if (method === 'eth_getLogs') return [];
  if (method === 'eth_getBlockByNumber' || method === 'eth_getBlockByHash') return missingVenueBlock();
  return null;
}

async function missingVenueRpc(): Promise<{
  url: string;
  methods: string[];
  /** The chain id the endpoint answers with; change it to play a proxy or fleet swap. */
  answers: { chainId: string };
  close: () => Promise<void>;
}> {
  const methods: string[] = [];
  const answers = { chainId: '0x7a69' };
  const server = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = chunks.length > 0 ? Buffer.concat(chunks).toString('utf8') : '';
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }
      const batch = Array.isArray(parsed);
      const entries = batch ? parsed : [parsed];
      const replies = (entries as Array<{ id?: unknown; method?: unknown }>).map((entry) => {
        const method = typeof entry.method === 'string' ? entry.method : 'unknown';
        methods.push(method);
        return { jsonrpc: '2.0', id: entry.id ?? 1, result: rpcResultFor(method, answers.chainId) };
      });
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify(batch ? replies : replies[0]));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    methods,
    answers,
    close: () =>
      new Promise((resolve, reject) => {
        // viem's HTTP agent keep-alives; without this, vitest waits on open
        // sockets and CI Tests never finish (observed on #2232).
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
        }
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

describe('EvmChainSource · missing venue code never paints an empty book', () => {
  it('refuses head() with indexer.venue_not_deployed even though getLogs would return []', async () => {
    const rpc = await missingVenueRpc();
    try {
      const source = new EvmChainSource({ chainId: 31337, rpcUrl: rpc.url, venue: VENUE, requestTimeoutMs: 5_000 });
      let settled: unknown = 'did-not-settle';
      try {
        settled = await source.head();
      } catch (err) {
        expect(err).toBeInstanceOf(ChainUnavailableError);
        expect(err).toMatchObject({ code: 'indexer.venue_not_deployed' });
        expect((err as Error).message).toMatch(/empty book|no contract code/i);
        settled = 'threw';
      }
      expect(settled).toBe('threw');
      expect(rpc.methods).toContain('eth_getCode');
      expect(rpc.methods).not.toContain('eth_getLogs');
    } finally {
      await rpc.close();
    }
  }, 30_000);

  it('refuses blockAt() — never a ChainBlock with events: [] from an empty address', async () => {
    const rpc = await missingVenueRpc();
    try {
      const source = new EvmChainSource({ chainId: 31337, rpcUrl: rpc.url, venue: VENUE, requestTimeoutMs: 5_000 });
      let painted: unknown = 'did-not-settle';
      try {
        painted = await source.blockAt(1);
      } catch (err) {
        expect(err).toBeInstanceOf(ChainUnavailableError);
        expect(err).toMatchObject({ code: 'indexer.venue_not_deployed' });
        painted = 'threw';
      }
      // If #verifyVenue is deleted, this resolves to { events: [] } and fails here.
      expect(painted).toBe('threw');
      expect(painted).not.toMatchObject({ events: [] });
      expect(rpc.methods).toContain('eth_getCode');
      expect(rpc.methods).not.toContain('eth_getLogs');
    } finally {
      await rpc.close();
    }
  }, 30_000);

  it('probe names venue_not_deployed — reachable node, not a quiet healthy book', async () => {
    const rpc = await missingVenueRpc();
    try {
      const source = new EvmChainSource({ chainId: 31337, rpcUrl: rpc.url, venue: VENUE, requestTimeoutMs: 5_000 });
      const probe = await source.probe();
      expect(probe).toMatchObject({
        kind: 'evm',
        reachable: true,
        venueDeployed: false,
        refusalCode: 'indexer.venue_not_deployed',
      });
      expect(probe.reason).toMatch(/empty book|no contract code/i);
    } finally {
      await rpc.close();
    }
  }, 30_000);
});

describe('assertLogsBoundToBlock · getLogs answer must match the request', () => {
  const expected = { hash: HASH, venue: VENUE, height: 7, rpcUrl: 'http://rpc.test' };

  it('accepts empty logs and matching logs', () => {
    expect(() => assertLogsBoundToBlock([], expected)).not.toThrow();
    expect(() => assertLogsBoundToBlock([fakeLog()], expected)).not.toThrow();
  });

  it('refuses a log whose blockHash does not match the one we asked for', () => {
    expect(() => assertLogsBoundToBlock([fakeLog({ blockHash: OTHER })], expected)).toThrow(ChainUnavailableError);
    try {
      assertLogsBoundToBlock([fakeLog({ blockHash: OTHER })], expected);
    } catch (err) {
      expect(err).toMatchObject({ code: 'indexer.malformed_block' });
      expect((err as Error).message).toMatch(/blockHash|foreign/i);
    }
  });

  it('refuses a removed log the node admits is gone', () => {
    expect(() => assertLogsBoundToBlock([fakeLog({ removed: true })], expected)).toThrow(/removed/i);
  });

  it('refuses a log from a different address than the venue filter', () => {
    const otherVenue = '0x2222222222222222222222222222222222222222' as Address;
    expect(() => assertLogsBoundToBlock([fakeLog({ address: otherVenue })], expected)).toThrow(/another contract/i);
  });

  it('refuses a log whose blockNumber does not match the height we asked for', () => {
    expect(() => assertLogsBoundToBlock([fakeLog({ blockNumber: 99n })], expected)).toThrow(/height 99/i);
  });

  it('refuses a log with no blockNumber — height bind is not optional', () => {
    // Runtime null (node sometimes) is not in viem's Log type — cast for the refuse path.
    const missing = { ...fakeLog(), blockNumber: null } as unknown as RawLog;
    expect(() => assertLogsBoundToBlock([missing], expected)).toThrow(/no blockNumber/i);
    expect(() => assertLogsBoundToBlock([fakeLog({ blockNumber: undefined })], expected)).toThrow(/no blockNumber/i);
    try {
      assertLogsBoundToBlock([missing], expected);
    } catch (err) {
      expect(err).toMatchObject({ code: 'indexer.malformed_block' });
    }
  });
});

describe('EvmChainSource · the chain id is re-asked every pass, never latched', () => {
  it('asks eth_chainId on each assertChainId() and refuses an endpoint that later answers for another chain', async () => {
    const rpc = await missingVenueRpc();
    try {
      const source = new EvmChainSource({ chainId: 31337, rpcUrl: rpc.url, venue: VENUE, requestTimeoutMs: 5_000 });
      await expect(source.assertChainId()).resolves.toBe(31337);
      await expect(source.assertChainId()).resolves.toBe(31337);
      expect(rpc.methods.filter((m) => m === 'eth_chainId')).toHaveLength(2);

      // The same URL now answers for chain 1 (a proxy or fleet swap). A latch on the first success would miss it.
      rpc.answers.chainId = '0x1';
      await expect(source.assertChainId()).rejects.toMatchObject({ code: 'indexer.chain_id_mismatch' });
      expect(rpc.methods.filter((m) => m === 'eth_chainId')).toHaveLength(3);
    } finally {
      await rpc.close();
    }
  }, 30_000);
});
