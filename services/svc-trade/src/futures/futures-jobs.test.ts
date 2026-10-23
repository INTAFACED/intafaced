import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseFundingMarketIds, startFuturesJobs } from './futures-jobs.js';
import type { MarkSource } from './liquidation-tick.js';

describe('parseFundingMarketIds', () => {
  it('empty → no invent list', () => {
    expect(parseFundingMarketIds(undefined)).toEqual([]);
    expect(parseFundingMarketIds('')).toEqual([]);
    expect(parseFundingMarketIds('  ')).toEqual([]);
  });

  it('splits and trims', () => {
    expect(parseFundingMarketIds('m1, m2 ,m3')).toEqual(['m1', 'm2', 'm3']);
  });
});

describe('startFuturesJobs', () => {
  it('disabled → no scheduled jobs (safe default)', () => {
    const handle = startFuturesJobs({
      sql: {} as never,
      ledger: { post: vi.fn(), balance: vi.fn() },
      matching: { depth: vi.fn() } as never,
      bus: null,
      config: {
        enabled: false,
        liqIntervalMs: 1000,
        fundingIntervalMs: 1000,
        fundingMarketIds: ['m1'],
        fundingMaxAbsRate: '1', // test fixture only — not product law (D2)
      },
    });
    expect(handle.host.list()).toEqual([]);
    expect(handle.marginCalls).toBeTruthy();
    handle.stop();
  });

  it('ladderGate: no policy until the owner publishes one (production today); the published one is handed on, jobs enabled or not', () => {
    const base = {
      sql: {} as never,
      ledger: { post: vi.fn(), balance: vi.fn() },
      matching: { depth: vi.fn() } as never,
      bus: null,
      config: { enabled: false, liqIntervalMs: 1000, fundingIntervalMs: null, fundingMarketIds: [], fundingMaxAbsRate: null },
    };
    const none = startFuturesJobs(base as never);
    expect(none.ladderGate.policy).toBeUndefined();
    expect(typeof none.ladderGate.depth.depthNotional).toBe('function');
    none.stop();
    const policy = {
      tiers: [{ uptoDepthBps: Number.MAX_SAFE_INTEGER, maintenanceBps: 500 }],
      marginCallBps: 12_000,
      targetBps: 15_000,
      maxTrancheBps: 10_000,
    };
    const some = startFuturesJobs({ ...base, ladderPolicy: policy } as never);
    expect(some.ladderGate.policy).toBe(policy);
    some.stop();
  });

  it('enabled schedules liq + one funding job per market id', () => {
    const timers: string[] = [];
    // Intercept via createJobHost internals by checking list after start
    // Use real host with fake timers injected through a thin re-export path:
    // We only assert names on host.list after enable — use short intervals but
    // clear immediately so no real ticks fire against empty mocks.
    const handle = startFuturesJobs({
      sql: Object.assign((strings: TemplateStringsArray) => {
        const t = strings.join('').toLowerCase();
        if (t.includes('select')) return Promise.resolve([]);
        return Promise.resolve([]);
      }, {}) as never,
      ledger: {
        post: async () => ({ id: 'x' }) as never,
        balance: async () => ({ account: {} as never, accountId: 'x', amount: 0n }),
      },
      matching: {
        depth: async () => ({ bids: [], asks: [], sequence: 0 }),
      } as never,
      bus: null,
      config: {
        enabled: true,
        liqIntervalMs: 60_000,
        fundingIntervalMs: 60_000,
        fundingMarketIds: ['m1', 'm2'],
        fundingMaxAbsRate: '1', // test fixture only — not product law (D2)
      },
    });
    const names = handle.host.list().sort();
    expect(names).toContain('futures.liquidation');
    expect(names).toContain('futures.dated_settlement');
    expect(names).toContain('futures.funding.m1');
    expect(names).toContain('futures.funding.m2');
    handle.stop();
    expect(handle.host.list()).toEqual([]);
    void timers;
  });

  it('enabled with empty fundingMarketIds schedules liq only — never invents a funding market', () => {
    const handle = startFuturesJobs({
      sql: Object.assign((strings: TemplateStringsArray) => {
        void strings;
        return Promise.resolve([]);
      }, {}) as never,
      ledger: {
        post: async () => ({ id: 'x' }) as never,
        balance: async () => ({ account: {} as never, accountId: 'x', amount: 0n }),
      },
      matching: {
        depth: async () => ({ bids: [], asks: [], sequence: 0 }),
      } as never,
      bus: null,
      config: {
        enabled: true,
        liqIntervalMs: 60_000,
        fundingIntervalMs: 60_000,
        fundingMarketIds: [],
        fundingMaxAbsRate: null,
      },
    });
    const names = handle.host.list();
    expect(names).toContain('futures.liquidation');
    expect(names).toContain('futures.dated_settlement');
    expect(names.filter((n) => n.startsWith('futures.funding.'))).toEqual([]);
    handle.stop();
  });

  it('markPrice prefers venue fabric over matching depth', async () => {
    const venue: MarkSource = {
      markPrice: async ({ marketId }) => (marketId === 'm1' ? '50000' : null),
    };
    // Real size on both sides: this test is about SOURCE PREFERENCE, and a book
    // too thin to quote is refused by `mark-from-depth.ts` before preference
    // gets a say.
    const depth = vi.fn(async () => ({
      bids: [['99', '100']],
      asks: [['101', '100']],
      sequence: 1,
      observedAt: new Date(),
    }));
    const handle = startFuturesJobs({
      sql: {} as never,
      ledger: { post: vi.fn(), balance: vi.fn() },
      matching: { depth } as never,
      bus: null,
      venueMarkSource: venue,
      config: {
        enabled: false,
        liqIntervalMs: 1000,
        fundingIntervalMs: 1000,
        fundingMarketIds: [],
        fundingMaxAbsRate: '1', // test fixture only — not product law (D2)
      },
    });
    expect(await handle.markPrice('m1')).toBe('50000');
    expect(depth).not.toHaveBeenCalled();
    // Unmapped on venue → depth fallback mid
    expect(await handle.markPrice('m2')).toBe('100');
    expect(depth).toHaveBeenCalled();
    handle.stop();
  });

  it('markPrice null when no venue and empty depth (never invent)', async () => {
    const handle = startFuturesJobs({
      sql: {} as never,
      ledger: { post: vi.fn(), balance: vi.fn() },
      matching: {
        depth: async () => ({ bids: [], asks: [], sequence: 0 }),
      } as never,
      bus: null,
      config: {
        enabled: false,
        liqIntervalMs: 1000,
        fundingIntervalMs: 1000,
        fundingMarketIds: [],
        fundingMaxAbsRate: '1', // test fixture only — not product law (D2)
      },
    });
    expect(await handle.markPrice('m1')).toBeNull();
    handle.stop();
  });

  it('does not import DEFAULT_FUTURES_LADDER_POLICY — omitted D3 does not invent rungs', () => {
    const src = readFileSync(new URL('./futures-jobs.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/DEFAULT_FUTURES_LADDER_POLICY/);
  });

  it('does not pass a maintenanceBps number into the live tick', () => {
    const src = readFileSync(new URL('./futures-jobs.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/maintenanceBps\s*:/);
    expect(src).toMatch(/policy:\s*deps\.ladderPolicy/);
  });
});
