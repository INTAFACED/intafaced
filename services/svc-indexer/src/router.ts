import { SYMBOL_MAX_CHARS } from './chain/evm/token-meta.js';
import { z } from 'zod';
import { formatAmount } from '@intafaced/ledger-client/money';
import { publicJurisdictionProcedure, publicProcedure, router, TRPCError } from '@intafaced/contracts';
import { ChainDataError } from './chain/source.js';
import { ChainUnavailableError } from './chain/evm/availability.js';
import { finalizedHeightOf, type FillRecord, type PositionRecord, type ProjectionStore } from './projection/store.js';
import type { Indexer } from './indexer.js';
import { clobFixtureRefusesLiveClaim, clobHonesty, clobHonestySchema, INDEXER_CLOB_FIXTURE_NOT_LIVE } from './clob-honesty.js';
import { indexerHealthHonesty, indexerHealthHonestySchema } from './health-honesty.js';
import {
  chainSourceRefusesServing,
  haltServingReason,
  lastErrorRefusesServing,
  lastErrorServingReason,
  nullChainServingReason,
} from './serving.js';
import { userCopy } from './user-copy.js';
import { withReadSpan } from './tracing.js';
import {
  INDEXER_EXPLORER_LIST_LIMIT_UNSET,
  INDEXER_EXPLORER_UNWIRED,
  PROTOCOL_NOT_FOUND,
  listPage,
  toRow,
  type ExplorerBlocksSource,
} from './explorer/blocks.js';
import { classifyExplorerTx, listTxPage, type ExplorerTxList, type ExplorerTxSource } from './explorer/tx.js';
import {
  directionOf,
  endOfUtcDay,
  listAddressInternalPage,
  listAddressTxPage,
  type AddressPageSource,
  type ExplorerAddressSource,
} from './explorer/address.js';
import { StateUnavailableError } from './chain/evm/address-state.js';
import type { FindTx } from './explorer/search-networks.js';
import { assessProjectionStream, INDEXER_STREAM_UNWIRED, type StreamBook, type StreamLevel } from './stream.js';
import {
  INDEXER_BOOK_DEPTH_UNSET,
  INDEXER_FILLS_LIMIT_UNSET,
  INDEXER_MARKETS_LIST_LIMIT_UNSET,
  INDEXER_POSITIONS_LIST_LIMIT_UNSET,
  INDEXER_STREAM_DEPTH_UNSET,
  INDEXER_STREAM_MARKETS_LIMIT_UNSET,
  isPublishedBookDepth,
  isPublishedFillsLimit,
} from './trpc-windows.js';

/**
 * svc-indexer's API — the read path for `apps/web` (§17.5).
 *
 * ── Read the guards ────────────────────────────────────────────────────────
 *
 * EVERY data procedure is `publicJurisdictionProcedure('indexer', 'protocol')`.
 * No login, no KYC tier, no account gate. That is §22 as code:
 * `MODULES.indexer` is `custodial: false` on the `protocol` plane, so
 * `checkAccess` returns `allowed.permissionless` and there is nothing to
 * verify, because there is nothing held. `sovereignty.test.ts` asserts that for
 * every region and every tier rather than trusting the reading.
 *
 * There is no scoped procedure anywhere in this router, and there could not
 * usefully be one. Every fact here is a copy of public chain state: the book,
 * the tape, and a position at an address anyone can already query from any
 * node. Putting an account gate in front of a mirror of public data would not
 * protect a user, it would only make the mirror worse than the original.
 *
 * ── Money on the wire ──────────────────────────────────────────────────────
 *
 * Decimal strings, always. `formatAmount` is the only thing that renders a
 * price in this file; nothing here constructs a `number` from an amount. A
 * client that wants arithmetic parses the string — it does not get handed a
 * float that already lost the last decimal place.
 */

const marketSchema = z.string().min(1).max(64);
const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 20-byte hex address');

/** `['30000.5', '2.25']` — price, quantity. */
const wireLevelSchema = z.tuple([z.string(), z.string()]);

const fillSchema = z.object({
  market: z.string(),
  price: z.string(),
  quantity: z.string(),
  takerSide: z.enum(['buy', 'sell']),
  maker: z.string(),
  taker: z.string(),
  blockHeight: z.number().int(),
  blockHash: z.string(),
  logIndex: z.number().int(),
  blockTime: z.string(),
});

const positionSchema = z.object({
  market: z.string(),
  account: z.string(),
  /** Signed decimal string — negative is short. */
  size: z.string(),
  entryPrice: z.string(),
  blockHeight: z.number().int(),
  blockHash: z.string(),
});

function toWireFill(fill: FillRecord): z.infer<typeof fillSchema> {
  return {
    market: fill.market,
    price: formatAmount(fill.price),
    quantity: formatAmount(fill.quantity),
    takerSide: fill.takerSide,
    maker: fill.maker,
    taker: fill.taker,
    blockHeight: fill.blockHeight,
    blockHash: fill.blockHash,
    logIndex: fill.logIndex,
    blockTime: fill.blockTime.toISOString(),
  };
}

function toWirePosition(position: PositionRecord): z.infer<typeof positionSchema> {
  return {
    market: position.market,
    account: position.account,
    size: formatAmount(position.size),
    entryPrice: formatAmount(position.entryPrice),
    blockHeight: position.blockHeight,
    blockHash: position.blockHash,
  };
}

