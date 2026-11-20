import { z } from 'zod';
import { defineProcedure, NO_INPUT, type ProcedureOutput, type RefusalStatus, type Refusals } from './procedure.js';

/**
 * svc-indexer's whole call surface, one record per call: the explorer's reads, the projection's status, the finalized
 * book and an address's positions. svc-indexer mounts each from here (`mountRecords`), so its path, guard, input, output
 * and named refusals are this file, not its router. Every schema is the one the router used before, so the wire did not
 * move (`services/svc-indexer/src/wire-replay.test.ts`). The customer app, the admin desk, svc-dex, svc-ledger's portfolio
 * read and svc-protocol's blockers take their path and reply parser from the same record.
 */

const base = { service: 'svc-indexer', module: 'indexer', transport: 'trpc' } as const;

/** No login, no tier: the indexer mirrors public chain state. A region the module is not served in is still refused. */
const PUBLIC_CHAIN = { caller: 'jurisdiction', module: 'indexer', plane: 'protocol' } as const;

const refuse = (status: RefusalStatus, ...codes: readonly string[]): Refusals =>
  Object.fromEntries(codes.map((code) => [code, status] as const));
const refusals = (...parts: readonly Refusals[]): Refusals => Object.freeze(Object.assign({}, ...parts) as Refusals);

/**
 * Every data read first asks whether the projection may serve: a halt, a typed chain-door failure on the last sync, a
 * boot with no chain, or the fixture venue claimed as live (svc-indexer `serving.ts`, `assertServing`).
 */
const SERVING = refusals(
  refuse(
    'SERVICE_UNAVAILABLE',
    'indexer.halted',
    'indexer.chain_not_configured',
    'indexer.venue_unset',
    'indexer.chain_unreachable',
    'indexer.chain_id_mismatch',
    'indexer.venue_not_deployed',
    'indexer.malformed_block',
    'indexer.start_height_above_tip',
    'indexer.start_height_unavailable',
  ),
  refuse('PRECONDITION_FAILED', 'indexer.clob_fixture_not_live'),
);
/** The explorer's stores are not wired in this process. */
const UNWIRED = refuse('SERVICE_UNAVAILABLE', 'indexer.explorer_unwired');
/** The owner's explorer list size is blank. */
const LIST_LIMIT = refuse('BAD_REQUEST', 'indexer.explorer_list_limit_unset');
const NOT_FOUND = refuse('NOT_FOUND', 'protocol.not_found');
/** The node no longer holds the state at that block (a non-archive node). */
const STATE_GONE = refuse('PRECONDITION_FAILED', 'indexer.state_unavailable');
const POOL_FACTORY = refuse('PRECONDITION_FAILED', 'indexer.pool_factory_unset');
const NOT_A_POOL = refuse('NOT_FOUND', 'indexer.not_a_pool');

export const INDEXER_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
/** A token symbol is stored and searched counted in characters, at most this many (svc-indexer `token-meta.ts`). */
export const INDEXER_SYMBOL_MAX_CHARS = 32;
/** The candle widths a pool's day is read at, and the default. */
export const INDEXER_CANDLE_INTERVALS = ['5m', '1h'] as const;
export type IndexerCandleInterval = (typeof INDEXER_CANDLE_INTERVALS)[number];

/** The end of a `YYYY-MM-DD` UTC day (the next midnight), or null when it is not a real calendar day. */
export function endOfUtcDay(date: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const start = new Date(Date.UTC(year, month - 1, day));
  if (start.getUTCFullYear() !== year || start.getUTCMonth() !== month - 1 || start.getUTCDate() !== day) return null;
  return new Date(start.getTime() + 86_400_000);
}

const chainIdSchema = z.number().int();
const marketSchema = z.string().min(1).max(64);
const addressSchema = z.string().regex(INDEXER_ADDRESS, 'must be a 20-byte hex address');

/** What svc-indexer says of the order-book venue it reads: never audited, never INTACHAIN, never reserves. */
export const clobHonestySchema = z.object({
  live: z.boolean(),
  kind: z.enum(['unset', 'fixture', 'sovereign-venue', 'unpublished']),
  reserves: z.literal(false),
});

