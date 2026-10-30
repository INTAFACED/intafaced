import { describe, expect, it } from 'vitest';
import { ChainUnavailableError } from './availability.js';
import { readAccount, readBalance, readTokenBalances, STATE_UNAVAILABLE, StateUnavailableError } from './address-state.js';
import { TOKEN_CALL_GAS } from './token-meta.js';

const HOLDER = `0x${'a'.repeat(40)}`;
const T1 = `0x${'1'.repeat(40)}`;
const T2 = `0x${'2'.repeat(40)}`;
const T3 = `0x${'3'.repeat(40)}`;
const word = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;
const URL = 'http://node.test';

describe('readAccount', () => {
  it('reads balance and code at the height asked', async () => {
    const asked: unknown[] = [];
    const client = {
      request: async ({ method, params }: { method: string; params: unknown[] }) => {
        asked.push([method, ...params]);
        return method === 'eth_getBalance' ? '0xde0b6b3a7640000' : '0x6000';
      },
    };
    expect(await readAccount(client as never, HOLDER, 26, URL)).toEqual({ balanceWei: 10n ** 18n, isContract: true });
    expect(asked).toEqual([
      ['eth_getBalance', HOLDER, '0x1a'],
      ['eth_getCode', HOLDER, '0x1a'],
    ]);
  });

  it('reads no code as an account, and a zero balance as zero', async () => {
    const client = { request: async ({ method }: { method: string }) => (method === 'eth_getBalance' ? '0x0' : '0x') };
    expect(await readAccount(client as never, HOLDER, 1, URL)).toEqual({ balanceWei: 0n, isContract: false });
  });

  it('refuses a balance that is not a quantity, never reading it as zero', async () => {
    const client = { request: async ({ method }: { method: string }) => (method === 'eth_getBalance' ? null : '0x') };
    await expect(readAccount(client as never, HOLDER, 1, URL)).rejects.toMatchObject({ code: 'indexer.malformed_block' });
  });

  it('says the node no longer holds that state, with its own code', async () => {
    const client = {
      request: async () => {
        throw { code: -32000, message: 'missing trie node 0xabc (path ) state 0xabc is not available' };
      },
    };
    const err = await readAccount(client as never, HOLDER, 7, URL).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StateUnavailableError);
    expect((err as StateUnavailableError).code).toBe(STATE_UNAVAILABLE);
    expect((err as StateUnavailableError).height).toBe(7);
  });

  it('reads a dead node as unavailable, not as missing state', async () => {
    const client = {
      request: async () => {
        throw new Error('fetch failed');
      },
    };
    await expect(readBalance(client as never, HOLDER, 7, URL)).rejects.toBeInstanceOf(ChainUnavailableError);
  });
});

describe('readTokenBalances', () => {
  it("reads each token's own balanceOf at the height, in order; a contract that does not answer as a token is null", async () => {
    const asked: Array<{ to: string; data: string; gas: string; tag: string }> = [];
    const client = {
      request: async ({ params }: { params: [{ to: string; data: string; gas: string }, string] }) => {
        asked.push({ ...params[0], tag: params[1] });
        if (params[0].to === T1) return word(1500000n);
        if (params[0].to === T2) throw { code: 3, message: 'execution reverted' };
        return '0x';
      },
    };
    expect(await readTokenBalances(client as never, [T1, T2, T3], HOLDER, 26, URL)).toEqual([1500000n, null, null]);
    expect(asked.map((a) => a.to)).toEqual([T1, T2, T3]);
    expect(asked.every((a) => a.data === `0x70a08231${'0'.repeat(24)}${'a'.repeat(40)}` && a.tag === '0x1a')).toBe(true);
    expect(asked.every((a) => a.gas === `0x${TOKEN_CALL_GAS.toString(16)}`)).toBe(true);
  });

  it('reads a few tokens at a time', async () => {
    let open = 0;
    let most = 0;
    const tokens = Array.from({ length: 20 }, (_, i) => `0x${i.toString(16).padStart(40, '0')}`);
    const client = {
      request: async () => {
        open += 1;
        most = Math.max(most, open);
        await new Promise((r) => setTimeout(r, 1));
        open -= 1;
        return word(1n);
      },
    };
    expect(await readTokenBalances(client as never, tokens, HOLDER, 1, URL)).toEqual(tokens.map(() => 1n));
    expect(most).toBe(8);
  });

  it('throws when the node is busy or lost the state, never a guessed zero', async () => {
    const busy = {
      request: async () => {
        throw { code: -32005, message: 'limit exceeded' };
      },
    };
    await expect(readTokenBalances(busy as never, [T1], HOLDER, 1, URL)).rejects.toBeInstanceOf(ChainUnavailableError);
    const pruned = {
      request: async () => {
        throw { code: -32000, message: 'historical state 0xabc is not available' };
      },
    };
    await expect(readTokenBalances(pruned as never, [T1], HOLDER, 1, URL)).rejects.toBeInstanceOf(StateUnavailableError);
    // A lagging node behind a load balancer has not seen the block yet: busy, not lost state.
    const lagging = {
      request: async () => {
        throw { code: -32000, message: 'header not found' };
      },
    };
    await expect(readTokenBalances(lagging as never, [T1], HOLDER, 1, URL)).rejects.not.toBeInstanceOf(StateUnavailableError);
    await expect(readTokenBalances(lagging as never, [T1], HOLDER, 1, URL)).rejects.toBeInstanceOf(ChainUnavailableError);
  });

  it('asks nothing for no tokens', async () => {
    expect(
      await readTokenBalances(
        {
          request: async () => {
            throw new Error('asked');
          },
        } as never,
        [],
        HOLDER,
        1,
        URL,
      ),
    ).toEqual([]);
  });
});
