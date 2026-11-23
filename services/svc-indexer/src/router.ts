import { formatAmount } from '@intafaced/ledger-client/money';
import { TRPCError } from '@intafaced/contracts/trpc';
import { mountRecords, type RefusalOf } from '@intafaced/contracts/procedure-mount';
import {
  INDEXER_PROCEDURES,
  INDEXER_REFUSAL_CODES,
  endOfUtcDay,
  type IndexerPosition,
  type Pool,
} from '@intafaced/contracts/indexer-procedures';
import { ChainDataError } from './chain/source.js';
import { ChainUnavailableError } from './chain/evm/availability.js';
import { finalizedHeightOf, type PositionRecord, type ProjectionStore } from './projection/store.js';
import type { Indexer } from './indexer.js';
import { clobFixtureRefusesLiveClaim, clobHonesty, INDEXER_CLOB_FIXTURE_NOT_LIVE } from './clob-honesty.js';
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
  listAddressInternalPage,
  listAddressTxPage,
  type AddressPageSource,
  type ExplorerAddressSource,
} from './explorer/address.js';
import { StateUnavailableError } from './chain/evm/address-state.js';
import type { FindTx } from './explorer/search-networks.js';
import {
  CANDLE_SECONDS,
  INDEXER_NOT_A_POOL,
  INDEXER_POOL_FACTORY_UNSET,
  POOL_WINDOW_SECONDS,
  priceScale,
  swapSide,
  type ExplorerPoolReads,
  type PoolFact,
} from './explorer/pools.js';
import { INDEXER_BOOK_DEPTH_UNSET, INDEXER_POSITIONS_LIST_LIMIT_UNSET, isPublishedBookDepth } from './trpc-windows.js';

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
 * The calls themselves (path, guard, input, output, named refusals) are svc-indexer's records,
 * `@intafaced/contracts/indexer-procedures`; this file holds only their handlers.
 *
 * ── Money on the wire ──────────────────────────────────────────────────────
 *
 * Decimal strings, always. `formatAmount` is the only thing that renders a
 * price in this file; nothing here constructs a `number` from an amount. A
 * client that wants arithmetic parses the string — it does not get handed a
 * float that already lost the last decimal place.
 */

/**
 * svc-indexer's one reader of its refusals. Every handler already sends a TRPCError whose message is the refusal's copy
 * (`userCopy(code)`), so the code is read back from that copy; the error itself leaves unchanged, and the wire with it.
 */
const COPY_TO_CODE = new Map(INDEXER_REFUSAL_CODES.map((code) => [userCopy(code), code] as const));
const indexerRefusal: RefusalOf = (err) => {
  if (!(err instanceof TRPCError)) return undefined;
  const code = COPY_TO_CODE.get(err.message);
  return code === undefined ? undefined : { code, error: err };
};

function toWirePosition(position: PositionRecord): IndexerPosition {
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
  /**
   * D-explorer-05 pools: the stored reads, and the owner's factory whose pools are listed. Absent => `indexer.explorer_unwired`;
   * a null factory (blank `INDEXER_POOL_FACTORY_ADDRESS`) => `indexer.pool_factory_unset`.
   */
  readonly pools?: { readonly reads: ExplorerPoolReads; readonly factory: string | null };
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

function poolRow(chainId: number, pool: PoolFact): Pool {
  return {
    chainId,
    address: pool.pool,
    factory: pool.factory,
    token0: pool.token0,
    token1: pool.token1,
    feeBps: pool.feeBps,
    createdHeight: pool.createdHeight,
    createdTx: pool.createdTx,
    reserves: pool.reserves
      ? { reserve0: pool.reserves.reserve0.toString(), reserve1: pool.reserves.reserve1.toString(), height: pool.reserves.height }
      : null,
  };
}

/** The pool reads and the owner's factory, or the refusal that names what is missing. */
function poolsOrRefuse(deps: IndexerRouterDeps): { explorer: ExplorerBlocksSource; reads: ExplorerPoolReads; factory: string } {
  const explorer = explorerOrRefuse(deps);
  if (!deps.pools) {
    throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: userCopy(INDEXER_EXPLORER_UNWIRED) });
  }
  if (deps.pools.factory === null) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: userCopy(INDEXER_POOL_FACTORY_UNSET) });
  }
  return { explorer, reads: deps.pools.reads, factory: deps.pools.factory };
}

function explorerOrRefuse(deps: IndexerRouterDeps): ExplorerBlocksSource {
  assertServing(deps.indexer, deps.chainSource, deps.venue, deps.claimLiveClob);
  if (!deps.explorer) {
    throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: userCopy(INDEXER_EXPLORER_UNWIRED) });
  }
  return deps.explorer;
}