/** `['30000.5', '2.25']`: price, quantity. */
const wireLevelSchema = z.tuple([z.string(), z.string()]);

const positionSchema = z.object({
  market: z.string(),
  account: z.string(),
  /** Signed decimal string; negative is short. */
  size: z.string(),
  entryPrice: z.string(),
  blockHeight: z.number().int(),
  blockHash: z.string(),
});

const networkAnswerSchema = z.discriminatedUnion('state', [
  z.object({
    chainId: z.number().int(),
    state: z.literal('found'),
    pending: z.boolean(),
    blockHeight: z.number().int().nullable(),
    status: z.enum(['success', 'failed']).nullable(),
  }),
  z.object({ chainId: z.number().int(), state: z.literal('not_found') }),
  z.object({ chainId: z.number().int(), state: z.literal('not_checked'), code: z.string() }),
]);

const chainProbeSchema = z.object({
  kind: z.enum(['null', 'evm']),
  rpcUrl: z.string().nullable(),
  venue: z.string().nullable(),
  reachable: z.boolean(),
  observedChainId: z.number().int().nullable(),
  chainHeight: z.number().int().nullable(),
  venueDeployed: z.boolean(),
  refusalCode: z.string().nullable(),
  reason: z.string().nullable(),
});

const explorerTxSchema = z.object({
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
  logs: z.array(
    z.object({
      logIndex: z.number().int(),
      address: z.string(),
      topics: z.array(z.string()),
      data: z.string(),
    }),
  ),
  /** Set when the block that held this transaction was reorged away. */
  orphaned: z.object({ reason: z.string() }).nullable(),
});

const explorerBlockRowSchema = z.object({
  chainId: z.number().int(),
  height: z.number().int(),
  hash: z.string(),
  gasUsed: z.string(),
  gasLimit: z.string(),
  baseFeePerGas: z.string().nullable(),
  utilisation: z.string().nullable(),
  miner: z.string(),
  txCount: z.number().int(),
  size: z.number().int(),
  timestamp: z.number().int(),
  orphaned: z.object({ reason: z.string() }).nullable(),
});

const explorerTxListRowSchema = z.object({
  chainId: z.number().int(),
  hash: z.string(),
  blockHeight: z.number().int(),
  blockHash: z.string(),
  index: z.number().int(),
  from: z.string(),
  to: z.string().nullable(),
  /** Wei, decimal string. */
  value: z.string(),
  status: z.enum(['success', 'failed']),
  timestamp: z.number().int(),
  orphaned: z.object({ reason: z.string() }).nullable(),
});

const txCursorSchema = z.object({
  height: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  index: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  hash: z.string().regex(HASH),
});
const txNextCursorSchema = z.object({ height: z.number().int(), index: z.number().int(), hash: z.string() }).nullable();

const tokenSchema = z.object({
  address: z.string(),
  /** Null when the contract did not answer `symbol()` / `name()` / `decimals()`. */
  symbol: z.string().nullable(),
  name: z.string().nullable(),
  decimals: z.number().int().nullable(),
});

const addressTxRowSchema = z.object({
  chainId: z.number().int(),
  hash: z.string(),
  blockHeight: z.number().int(),
  blockHash: z.string(),
  index: z.number().int(),
  timestamp: z.number().int(),
  from: z.string(),
  to: z.string().nullable(),
  status: z.enum(['success', 'failed']),
  revertReason: z.string().nullable(),
  transfers: z.array(
    z.object({
      token: tokenSchema.omit({ name: true }),
      /** Raw base units, decimal string. */
      amount: z.string(),
      direction: z.enum(['in', 'out', 'self']),
    }),
  ),
});

const addressInput = z.object({ chainId: chainIdSchema, address: addressSchema });

// Bounded so an out-of-range cursor is a typed BAD_REQUEST, never a database cast error.
const poolCursorSchema = z.object({
  height: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  index: z.number().int().min(0).max(2_147_483_647),
  logIndex: z.number().int().min(0).max(2_147_483_647),
});

