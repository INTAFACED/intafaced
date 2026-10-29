import { createPublicClient, http, type Hex, type PublicClient } from 'viem';
import { ChainUnavailableError, classifyChainError } from '../chain/evm/availability.js';

/**
 * D-explorer-02. The other networks a transaction hash is looked up on, beside the one this indexer follows. They are
 * not indexed: each search asks that network's node for the hash, live. Blank means none: the search answers for the
 * followed network alone and names no other network as checked. Never a public endpoint chosen here.
 */
export const INDEXER_SEARCH_NETWORKS_INVALID = 'indexer.search_networks_invalid' as const;

/** Each call to a node waits this long; a node slower than that did not answer. */
export const SEARCH_TIMEOUT_MS = 5_000;

/**
 * One network's whole answer (its chain id check and up to two reads) waits no longer than this, well inside the edge's
 * and the browser's 15 s, so one slow node reads "not checked" and never fails the other networks' answers with it.
 */
export const SEARCH_DEADLINE_MS = 6_000;

/** A node that said which chain it is is believed this long, so a search costs one or two reads, not three. */
export const CHAIN_ID_TTL_MS = 60_000;

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

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : '';
}

/** The chain id the node says it is; a finder remembers a matching answer for a while, never a mismatch. */
export type ChainIdCheck = (client: PublicClient) => Promise<number>;

/**
 * Asks one network's node for a hash. The node must first say it is that network: a node on another chain could hold
 * the same hash, and its answer is not this network's. Any failure is "not checked" with its typed code, never "not found".
 * A mined transaction whose receipt the node does not serve yet is found with its block and no outcome, never "not checked".
 */
export async function findTxOn(
  client: PublicClient,
  network: SearchNetwork,
  hash: string,
  chainIdOf: ChainIdCheck = (c) => c.getChainId(),
): Promise<NetworkAnswer> {
  const id = hash.toLowerCase() as Hex;
  try {
    const observed = await chainIdOf(client);
    if (observed !== network.chainId) return { chainId: network.chainId, state: 'not_checked', code: 'indexer.chain_id_mismatch' };
    let tx;
    try {
      tx = await client.getTransaction({ hash: id });
    } catch (err) {
      if (errorName(err) === 'TransactionNotFoundError') return { chainId: network.chainId, state: 'not_found' };
      throw err;
    }
    if (tx.blockNumber === null) return { chainId: network.chainId, state: 'found', pending: true, blockHeight: null, status: null };
    const blockHeight = Number(tx.blockNumber);
    let receipt;
    try {
      receipt = await client.getTransactionReceipt({ hash: id });
    } catch (err) {
      if (errorName(err) === 'TransactionReceiptNotFoundError')
        return { chainId: network.chainId, state: 'found', pending: false, blockHeight, status: null };
      throw err;
    }
    return {
      chainId: network.chainId,
      state: 'found',
      pending: false,
      blockHeight,
      status: receipt.status === 'success' ? 'success' : 'failed',
    };
  } catch (err) {
    const failure = err instanceof ChainUnavailableError ? err : classifyChainError(err, `search(${id})`, network.rpcUrl);
    return { chainId: network.chainId, state: 'not_checked', code: failure.code };
  }
}

/** The answer, or "not checked: the node didn't answer" once the deadline passes; the timer never holds the process. */
function withDeadline(chainId: number, answer: Promise<NetworkAnswer>, ms: number): Promise<NetworkAnswer> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<NetworkAnswer>((resolve) => {
    timer = setTimeout(() => resolve({ chainId, state: 'not_checked', code: 'indexer.chain_unreachable' }), ms);
    timer.unref();
  });
  return Promise.race([answer, late]).finally(() => clearTimeout(timer));
}

export interface FinderOptions {
  readonly deadlineMs?: number;
  readonly chainIdTtlMs?: number;
  readonly now?: () => number;
}

/**
 * One lookup per listed network, each with its own short-timeout client and its own deadline, so one slow node cannot
 * hold the others. The same hash searched again while a lookup of it is still running shares that lookup rather than
 * asking the node again; nothing is kept once it answers, so a later search always reads the node afresh.
 */
export function searchNetworkFinders(
  networks: readonly SearchNetwork[],
  { deadlineMs = SEARCH_DEADLINE_MS, chainIdTtlMs = CHAIN_ID_TTL_MS, now = Date.now }: FinderOptions = {},
): Array<{ chainId: number; find: FindTx }> {
  return networks.map((network) => {
    const client = createPublicClient({ transport: http(network.rpcUrl, { timeout: SEARCH_TIMEOUT_MS, retryCount: 0 }) });
    let confirmedUntil = 0;
    const chainIdOf: ChainIdCheck = async (c) => {
      if (now() < confirmedUntil) return network.chainId;
      const observed = await c.getChainId();
      if (observed === network.chainId) confirmedUntil = now() + chainIdTtlMs;
      return observed;
    };
    const inFlight = new Map<string, Promise<NetworkAnswer>>();
    const find: FindTx = (hash) => {
      const key = hash.toLowerCase();
      const running = inFlight.get(key);
      if (running) return running;
      const answer = withDeadline(network.chainId, findTxOn(client, network, key, chainIdOf), deadlineMs).finally(() =>
        inFlight.delete(key),
      );
      inFlight.set(key, answer);
      return answer;
    };
    return { chainId: network.chainId, find };
  });
}
