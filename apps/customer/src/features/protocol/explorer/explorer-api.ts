import {
  explorerAddressHoldingsSchema,
  explorerAddressInternalPageSchema,
  explorerAddressSummarySchema,
  explorerAddressTxsPageSchema,
  explorerBalanceAtSchema,
  explorerBlockRowSchema,
  explorerBlocksPageSchema,
  explorerTokensBySymbolSchema,
  explorerTxNetworksSchema,
  explorerTxSchema,
  explorerTxsPageSchema,
  type ExplorerAddressInternalPage,
  type ExplorerAddressTxsPage,
  type ExplorerTxsPage,
} from '@intafaced/contracts/indexer-explorer';
import type { ApiClient } from '../../../shared/api';

export * from '@intafaced/contracts/indexer-explorer';

/** The indexer's answer for a hash it has never seen on the chain it reads (`protocol.not_found`, tRPC NOT_FOUND). */
export const isNotFound = (code: string | undefined) => code === 'NOT_FOUND' || code === 'protocol.not_found';

export function createExplorerApi(api: ApiClient) {
  return {
    /** Newest blocks first. The window is the owner's list limit; a blank limit refuses rather than picking one. */
    latestBlocks: (chainId: number, signal?: AbortSignal, cursor?: number) =>
      api.query('indexer', 'explorer.blocks.list', { chainId, ...(cursor === undefined ? {} : { cursor }) }, explorerBlocksPageSchema, {
        signal,
      }),
    /** One block by height (the canonical one) or hash. An unknown block is NOT_FOUND. */
    block: (chainId: number, at: { height: number } | { hash: string }, signal?: AbortSignal) =>
      api.query('indexer', 'explorer.blocks.get', { chainId, ...at }, explorerBlockRowSchema, { signal }),
    /** Newest transactions first, or one block's. The window is the owner's list limit, as for blocks. */
    latestTxs: (chainId: number, signal?: AbortSignal, blockHash?: string, cursor?: ExplorerTxsPage['nextCursor']) =>
      api.query(
        'indexer',
        'explorer.txs.list',
        { chainId, ...(blockHash ? { blockHash } : {}), ...(cursor ? { cursor } : {}) },
        explorerTxsPageSchema,
        { signal },
      ),
    /** One transaction by hash on the chain the indexer reads. An unknown hash is NOT_FOUND, never an empty success. */
    tx: (chainId: number, hash: string, signal?: AbortSignal) =>
      api.query('indexer', 'explorer.tx.get', { chainId, hash }, explorerTxSchema, { signal }),
    /** An address's transactions, newest first, in pages of the owner's list limit. */
    addressTxs: (chainId: number, address: string, signal?: AbortSignal, cursor?: ExplorerAddressTxsPage['nextCursor']) =>
      api.query('indexer', 'explorer.address.txs', { chainId, address, ...(cursor ? { cursor } : {}) }, explorerAddressTxsPageSchema, {
        signal,
      }),
    /** The address's kind and native balance at the newest canonical block indexed. */
    addressSummary: (chainId: number, address: string, signal?: AbortSignal) =>
      api.query('indexer', 'explorer.address.summary', { chainId, address }, explorerAddressSummarySchema, { signal }),
    /** The tokens the address holds, at the same block. A blank owner list limit refuses. */
    addressHoldings: (chainId: number, address: string, signal?: AbortSignal) =>
      api.query('indexer', 'explorer.address.holdings', { chainId, address }, explorerAddressHoldingsSchema, { signal }),
    /** Transactions with value moved inside them to or from the address, newest first, with the blocks not traced. */
    addressInternal: (chainId: number, address: string, signal?: AbortSignal, cursor?: ExplorerAddressInternalPage['nextCursor']) =>
      api.query(
        'indexer',
        'explorer.address.internal',
        { chainId, address, ...(cursor ? { cursor } : {}) },
        explorerAddressInternalPageSchema,
        { signal },
      ),
    /** The native balance at a block height, or at the end of a UTC day (`YYYY-MM-DD`). */
    balanceAt: (chainId: number, address: string, at: { height: number } | { date: string }, signal?: AbortSignal) =>
      api.query('indexer', 'explorer.address.balanceAt', { chainId, address, at }, explorerBalanceAtSchema, { signal }),
    /** Every token contract with this symbol, ignoring case. Two contracts sharing a symbol are two rows. */
    tokensBySymbol: (chainId: number, symbol: string, signal?: AbortSignal) =>
      api.query('indexer', 'explorer.tokens.bySymbol', { chainId, symbol }, explorerTokensBySymbolSchema, { signal }),
    /** The same hash on every other network the indexer searches, each Found, Not found or not checked with its code. */
    txNetworks: (hash: string, signal?: AbortSignal) =>
      api.query('indexer', 'explorer.tx.networks', { hash }, explorerTxNetworksSchema, { signal }),
  };
}
export type ExplorerApi = ReturnType<typeof createExplorerApi>;