const poolSchema = z.object({
  chainId: z.number().int(),
  address: z.string(),
  factory: z.string(),
  token0: tokenSchema,
  token1: tokenSchema,
  feeBps: z.number().int(),
  createdHeight: z.number().int(),
  createdTx: z.string(),
  /** Raw base units after the pool's latest Sync in a canonical block; null before its first. */
  reserves: z.object({ reserve0: z.string(), reserve1: z.string(), height: z.number().int() }).nullable(),
});

const poolWindowSchema = z.object({ since: z.string(), seconds: z.number().int() });

const A = '0x' + 'a'.repeat(40);
const H = '0x' + 'd'.repeat(64);

/** Descending from the head; owner-bounded window (a larger asked limit is clamped); orphans kept with their reason. */
export const INDEXER_EXPLORER_BLOCKS_LIST = defineProcedure({
  ...base,
  name: 'indexer.explorer.blocks.list',
  kind: 'query',
  path: 'explorer.blocks.list',
  access: PUBLIC_CHAIN,
  refusals: refusals(SERVING, UNWIRED, LIST_LIMIT),
  input: z.object({
    chainId: chainIdSchema,
    cursor: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).optional(),
  }),
  output: z.object({
    rows: z.array(explorerBlockRowSchema),
    nextCursor: z.number().int().nullable(),
    /** Head minus the finality depth; null before the first block or on another network. */
    finalizedHeight: z.number().int().nullable(),
    asOf: z.string(),
  }),
  samples: [
    { verdict: 'accept', input: { chainId: 84532 } },
    { verdict: 'accept', input: { chainId: 1, cursor: 3, limit: 1 } },
    { verdict: 'refuse', input: { chainId: 84532, limit: 0 } },
  ],
});

/** One block by height (canonical first) or hash. Unknown is NOT_FOUND, never null. */
export const INDEXER_EXPLORER_BLOCKS_GET = defineProcedure({
  ...base,
  name: 'indexer.explorer.blocks.get',
  kind: 'query',
  path: 'explorer.blocks.get',
  access: PUBLIC_CHAIN,
  refusals: refusals(SERVING, UNWIRED, NOT_FOUND),
  input: z.union([
    z.object({ chainId: chainIdSchema, height: z.number().int().min(0) }),
    z.object({ chainId: chainIdSchema, hash: z.string().regex(HASH) }),
  ]),
  output: explorerBlockRowSchema,
  samples: [
    { verdict: 'accept', input: { chainId: 84532, height: 2 } },
    { verdict: 'accept', input: { chainId: 84532, hash: H } },
    { verdict: 'refuse', input: { chainId: 84532, hash: '0x1' } },
  ],
});

/** Newest transactions first, optionally of one block; owner-bounded window; orphans kept with their reason. */
export const INDEXER_EXPLORER_TXS_LIST = defineProcedure({
  ...base,
  name: 'indexer.explorer.txs.list',
  kind: 'query',
  path: 'explorer.txs.list',
  access: PUBLIC_CHAIN,
  refusals: refusals(SERVING, UNWIRED, LIST_LIMIT),
  input: z.object({
    chainId: chainIdSchema,
    blockHash: z.string().regex(HASH).optional(),
    cursor: z
      .object({
        height: z.number().int().min(0),
        index: z.number().int().min(0),
        hash: z.string().regex(HASH),
      })
      .optional(),
    limit: z.number().int().min(1).optional(),
  }),
  output: z.object({ rows: z.array(explorerTxListRowSchema), nextCursor: txNextCursorSchema, asOf: z.string() }),
  samples: [
    { verdict: 'accept', input: { chainId: 84532 } },
    { verdict: 'accept', input: { chainId: 84532, blockHash: H, cursor: { height: 1, index: 0, hash: H }, limit: 1 } },
    { verdict: 'refuse', input: { chainId: 84532, blockHash: '0x1' } },
  ],
});

/**
 * Transactions the address sent, received, or is a party to through an ERC-20 Transfer, newest first, from canonical
 * blocks, each with the transfers to or from the address. Owner-bounded window.
 */
