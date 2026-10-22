import { parseAmount, type Amount } from '@intafaced/ledger-client/money';

/**
 * THE `ChainSource` PORT — the only thing this service reads from.
 *
 * Everything downstream of here (projection, reorg repair, the read API) is
 * written against this interface and nothing else, which is what makes the
 * reorg behaviour testable at all: a real chain will not fork on demand, and a
 * design whose central property can only be observed in production is a design
 * nobody has checked.
 *
 * ── EVM adapter lives at `evm/source.ts` ────────────────────────────────────
 *
 * SOCKET §13 `socket.evm-rpc` is closed: `EvmChainSource` walks a real JSON-RPC
 * endpoint (read-only `PublicClient`, logs by block hash, typed refusals on
 * dark/dead/wrong chain). What remains open is `socket.clob-contracts` — no
 * audited production venue emits the events in `evm/abi.ts` yet; the adapter
 * still refuses a zero venue / empty RPC / unreachable endpoint rather than
 * inventing an empty book. `MemoryChainSource` stays the hermetic reference
 * implementation for reorg/projection proofs that must not need a node.
 *
 * ── The one demand this port makes of any implementation ────────────────────
 *
 * **Events carry absolute state, never a delta.** A `book_level` event says
 * "the total resting at this price is now X", not "add X". A `position` event
 * says "this account's size is now X". Two properties fall out of that and
 * nothing else buys both:
 *
 *   · re-applying a block is a no-op, so idempotency is structural rather than
 *     a dedupe table someone can forget to consult
 *   · unwinding a reorg is a delete of the newer version, with no compensating
 *     arithmetic to get wrong
 *
 * A chain that only emits deltas is not excluded — it means its adapter must
 * reduce them to absolute state before yielding a block. That reduction is the
 * adapter's problem precisely because it is the part that needs the chain's own
 * state reads to be correct.
 */

export type BookSide = 'bid' | 'ask';
export type TakerSide = 'buy' | 'sell';

/** 0x + 64 lowercase hex. Normalised, because a hash compared two ways is a bug. */
export type BlockHash = string;

export interface ChainHead {
  readonly height: number;
  readonly hash: BlockHash;
}

interface EventBase {
  /**
   * Position within the block. The chain's own ordering, kept because it is
   * half of a fill's natural primary key and the only stable tiebreak for
   * events that touch the same key twice in one block.
   */
  readonly logIndex: number;
}

/**
 * A price level's new ABSOLUTE total. `quantity: '0'` means the level is empty.
 *
 * Absent from a block means UNCHANGED, never removed — conflating those two is
 * how a book grows phantom liquidity (the same rule
 * `packages/market-data/src/depth.ts` states for the fiat-plane book, for the
 * same reason).
 */
export interface BookLevelEvent extends EventBase {
  readonly kind: 'book_level';
  readonly market: string;
  readonly side: BookSide;
  /** Decimal string on the wire. Parsed to scaled bigint before use. */
  readonly price: string;
  readonly quantity: string;
}

/** A trade that happened. Immutable, and identified by (block hash, log index). */
export interface FillEvent extends EventBase {
  readonly kind: 'fill';
  readonly market: string;
  readonly price: string;
  readonly quantity: string;
  readonly takerSide: TakerSide;
  readonly maker: string;
  readonly taker: string;
}

/**
 * An account's ABSOLUTE position in a market, as the contract holds it.
 *
 * `size` is signed — negative is short. It is a mirror of a number in a
 * contract at an address derived from the user's own key; it is not a balance
 * this service holds, and there is no code path here that can change it.
 */
export interface PositionEvent extends EventBase {
  readonly kind: 'position';
  readonly market: string;
  readonly account: string;
  readonly size: string;
  readonly entryPrice: string;
}

export type ChainEvent = BookLevelEvent | FillEvent | PositionEvent;

export interface ChainBlock {
  readonly chainId: number;
  readonly height: number;
  readonly hash: BlockHash;
  readonly parentHash: BlockHash;
  /** Unix seconds, from the block itself. Not when we observed it. */
  readonly timestamp: number;
  readonly events: readonly ChainEvent[];
  /**
   * D-explorer-01 header facts. Absent when the source does not read them
   * (memory/null sources); never a partially filled object.
   */
  readonly header?: ChainBlockHeader;
}

export interface ChainBlockHeader {
  readonly gasUsed: bigint;
  readonly gasLimit: bigint;
  /** null when the network does not report it (pre-EIP-1559) — never zero. */
  readonly baseFeePerGas: bigint | null;
  readonly miner: string;
  readonly txCount: number;
  readonly size: number;
}

export interface ChainSource {
  readonly chainId: number;

