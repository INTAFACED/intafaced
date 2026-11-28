/**
 * What `startFuturesJobs` hands the live liquidation tick, read off the tick's own input.
 *
 * The liquidation job is run once through the host's own interval callback, with `runLiquidationTick` replaced by a
 * recorder, so each assertion is on the object the live tick receives: no ADL policy (an underfunded rung refuses
 * `trade.adl_unconfigured`), no ladder but the one passed in (no placeholder rungs, no maintenance number of its own),
 * the SQL rung store, the durable margin-call notifier, only the owner's published liquidation limits, and the
 * matched-order book's increasing-order pull.
 */
import { describe, expect, it, vi } from 'vitest';
import { partial } from '@intafaced/service-kit/testing';
import type { LiquidationTickResult } from './liquidation-tick.js';
import type { FuturesLadderPolicy } from './maintenance-ladder.js';
import type { PublishedLiquidationLimits } from './mark-policy.js';

type TickInput = Record<string, unknown> & {
  ladder: { policy?: FuturesLadderPolicy; reducer: unknown; depth: unknown };
  rungs: { findLive(positionId: string): Promise<unknown> };
  notifyMarginCall: { notifyMarginCall(input: Record<string, unknown>): Promise<{ delivered: boolean }> };
};

const ticks = vi.hoisted(() => ({ inputs: [] as unknown[] }));

vi.mock('./liquidation-tick.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./liquidation-tick.js')>();
  return {
    ...actual,
    runLiquidationTick: async (input: unknown): Promise<LiquidationTickResult> => {
      ticks.inputs.push(input);
      return partial<LiquidationTickResult>({ items: [], liquidated: 0, marginCalls: 0 });
    },
  };
});

const { startFuturesJobs } = await import('./futures-jobs.js');

/** A tagged-template sql that records each query's text and answers no rows. */
function recordingSql() {
  const queries: string[] = [];
  const sql = Object.assign(
    (strings: TemplateStringsArray) => {
      queries.push(strings.join('?'));
      return Promise.resolve([]);
    },
    { unsafe: () => Promise.resolve([]) },
  );
  return { sql: sql as never, queries };
}

async function liveTickInput(extra: Record<string, unknown> = {}, config: Record<string, unknown> = {}) {
  ticks.inputs.length = 0;
  const callbacks: Array<() => unknown> = [];
  const { sql, queries } = recordingSql();
  const handle = startFuturesJobs({
    sql,
    ledger: { post: vi.fn(), balance: vi.fn() },
    matching: { depth: vi.fn(async () => ({ bids: [], asks: [], sequence: 0 })) } as never,
    bus: null,
    setIntervalFn: partial<typeof setInterval>((fn: () => unknown) => {
      callbacks.push(fn);
      return callbacks.length;
    }),
    clearIntervalFn: (() => undefined) as typeof clearInterval,
    onError: () => undefined,
    config: { enabled: true, liqIntervalMs: 1000, fundingIntervalMs: null, fundingMarketIds: [], fundingMaxAbsRate: null, ...config },
    ...extra,
  } as never);
  expect(handle.host.list()).toContain('futures.liquidation');
  // Each scheduled job runs once through the host's own interval callback; only the liquidation job reaches the tick.
  for (const fn of callbacks) await fn();
  await vi.waitFor(() => expect(ticks.inputs).toHaveLength(1));
  handle.stop();
  return { input: ticks.inputs[0] as TickInput, queries, handle };
}

const POLICY: FuturesLadderPolicy = {
  tiers: [{ uptoDepthBps: Number.MAX_SAFE_INTEGER, maintenanceBps: 500 }],
  marginCallBps: 12_000,
  targetBps: 15_000,
  maxTrancheBps: 10_000,
};

describe('the live liquidation tick as startFuturesJobs assembles it', () => {
  it('omits the ADL policy, so the tick refuses trade.adl_unconfigured rather than inventing a reduce size', async () => {
    const { input } = await liveTickInput();
    expect(input).not.toHaveProperty('adl');
    expect(JSON.stringify(Object.keys(input))).not.toMatch(/maxReduceBps|adl/i);
  });

  it('passes the ladder policy through with no fallback: omitted stays undefined, a published one is the same object', async () => {
    const none = await liveTickInput();
    expect(none.input.ladder.policy).toBeUndefined();
    expect(none.input.ladder).not.toHaveProperty('maintenanceBps');
    const some = await liveTickInput({ ladderPolicy: POLICY });
    expect(some.input.ladder.policy).toBe(POLICY);
  });

  it('hands the tick the SQL rung store (a rung that is not stored cannot be replayed)', async () => {
    const { input, queries } = await liveTickInput();
    expect(await input.rungs.findLive('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).toBeNull();
    expect(queries.some((q) => /FROM trade\.liquidation_rungs/.test(q))).toBe(true);
  });

  it('delivers margin calls through the durable store the REST door reads', async () => {
    const { input, queries } = await liveTickInput();
    const before = queries.length;
    await input.notifyMarginCall.notifyMarginCall({
      positionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      userId: '11111111-1111-4111-8111-111111111111',
      marketId: 'm1',
      healthBps: 11_000,
      at: new Date('2026-09-03T00:00:00.000Z'),
    });
    expect(queries.slice(before).some((q) => /INSERT INTO trade\.position_margin_calls/.test(q))).toBe(true);
  });

  it('passes null published limits until the owner publishes them, and the publication itself when set', async () => {
    expect((await liveTickInput()).input.publishedLiquidationLimits).toBeNull();
    const limits: PublishedLiquidationLimits = { maxAgeSeconds: 1, liquidationMaxAgeSeconds: 1, maxDeviationBps: 1 };
    expect((await liveTickInput({}, { liquidationLimits: limits })).input.publishedLiquidationLimits).toBe(limits);
  });

  it('pulls the trader’s growing orders from the matched-order book when one is bound, and nothing when none is', async () => {
    expect((await liveTickInput()).input).not.toHaveProperty('increasingOrders');
    const increasingOrders = vi.fn();
    const port = { increasingOrders };
    const bound = await liveTickInput({ matchedLiquidation: { current: port } });
    expect(bound.input.matched).toBe(port);
    expect(bound.input.increasingOrders).toBe(increasingOrders);
  });
});