export function createIndexerRouter(deps: IndexerRouterDeps) {
  const { store, indexer } = deps;

  return mountRecords(
    INDEXER_PROCEDURES,
    {
      'indexer.explorer.blocks.list': async ({ input }) => {
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
      },
      'indexer.explorer.blocks.get': async ({ input }) => {
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
      },
      'indexer.explorer.txs.list': async ({ input }) => {
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
      },
      'indexer.explorer.address.txs': async ({ input }) => {
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
      },
      'indexer.explorer.address.summary': async ({ input }) => {
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
      },
      'indexer.explorer.address.holdings': async ({ input }) => {
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
      },
      'indexer.explorer.address.internal': async ({ input }) => {
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
      },
      'indexer.explorer.address.balanceAt': async ({ input }) => {
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
      },
      'indexer.explorer.tokens.bySymbol': async ({ input }) => {
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
      },
      'indexer.explorer.pools.list': async ({ input }) => {
        try {
          const { explorer, reads, factory } = poolsOrRefuse(deps);
          const limit = ownerLimit(explorer);
          const fetched =
            input.chainId === deps.chainId ? await reads.list({ factory, limit, ...(input.cursor ? { cursor: input.cursor } : {}) }) : [];
          const rows = fetched.slice(0, limit);
          const last = rows[rows.length - 1];
          // Each row's last day of swaps (J-dex-protocol-12 #1: the list shows volume), the window `get` uses.
          const now = new Date();
          const since = new Date(now.getTime() - POOL_WINDOW_SECONDS * 1000);
          const volumes = await Promise.all(rows.map((pool) => reads.volume({ pool: pool.pool, since })));
          return {
            rows: rows.map((pool, i) => ({
              ...poolRow(deps.chainId, pool),
              volume1: volumes[i]!.volume1.toString(),
              swaps: volumes[i]!.swaps,
            })),
            window: { since: since.toISOString(), seconds: POOL_WINDOW_SECONDS },
            nextCursor: fetched.length > limit && last ? last.cursor : null,
            asOf: now.toISOString(),
          };
        } catch (err) {
          throw toTrpcError(err);
        }
      },
      'indexer.explorer.pools.get': async ({ input }) => {
        try {
          const { reads, factory } = poolsOrRefuse(deps);
          const pool = input.chainId === deps.chainId ? await reads.get({ factory, pool: input.address.toLowerCase() }) : null;
          if (!pool) throw new TRPCError({ code: 'NOT_FOUND', message: userCopy(INDEXER_NOT_A_POOL) });
          const now = new Date();
          const since = new Date(now.getTime() - POOL_WINDOW_SECONDS * 1000);
          const scale = priceScale(pool.token0.decimals, pool.token1.decimals);
          const [volume, candles] = await Promise.all([
            reads.volume({ pool: pool.pool, since }),
            scale === null
              ? Promise.resolve(null)
              : reads.candles({ pool: pool.pool, since, seconds: CANDLE_SECONDS[input.interval], scale }),
          ]);
          return {
            pool: poolRow(deps.chainId, pool),
            window: { since: since.toISOString(), seconds: POOL_WINDOW_SECONDS },
            volume1: volume.volume1.toString(),
            swaps: volume.swaps,
            candles: candles?.map((c) => ({ ...c, volume1: c.volume1.toString() })) ?? null,
            asOf: now.toISOString(),
          };
        } catch (err) {
          throw toTrpcError(err);
        }
      },
      'indexer.explorer.pools.swaps': async ({ input }) => {
        try {
          const { explorer, reads, factory } = poolsOrRefuse(deps);
          const limit = ownerLimit(explorer);
          const pool = input.chainId === deps.chainId ? await reads.get({ factory, pool: input.address.toLowerCase() }) : null;
          if (!pool) throw new TRPCError({ code: 'NOT_FOUND', message: userCopy(INDEXER_NOT_A_POOL) });
          const fetched = await reads.swaps({ pool: pool.pool, limit, ...(input.cursor ? { cursor: input.cursor } : {}) });
          const rows = fetched.slice(0, limit);
          const last = rows[rows.length - 1];
          return {
            rows: rows.map((swap) => ({
              hash: swap.hash,
              blockHeight: swap.blockHeight,
              index: swap.index,
              logIndex: swap.logIndex,
              timestamp: swap.timestamp,
              side: swapSide(swap),
              sender: swap.sender,
              recipient: swap.recipient,
              amount0In: swap.amount0In.toString(),
              amount1In: swap.amount1In.toString(),
              amount0Out: swap.amount0Out.toString(),
              amount1Out: swap.amount1Out.toString(),
            })),
            nextCursor: fetched.length > limit && last ? { height: last.blockHeight, index: last.index, logIndex: last.logIndex } : null,
            asOf: new Date().toISOString(),
          };
        } catch (err) {
          throw toTrpcError(err);
        }
      },
      'indexer.explorer.tx.get': async ({ input }) => {
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
      },
      'indexer.explorer.tx.networks': async ({ input }) => {
        const finders = deps.searchNetworks ?? [];
        return { networks: await Promise.all(finders.map(({ find }) => find(input.hash))) };
      },
      'indexer.status': async () => {
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
      },
      'indexer.book': async ({ input }) => {
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
      },
      'indexer.positions': async ({ input }) => {
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
      },
    },
    indexerRefusal,
  );
}

export type IndexerRouter = ReturnType<typeof createIndexerRouter>;
