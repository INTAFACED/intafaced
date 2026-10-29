import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  INDEXER_SEARCH_NETWORKS_INVALID,
  parseSearchNetworks,
  searchNetworkFinders,
  SearchNetworksInvalidError,
} from './search-networks.js';

const HASH = `0x${'ab'.repeat(32)}`;
const OTHER = `0x${'cd'.repeat(32)}`;

describe('INDEXER_SEARCH_NETWORKS', () => {
  it('blank is no other network, never an invented one', () => {
    expect(parseSearchNetworks(undefined, 84532)).toEqual([]);
    expect(parseSearchNetworks('  ', 84532)).toEqual([]);
  });
  it('reads each network once, by its chain id and node', () => {
    expect(parseSearchNetworks('[{"chainId":31337,"rpcUrl":"http://127.0.0.1:14533"}]', 84532)).toEqual([
      { chainId: 31337, rpcUrl: 'http://127.0.0.1:14533/' },
    ]);
  });
  it.each([
    ['not JSON', '[{'],
    ['not a list', '{"chainId":1}'],
    ['a chain id that is not a positive integer', '[{"chainId":"1","rpcUrl":"http://a"}]'],
    ['a zero chain id', '[{"chainId":0,"rpcUrl":"http://a"}]'],
    ['the followed network again', '[{"chainId":84532,"rpcUrl":"http://a"}]'],
    ['a network twice', '[{"chainId":1,"rpcUrl":"http://a"},{"chainId":1,"rpcUrl":"http://b"}]'],
    ['a node that is not a URL', '[{"chainId":1,"rpcUrl":"node"}]'],
    ['a node that is not http', '[{"chainId":1,"rpcUrl":"file:///etc/passwd"}]'],
    ['more than eight networks', JSON.stringify(Array.from({ length: 9 }, (_, i) => ({ chainId: i + 1, rpcUrl: 'http://a' })))],
  ])('refuses %s with its code, so the service does not start', (_, raw) => {
    let thrown: unknown;
    try {
      parseSearchNetworks(raw, 84532);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SearchNetworksInvalidError);
    expect((thrown as SearchNetworksInvalidError).code).toBe(INDEXER_SEARCH_NETWORKS_INVALID);
  });
});

/** A node over real HTTP, so the lookup runs through viem's own transport: it answers as `chainId` and holds `txs`. */
let servers: Server[] = [];
async function node(chainId: number, txs: Record<string, { block: number | null; status?: '0x1' | '0x0' }>) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const { id, method, params } = JSON.parse(body) as { id: number; method: string; params: string[] };
      const hash = params?.[0];
      const tx = typeof hash === 'string' ? txs[hash] : undefined;
      let result: unknown = null;
      if (method === 'eth_chainId') result = `0x${chainId.toString(16)}`;
      if (method === 'eth_getTransactionByHash' && tx) {
        const mined = tx.block !== null;
        result = {
          hash,
          from: `0x${'1'.repeat(40)}`,
          to: null,
          value: '0x0',
          nonce: '0x0',
          gas: '0x5208',
          gasPrice: '0x1',
          input: '0x',
          type: '0x0',
          v: '0x1b',
          r: '0x1',
          s: '0x1',
          blockHash: mined ? `0x${'e'.repeat(64)}` : null,
          blockNumber: mined ? `0x${tx.block!.toString(16)}` : null,
          transactionIndex: mined ? '0x0' : null,
        };
      }
      if (method === 'eth_getTransactionReceipt' && tx && tx.block !== null) {
        result = {
          transactionHash: hash,
          transactionIndex: '0x0',
          blockHash: `0x${'e'.repeat(64)}`,
          blockNumber: `0x${tx.block.toString(16)}`,
          from: `0x${'1'.repeat(40)}`,
          to: null,
          cumulativeGasUsed: '0x5208',
          gasUsed: '0x5208',
          effectiveGasPrice: '0x1',
          contractAddress: null,
          logs: [],
          logsBloom: `0x${'0'.repeat(512)}`,
          status: tx.status ?? '0x1',
          type: '0x0',
        };
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A port that was listening and is now closed: the node does not answer. */
async function closedPort() {
  const url = await node(1, {});
  const server = servers.pop()!;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return url;
}

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  servers = [];
});

describe('a hash looked up on each listed network', () => {
  it('found on each network that holds it, with its block and outcome; not found where it is absent', async () => {
    const [a, b] = await Promise.all([node(31337, { [HASH]: { block: 7 } }), node(5, { [HASH]: { block: 9, status: '0x0' } })]);
    const finders = searchNetworkFinders([
      { chainId: 31337, rpcUrl: a },
      { chainId: 5, rpcUrl: b },
    ]);
    expect(await Promise.all(finders.map(({ find }) => find(HASH)))).toEqual([
      { chainId: 31337, state: 'found', pending: false, blockHeight: 7, status: 'success' },
      { chainId: 5, state: 'found', pending: false, blockHeight: 9, status: 'failed' },
    ]);
    expect(await Promise.all(finders.map(({ find }) => find(OTHER)))).toEqual([
      { chainId: 31337, state: 'not_found' },
      { chainId: 5, state: 'not_found' },
    ]);
  });
  it('a hash still in the mempool is found and pending, with no block', async () => {
    const [finder] = searchNetworkFinders([{ chainId: 31337, rpcUrl: await node(31337, { [HASH]: { block: null } }) }]);
    expect(await finder!.find(HASH)).toEqual({ chainId: 31337, state: 'found', pending: true, blockHeight: null, status: null });
  });
  it('a node that does not answer is not checked with its code, never not found', async () => {
    const [finder] = searchNetworkFinders([{ chainId: 31337, rpcUrl: await closedPort() }]);
    expect(await finder!.find(HASH)).toEqual({ chainId: 31337, state: 'not_checked', code: 'indexer.chain_unreachable' });
  });
  it('a node that answers as another chain is not checked, even though it holds the hash', async () => {
    const [finder] = searchNetworkFinders([{ chainId: 31337, rpcUrl: await node(1, { [HASH]: { block: 3 } }) }]);
    expect(await finder!.find(HASH)).toEqual({ chainId: 31337, state: 'not_checked', code: 'indexer.chain_id_mismatch' });
  });
});
