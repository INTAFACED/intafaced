import { describe, expect, it } from 'vitest';
import { assertValidBlock, ChainDataError, type ChainBlock, type ChainEvent } from './source.js';
import { MemoryChainSource } from './memory-source.js';

/**
 * The port boundary.
 *
 * These are the checks that stand between a wrong adapter and a wrong book. An
 * indexer that projects a malformed block does not fail — it produces a price
 * nobody can explain, which is the same failure mode as an unhandled reorg
 * arriving from a different direction.
 */

const OK = '0x'.padEnd(66, 'a');
const OK_PARENT = '0x'.padEnd(66, 'b');

function blockWith(events: ChainEvent[], overrides: Partial<ChainBlock> = {}): ChainBlock {
  return { chainId: 1, height: 5, hash: OK, parentHash: OK_PARENT, timestamp: 1_700_000_000, events, ...overrides };
}

describe('chain/source · internal calls (D-explorer-03)', () => {
  const TX = '0x'.padEnd(66, '1');
  const tx = {
    hash: TX,
    index: 0,
    from: '0x'.padEnd(42, 'a'),
    to: '0x'.padEnd(42, 'b'),
    valueWei: 1n,
    nonce: 0,
    gasLimit: 21000n,
    gasPriceWei: 1n,
    gasConsumed: 21000n,
    status: 'success' as const,
    revertReason: null,
    input: '0x',
    createdContract: null,
    logs: [],
  };
  const call = { txHash: TX, path: '0.1', kind: 'call' as const, from: '0x'.padEnd(42, 'b'), to: '0x'.padEnd(42, 'c'), valueWei: 5n };
  const withInternal = (internal: ChainBlock['internal']) => blockWith([], { transactions: [tx], internal });

  it('accepts read calls and a coded refusal', () => {
    expect(() => assertValidBlock(withInternal({ read: true, calls: [call] }))).not.toThrow();
    expect(() => assertValidBlock(withInternal({ read: false, reason: 'indexer.trace_unavailable' }))).not.toThrow();
  });

  it('refuses a refusal with no code, a call outside the block, a bad path, a duplicate, a bad kind or a negative value', () => {
    const bad = (internal: ChainBlock['internal']) => expect(() => assertValidBlock(withInternal(internal))).toThrow(ChainDataError);
    bad({ read: false, reason: 'no trace' });
    bad({ read: true, calls: [{ ...call, txHash: '0x'.padEnd(66, '2') }] });
    bad({ read: true, calls: [{ ...call, path: '' }] });
    bad({ read: true, calls: [{ ...call, path: '01' }] });
    bad({ read: true, calls: [call, call] });
    bad({ read: true, calls: [{ ...call, kind: 'delegatecall' as never }] });
    bad({ read: true, calls: [{ ...call, to: '0x1' }] });
    bad({ read: true, calls: [{ ...call, valueWei: -1n }] });
  });

  it('takes a path as deep as the EVM allows', () => {
    const deep = Array.from({ length: 1024 }, () => '0').join('.');
    expect(() => assertValidBlock(withInternal({ read: true, calls: [{ ...call, path: deep }] }))).not.toThrow();
  });
});