function toTrpcError(err: unknown): TRPCError {
  if (err instanceof TRPCError) return err;
  if (err instanceof ChainDataError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: userCopy(err.code), cause: err });
  }
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: userCopy('indexer.request_failed'), cause: err });
}

/**
 * A live look at the chain behind the projection. Produced by
 * `EvmChainSource.probe()`, which never throws — "the chain is down" is an
 * answer a status surface has to render, not an exception it has to catch.
 *
 * `NullChainSource` fills this in too, with `kind: 'null'` and a reason, because
 * "we were never given a chain" is a fact a caller needs as much as "the chain
 * is down" and the two must not render the same.
 */
export interface ChainProbe {
  readonly kind: 'null' | 'evm';
  readonly rpcUrl: string | null;
  readonly venue: string | null;
  readonly reachable: boolean;
  readonly observedChainId: number | null;
  /** The chain's own tip. Half of the staleness answer; the cursor is the other. */
  readonly chainHeight: number | null;
  readonly venueDeployed: boolean;
  readonly refusalCode: string | null;
  readonly reason: string | null;
}

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

export interface IndexerRouterDeps {
  readonly store: ProjectionStore;
  readonly indexer: Indexer;
  readonly chainId: number;
  readonly finalityDepth: number;
  /** Mirrors the `indexer.ingest` kill-switch (§14). */
  readonly ingestEnabled: () => boolean;
  /** Which `ChainSource` is wired: `'null'` or `'evm'`. */
  readonly chainSource: string;
  /**
   * Live probe of the chain, for `status`. Optional so a router can be mounted
   * without one; when it is absent `status.chain` is `null`, which reads as
   * "nobody asked" and never as "the chain is fine".
   */
  readonly chainProbe?: () => Promise<ChainProbe>;
  /**
   * Venue + RPC that would feed the projection stream. Blank / zero venue →
   * `indexer.stream_unwired`. Optional so existing mounts stay honest.
   */
  readonly venue?: string | null;
  readonly rpcUrl?: string | null;
  /**
   * True when this process is presenting as a live production CLOB
   * (`APP_ENV=prod`). Fixture ABI then refuses data paths.
   */
  readonly claimLiveClob?: boolean;
  /** D-explorer-01 block facts + owner list limit. Absent => `indexer.explorer_unwired`. */
  readonly explorer?: ExplorerBlocksSource;
  /** D-explorer-02 transaction read. Absent => `indexer.explorer_unwired`. */
  readonly txs?: ExplorerTxSource;
  /** Latest transactions, newest first. Absent => `indexer.explorer_unwired`. */
  readonly txList?: ExplorerTxList;
  /** D-explorer-03 address transactions and token search. Absent => `indexer.explorer_unwired`. */
  readonly address?: ExplorerAddressSource;
  /** D-explorer-03 address page: live balance, kind and token balances, internal moves, past balance. Absent => `indexer.explorer_unwired`. */
  readonly addressPage?: AddressPageSource;
  /** D-explorer-02 the other networks a hash is looked up on, live. Absent or empty => the search names none. */
  readonly searchNetworks?: ReadonlyArray<{ readonly chainId: number; readonly find: FindTx }>;
}

/**
 * A halted projection knows its book is wrong and cannot repair it.
 * A projection whose last sync hit a typed serving-refuse lastError (chain
 * door or startHeight — see `SERVING_REFUSE_CODES`) likewise must not serve
 * prices as current. A `chainSource: 'null'` boot never sets lastError
 * (`NullChainSource` cannot fail) — without this door an empty book / null
 * position would look like a quiet market or a flat holding.
 * `status` and `health` still answer so an operator can see why.
 *
 * Call before published-window 400s: a halt must not look like bad input.
 */
function assertServing(indexer: Indexer, chainSource: string, venue?: string | null, claimLiveClob = false): void {
  const halt = indexer.halted;
  if (halt) {
    throw new TRPCError({
      code: 'SERVICE_UNAVAILABLE',
      message: haltServingReason(halt),
    });
  }
  const failure = indexer.lastError;
  if (lastErrorRefusesServing(failure)) {
    throw new TRPCError({
      code: 'SERVICE_UNAVAILABLE',
      message: lastErrorServingReason(failure),
    });
  }
  if (chainSourceRefusesServing(chainSource)) {
    throw new TRPCError({
      code: 'SERVICE_UNAVAILABLE',
      message: nullChainServingReason(),
    });
  }
  if (clobFixtureRefusesLiveClaim({ claimLiveClob, venue })) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: userCopy(INDEXER_CLOB_FIXTURE_NOT_LIVE),
    });
  }
}

const explorerTxSchema = z.object({
  chainId: z.number().int(),
  hash: z.string(),
  status: z.enum(['success', 'failed', 'pending', 'dropped', 'replaced']),
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
  hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
});

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

/**
 * A live read of the node failed. The node no longer holding that block's state, or not answering, is said with its own
 * code so the page can name it; it is never a zero balance.
 */
function nodeReadError(err: unknown): unknown {
  if (err instanceof StateUnavailableError) {
    return new TRPCError({ code: 'PRECONDITION_FAILED', message: userCopy(err.code), cause: err });
  }
  if (err instanceof ChainUnavailableError) {
    return new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: userCopy(err.code), cause: err });
  }
  return err;
}

