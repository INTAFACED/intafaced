import {
  INDEXER_EXPLORER_ADDRESS_BALANCE_AT,
  INDEXER_EXPLORER_ADDRESS_HOLDINGS,
  INDEXER_EXPLORER_ADDRESS_INTERNAL,
  INDEXER_EXPLORER_ADDRESS_SUMMARY,
  INDEXER_EXPLORER_ADDRESS_TXS,
  INDEXER_EXPLORER_BLOCKS_GET,
  INDEXER_EXPLORER_BLOCKS_LIST,
  INDEXER_EXPLORER_TOKENS_BY_SYMBOL,
  INDEXER_EXPLORER_TX_GET,
  INDEXER_EXPLORER_TX_NETWORKS,
  INDEXER_EXPLORER_TXS_LIST,
  type ExplorerAddressInternalPage,
  type ExplorerAddressTxsPage,
  type ExplorerTxsPage,
} from '@intafaced/contracts/indexer-procedures';
import type { ApiClient } from '../../../shared/api';

export type {
  ExplorerAddressHoldings,
  ExplorerAddressInternalPage,
  ExplorerAddressSummary,
  ExplorerAddressTxsPage,
  ExplorerBalanceAt,
  ExplorerBlockRow,
  ExplorerBlocksPage,
  ExplorerToken,
  ExplorerTx,
  ExplorerTxNetworks,
  ExplorerTxRow,
  ExplorerTxsPage,
} from '@intafaced/contracts/indexer-procedures';

/** The indexer's answer for a hash it has never seen on the chain it reads (`protocol.not_found`, tRPC NOT_FOUND). */
export const isNotFound = (code: string | undefined) => code === 'NOT_FOUND' || code === 'protocol.not_found';

export function createExplorerApi(api: ApiClient) {
  return {
    /** Newest blocks first. The window is the owner's list limit; a blank limit refuses rather than picking one. */
    latestBlocks: (chainId: number, signal?: AbortSignal, cursor?: number) =>
      api.call(INDEXER_EXPLORER_BLOCKS_LIST, { chainId, ...(cursor === undefined ? {} : { cursor }) }, { signal }),
    /** One block by height (the canonical one) or hash. An unknown block is NOT_FOUND. */
    block: (chainId: number, at: { height: number } | { hash: string }, signal?: AbortSignal) =>
      api.call(INDEXER_EXPLORER_BLOCKS_GET, { chainId, ...at }, { signal }),
    /** Newest transactions first, or one block's. The window is the owner's list limit, as for blocks. */
    latestTxs: (chainId: number, signal?: AbortSignal, blockHash?: string, cursor?: ExplorerTxsPage['nextCursor']) =>
      api.call(INDEXER_EXPLORER_TXS_LIST, { chainId, ...(blockHash ? { blockHash } : {}), ...(cursor ? { cursor } : {}) }, { signal }),
    /** One transaction by hash on the chain the indexer reads. An unknown hash is NOT_FOUND, never an empty success. */
    tx: (chainId: number, hash: string, signal?: AbortSignal) => api.call(INDEXER_EXPLORER_TX_GET, { chainId, hash }, { signal }),
    /** An address's transactions, newest first, in pages of the owner's list limit. */
    addressTxs: (chainId: number, address: string, signal?: AbortSignal, cursor?: ExplorerAddressTxsPage['nextCursor']) =>
      api.call(INDEXER_EXPLORER_ADDRESS_TXS, { chainId, address, ...(cursor ? { cursor } : {}) }, { signal }),
    /** The address's kind and native balance at the newest canonical block indexed. */
    addressSummary: (chainId: number, address: string, signal?: AbortSignal) =>
      api.call(INDEXER_EXPLORER_ADDRESS_SUMMARY, { chainId, address }, { signal }),
    /** The tokens the address holds, at the same block. A blank owner list limit refuses. */
    addressHoldings: (chainId: number, address: string, signal?: AbortSignal) =>
      api.call(INDEXER_EXPLORER_ADDRESS_HOLDINGS, { chainId, address }, { signal }),
    /** Transactions with value moved inside them to or from the address, newest first, with the blocks not traced. */
    addressInternal: (chainId: number, address: string, signal?: AbortSignal, cursor?: ExplorerAddressInternalPage['nextCursor']) =>
      api.call(INDEXER_EXPLORER_ADDRESS_INTERNAL, { chainId, address, ...(cursor ? { cursor } : {}) }, { signal }),
    /** The native balance at a block height, or at the end of a UTC day (`YYYY-MM-DD`). */
    balanceAt: (chainId: number, address: string, at: { height: number } | { date: string }, signal?: AbortSignal) =>
      api.call(INDEXER_EXPLORER_ADDRESS_BALANCE_AT, { chainId, address, at }, { signal }),
    /** Every token contract with this symbol, ignoring case. Two contracts sharing a symbol are two rows. */
    tokensBySymbol: (chainId: number, symbol: string, signal?: AbortSignal) =>
      api.call(INDEXER_EXPLORER_TOKENS_BY_SYMBOL, { chainId, symbol }, { signal }),
    /** The same hash on every other network the indexer searches, each Found, Not found or not checked with its code. */
    txNetworks: (hash: string, signal?: AbortSignal) => api.call(INDEXER_EXPLORER_TX_NETWORKS, { hash }, { signal }),
  };
}
export type ExplorerApi = ReturnType<typeof createExplorerApi>;
