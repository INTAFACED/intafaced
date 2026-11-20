import { z } from 'zod';

/**
 * Read-only wire shapes for the explorer, mirroring svc-indexer's `explorer.blocks.list`, `explorer.blocks.get`, `explorer.txs.list`, `explorer.tx.get`,
 * `explorer.tx.networks`, `explorer.address.txs`, `explorer.address.summary`, `explorer.address.holdings`, `explorer.address.internal`,
 * `explorer.address.balanceAt` and `explorer.tokens.bySymbol` output
 * schemas and keeping only the fields the explorer renders. Amounts and gas stay decimal strings. Browser-safe (zod only).
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

const txCursorSchema = z.object({ height: z.number().int(), index: z.number().int(), hash: z.string() });
/** `explorer.address.txs`: what the address sent, received, or was a party to as an ERC-20 transfer. Amounts are raw base units. */
export const explorerAddressTxsPageSchema = z.object({
  rows: z.array(
    z.object({
      chainId: z.number().int(),
      hash: z.string(),
      blockHeight: z.number().int(),
      index: z.number().int(),
      timestamp: z.number().int(),
      from: z.string(),
      to: z.string().nullable(),
      status: z.enum(['success', 'failed']),
      revertReason: z.string().nullable(),
      transfers: z.array(
        z.object({
          token: z.object({ address: z.string(), symbol: z.string().nullable(), decimals: z.number().int().nullable() }),
          amount: z.string(),
          direction: z.enum(['in', 'out', 'self']),
        }),
      ),
    }),
  ),
  nextCursor: txCursorSchema.nullable(),
  asOf: z.string(),
  asOfHeight: z.number().int().nullable(),
});
/** `explorer.tokens.bySymbol`: every contract that says it has this symbol, one row each. */
export const explorerTokensBySymbolSchema = z.object({
  rows: z.array(
    z.object({
      chainId: z.number().int(),
      address: z.string(),
      symbol: z.string().nullable(),
      name: z.string().nullable(),
      decimals: z.number().int().nullable(),
    }),
  ),
  more: z.boolean(),
  asOf: z.string(),
});

/** `explorer.address.summary`: the address's kind and native balance (wei) at the newest canonical block indexed. */
export const explorerAddressSummarySchema = z.object({
  kind: z.enum(['account', 'contract']).nullable(),
  balance: z.string().nullable(),
  asOfHeight: z.number().int().nullable(),
  asOf: z.string(),
});
/** `explorer.address.holdings`: tokens the address holds, each from its own `balanceOf`. The indexer has no price source. */
export const explorerAddressHoldingsSchema = z.object({
  rows: z.array(
    z.object({
      token: z.object({ address: z.string(), symbol: z.string().nullable(), decimals: z.number().int().nullable() }),
      balance: z.string().nullable(),
      price: z.null(),
    }),
  ),
  unpriced: z.number().int(),
  more: z.boolean(),
  asOfHeight: z.number().int().nullable(),
  asOf: z.string(),
});
/** `explorer.address.internal`: value moved inside transactions, and the indexed blocks whose trace was not read. */
export const explorerAddressInternalPageSchema = z.object({
  rows: z.array(
    z.object({
      chainId: z.number().int(),
      hash: z.string(),
      blockHeight: z.number().int(),
      index: z.number().int(),
      timestamp: z.number().int(),
      calls: z.array(
        z.object({
          path: z.string(),
          kind: z.enum(['call', 'create', 'selfdestruct']),
          from: z.string(),
          to: z.string(),
          value: z.string(),
        }),
      ),
    }),
  ),
  nextCursor: txCursorSchema.nullable(),
  gaps: z.object({
    blocks: z.number().int(),
    fromHeight: z.number().int().nullable(),
    toHeight: z.number().int().nullable(),
    reasons: z.array(z.string()),
  }),
  asOfHeight: z.number().int().nullable(),
  asOf: z.string(),
});
/** `explorer.address.balanceAt`: the native balance at a past block, or the indexed range when that point is outside it. */
export const explorerBalanceAtSchema = z.union([
  z.object({ indexed: z.literal(true), height: z.number().int(), timestamp: z.number().int(), balance: z.string() }),
  z.object({
    indexed: z.literal(false),
    after: z.boolean(),
    earliestHeight: z.number().int().nullable(),
    latestHeight: z.number().int().nullable(),
  }),
]);

export type ExplorerAddressSummary = z.infer<typeof explorerAddressSummarySchema>;
export type ExplorerAddressHoldings = z.infer<typeof explorerAddressHoldingsSchema>;
export type ExplorerAddressInternalPage = z.infer<typeof explorerAddressInternalPageSchema>;
export type ExplorerBalanceAt = z.infer<typeof explorerBalanceAtSchema>;
export type ExplorerAddressTxsPage = z.infer<typeof explorerAddressTxsPageSchema>;
export type ExplorerToken = z.infer<typeof explorerTokensBySymbolSchema>['rows'][number];
export type ExplorerBlockRow = z.infer<typeof explorerBlockRowSchema>;
export type ExplorerBlocksPage = z.infer<typeof explorerBlocksPageSchema>;
export type ExplorerTx = z.infer<typeof explorerTxSchema>;
export type ExplorerTxRow = z.infer<typeof explorerTxRowSchema>;
export type ExplorerTxsPage = z.infer<typeof explorerTxsPageSchema>;

/** The same hash on the other networks the indexer is told to search, each asked live (`explorer.tx.networks`). */
export const explorerTxNetworksSchema = z.object({
  networks: z.array(
    z.discriminatedUnion('state', [
      z.object({
        chainId: z.number().int(),
        state: z.literal('found'),
        pending: z.boolean(),
        blockHeight: z.number().int().nullable(),
        status: z.enum(['success', 'failed']).nullable(),
      }),
      z.object({ chainId: z.number().int(), state: z.literal('not_found') }),
      z.object({ chainId: z.number().int(), state: z.literal('not_checked'), code: z.string() }),
    ]),
  ),
});
export type ExplorerTxNetworks = z.infer<typeof explorerTxNetworksSchema>;