function addressPageOrRefuse(deps: IndexerRouterDeps): { explorer: ExplorerBlocksSource; page: AddressPageSource } {
  const explorer = explorerOrRefuse(deps);
  if (!deps.addressPage) {
    throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: userCopy(INDEXER_EXPLORER_UNWIRED) });
  }
  return { explorer, page: deps.addressPage };
}

function ownerLimit(explorer: ExplorerBlocksSource): number {
  const owner = explorer.listLimit;
  if (!owner.ok) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: userCopy(INDEXER_EXPLORER_LIST_LIMIT_UNSET) });
  }
  return owner.limit;
}

const addressInput = z.object({ chainId: z.number().int(), address: addressSchema });

function explorerOrRefuse(deps: IndexerRouterDeps): ExplorerBlocksSource {
  assertServing(deps.indexer, deps.chainSource, deps.venue, deps.claimLiveClob);
  if (!deps.explorer) {
    throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: userCopy(INDEXER_EXPLORER_UNWIRED) });
  }
  return deps.explorer;
}

export function createIndexerRouter(deps: IndexerRouterDeps) {
  const { store, indexer } = deps;

  return router({
    explorer: router({
      blocks: router({
        /** Descending from the head; owner-bounded window; orphans kept with reason. */
        list: publicJurisdictionProcedure('indexer', 'protocol')
          .input(
            z.object({
              chainId: z.number().int(),
              cursor: z.number().int().min(0).optional(),
              limit: z.number().int().min(1).optional(),
            }),
          )
          .output(
            z.object({
              rows: z.array(explorerBlockRowSchema),
              nextCursor: z.number().int().nullable(),
              /** Head minus the finality depth; null before the first block or on another network. */
              finalizedHeight: z.number().int().nullable(),
              asOf: z.string(),
            }),
          )
          .query(async ({ input }) => {
            try {
              const explorer = explorerOrRefuse(deps);
              const owner = explorer.listLimit;
              if (!owner.ok) {
                throw new TRPCError({ code: 'BAD_REQUEST', message: userCopy(INDEXER_EXPLORER_LIST_LIMIT_UNSET) });
              }
              // Owner limit bounds the window: a larger caller limit is clamped, not refused.
              const limit = Math.min(input.limit ?? owner.limit, owner.limit);
              const paged =
                input.chainId === deps.chainId ? await listPage(explorer, { cursor: input.cursor, limit }) : { rows: [], nextCursor: null };
              const page = { rows: paged.rows.map(toRow), nextCursor: paged.nextCursor };
              const finalizedHeight = input.chainId === deps.chainId ? finalizedHeightOf(await store.head(), deps.finalityDepth) : null;
              return { ...page, finalizedHeight, asOf: new Date().toISOString() };
            } catch (err) {
              throw toTrpcError(err);
            }
          }),
        /** By height (canonical first) or hash. Unknown => NOT_FOUND, never null. */
        get: publicJurisdictionProcedure('indexer', 'protocol')
          .input(
            z.union([
              z.object({ chainId: z.number().int(), height: z.number().int().min(0) }),
              z.object({ chainId: z.number().int(), hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }),
            ]),
          )
          .output(explorerBlockRowSchema)
          .query(async ({ input }) => {
            try {
              const explorer = explorerOrRefuse(deps);
              const match =
                input.chainId !== deps.chainId
                  ? null
                  : await explorer.block('hash' in input ? { hash: input.hash.toLowerCase() } : { height: input.height });
              if (!match) throw new TRPCError({ code: 'NOT_FOUND', message: userCopy(PROTOCOL_NOT_FOUND) });
              return toRow(match);
            } catch (err) {
              throw toTrpcError(err);
            }
          }),
      }),
      txs: router({
        /** Newest first, optionally of one block; owner-bounded window; orphans kept with reason. */
        list: publicJurisdictionProcedure('indexer', 'protocol')
          .input(
            z.object({
              chainId: z.number().int(),
              blockHash: z
                .string()
                .regex(/^0x[0-9a-fA-F]{64}$/)
                .optional(),
              cursor: z
                .object({
                  height: z.number().int().min(0),
                  index: z.number().int().min(0),
                  hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
                })
                .optional(),
              limit: z.number().int().min(1).optional(),
            }),
          )
          .output(
            z.object({
              rows: z.array(explorerTxListRowSchema),
              nextCursor: z.object({ height: z.number().int(), index: z.number().int(), hash: z.string() }).nullable(),
              asOf: z.string(),
            }),
          )
          .query(async ({ input }) => {
            try {
              const explorer = explorerOrRefuse(deps);
              if (!deps.txList) {
                throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: userCopy(INDEXER_EXPLORER_UNWIRED) });
              }
              const owner = explorer.listLimit;
              if (!owner.ok) {
                throw new TRPCError({ code: 'BAD_REQUEST', message: userCopy(INDEXER_EXPLORER_LIST_LIMIT_UNSET) });
              }
              const limit = Math.min(input.limit ?? owner.limit, owner.limit);
              const page =
                input.chainId === deps.chainId
                  ? await listTxPage(deps.txList, {
                      limit,
                      ...(input.blockHash ? { blockHash: input.blockHash.toLowerCase() } : {}),
                      ...(input.cursor ? { cursor: { ...input.cursor, hash: input.cursor.hash.toLowerCase() } } : {}),
                    })
                  : { rows: [], nextCursor: null };
              return {
                rows: page.rows.map(({ valueWei, ...r }) => ({ ...r, chainId: deps.chainId, value: valueWei.toString() })),
                nextCursor: page.nextCursor,
                asOf: new Date().toISOString(),
              };
            } catch (err) {
              throw toTrpcError(err);
            }
          }),
      }),
      address: router({
        /**
         * Transactions the address sent, received, or is a party to through an ERC-20 Transfer, newest first, from
         * canonical blocks. Each row carries the transfers to or from the address. Owner-bounded window.
         */
        txs: publicJurisdictionProcedure('indexer', 'protocol')
          .input(
            z.object({
              chainId: z.number().int(),
              address: addressSchema,
              cursor: txCursorSchema.optional(),
              limit: z.number().int().min(1).optional(),
            }),
          )
          .output(
            z.object({
              rows: z.array(addressTxRowSchema),
              nextCursor: z.object({ height: z.number().int(), index: z.number().int(), hash: z.string() }).nullable(),
              asOf: z.string(),
              /** The newest canonical block indexed when this answer was read; null before the first block or on another network. */
              asOfHeight: z.number().int().nullable(),
            }),
          )
          .query(async ({ input }) => {
            try {
              const explorer = explorerOrRefuse(deps);
              if (!deps.address) {
                throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: userCopy(INDEXER_EXPLORER_UNWIRED) });
              }
              const owner = explorer.listLimit;
              if (!owner.ok) {
                throw new TRPCError({ code: 'BAD_REQUEST', message: userCopy(INDEXER_EXPLORER_LIST_LIMIT_UNSET) });
              }
              const limit = Math.min(input.limit ?? owner.limit, owner.limit);
              const address = input.address.toLowerCase();
              const ours = input.chainId === deps.chainId;
              const head = ours ? await store.head() : null;
              const page = ours
                ? await listAddressTxPage(deps.address.txs, {
                    address,
                    limit,
                    ...(input.cursor ? { cursor: { ...input.cursor, hash: input.cursor.hash.toLowerCase() } } : {}),
                  })
                : { rows: [], nextCursor: null };
              return {
                rows: page.rows.map((row) => ({
                  chainId: deps.chainId,
                  hash: row.hash,
                  blockHeight: row.blockHeight,
                  blockHash: row.blockHash,
                  index: row.index,
                  timestamp: row.timestamp,
                  from: row.from,
                  to: row.to,
                  status: row.status,
                  revertReason: row.revertReason,
                  transfers: row.transfers.map((transfer) => ({
                    token: { address: transfer.token.address, symbol: transfer.token.symbol, decimals: transfer.token.decimals },
                    amount: transfer.amount.toString(),
                    direction: directionOf(transfer, address),
                  })),
                })),
                nextCursor: page.nextCursor,
                asOf: new Date().toISOString(),
                asOfHeight: head?.height ?? null,
              };
            } catch (err) {
              throw toTrpcError(err);
            }
          }),
        /**
         * The address's native balance (wei) and whether code lives there, read from the node at the newest canonical
         * block indexed, so it speaks of the same block as the transactions list. Nulls on another network or before
         * the first block.
         */
        summary: publicJurisdictionProcedure('indexer', 'protocol')
          .input(addressInput)
          .output(
            z.object({
              kind: z.enum(['account', 'contract']).nullable(),
              /** Wei, decimal string. */
              balance: z.string().nullable(),
              asOfHeight: z.number().int().nullable(),
              asOf: z.string(),
            }),
          )
          .query(async ({ input }) => {
            try {
              const { page } = addressPageOrRefuse(deps);
              const head = input.chainId === deps.chainId ? await store.head() : null;
              if (!head) return { kind: null, balance: null, asOfHeight: null, asOf: new Date().toISOString() };
              const account = await page.state.account(input.address.toLowerCase(), head.height).catch((err: unknown) => {
                throw nodeReadError(err);
              });
              return {
                kind: account.isContract ? ('contract' as const) : ('account' as const),
                balance: account.balanceWei.toString(),
                asOfHeight: head.height,
                asOf: new Date().toISOString(),
              };
            } catch (err) {
              throw toTrpcError(err);
            }
          }),
        /**
         * Tokens the address sent or received, each with its own `balanceOf` read at the newest canonical block
         * indexed. A zero balance is not a holding. `balance` is null where the contract did not answer as a token.
         * The indexer has no price source, so `price` is always null and every holding counts in `unpriced`.
         */
        holdings: publicJurisdictionProcedure('indexer', 'protocol')
          .input(addressInput)
          .output(
            z.object({
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
          )
          .query(async ({ input }) => {
            try {
              const { explorer, page } = addressPageOrRefuse(deps);
              const limit = ownerLimit(explorer);
              const head = input.chainId === deps.chainId ? await store.head() : null;
              if (!head) return { rows: [], unpriced: 0, more: false, asOfHeight: null, asOf: new Date().toISOString() };
              const address = input.address.toLowerCase();
              const fetched = await page.reads.tokens({ address, limit });
              const tokens = fetched.slice(0, limit);
              const balances = await page.state
                .tokenBalances(
                  tokens.map((token) => token.address),
                  address,
                  head.height,
                )
                .catch((err: unknown) => {
                  throw nodeReadError(err);
                });
              const rows = tokens
                .map((token, i) => ({ token, balance: balances[i] ?? null }))
                .filter((row) => row.balance !== 0n)
                .map((row) => ({
                  token: { address: row.token.address, symbol: row.token.symbol, decimals: row.token.decimals },
                  balance: row.balance === null ? null : row.balance.toString(),
                  price: null,
                }));
              return {
                rows,
                unpriced: rows.filter((row) => row.balance !== null).length,
                more: fetched.length > limit,
                asOfHeight: head.height,
                asOf: new Date().toISOString(),
              };
            } catch (err) {
              throw toTrpcError(err);
            }
          }),
        /**
         * Transactions with internal value moves to or from the address, newest first, each with those moves. `gaps`
         * names the indexed blocks whose trace was not read, where a move could exist that this list cannot show.
         */
        internal: publicJurisdictionProcedure('indexer', 'protocol')
          .input(addressInput.extend({ cursor: txCursorSchema.optional(), limit: z.number().int().min(1).optional() }))
          .output(
            z.object({
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
              nextCursor: z.object({ height: z.number().int(), index: z.number().int(), hash: z.string() }).nullable(),
              gaps: z.object({
                blocks: z.number().int(),
                fromHeight: z.number().int().nullable(),
                toHeight: z.number().int().nullable(),
                reasons: z.array(z.string()),
              }),
              asOfHeight: z.number().int().nullable(),
              asOf: z.string(),
            }),
          )
          .query(async ({ input }) => {
            try {
              const { explorer, page } = addressPageOrRefuse(deps);
              const owner = ownerLimit(explorer);
              const limit = Math.min(input.limit ?? owner, owner);
              const ours = input.chainId === deps.chainId;
              const head = ours ? await store.head() : null;
              const list = ours
                ? await listAddressInternalPage(page.reads.internal, {
                    address: input.address.toLowerCase(),
                    limit,
                    ...(input.cursor ? { cursor: { ...input.cursor, hash: input.cursor.hash.toLowerCase() } } : {}),
                  })
                : { rows: [], nextCursor: null };
              const gaps = ours ? await page.reads.traceGaps() : { blocks: 0, fromHeight: null, toHeight: null, reasons: [] };
              return {
                rows: list.rows.map((row) => ({
                  chainId: deps.chainId,
                  hash: row.hash,
                  blockHeight: row.blockHeight,
                  index: row.index,
                  timestamp: row.timestamp,
                  calls: row.calls.map(({ valueWei, ...call }) => ({ ...call, value: valueWei.toString() })),
                })),
                nextCursor: list.nextCursor,
                gaps: { ...gaps, reasons: [...gaps.reasons] },
                asOfHeight: head?.height ?? null,
                asOf: new Date().toISOString(),
              };
            } catch (err) {
              throw toTrpcError(err);
            }
          }),
        /**
         * The address's native balance at a past block, or at the end of a UTC day (the last canonical block before
         * midnight after it). A point outside the indexed blocks answers `indexed: false` with the indexed range.
         */
        balanceAt: publicJurisdictionProcedure('indexer', 'protocol')
          .input(
            addressInput.extend({
              at: z.union([
                z.object({ height: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }),
                z.object({ date: z.string().refine((date) => endOfUtcDay(date) !== null, 'must be a YYYY-MM-DD date') }),
              ]),
            }),
          )
          .output(
            z.union([
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
          )
          .query(async ({ input }) => {
            try {
              const { page } = addressPageOrRefuse(deps);
              const ours = input.chainId === deps.chainId;
              const [earliestHeight, head] = ours ? await Promise.all([page.reads.earliestHeight(), store.head()]) : [null, null];
              const latestHeight = head?.height ?? null;
              const notIndexed = (after: boolean) => ({ indexed: false as const, after, earliestHeight, latestHeight });
              if (!head) return notIndexed(false);
              let block;
              if ('height' in input.at) {
                if (input.at.height > head.height) return notIndexed(true);
                block = await page.reads.blockAt(input.at.height);
              } else {
                // A day is read only once a block after its end is indexed: before that, a later block of the day may
                // still move the balance, and the newest indexed block is not "the end of that day".
                const dayEnd = endOfUtcDay(input.at.date) as Date;
                if (head.blockTime.getTime() < dayEnd.getTime()) return notIndexed(true);
                block = await page.reads.blockBefore(dayEnd);
              }
              if (!block) return notIndexed(false);
              const balance = await page.state.balance(input.address.toLowerCase(), block.height).catch((err: unknown) => {
                throw nodeReadError(err);
              });
              return { indexed: true as const, height: block.height, timestamp: block.timestamp, balance: balance.toString() };
            } catch (err) {
              throw toTrpcError(err);
            }
          }),
      }),
      tokens: router({
        /**
         * Every token contract whose own `symbol()` is this one, ignoring case: one row per contract, never merged,
         * so two tokens sharing a symbol are both listed. `more` is true when the owner window cut the list.
         */
        bySymbol: publicJurisdictionProcedure('indexer', 'protocol')
          .input(
            z.object({
              chainId: z.number().int(),
              // Counted in characters, as token-meta stores them, so a stored symbol can always be searched.
              symbol: z
                .string()
                .trim()
                .min(1)
                .refine((symbol) => Array.from(symbol).length <= SYMBOL_MAX_CHARS),
            }),
          )
          .output(z.object({ rows: z.array(tokenSchema.extend({ chainId: z.number().int() })), more: z.boolean(), asOf: z.string() }))
          .query(async ({ input }) => {
            try {
              const explorer = explorerOrRefuse(deps);
              if (!deps.address) {
                throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: userCopy(INDEXER_EXPLORER_UNWIRED) });
              }
              const owner = explorer.listLimit;
              if (!owner.ok) {
                throw new TRPCError({ code: 'BAD_REQUEST', message: userCopy(INDEXER_EXPLORER_LIST_LIMIT_UNSET) });
              }
              const fetched =
                input.chainId === deps.chainId ? await deps.address.tokensBySymbol({ symbol: input.symbol, limit: owner.limit }) : [];
              return {
                rows: fetched.slice(0, owner.limit).map((token) => ({ ...token, chainId: deps.chainId })),
                more: fetched.length > owner.limit,
                asOf: new Date().toISOString(),
              };
            } catch (err) {
              throw toTrpcError(err);
            }
          }),
      }),
      tx: router({
        /** By hash. Unknown => NOT_FOUND. A blank drop window refuses rather than guessing dropped. */
        get: publicJurisdictionProcedure('indexer', 'protocol')
          .input(z.object({ chainId: z.number().int(), hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }))
          .output(explorerTxSchema)
          .query(async ({ input }) => {
            try {
              assertServing(deps.indexer, deps.chainSource, deps.venue, deps.claimLiveClob);
              if (!deps.txs) {
                throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: userCopy(INDEXER_EXPLORER_UNWIRED) });
              }
              if (input.chainId !== deps.chainId) {
                throw new TRPCError({ code: 'NOT_FOUND', message: userCopy(PROTOCOL_NOT_FOUND) });
              }
              const hash = input.hash.toLowerCase();
              const indexed = await deps.txs.indexed(hash);
              let live = null;
              if (!indexed) {
                try {
                  live = await deps.txs.lookup(hash);
                } catch (err) {
                  if (err instanceof ChainUnavailableError) {
                    throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: userCopy(err.code), cause: err });
                  }
                  throw err;
                }
              }
              const now = new Date();
              const pendingSince = !indexed && !live ? await deps.txs.pendingSince(hash) : null;
              const decision = classifyExplorerTx({
                indexed,
                live,
                pendingSince,
                now,
                dropWindow: deps.txs.dropWindow,
              });
              if (decision.kind === 'refuse') {
                throw new TRPCError({ code: 'PRECONDITION_FAILED', message: userCopy(decision.code) });
              }
              if (decision.kind === 'missing') {
                throw new TRPCError({ code: 'NOT_FOUND', message: userCopy(PROTOCOL_NOT_FOUND) });
              }
              if (decision.answer.recordPending) await deps.txs.notePending(hash, now);
              return {
                chainId: deps.chainId,
                hash,
                status: decision.answer.status,
                replacingHash: decision.answer.replacingHash,
                transaction: decision.answer.transaction,
                receipt: decision.answer.receipt,
                logs: decision.answer.logs,
                orphaned: decision.answer.orphaned,
              };
            } catch (err) {
              throw toTrpcError(err);
            }
          }),
        /**
         * The same hash on the other networks this indexer is told to search, asked live of each one's node. A node that
         * did not answer, or answered as another chain, is `not_checked` with its code, never `not_found`. No listed
         * network is an empty list, never an invented one.
         */
        networks: publicJurisdictionProcedure('indexer', 'protocol')
          .input(z.object({ hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }))
          .output(z.object({ networks: z.array(networkAnswerSchema) }))
          .query(async ({ input }) => {
            const finders = deps.searchNetworks ?? [];
            return { networks: await Promise.all(finders.map(({ find }) => find(input.hash))) };
          }),
      }),
    }),

    health: publicProcedure.output(indexerHealthHonestySchema).query(() =>
      indexerHealthHonesty({
        ingestEnabled: deps.ingestEnabled(),
        venue: deps.venue,
      }),
    ),

    /**
     * How far behind the chain this projection is, and whether it trusts itself.
     *
     * ── The three fields that matter, and why none of them is optional ───────
     *
     * `halted` — a projection that has hit a reorg deeper than its retained
     * history knows it is wrong. `indexedHeight` looks perfectly healthy in that
     * state, so the halt is published beside it rather than left to `/ready`.
     *
     * `behindBy` — the cursor alone cannot say how stale it is. "Height 8412"
     * means nothing without the chain's own tip next to it, and a read model that
     * cannot state its staleness gets trusted at exactly the moment it should not
     * be. `null` here means we could not ask, which is itself the answer: it is
     * never zero-by-default, because zero would read as "current".
     *
     * `lastError` — the pass that ends in neither progress nor a halt. The
     * endpoint is down, the venue holds no code, the node is on another chain:
     * the cursor freezes at a plausible number and nothing else on this response
     * would change. See `Indexer.lastError`.
     *
     * Always answers, including when halted — that is how a caller learns why
     * data procedures refuse.
     */
    status: publicJurisdictionProcedure('indexer', 'protocol')
      .output(
        z.object({
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
          /** Live, per request. `null` when no probe is wired — never a guess. */
          chain: chainProbeSchema.nullable(),
          /** Chain tip minus our cursor. `null` when either is unknown. */
          behindBy: z.number().int().nullable(),
          lastError: z.object({ code: z.string().nullable(), message: z.string(), at: z.string() }).nullable(),
          clob: clobHonestySchema,
        }),
      )
      .query(async () => {
        const [head, earliest, chain] = await Promise.all([store.head(), store.earliestHeight(), deps.chainProbe?.() ?? null]);
        const halt = indexer.halted;
        const failure = indexer.lastError;
        const indexedHeight = head?.height ?? null;
        return {
          chainId: deps.chainId,
          chainSource: deps.chainSource,
          indexedHeight,
          indexedHash: head?.hash ?? null,
          earliestHeight: earliest,
          finalityDepth: deps.finalityDepth,
          finalizedHeight: finalizedHeightOf(head, deps.finalityDepth),
          ingestEnabled: deps.ingestEnabled(),
          halted: halt ? { reason: halt.reason, at: halt.at.toISOString() } : null,
          chain,
          behindBy: chain?.chainHeight != null && indexedHeight != null ? chain.chainHeight - indexedHeight : null,
          lastError: failure ? { code: failure.code, message: failure.message, at: failure.at.toISOString() } : null,
          clob: clobHonesty(deps.venue),
        };
      }),

    /**
     * Distinct projected markets. `limit` is a published 1..200 window
     * (same cap as book/stream depth). Omit / 0 / over-cap refuses
     * `indexer.markets_list_limit_unset` — never invent 50.
     */
    markets: publicJurisdictionProcedure('indexer', 'protocol')
      .input(z.object({ limit: z.number().optional() }).optional())
      .output(z.array(z.string()))
      .query(async ({ input }) => {
        try {
          assertServing(indexer, deps.chainSource, deps.venue, deps.claimLiveClob);
          const limit = input?.limit;
          if (!isPublishedBookDepth(limit)) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: userCopy(INDEXER_MARKETS_LIST_LIMIT_UNSET) });
          }
          return [...(await store.markets(limit))];
        } catch (err) {
          throw toTrpcError(err);
        }
      }),

    /**
     * The book, as of a named block — the FINALIZED block, not the head.
     *
     * Inclusion is not finality: a book at the head can still be reorged away,
     * and a quote reader (svc-dex `IndexerQuoteVenue`) rightly refuses any book
     * above `status.finalizedHeight`. Serving the head book meant every healthy
     * head was refused and nothing could ever be priced. So this reads the
     * projection as of `finalizedHeight` (`store.bookFinalized`, one snapshot, so a
     * prune cannot land between choosing the height and reading it): only
     * versions written at or below it count, so a reorg above it cannot change
     * the answer. The book is `finalityDepth` blocks behind the head by design.
     * `asOfHeight` therefore equals `status.finalizedHeight` whenever that
     * block is held; an empty index, or one that holds no block at the
     * finalized height yet (a `startHeight` less than `finalityDepth` below the
     * head), answers the empty book with a `null` as-of, never a guess.
     *
     * The head book is still reachable through `stream`, which is live market
     * data rather than a price a trade settles against.
     *
     * `asOfHeight` / `asOfHash` are part of the response rather than a detail,
     * because "which chain state is this?" is the question a reorg makes real.
     * A client holding two books can tell whether they describe the same chain;
     * one holding two bare price ladders cannot.
     *
     * Refuses when halted or when the chain door last failed with a typed code
     * (D26-P1-I3) — a wrong/stale-as-live price costs a trade.
     *
     * `depth` is a published window. Omit / 0 / over-cap refuses
     * `indexer.book_depth_unset` — never invent 50. Owner may pass 50.
     */
    book: publicJurisdictionProcedure('indexer', 'protocol')
      .input(z.object({ market: marketSchema, depth: z.number().optional() }))
      .output(
        z.object({
          market: z.string(),
          chainId: z.number(),
          asOfHeight: z.number().int().nullable(),
          asOfHash: z.string().nullable(),
          bids: z.array(wireLevelSchema),
          asks: z.array(wireLevelSchema),
          clob: clobHonestySchema,
        }),
      )
      .query(async ({ input }) => {
        try {
          assertServing(indexer, deps.chainSource, deps.venue, deps.claimLiveClob);
          const depth = input.depth;
          if (!isPublishedBookDepth(depth)) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: userCopy(INDEXER_BOOK_DEPTH_UNSET) });
          }
          const view = await withReadSpan('indexer.book', input.market, () => store.bookFinalized(input.market, depth, deps.finalityDepth));
          return {
            market: view.market,
            chainId: view.chainId,
            asOfHeight: view.asOfHeight,
            asOfHash: view.asOfHash,
            bids: view.bids.map((l) => [formatAmount(l.price), formatAmount(l.quantity)] as [string, string]),
            asks: view.asks.map((l) => [formatAmount(l.price), formatAmount(l.quantity)] as [string, string]),
            clob: clobHonesty(deps.venue),
          };
        } catch (err) {
          throw toTrpcError(err);
        }
      }),

    fills: publicJurisdictionProcedure('indexer', 'protocol')
      .input(z.object({ market: marketSchema, limit: z.number().optional() }))
      .output(z.array(fillSchema))
      .query(async ({ input }) => {
        try {
          assertServing(indexer, deps.chainSource, deps.venue, deps.claimLiveClob);
          const limit = input.limit;
          if (!isPublishedFillsLimit(limit)) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: userCopy(INDEXER_FILLS_LIMIT_UNSET) });
          }
          const rows = await withReadSpan('indexer.fills', input.market, () => store.recentFills(input.market, limit));
          return rows.map(toWireFill);
        } catch (err) {
          throw toTrpcError(err);
        }
      }),

    /** An address's own tape. Public chain data, so public here (§22). */
    accountFills: publicJurisdictionProcedure('indexer', 'protocol')
      .input(z.object({ account: addressSchema, limit: z.number().optional() }))
      .output(z.array(fillSchema))
      .query(async ({ input }) => {
        try {
          assertServing(indexer, deps.chainSource, deps.venue, deps.claimLiveClob);
          const limit = input.limit;
          if (!isPublishedFillsLimit(limit)) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: userCopy(INDEXER_FILLS_LIMIT_UNSET) });
          }
          const rows = await withReadSpan('indexer.accountFills', null, () => store.fillsForAccount(input.account, limit));
          return rows.map(toWireFill);
        } catch (err) {
          throw toTrpcError(err);
        }
      }),

    position: publicJurisdictionProcedure('indexer', 'protocol')
      .input(z.object({ market: marketSchema, account: addressSchema }))
      .output(positionSchema.nullable())
      .query(async ({ input }) => {
        try {
          assertServing(indexer, deps.chainSource, deps.venue, deps.claimLiveClob);
          const row = await withReadSpan('indexer.position', input.market, () => store.position(input.market, input.account));
          return row ? toWirePosition(row) : null;
        } catch (err) {
          throw toTrpcError(err);
        }
      }),

    /**
     * An address's positions across markets. `limit` is a published 1..200
     * window. Omit / 0 / over-cap refuses `indexer.positions_list_limit_unset`
     * — never invent 50.
     */
    positions: publicJurisdictionProcedure('indexer', 'protocol')
      .input(z.object({ account: addressSchema, limit: z.number().optional() }))
      .output(z.array(positionSchema))
      .query(async ({ input }) => {
        try {
          assertServing(indexer, deps.chainSource, deps.venue, deps.claimLiveClob);
          const limit = input.limit;
          if (!isPublishedBookDepth(limit)) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: userCopy(INDEXER_POSITIONS_LIST_LIMIT_UNSET) });
          }
          const rows = await withReadSpan('indexer.positions', null, () => store.positionsOf(input.account, limit));
          return rows.map(toWirePosition);
        } catch (err) {
          throw toTrpcError(err);
        }
      }),

    /**
     * Projection stream as market-data absolute deltas.
     *
     * Unwired venue/RPC → `indexer.stream_unwired` (do not invent ABI).
     * Empty projection → empty deltas, never a live $0 book.
     * `depth` is a published window. Omit refuses `indexer.stream_depth_unset`
     * — never invent 50. Owner may pass 50.
     * Omit `market` does not invent all-markets: pass a published `marketsLimit`
     * (1..200) or refuse `indexer.stream_markets_limit_unset`.
     */
    stream: publicJurisdictionProcedure('indexer', 'protocol')
      .input(
        z
          .object({
            market: marketSchema.optional(),
            depth: z.number().optional(),
            marketsLimit: z.number().optional(),
          })
          .optional(),
      )
      .output(
        z.object({
          status: z.enum(['ok', 'unwired']),
          code: z.string().nullable(),
          deltas: z.array(
            z.object({
              type: z.literal('delta'),
              marketId: z.string(),
              fromSequence: z.number().int(),
              sequence: z.number().int(),
              bids: z.array(wireLevelSchema),
              asks: z.array(wireLevelSchema),
            }),
          ),
          clob: clobHonestySchema,
        }),
      )
      .query(async ({ input }) => {
        try {
          assertServing(indexer, deps.chainSource, deps.venue, deps.claimLiveClob);
          const depth = input?.depth;
          if (!isPublishedBookDepth(depth)) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: userCopy(INDEXER_STREAM_DEPTH_UNSET) });
          }
          const namedMarket = input?.market;
          const marketsLimit = input?.marketsLimit;
          if (!namedMarket && !isPublishedBookDepth(marketsLimit)) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: userCopy(INDEXER_STREAM_MARKETS_LIMIT_UNSET),
            });
          }
          const assessed = assessProjectionStream({ venue: deps.venue, rpcUrl: deps.rpcUrl });
          if (assessed.status === 'unwired') {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: userCopy(INDEXER_STREAM_UNWIRED),
              cause: new Error(INDEXER_STREAM_UNWIRED),
            });
          }
          const markets = namedMarket ? [namedMarket] : [...(await store.markets(marketsLimit as number))];
          const books: StreamBook[] = [];
          for (const market of markets) {
            const view = await store.book(market, depth);
            // Unknown as-of is not sequence 0. A projection with no head is
            // empty, not a successful genesis book.
            if (view.asOfHeight === null) continue;
            books.push({
              market: view.market,
              sequence: view.asOfHeight,
              bids: view.bids.map((l) => [formatAmount(l.price), formatAmount(l.quantity)] as StreamLevel),
              asks: view.asks.map((l) => [formatAmount(l.price), formatAmount(l.quantity)] as StreamLevel),
            });
          }
          return {
            ...assessProjectionStream({ venue: deps.venue, rpcUrl: deps.rpcUrl, books }),
            clob: clobHonesty(deps.venue),
          };
        } catch (err) {
          throw toTrpcError(err);
        }
      }),
  });
}

export type IndexerRouter = ReturnType<typeof createIndexerRouter>;
