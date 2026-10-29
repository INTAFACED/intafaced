import { createPublicClient, http, type Hex, type PublicClient } from 'viem';
import { ChainUnavailableError, classifyChainError } from '../chain/evm/availability.js';

/**
 * D-explorer-02. The other networks a transaction hash is looked up on, beside the one this indexer follows. They are
 * not indexed: each search asks that network's node for the hash, live. Blank means none: the search answers for the
 * followed network alone and names no other network as checked. Never a public endpoint chosen here.
 */
export const INDEXER_SEARCH_NETWORKS_INVALID = 'indexer.search_networks_invalid' as const;

/** One search waits this long for each node; a node slower than that did not answer. */
export const SEARCH_TIMEOUT_MS = 5_000;

/** A search fans out to every listed node per request, so the list stays short. */
const SEARCH_NETWORKS_MAX = 8;

export interface SearchNetwork {
  readonly chainId: number;
  readonly rpcUrl: string;
}

export class SearchNetworksInvalidError extends Error {
  readonly code = INDEXER_SEARCH_NETWORKS_INVALID;
  constructor(detail: string) {
    super(`INDEXER_SEARCH_NETWORKS is not a usable list (${detail}). Expected JSON [{"chainId":<id>,"rpcUrl":"http…"}].`);
    this.name = 'SearchNetworksInvalidError';
  }
}

/**
 * Parsed at boot: a malformed list refuses to start rather than searching a network nobody named. The followed network
 * may not be listed again, and a network is listed once.
 */
export function parseSearchNetworks(raw: string | undefined, followedChainId: number): SearchNetwork[] {
  const text = raw?.trim() ?? '';
  if (text === '') return [];
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new SearchNetworksInvalidError('not JSON');
  }
  if (!Array.isArray(value)) throw new SearchNetworksInvalidError('not a list');
  if (value.length > SEARCH_NETWORKS_MAX) throw new SearchNetworksInvalidError(`more than ${SEARCH_NETWORKS_MAX} networks`);
  const seen = new Set<number>([followedChainId]);
  return value.map((entry, i) => {
    const { chainId, rpcUrl } = (entry ?? {}) as { chainId?: unknown; rpcUrl?: unknown };
    if (typeof chainId !== 'number' || !Number.isSafeInteger(chainId) || chainId < 1) {
      throw new SearchNetworksInvalidError(`entry ${i}: chainId is not a positive integer`);
    }
    if (seen.has(chainId)) throw new SearchNetworksInvalidError(`entry ${i}: chain ${chainId} is listed twice or is the followed one`);
    seen.add(chainId);
    let url: URL;
    try {
      url = new URL(typeof rpcUrl === 'string' ? rpcUrl : '');
    } catch {
      throw new SearchNetworksInvalidError(`entry ${i}: rpcUrl is not a URL`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SearchNetworksInvalidError(`entry ${i}: rpcUrl is not http(s)`);
    return { chainId, rpcUrl: url.toString() };
  });
}

export type NetworkAnswer =
  | { chainId: number; state: 'found'; pending: boolean; blockHeight: number | null; status: 'success' | 'failed' | null }
  | { chainId: number; state: 'not_found' }
  | { chainId: number; state: 'not_checked'; code: string };

export type FindTx = (hash: string) => Promise<NetworkAnswer>;

function isNotFound(err: unknown): boolean {
  const name = err instanceof Error ? err.name : '';
  return name === 'TransactionNotFoundError' || name === 'TransactionReceiptNotFoundError';
}

/**
 * Asks one network's node for a hash. The node must first say it is that network: a node on another chain could hold
 * the same hash, and its answer is not this network's. Any failure is "not checked" with its typed code, never "not found".
 */
export async function findTxOn(client: PublicClient, network: SearchNetwork, hash: string): Promise<NetworkAnswer> {
  const id = hash.toLowerCase() as Hex;
  try {
    const observed = await client.getChainId();
    if (observed !== network.chainId) return { chainId: network.chainId, state: 'not_checked', code: 'indexer.chain_id_mismatch' };
    let tx;
    try {
      tx = await client.getTransaction({ hash: id });
    } catch (err) {
      if (isNotFound(err)) return { chainId: network.chainId, state: 'not_found' };
      throw err;
    }
    if (tx.blockNumber === null) return { chainId: network.chainId, state: 'found', pending: true, blockHeight: null, status: null };
    const receipt = await client.getTransactionReceipt({ hash: id });
    return {
      chainId: network.chainId,
      state: 'found',
      pending: false,
      blockHeight: Number(tx.blockNumber),
      status: receipt.status === 'success' ? 'success' : 'failed',
    };
  } catch (err) {
    const failure = err instanceof ChainUnavailableError ? err : classifyChainError(err, `search(${id})`, network.rpcUrl);
    return { chainId: network.chainId, state: 'not_checked', code: failure.code };
  }
}

/** One lookup per listed network, each with its own short-timeout client so one slow node cannot hold the others. */
export function searchNetworkFinders(networks: readonly SearchNetwork[]): Array<{ chainId: number; find: FindTx }> {
  return networks.map((network) => {
    const client = createPublicClient({ transport: http(network.rpcUrl, { timeout: SEARCH_TIMEOUT_MS, retryCount: 0 }) });
    return { chainId: network.chainId, find: (hash: string) => findTxOn(client, network, hash) };
  });
}
