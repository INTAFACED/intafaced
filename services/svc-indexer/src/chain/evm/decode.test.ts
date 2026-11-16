import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, pad, stringToHex, type Hex } from 'viem';
import { formatAmount, parseAmount } from '@intafaced/ledger-client/money';
import { bookLevelEvent, fillEvent, positionEvent, venueAbi, VENUE_TOPICS } from './abi.js';
import { decodeVenueLog, decodeVenueLogs, marketFromBytes32, MAX_STORABLE_SCALED, P0_TEST_USDC_MARKET_ID, type RawLog } from './decode.js';
import { ChainDataError } from '../source.js';

/**
 * The decoder, with no chain in the room.
 *
 * These run on every `pnpm test` — no docker, no anvil, no skip. That matters
 * because the live suites can legitimately skip on a laptop, and the arithmetic
 * below is the part that must never be unproven: an 18-decimal price that loses
 * its last place is money, and it is invisible in an order book until somebody
 * reconciles.
 *
 * The logs are built with viem's own encoders rather than pasted hex, so a test
 * that passes proves the decoder agrees with an ABI encoder — not that it agrees
 * with a string somebody typed while writing the decoder.
 */

const MARKET = pad(stringToHex('ETH-USD'), { dir: 'right', size: 32 });
const MAKER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const TAKER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const BLOCK_HASH = `0x${'ab'.repeat(32)}` as Hex;

function log(topics: readonly Hex[], data: Hex, logIndex = 0): RawLog {
  return {
    address: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    topics: topics as [Hex, ...Hex[]],
    data,
    blockHash: BLOCK_HASH,
    blockNumber: 42n,
    logIndex,
    transactionHash: `0x${'cd'.repeat(32)}` as Hex,
    transactionIndex: 0,
    removed: false,
  } as RawLog;
}

function bookLevelLog(side: number, price: bigint, quantity: bigint, logIndex = 0, market: Hex = MARKET): RawLog {
  return log(
    encodeEventTopics({ abi: venueAbi, eventName: 'BookLevel', args: { market } }) as Hex[],
    encodeAbiParameters(
      bookLevelEvent.inputs.filter((i) => !i.indexed),
      [side, price, quantity],
    ),
    logIndex,
  );
}

function fillLog(price: bigint, quantity: bigint, takerSide: number, logIndex = 0): RawLog {
  return log(
    encodeEventTopics({ abi: venueAbi, eventName: 'Fill', args: { market: MARKET, maker: MAKER, taker: TAKER } }) as Hex[],
    encodeAbiParameters(
      fillEvent.inputs.filter((i) => !i.indexed),
      [price, quantity, takerSide],
    ),
    logIndex,
  );
}

function positionLog(size: bigint, entryPrice: bigint, logIndex = 0): RawLog {
  return log(
    encodeEventTopics({ abi: venueAbi, eventName: 'Position', args: { market: MARKET, account: MAKER } }) as Hex[],
    encodeAbiParameters(
      positionEvent.inputs.filter((i) => !i.indexed),
      [size, entryPrice],
    ),
    logIndex,
  );
}