export const INDEXER_EXPLORER_ADDRESS_TXS = defineProcedure({
  ...base,
  name: 'indexer.explorer.address.txs',
  kind: 'query',
  path: 'explorer.address.txs',
  access: PUBLIC_CHAIN,
  refusals: refusals(SERVING, UNWIRED, LIST_LIMIT),
  input: z.object({
    chainId: chainIdSchema,
    address: addressSchema,
    cursor: txCursorSchema.optional(),
    limit: z.number().int().min(1).optional(),
  }),
  output: z.object({
    rows: z.array(addressTxRowSchema),
    nextCursor: txNextCursorSchema,
    asOf: z.string(),
    /** The newest canonical block indexed when this answer was read; null before the first block or on another network. */
    asOfHeight: z.number().int().nullable(),
  }),
  samples: [
    { verdict: 'accept', input: { chainId: 84532, address: A } },
    { verdict: 'accept', input: { chainId: 84532, address: A, cursor: { height: 1, index: 0, hash: H }, limit: 1 } },
    { verdict: 'refuse', input: { chainId: 84532, address: 'not-an-address' } },
  ],
});

/** The address's kind and native balance (wei) at the newest canonical block indexed; nulls on another network or before the first block. */
export const INDEXER_EXPLORER_ADDRESS_SUMMARY = defineProcedure({
  ...base,
  name: 'indexer.explorer.address.summary',
  kind: 'query',
  path: 'explorer.address.summary',
  access: PUBLIC_CHAIN,
  refusals: refusals(SERVING, UNWIRED, STATE_GONE),
  input: addressInput,
  output: z.object({
    kind: z.enum(['account', 'contract']).nullable(),
    /** Wei, decimal string. */
    balance: z.string().nullable(),
    asOfHeight: z.number().int().nullable(),
    asOf: z.string(),
  }),
  samples: [
    { verdict: 'accept', input: { chainId: 84532, address: A } },
    { verdict: 'refuse', input: { chainId: 84532 } },
  ],
});

/**
 * Tokens the address sent or received, each with its own `balanceOf` at the newest canonical block indexed. A zero
 * balance is not a holding; `balance` is null where the contract did not answer as a token. The indexer has no price
 * source, so `price` is always null and every holding counts in `unpriced`.
 */
export const INDEXER_EXPLORER_ADDRESS_HOLDINGS = defineProcedure({
  ...base,
  name: 'indexer.explorer.address.holdings',
  kind: 'query',
  path: 'explorer.address.holdings',
  access: PUBLIC_CHAIN,
  refusals: refusals(SERVING, UNWIRED, LIST_LIMIT, STATE_GONE),
  input: addressInput,
  output: z.object({
    rows: z.array(
      z.object({
        token: tokenSchema.omit({ name: true }),
        /** Raw base units, decimal string; null when the contract did not answer `balanceOf`. */
        balance: z.string().nullable(),
        price: z.null(),
      }),
    ),
    unpriced: z.number().int(),
    more: z.boolean(),
    asOfHeight: z.number().int().nullable(),
    asOf: z.string(),
  }),
  samples: [
    { verdict: 'accept', input: { chainId: 84532, address: A } },
    { verdict: 'refuse', input: { chainId: '84532', address: A } },
  ],
});

/**
 * Transactions with internal value moves to or from the address, newest first, each with those moves. `gaps` names the
 * indexed blocks whose trace was not read, where a move could exist that this list cannot show.
 */
export const INDEXER_EXPLORER_ADDRESS_INTERNAL = defineProcedure({
  ...base,
  name: 'indexer.explorer.address.internal',
  kind: 'query',
  path: 'explorer.address.internal',
  access: PUBLIC_CHAIN,
  refusals: refusals(SERVING, UNWIRED, LIST_LIMIT),
  input: addressInput.extend({ cursor: txCursorSchema.optional(), limit: z.number().int().min(1).optional() }),
  output: z.object({
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
            /** Wei, decimal string. */
            value: z.string(),
          }),
        ),
      }),
    ),
    nextCursor: txNextCursorSchema,
    gaps: z.object({
      blocks: z.number().int(),
      fromHeight: z.number().int().nullable(),
      toHeight: z.number().int().nullable(),
      reasons: z.array(z.string()),
    }),
    asOfHeight: z.number().int().nullable(),
    asOf: z.string(),
  }),
  samples: [
    { verdict: 'accept', input: { chainId: 84532, address: A } },
    { verdict: 'accept', input: { chainId: 84532, address: A, limit: 1 } },
    { verdict: 'refuse', input: { chainId: 84532, address: A, limit: 0 } },
  ],
});

