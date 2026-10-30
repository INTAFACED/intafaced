// hand-declared-ok: svc-indexer's explorer output schemas are declared in its router, not in @intafaced/contracts.
import { z } from 'zod';
import type { ApiClient } from '../../../shared/api';

/**
 * Read-only wire shapes for the explorer, mirroring svc-indexer's `explorer.blocks.list` and `explorer.tx.get` output
 * schemas and keeping only the fields the explorer renders. Amounts and gas stay decimal strings.
 */
export const explorerBlockRowSchema = z.object({
  chainId: z.number().int(),
  height: z.number().int(),
  hash: z.string(),
  gasUsed: z.string(),
  gasLimit: z.string(),
  utilisation: z.string().nullable(),
  txCount: z.number().int(),
  timestamp: z.number().int(),
  orphaned: z.object({ reason: z.string() }).nullable(),
});
export const explorerBlocksPageSchema = z.object({
  rows: z.array(explorerBlockRowSchema),
  nextCursor: z.number().int().nullable(),
  asOf: z.string(),
});
export const explorerTxSchema = z.object({
  chainId: z.number().int(),
  hash: z.string(),
  status: z.enum(['success', 'failed', 'pending', 'dropped', 'replaced']),
  /** The hash that replaced this one (same sender and nonce), when the status is `replaced`. */
  replacingHash: z.string().nullable(),
  /** Set when the block that held this transaction was reorged away. */
  orphaned: z.object({ reason: z.string() }).nullable(),
});

export type ExplorerBlockRow = z.infer<typeof explorerBlockRowSchema>;
export type ExplorerBlocksPage = z.infer<typeof explorerBlocksPageSchema>;
export type ExplorerTx = z.infer<typeof explorerTxSchema>;

/** The indexer's answer for a hash it has never seen on the chain it reads (`protocol.not_found`, tRPC NOT_FOUND). */
export const isNotFound = (code: string | undefined) => code === 'NOT_FOUND' || code === 'protocol.not_found';

export function createExplorerApi(api: ApiClient) {
  return {
    /** Newest blocks first. The window is the owner's list limit; a blank limit refuses rather than picking one. */
    latestBlocks: (chainId: number, signal?: AbortSignal) =>
      api.query('indexer', 'explorer.blocks.list', { chainId }, explorerBlocksPageSchema, { signal }),
    /** One transaction by hash on the chain the indexer reads. An unknown hash is NOT_FOUND, never an empty success. */
    tx: (chainId: number, hash: string, signal?: AbortSignal) =>
      api.query('indexer', 'explorer.tx.get', { chainId, hash }, explorerTxSchema, { signal }),
  };
}
export type ExplorerApi = ReturnType<typeof createExplorerApi>;