describe('svc-indexer · EVM decode — money', () => {
  /**
   * The claim `abi.ts` makes: a uint256 with eighteen implied decimals and an
   * `Amount` are the same number in the same representation. If that is true
   * there is no conversion to get wrong; if it is false, every price in the read
   * model is off by a power of ten and nothing anywhere would say so.
   */
  it('treats a uint256 with 18 implied decimals AS the scaled bigint', () => {
    const raw = 3_000_500_000_000_000_000_000n; // 3000.5 × 10^18
    const [event] = decodeVenueLogs([bookLevelLog(0, raw, 1n)]);
    expect(event).toMatchObject({ kind: 'book_level', price: '3000.5' });
    expect(parseAmount((event as { price: string }).price)).toBe(raw);
  });

  it('round-trips all eighteen decimal places without losing the last one', () => {
    // Eighteen nines: the value that a float, or a scale off by one, cannot carry.
    const raw = 10n ** 18n - 1n;
    const [event] = decodeVenueLogs([bookLevelLog(1, raw, raw)]);
    expect(event).toMatchObject({ price: '0.999999999999999999', quantity: '0.999999999999999999' });
    expect(parseAmount((event as { price: string }).price)).toBe(raw);
  });

  it('carries a uint256 far above Number.MAX_SAFE_INTEGER intact', () => {
    // 10^30 scaled. As a double this is 1.0000000000000000199…e+30 — wrong in
    // the eleventh significant figure, which is a lot of money.
    const raw = 10n ** 30n;
    const [event] = decodeVenueLogs([bookLevelLog(0, raw, 1n)]);
    expect((event as { price: string }).price).toBe('1000000000000');
    expect(parseAmount((event as { price: string }).price)).toBe(raw);
    expect(raw > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it('decodes a negative position size — short is a real state, not an error', () => {
    const [event] = decodeVenueLogs([positionLog(-2_500_000_000_000_000_000n, 10n ** 18n)]);
    expect(event).toMatchObject({ kind: 'position', size: '-2.5', entryPrice: '1' });
  });

  /**
   * The bound `numeric(38,18)` imposes, refused at the boundary.
   *
   * Without this the block reaches `applyBlock`, Postgres raises a numeric
   * overflow inside the transaction, the whole block rolls back, and the ingest
   * loop retries it forever — with an error message that reads as a database
   * problem rather than "the chain published a number this read model cannot
   * hold".
   */
  it('refuses an amount larger than numeric(38,18) can hold, naming the field', () => {
    expect(() => decodeVenueLogs([bookLevelLog(0, MAX_STORABLE_SCALED, 1n)])).toThrow(ChainDataError);
    try {
      decodeVenueLogs([bookLevelLog(0, MAX_STORABLE_SCALED, 1n)]);
    } catch (err) {
      expect((err as ChainDataError).code).toBe('indexer.amount_out_of_range');
      expect((err as Error).message).toContain('book level price');
    }
    // The control: one unit below the bound is fine, so the test above is not
    // passing because everything throws.
    expect(() => decodeVenueLogs([bookLevelLog(0, MAX_STORABLE_SCALED - 1n, 1n)])).not.toThrow();
  });

  it('refuses a uint256 at its maximum rather than truncating it', () => {
    const maxUint256 = 2n ** 256n - 1n;
    expect(() => decodeVenueLogs([fillLog(maxUint256, 1n, 0)])).toThrow(/exceeds what numeric\(38,18\) can hold/);
  });

  /** A zero quantity is an EMPTY level, which is a fact. It must decode. */
  it('accepts quantity zero — an empty level is not an absent one', () => {
    const [event] = decodeVenueLogs([bookLevelLog(0, 10n ** 18n, 0n)]);
    expect(event).toMatchObject({ quantity: '0' });
    expect(formatAmount(0n)).toBe('0');
  });
});

describe('svc-indexer · EVM decode — market symbols', () => {
  it('unpacks a right-padded bytes32 back to its symbol', () => {
    expect(marketFromBytes32(MARKET)).toBe('ETH-USD');
    expect(marketFromBytes32(pad(stringToHex('A'), { dir: 'right', size: 32 }))).toBe('A');
    // A full 32 bytes, i.e. no padding to strip.
    const full = 'M'.repeat(32);
    expect(marketFromBytes32(pad(stringToHex(full), { dir: 'right', size: 32 }))).toBe(full);
  });

  /**
   * Guessing a symbol from a hash splits the book. Project the 0x word instead
   * of throwing — SovereignVenue keccak ids are a topic we claim, and a throw
   * froze the live 84532 ingest.
   */
  it('projects a keccak market id as hex rather than inventing a symbol', () => {
    const hashed = `0x${'ff'.repeat(32)}` as Hex;
    expect(marketFromBytes32(hashed)).toBe(hashed);
    const interiorNul = `0x4554002d555344${'00'.repeat(25)}` as Hex;
    expect(marketFromBytes32(interiorNul)).toBe(interiorNul);
  });

  it('aliases the published P0 keccak256(TEST/USDC) to TEST/USDC', () => {
    expect(P0_TEST_USDC_MARKET_ID.toLowerCase()).toBe('0x6060d45dadad8ddd9491c847a247ec1f9158fad901bad34bb21d4eb2c9e08336');
    expect(marketFromBytes32(P0_TEST_USDC_MARKET_ID)).toBe('TEST/USDC');
  });

  it('decodes a live 84532 Fill from SovereignVenue (tx 0x702cac65…)', () => {
    const live = log(
      [
        encodeEventTopics({ abi: venueAbi, eventName: 'Fill' })[0] as Hex,
        P0_TEST_USDC_MARKET_ID,
        `0x000000000000000000000000fb4f4d2385c3291e2601bf36d8c1dc1c930f08e0` as Hex,
        `0x000000000000000000000000edc808aacf685c713c50dfdfa0888420c59b9d2d` as Hex,
      ],
      '0x0000000000000000000000000000000000000000000000000de0b6b3a76400000000000000000000000000000000000000000000000000000de0b6b3a76400000000000000000000000000000000000000000000000000000000000000000001',
      4,
    );
    expect(decodeVenueLog(live)).toMatchObject({
      kind: 'fill',
      market: 'TEST/USDC',
      price: '1',
      quantity: '1',
      takerSide: 'sell',
      maker: '0xfb4f4d2385c3291e2601bf36d8c1dc1c930f08e0',
      taker: '0xedc808aacf685c713c50dfdfa0888420c59b9d2d',
      logIndex: 4,
    });
  });

  it('refuses an all-zero market — a fill with no market is not projectable', () => {
    expect(() => marketFromBytes32(`0x${'00'.repeat(32)}`)).toThrow(/all zero bytes/);
  });
});

describe('svc-indexer · EVM decode — what is skipped and what throws', () => {
  /**
   * A real venue address emits events this adapter has never heard of. Throwing
   * on the first one would stop the entire projection over a log that was never
   * this service's business.
   */
  it('skips a log whose topic0 this adapter does not claim', () => {
    const unrelated = log([`0x${'11'.repeat(32)}` as Hex], '0x');
    expect(decodeVenueLog(unrelated)).toBeNull();
    expect(decodeVenueLogs([unrelated, bookLevelLog(0, 10n ** 18n, 10n ** 18n, 3)])).toHaveLength(1);
  });

  /**
   * The opposite case. A topic we DO claim, with a payload that will not decode,
   * means the contract and `abi.ts` disagree — and projecting past that is
   * projecting a guess.
   */
  it('throws when a topic it claims will not decode', () => {
    const claimed = [...VENUE_TOPICS.keys()][0]!;
    expect(() => decodeVenueLog(log([claimed], '0xdeadbeef'))).toThrow(/did not decode against this service's ABI/);
  });

  it('refuses an out-of-range side rather than defaulting to bid', () => {
    expect(() => decodeVenueLogs([bookLevelLog(7, 10n ** 18n, 10n ** 18n)])).toThrow(/must be 0 \(bid\) or 1 \(ask\), got 7/);
    expect(() => decodeVenueLogs([fillLog(10n ** 18n, 10n ** 18n, 9)])).toThrow(/must be 0 \(buy\) or 1 \(sell\), got 9/);
  });

  it('refuses a log with no logIndex — it would have no stable identity', () => {
    const orphan = { ...bookLevelLog(0, 10n ** 18n, 10n ** 18n), logIndex: null } as unknown as RawLog;
    expect(() => decodeVenueLog(orphan)).toThrow(/no logIndex/);
  });
});

describe('svc-indexer · EVM decode — ordering and identity', () => {
  /**
   * A fill's primary key is (block hash, log index). Renumbering log indices
   * would change a fill's identity between one index pass and the next, which is
   * exactly the idempotency the projection depends on. Gaps are correct: they are
   * the logs other contracts in the same block emitted.
   */
  it('keeps the chain’s own log indices, gaps and all', () => {
    const events = decodeVenueLogs([fillLog(10n ** 18n, 10n ** 18n, 0, 9), bookLevelLog(0, 10n ** 18n, 10n ** 18n, 2)]);
    expect(events.map((e) => e.logIndex)).toEqual([2, 9]);
  });

  it('sorts by log index, whatever order the node returned them in', () => {
    const events = decodeVenueLogs([
      positionLog(10n ** 18n, 10n ** 18n, 5),
      bookLevelLog(0, 10n ** 18n, 10n ** 18n, 1),
      fillLog(10n ** 18n, 10n ** 18n, 0, 3),
    ]);
    expect(events.map((e) => e.kind)).toEqual(['book_level', 'fill', 'position']);
  });

  it('lowercases addresses so one account cannot appear as two', () => {
    const [event] = decodeVenueLogs([fillLog(10n ** 18n, 10n ** 18n, 1)]);
    expect(event).toMatchObject({ maker: MAKER.toLowerCase(), taker: TAKER.toLowerCase(), takerSide: 'sell' });
  });
});

describe('decodeVenueLog · fill price and quantity must be positive', () => {
  it('refuses a fill with quantity zero at decode time', () => {
    expect(() => decodeVenueLog(fillLog(10n ** 18n, 0n, 0))).toThrow(/fill quantity must be positive/);
    try {
      decodeVenueLog(fillLog(10n ** 18n, 0n, 0));
    } catch (err) {
      expect(err).toMatchObject({ code: 'indexer.bad_amount' });
    }
  });

  it('refuses a fill with price zero at decode time', () => {
    expect(() => decodeVenueLog(fillLog(0n, 10n ** 18n, 0))).toThrow(/fill price must be positive/);
    try {
      decodeVenueLog(fillLog(0n, 10n ** 18n, 0));
    } catch (err) {
      expect(err).toMatchObject({ code: 'indexer.bad_amount' });
    }
  });

  it('still accepts a book level with quantity zero', () => {
    expect(decodeVenueLog(bookLevelLog(0, 10n ** 18n, 0n))).toMatchObject({ quantity: '0' });
  });

  it('refuses a book level with price zero at decode time', () => {
    expect(() => decodeVenueLog(bookLevelLog(0, 0n, 10n ** 18n))).toThrow(/book level price must be positive/);
    try {
      decodeVenueLog(bookLevelLog(0, 0n, 10n ** 18n));
    } catch (err) {
      expect(err).toMatchObject({ code: 'indexer.bad_amount' });
    }
  });
});