/**
 * The address's native balance at a past block, or at the end of a UTC day (the last canonical block before the
 * midnight after it). A point outside the indexed blocks answers `indexed: false` with the indexed range.
 */
export const INDEXER_EXPLORER_ADDRESS_BALANCE_AT = defineProcedure({
  ...base,
  name: 'indexer.explorer.address.balanceAt',
  kind: 'query',
  path: 'explorer.address.balanceAt',
  access: PUBLIC_CHAIN,
  refusals: refusals(SERVING, UNWIRED, STATE_GONE),
  input: addressInput.extend({
    at: z.union([
      z.object({ height: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }),
      z.object({ date: z.string().refine((date) => endOfUtcDay(date) !== null, 'must be a YYYY-MM-DD date') }),
    ]),
  }),
  checks: { utcDay: { at: 'input.at|1.date', says: 'the date is a real YYYY-MM-DD calendar day (no 30 February)' } },
  output: z.union([
    z.object({
      indexed: z.literal(true),
      height: z.number().int(),
      timestamp: z.number().int(),
      /** Wei, decimal string. */
      balance: z.string(),
    }),
    z.object({
      indexed: z.literal(false),
      /** True when the point lies past the newest indexed block (a later block, or a day not yet over in the index). */
      after: z.boolean(),
      earliestHeight: z.number().int().nullable(),
      latestHeight: z.number().int().nullable(),
    }),
  ]),
  samples: [
    { verdict: 'accept', input: { chainId: 84532, address: A, at: { height: 1 } } },
    { verdict: 'accept', input: { chainId: 84532, address: A, at: { date: '2026-02-28' } } },
    { verdict: 'refuse', input: { chainId: 84532, address: A, at: { height: -1 } } },
    { verdict: 'refuse', input: { chainId: 84532, address: A, at: { date: '2026-02-30' } }, by: 'utcDay' },
  ],
});

/**
 * Every token contract whose own `symbol()` is this one, ignoring case: one row per contract, never merged, so two
 * tokens sharing a symbol are both listed. `more` is true when the owner window cut the list.
 */
export const INDEXER_EXPLORER_TOKENS_BY_SYMBOL = defineProcedure({
  ...base,
  name: 'indexer.explorer.tokens.bySymbol',
  kind: 'query',
  path: 'explorer.tokens.bySymbol',
  access: PUBLIC_CHAIN,
  refusals: refusals(SERVING, UNWIRED, LIST_LIMIT),
  input: z.object({
    chainId: chainIdSchema,
    // Counted in characters, as token-meta stores them, so a stored symbol can always be searched.
    symbol: z
      .string()
      .trim()
      .min(1)
      .refine((symbol) => Array.from(symbol).length <= INDEXER_SYMBOL_MAX_CHARS),
  }),
  // `.trim()` runs before `.min(1)` and the length check; JSON Schema cannot say so, so the check's words carry it.
  checks: {
    symbolChars: {
      at: 'input.symbol',
      says: `the symbol, with surrounding spaces trimmed, is 1 to ${INDEXER_SYMBOL_MAX_CHARS} characters`,
    },
  },
  output: z.object({ rows: z.array(tokenSchema.extend({ chainId: z.number().int() })), more: z.boolean(), asOf: z.string() }),
  samples: [
    { verdict: 'accept', input: { chainId: 84532, symbol: 'USDC' } },
    { verdict: 'refuse', input: { chainId: 84532, symbol: 7 } },
    { verdict: 'refuse', input: { chainId: 84532, symbol: 'X'.repeat(INDEXER_SYMBOL_MAX_CHARS + 1) }, by: 'symbolChars' },
  ],
});