  /**
   * The canonical tip. `null` when the source has no chain to report.
   *
   * ── `null` IS NOT WHERE A FAILURE GOES ────────────────────────────────────
   *
   * The ingest loop reads `null` as *nothing to do*: no error, no halt, no
   * alert. That is exactly right for `NullChainSource`, which genuinely has no
   * chain to report.
   *
   * An adapter that swallowed a connection refusal into `null` would therefore
   * be indistinguishable from one that was never given a chain — the cursor
   * would stop moving without saying why and every read would keep serving the
   * last projection as though it were current. Any implementation backed by a
   * real endpoint MUST THROW instead. See `evm/availability.ts` for the codes
   * and `evm/source.ts` for the argument at length.
   */
  head(): Promise<ChainHead | null>;

  /**
   * The CANONICAL block at a height, as the source believes it right now.
   *
   * This is the method fork detection turns on: asking the same height twice
   * across a reorg must return two different hashes. An implementation that
   * memoises by height is not an implementation of this interface.
   *
   * `null` means the chain has no block at that height — which is how the loop
   * discovers it has caught up. It does not mean "we could not ask".
   */
  blockAt(height: number): Promise<ChainBlock | null>;
}

// ── Validation ──────────────────────────────────────────────────────────────
//
// Parsed at the port boundary rather than deeper in, so an adapter that yields
// a malformed price fails where the adapter can be blamed. Every amount becomes
// a scaled bigint here and stays one until it is formatted for the wire — a
// `number` never touches a price in this service.

export class ChainDataError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ChainDataError';
  }
}

const HASH_RE = /^0x[0-9a-f]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function assertBlockHash(value: string, what: string): BlockHash {
  if (!HASH_RE.test(value)) {
    throw new ChainDataError(`${what} must be 0x + 64 lowercase hex, got "${value}"`, 'indexer.bad_hash');
  }
  return value;
}

export function assertAddress(value: string, what: string): string {
  if (!ADDRESS_RE.test(value)) {
    throw new ChainDataError(`${what} must be a 20-byte hex address, got "${value}"`, 'indexer.bad_address');
  }
  return value;
}

/** Decimal string → scaled bigint, with the field name in the failure. */
export function amountOf(value: string, what: string): Amount {
  try {
    return parseAmount(value);
  } catch (err) {
    throw new ChainDataError(`${what}: ${(err as Error).message}`, 'indexer.bad_amount');
  }
}

export function positiveAmountOf(value: string, what: string): Amount {
  const parsed = amountOf(value, what);
  if (parsed <= 0n) throw new ChainDataError(`${what} must be positive, got "${value}"`, 'indexer.bad_amount');
  return parsed;
}

export function nonNegativeAmountOf(value: string, what: string): Amount {
  const parsed = amountOf(value, what);
  if (parsed < 0n) throw new ChainDataError(`${what} must not be negative, got "${value}"`, 'indexer.bad_amount');
  return parsed;
}

/**
 * Structural checks a block must pass before any of it is projected.
 *
 * All-or-nothing on purpose: a block is applied in one transaction, so a block
 * with one bad event must be rejected whole rather than half-projected. Half a
 * block is the state no amount of later reorg handling can reason about,
 * because nothing records that it was ever half-applied.
 */
export function assertValidBlock(block: ChainBlock): void {
  assertBlockHash(block.hash, 'block hash');
  assertBlockHash(block.parentHash, 'parent hash');

  if (!Number.isSafeInteger(block.height) || block.height < 0) {
    throw new ChainDataError(`block height must be a non-negative integer, got ${block.height}`, 'indexer.bad_height');
  }
  if (block.hash === block.parentHash) {
    throw new ChainDataError(`block ${block.height} is its own parent`, 'indexer.bad_parent');
  }

  const seen = new Set<number>();
  for (const event of block.events) {
    if (!Number.isSafeInteger(event.logIndex) || event.logIndex < 0) {
      throw new ChainDataError(`log index must be a non-negative integer, got ${event.logIndex}`, 'indexer.bad_log_index');
    }
    // Log index is half of a fill's primary key. Two events sharing one in the
    // same block would make an insert collide with an unrelated event and
    // silently drop it — which is exactly the double-count-adjacent bug the
    // key exists to prevent, arriving from the other direction.
    if (seen.has(event.logIndex)) {
      throw new ChainDataError(`duplicate logIndex ${event.logIndex} in block ${block.height}`, 'indexer.duplicate_log_index');
    }
    seen.add(event.logIndex);

    switch (event.kind) {
      case 'book_level':
        positiveAmountOf(event.price, 'book level price');
        nonNegativeAmountOf(event.quantity, 'book level quantity');
        break;
      case 'fill':
        positiveAmountOf(event.price, 'fill price');
        positiveAmountOf(event.quantity, 'fill quantity');
        assertAddress(event.maker, 'fill maker');
        assertAddress(event.taker, 'fill taker');
        break;
      case 'position':
        // Signed: negative is short. Only the entry price is bounded below.
        amountOf(event.size, 'position size');
        nonNegativeAmountOf(event.entryPrice, 'position entry price');
        assertAddress(event.account, 'position account');
        break;
    }
  }
}