describe('chain/source · block validation', () => {
  it('accepts a well-formed block', () => {
    expect(() =>
      assertValidBlock(
        blockWith([
          { kind: 'book_level', logIndex: 0, market: 'M', side: 'bid', price: '100', quantity: '0' },
          { kind: 'position', logIndex: 1, market: 'M', account: '0x'.padEnd(42, 'c'), size: '-3', entryPrice: '0' },
        ]),
      ),
    ).not.toThrow();
  });

  it('refuses a hash that is not 0x + 64 lowercase hex', () => {
    expect(() => assertValidBlock(blockWith([], { hash: '0xABC' }))).toThrow(ChainDataError);
    // Uppercase too: a hash compared two ways is a fork that is not there.
    expect(() => assertValidBlock(blockWith([], { hash: '0x'.padEnd(66, 'A') }))).toThrow(ChainDataError);
  });

  it('refuses a block that is its own parent', () => {
    expect(() => assertValidBlock(blockWith([], { parentHash: OK }))).toThrow(/its own parent/);
  });

  /**
   * Log index is half of a fill's primary key. Two events sharing one would let
   * an insert collide with an unrelated event and silently drop it — the
   * double-count guarantee failing open.
   */
  it('refuses two events sharing a log index', () => {
    expect(() =>
      assertValidBlock(
        blockWith([
          {
            kind: 'fill',
            logIndex: 3,
            market: 'M',
            price: '1',
            quantity: '1',
            takerSide: 'buy',
            maker: '0x'.padEnd(42, 'c'),
            taker: '0x'.padEnd(42, 'd'),
          },
          {
            kind: 'fill',
            logIndex: 3,
            market: 'M',
            price: '2',
            quantity: '1',
            takerSide: 'sell',
            maker: '0x'.padEnd(42, 'c'),
            taker: '0x'.padEnd(42, 'd'),
          },
        ]),
      ),
    ).toThrow(/duplicate logIndex/);
  });

  it('refuses a price that is not a decimal string, or that is zero', () => {
    const level = (price: string, quantity = '1'): ChainEvent => ({
      kind: 'book_level',
      logIndex: 0,
      market: 'M',
      side: 'bid',
      price,
      quantity,
    });
    expect(() => assertValidBlock(blockWith([level('1e5')]))).toThrow(ChainDataError);
    expect(() => assertValidBlock(blockWith([level('0')]))).toThrow(/must be positive/);
    expect(() => assertValidBlock(blockWith([level('100', '-1')]))).toThrow(/must not be negative/);
    // 19 decimal places is lossy at numeric(38,18) and is refused rather than
    // silently rounded — a rounded price is a price nobody sent.
    expect(() => assertValidBlock(blockWith([level('1.0000000000000000001')]))).toThrow(ChainDataError);
  });

  it('allows a negative position size and refuses a negative entry price', () => {
    const position = (size: string, entryPrice: string): ChainEvent => ({
      kind: 'position',
      logIndex: 0,
      market: 'M',
      account: '0x'.padEnd(42, 'c'),
      size,
      entryPrice,
    });
    expect(() => assertValidBlock(blockWith([position('-7.5', '100')]))).not.toThrow();
    expect(() => assertValidBlock(blockWith([position('1', '-1')]))).toThrow(/must not be negative/);
  });

  it('refuses an address that is not 20 bytes of hex', () => {
    expect(() =>
      assertValidBlock(
        blockWith([
          {
            kind: 'fill',
            logIndex: 0,
            market: 'M',
            price: '1',
            quantity: '1',
            takerSide: 'buy',
            maker: '0xdead',
            taker: '0x'.padEnd(42, 'd'),
          },
        ]),
      ),
    ).toThrow(/hex address/);
  });
});

describe('chain/memory-source', () => {
  /**
   * Deterministic hashes are not a convenience. A failing reorg test has to
   * name the same block on every run and in every process, or it is a flake
   * somebody retries rather than a bug somebody fixes.
   */
  it('derives the same hashes from the same script, in any process', async () => {
    const script = () => {
      const chain = new MemoryChainSource(1);
      chain.append([{ kind: 'book_level', logIndex: 0, market: 'M', side: 'bid', price: '100', quantity: '5' }]);
      chain.append([]);
      return chain;
    };
    expect((await script().head())!.hash).toBe((await script().head())!.hash);
  });

  it('links every block to its parent', async () => {
    const chain = new MemoryChainSource(1);
    chain.appendEmpty(4);
    for (let h = 1; h <= 3; h++) {
      expect((await chain.blockAt(h))!.parentHash).toBe((await chain.blockAt(h - 1))!.hash);
    }
  });

  /**
   * A replacement branch that produced byte-identical blocks would BE the
   * original branch, and a reorg test built on one would assert nothing.
   */
  it('produces different hashes on a competing branch with identical contents', async () => {
    const chain = new MemoryChainSource(1);
    chain.appendEmpty(3);
    const before = (await chain.blockAt(2))!.hash;

    chain.reorg(1, [[]]);
    expect((await chain.blockAt(2))!.hash).not.toBe(before);
  });

  it('reorg keeps the fork block and drops everything above it', async () => {
    const chain = new MemoryChainSource(1);
    chain.appendEmpty(5);
    const survivor = (await chain.blockAt(2))!.hash;

    chain.reorg(2, [[], []]);

    expect((await chain.blockAt(2))!.hash).toBe(survivor);
    expect((await chain.head())!.height).toBe(4);
    expect(await chain.blockAt(5)).toBeNull();
  });

  it('honours a non-zero start height', async () => {
    const chain = new MemoryChainSource(1, 1000);
    chain.appendEmpty(2);
    expect((await chain.blockAt(1000))!.height).toBe(1000);
    expect(await chain.blockAt(0)).toBeNull();
  });
});