/** Pools the owner's factory created, newest first, with their tokens, latest reserves and last day's volume. Owner-bounded pages. */
export const INDEXER_EXPLORER_POOLS_LIST = defineProcedure({
  ...base,
  name: 'indexer.explorer.pools.list',
  kind: 'query',
  path: 'explorer.pools.list',
  access: PUBLIC_CHAIN,
  refusals: refusals(SERVING, UNWIRED, POOL_FACTORY, LIST_LIMIT),
  input: z.object({ chainId: chainIdSchema, cursor: poolCursorSchema.optional() }),
  output: z.object({
    rows: z.array(poolSchema.extend({ volume1: z.string(), swaps: z.number().int() })),
    window: poolWindowSchema,
    nextCursor: poolCursorSchema.nullable(),
    asOf: z.string(),
  }),
  samples: [
    { verdict: 'accept', input: { chainId: 84532 } },
    { verdict: 'accept', input: { chainId: 84532, cursor: { height: 1, index: 0, logIndex: 0 } } },
    { verdict: 'refuse', input: { chainId: 84532, cursor: { height: 1, index: -1, logIndex: 0 } } },
  ],
});

/**
 * One pool: its facts, the last day's swap count and token1 volume, and that day's price candles at the asked width. An
 * address the factory did not create is `indexer.not_a_pool`. Without both tokens' decimals `candles` is null.
 */
export const INDEXER_EXPLORER_POOLS_GET = defineProcedure({
  ...base,
  name: 'indexer.explorer.pools.get',
  kind: 'query',
  path: 'explorer.pools.get',
  access: PUBLIC_CHAIN,
  refusals: refusals(SERVING, UNWIRED, POOL_FACTORY, NOT_A_POOL),
  input: addressInput.extend({ interval: z.enum(INDEXER_CANDLE_INTERVALS).default('1h') }),
  output: z.object({
    pool: poolSchema,
    window: poolWindowSchema,
    volume1: z.string(),
    swaps: z.number().int(),
    candles: z
      .array(
        z.object({
          start: z.number().int(),
          open: z.string(),
          high: z.string(),
          low: z.string(),
          close: z.string(),
          volume1: z.string(),
          swaps: z.number().int(),
        }),
      )
      .nullable(),
    asOf: z.string(),
  }),
  samples: [
    { verdict: 'accept', input: { chainId: 84532, address: A } },
    { verdict: 'accept', input: { chainId: 84532, address: A, interval: '5m' } },
    { verdict: 'refuse', input: { chainId: 84532, address: A, interval: '1d' } },
  ],
});

/** A pool's swaps, newest first, each labelled from token0's side: buy (token0 out), sell (token0 in) or both. */
export const INDEXER_EXPLORER_POOLS_SWAPS = defineProcedure({
  ...base,
  name: 'indexer.explorer.pools.swaps',
  kind: 'query',
  path: 'explorer.pools.swaps',
  access: PUBLIC_CHAIN,
  refusals: refusals(SERVING, UNWIRED, POOL_FACTORY, LIST_LIMIT, NOT_A_POOL),
  input: addressInput.extend({ cursor: poolCursorSchema.optional() }),
  output: z.object({
    rows: z.array(
      z.object({
        hash: z.string(),
        blockHeight: z.number().int(),
        index: z.number().int(),
        logIndex: z.number().int(),
        timestamp: z.number().int(),
        side: z.enum(['buy', 'sell', 'both']),
        sender: z.string(),
        recipient: z.string(),
        amount0In: z.string(),
        amount1In: z.string(),
        amount0Out: z.string(),
        amount1Out: z.string(),
      }),
    ),
    nextCursor: poolCursorSchema.nullable(),
    asOf: z.string(),
  }),
  samples: [
    { verdict: 'accept', input: { chainId: 84532, address: A } },
    { verdict: 'refuse', input: { chainId: 84532, address: A, cursor: { height: 1 } } },
  ],
});

/** One transaction by hash on the chain the indexer reads. Unknown is NOT_FOUND; a blank drop window refuses rather than guess dropped. */
export const INDEXER_EXPLORER_TX_GET = defineProcedure({
  ...base,
  name: 'indexer.explorer.tx.get',
  kind: 'query',
  path: 'explorer.tx.get',
  access: PUBLIC_CHAIN,
  refusals: refusals(SERVING, UNWIRED, NOT_FOUND, refuse('PRECONDITION_FAILED', 'indexer.tx_drop_window_unset')),
  input: z.object({ chainId: chainIdSchema, hash: z.string().regex(HASH) }),
  output: explorerTxSchema,
  samples: [
    { verdict: 'accept', input: { chainId: 84532, hash: H } },
    { verdict: 'refuse', input: { chainId: 84532, hash: '0x1' } },
  ],
});

