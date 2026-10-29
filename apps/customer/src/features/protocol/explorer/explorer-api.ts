// hand-declared-ok: svc-indexer's explorer output schemas are declared in its router, not in @intafaced/contracts.
import { z } from 'zod';
import type { ApiClient } from '../../../shared/api';

/**
 * Read-only wire shapes for the explorer, mirroring svc-indexer's `explorer.blocks.list`, `explorer.blocks.get`, `explorer.txs.list` and `explorer.tx.get` output
 * schemas and keeping only the fields the explorer renders. Amounts and gas stay decimal strings.
 */
export const explorerBlockRowSchema = z.object({
  chainId: z.number().int(),
  height: z.number().int(),
  hash: z.string(),
  gasUsed: z.string(),
  gasLimit: z.string(),
  baseFeePerGas: z.string().nullable(),
  utilisation: z.string().nullable(),
  miner: z.string(),
  size: z.number().int(),
  txCount: z.number().int(),
  timestamp: z.number().int(),
  orphaned: z.object({ reason: z.string() }).nullable(),
});
export const explorerBlocksPageSchema = z.object({
  rows: z.array(explorerBlockRowSchema),
  nextCursor: z.number().int().nullable(),
  /** The newest height the indexer counts as final (head minus the finality depth); null before the first block. */
  finalizedHeight: z.number().int().nullable(),
  asOf: z.string(),
});
export const explorerTxSchema = z.object({
  chainId: z.number().int(),
  hash: z.string(),
  status: z.enum(['success', 'failed', 'pending', 'dropped', 'replaced']),
  /** The hash that replaced this one (same sender and nonce), when the status is `replaced`. */
  replacingHash: z.string().nullable(),
  transaction: z
    .object({
      index: z.number().int().nullable(),
      from: z.string(),
      to: z.string().nullable(),
      value: z.string(),
      nonce: z.number().int(),
      gasLimit: z.string(),
      gasPrice: z.string().nullable(),
      input: z.string(),
    })
    .nullable(),
  receipt: z
    .object({
      status: z.enum(['success', 'failed']),
      gasConsumed: z.string().nullable(),
      revertReason: z.string().nullable(),
      createdContract: z.string().nullable(),
    })
    .nullable(),
  logs: z.array(z.object({ logIndex: z.number().int(), address: z.string(), topics: z.array(z.string()), data: z.string() })),
  /** Set when the block that held this transaction was reorged away. */
  orphaned: z.object({ reason: z.string() }).nullable(),
});
export const explorerTxRowSchema = z.object({
  chainId: z.number().int(),
  hash: z.string(),
  blockHeight: z.number().int(),
  blockHash: z.string(),
  index: z.number().int(),
  from: z.string(),
  to: z.string().nullable(),
  value: z.string(),
  status: z.enum(['success', 'failed']),
  timestamp: z.number().int(),
  orphaned: z.object({ reason: z.string() }).nullable(),
});
export const explorerTxsPageSchema = z.object({
  rows: z.array(explorerTxRowSchema),
  nextCursor: z.object({ height: z.number().int(), index: z.number().int(), hash: z.string() }).nullable(),
  asOf: z.string(),
});

export type ExplorerBlockRow = z.infer<typeof explorerBlockRowSchema>;
export type ExplorerBlocksPage = z.infer<typeof explorerBlocksPageSchema>;
export type ExplorerTx = z.infer<typeof explorerTxSchema>;
export type ExplorerTxRow = z.infer<typeof explorerTxRowSchema>;
export type ExplorerTxsPage = z.infer<typeof explorerTxsPageSchema>;

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
    latestTxs: (chainId: number, signal?: AbortSignal, blockHash?: string) =>
      api.query('indexer', 'explorer.txs.list', { chainId, ...(blockHash ? { blockHash } : {}) }, explorerTxsPageSchema, { signal }),
    /** One transaction by hash on the chain the indexer reads. An unknown hash is NOT_FOUND, never an empty success. */
    tx: (chainId: number, hash: string, signal?: AbortSignal) =>
      api.query('indexer', 'explorer.tx.get', { chainId, hash }, explorerTxSchema, { signal }),
  };
}
export type ExplorerApi = ReturnType<typeof createExplorerApi>;
