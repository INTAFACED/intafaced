import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { chainIdentityReader, fromAnotherChain } from './identity.js';

const A = `0x${'A'.repeat(64)}` as Hex;
const B = `0x${'b'.repeat(64)}` as Hex;

describe('chain identity', () => {
  it('a row from another genesis is from another chain; a row from before the column (null) is not', () => {
    const current = { chainId: 31337, genesisHash: B };
    expect(fromAnotherChain(A, current)).toBe(true);
    expect(fromAnotherChain(B.toUpperCase().replace('0X', '0x'), current)).toBe(false);
    expect(fromAnotherChain(null, current)).toBe(false);
    expect(fromAnotherChain(undefined, current)).toBe(false);
  });

  it('reads block 0 once per ttl, shared by concurrent callers, lower-cased; a failed read is not kept', async () => {
    let reads = 0;
    let answer: () => Promise<Hex> = async () => A;
    let now = 0;
    const read = chainIdentityReader(
      {
        config: { chainId: 31337 },
        genesisHash: () => {
          reads++;
          return answer();
        },
      },
      10_000,
      () => now,
    );
    const [one, two] = await Promise.all([read(), read()]);
    expect(one).toEqual({ chainId: 31337, genesisHash: A.toLowerCase() });
    expect(two).toBe(one);
    expect(reads).toBe(1);
    // The chain was started again: seen once the ttl has passed.
    answer = async () => B;
    now = 9_999;
    expect((await read()).genesisHash).toBe(A.toLowerCase());
    now = 10_000;
    expect((await read()).genesisHash).toBe(B);
    // An unreachable chain refuses, and the next call asks again.
    now = 20_000;
    answer = async () => {
      throw new Error('protocol.chain_unreachable');
    };
    await expect(read()).rejects.toThrow('protocol.chain_unreachable');
    answer = async () => B;
    expect((await read()).genesisHash).toBe(B);
    expect(reads).toBe(4);
  });
});