/**
 * The same hash on the other networks this indexer is told to search, asked live of each one's node. A node that did not
 * answer, or answered as another chain, is `not_checked` with its code, never `not_found`. No listed network is an empty list.
 */
export const INDEXER_EXPLORER_TX_NETWORKS = defineProcedure({
  ...base,
  name: 'indexer.explorer.tx.networks',
  kind: 'query',
  path: 'explorer.tx.networks',
  access: PUBLIC_CHAIN,
  refusals: {},
  input: z.object({ hash: z.string().regex(HASH) }),
  output: z.object({ networks: z.array(networkAnswerSchema) }),
  samples: [
    { verdict: 'accept', input: { hash: H } },
    { verdict: 'refuse', input: { hash: '0x1' } },
  ],
});

/**
 * How far behind the chain the projection is, and whether it trusts itself: `halted`, `behindBy` (null when either the
 * chain tip or the cursor is unknown, never zero) and `lastError`. Always answers, halted included: that is how a caller
 * learns why the data reads refuse.
 */
export const INDEXER_STATUS = defineProcedure({
  ...base,
  name: 'indexer.status',
  kind: 'query',
  path: 'status',
  access: PUBLIC_CHAIN,
  refusals: {},
  input: NO_INPUT,
  output: z.object({
    chainId: z.number(),
    chainSource: z.string(),
    indexedHeight: z.number().int().nullable(),
    indexedHash: z.string().nullable(),
    earliestHeight: z.number().int().nullable(),
    finalityDepth: z.number().int(),
    /** Below this, blocks are treated as final and version history is pruned. */
    finalizedHeight: z.number().int().nullable(),
    ingestEnabled: z.boolean(),
    halted: z.object({ reason: z.string(), at: z.string() }).nullable(),
    /** Live, per request. `null` when no probe is wired, never a guess. */
    chain: chainProbeSchema.nullable(),
    /** Chain tip minus our cursor. `null` when either is unknown. */
    behindBy: z.number().int().nullable(),
    lastError: z.object({ code: z.string().nullable(), message: z.string(), at: z.string() }).nullable(),
    clob: clobHonestySchema,
  }),
  samples: [{ verdict: 'accept' }],
});

/**
 * The book as of the FINALIZED block, not the head, so a reorg above it cannot change the answer. An empty index, or one
 * holding no block at the finalized height yet, answers the empty book with a null as-of. `depth` is a published 1..200
 * window: omitted, 0 or over the cap refuses `indexer.book_depth_unset`.
 */
export const INDEXER_BOOK = defineProcedure({
  ...base,
  name: 'indexer.book',
  kind: 'query',
  path: 'book',
  access: PUBLIC_CHAIN,
  refusals: refusals(SERVING, refuse('BAD_REQUEST', 'indexer.book_depth_unset')),
  input: z.object({ market: marketSchema, depth: z.number().optional() }),
  output: z.object({
    market: z.string(),
    chainId: z.number(),
    asOfHeight: z.number().int().nullable(),
    asOfHash: z.string().nullable(),
    bids: z.array(wireLevelSchema),
    asks: z.array(wireLevelSchema),
    clob: clobHonestySchema,
  }),
  samples: [
    { verdict: 'accept', input: { market: 'IFC-USD', depth: 10 } },
    { verdict: 'accept', input: { market: 'IFC-USD' } },
    { verdict: 'refuse', input: { market: '' } },
  ],
});

/** An address's positions across markets. `limit` is a published 1..200 window: omitted, 0 or over the cap refuses by name. */
export const INDEXER_POSITIONS = defineProcedure({
  ...base,
  name: 'indexer.positions',
  kind: 'query',
  path: 'positions',
  access: PUBLIC_CHAIN,
  refusals: refusals(SERVING, refuse('BAD_REQUEST', 'indexer.positions_list_limit_unset')),
  input: z.object({ account: addressSchema, limit: z.number().optional() }),
  output: z.array(positionSchema),
  samples: [
    { verdict: 'accept', input: { account: A, limit: 10 } },
    { verdict: 'accept', input: { account: A } },
    { verdict: 'refuse', input: { account: 'not-an-address', limit: 10 } },
  ],
});

