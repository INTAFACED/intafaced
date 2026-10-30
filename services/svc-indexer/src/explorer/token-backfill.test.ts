import { describe, expect, it, vi } from 'vitest';
import type { ChainToken } from '../chain/source.js';
import { backfillTokenMeta, startTokenBackfill, TOKEN_BACKFILL_BATCH, type TokenBackfillDeps } from './token-backfill.js';

const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const meta = (a: string): ChainToken => ({ address: a, symbol: 'TEST', name: null, decimals: 18 });

/** A store holding `count` unread tokens; writing one marks it read. */
function fakes(count: number, failReads = 0) {
  const unread = new Set(Array.from({ length: count }, (_, i) => address(i + 1)));
  const written: Array<{ tokens: ChainToken[]; height: number }> = [];
  let failures = failReads;
  const deps: TokenBackfillDeps = {
    unread: async (limit) => [...unread].slice(0, limit),
    read: async (addresses) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error('chain unreachable');
      }
      return { height: 9, tokens: addresses.map(meta) };
    },
    write: async (tokens, height) => {
      written.push({ tokens, height });
      for (const token of tokens) unread.delete(token.address);
    },
  };
  return { deps, unread, written };
}

describe('backfillTokenMeta', () => {
  it('reads every unread token in batches at one head height, then stops', async () => {
    const { deps, unread, written } = fakes(TOKEN_BACKFILL_BATCH + 3);
    expect(await backfillTokenMeta(deps)).toBe(TOKEN_BACKFILL_BATCH + 3);
    expect(unread.size).toBe(0);
    expect(written.map((w) => w.tokens.length)).toEqual([TOKEN_BACKFILL_BATCH, 3]);
    expect(written.every((w) => w.height === 9)).toBe(true);
  });

  it('does nothing when every token was read', async () => {
    const { deps, written } = fakes(0);
    expect(await backfillTokenMeta(deps)).toBe(0);
    expect(written).toEqual([]);
  });
});

describe('startTokenBackfill', () => {
  it('tries again after a failed pass, and sweeps again for tokens left unread later', async () => {
    vi.useFakeTimers();
    try {
      const { deps, unread } = fakes(2, 1);
      const log = { info: vi.fn(), warn: vi.fn() };
      startTokenBackfill(deps, log, 1_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(unread.size).toBe(2);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(unread.size).toBe(0);
      expect(log.info).toHaveBeenCalledWith({ read: 2 }, 'token metadata backfill finished');
      unread.add(address(99));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(unread.size).toBe(0);
      expect(log.info).toHaveBeenCalledTimes(1 + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops trying once stopped', async () => {
    vi.useFakeTimers();
    try {
      const { deps, unread } = fakes(1, 5);
      const handle = startTokenBackfill(deps, { info: vi.fn(), warn: vi.fn() }, 1_000);
      await vi.advanceTimersByTimeAsync(0);
      handle.stop();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(unread.size).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