/** Every svc-indexer call, in the order its router mounts them. */
export const INDEXER_PROCEDURES = [
  INDEXER_EXPLORER_BLOCKS_LIST,
  INDEXER_EXPLORER_BLOCKS_GET,
  INDEXER_EXPLORER_TXS_LIST,
  INDEXER_EXPLORER_ADDRESS_TXS,
  INDEXER_EXPLORER_ADDRESS_SUMMARY,
  INDEXER_EXPLORER_ADDRESS_HOLDINGS,
  INDEXER_EXPLORER_ADDRESS_INTERNAL,
  INDEXER_EXPLORER_ADDRESS_BALANCE_AT,
  INDEXER_EXPLORER_TOKENS_BY_SYMBOL,
  INDEXER_EXPLORER_POOLS_LIST,
  INDEXER_EXPLORER_POOLS_GET,
  INDEXER_EXPLORER_POOLS_SWAPS,
  INDEXER_EXPLORER_TX_GET,
  INDEXER_EXPLORER_TX_NETWORKS,
  INDEXER_STATUS,
  INDEXER_BOOK,
  INDEXER_POSITIONS,
] as const;

/** Every refusal code a record lists, so svc-indexer can read one back from the message it sent. */
export const INDEXER_REFUSAL_CODES: readonly string[] = [...new Set(INDEXER_PROCEDURES.flatMap((r) => Object.keys(r.refusals)))];

export type IndexerStatus = ProcedureOutput<typeof INDEXER_STATUS>;
export type IndexerBook = ProcedureOutput<typeof INDEXER_BOOK>;
export type IndexerPosition = ProcedureOutput<typeof INDEXER_POSITIONS>[number];
export type ClobHonesty = z.infer<typeof clobHonestySchema>;

export type ExplorerBlocksPage = ProcedureOutput<typeof INDEXER_EXPLORER_BLOCKS_LIST>;
export type ExplorerBlockRow = ProcedureOutput<typeof INDEXER_EXPLORER_BLOCKS_GET>;
export type ExplorerTxsPage = ProcedureOutput<typeof INDEXER_EXPLORER_TXS_LIST>;
export type ExplorerTxRow = ExplorerTxsPage['rows'][number];
export type ExplorerTx = ProcedureOutput<typeof INDEXER_EXPLORER_TX_GET>;
export type ExplorerTxNetworks = ProcedureOutput<typeof INDEXER_EXPLORER_TX_NETWORKS>;
export type ExplorerAddressTxsPage = ProcedureOutput<typeof INDEXER_EXPLORER_ADDRESS_TXS>;
export type ExplorerAddressSummary = ProcedureOutput<typeof INDEXER_EXPLORER_ADDRESS_SUMMARY>;
export type ExplorerAddressHoldings = ProcedureOutput<typeof INDEXER_EXPLORER_ADDRESS_HOLDINGS>;
export type ExplorerAddressInternalPage = ProcedureOutput<typeof INDEXER_EXPLORER_ADDRESS_INTERNAL>;
export type ExplorerBalanceAt = ProcedureOutput<typeof INDEXER_EXPLORER_ADDRESS_BALANCE_AT>;
export type ExplorerToken = ProcedureOutput<typeof INDEXER_EXPLORER_TOKENS_BY_SYMBOL>['rows'][number];

export type PoolsPage = ProcedureOutput<typeof INDEXER_EXPLORER_POOLS_LIST>;
export type PoolListRow = PoolsPage['rows'][number];
export type PoolCursor = NonNullable<PoolsPage['nextCursor']>;
export type PoolDay = ProcedureOutput<typeof INDEXER_EXPLORER_POOLS_GET>;
export type Pool = PoolDay['pool'];
export type PoolToken = Pool['token0'];
export type PoolCandle = NonNullable<PoolDay['candles']>[number];
export type PoolSwapsPage = ProcedureOutput<typeof INDEXER_EXPLORER_POOLS_SWAPS>;
