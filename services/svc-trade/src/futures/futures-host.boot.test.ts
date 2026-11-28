/**
 * svc-trade's entry, booted: what the running service hands the futures jobs, its doors and its position book.
 *
 * `__tests__/entry.ts` boots `index.ts` over a pool that answers no rows and an in-memory bus. Two boots: one with
 * every futures setting the owner can publish set, one with none set. Each wiring below is read off the call the
 * entry made (the argument a spied export received, the value it returned) or asked of the running service over
 * HTTP, so it is seen to follow the env and not a literal.
 */
import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import { bootTrade, tradeEnvOf, type BootedTrade } from '../__tests__/entry.js';
import { presentFuturesJobsHealth } from './futures-jobs-health.js';
import { presentMarginCallWire, type MarginCallRecord } from './margin-call-transport.js';
import { formatAccountRef, recipeProfitFundingAccount } from './profit-source.js';
import type { FuturesLadderPolicy } from './maintenance-ladder.js';

const BOOT_MS = 180_000;

const FUNDING_MARKETS = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'];
const VENUE_MARKET = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
/** A TEST ladder the owner could publish: one tier, coherent. */
const LADDER: FuturesLadderPolicy = {
  tiers: [{ uptoDepthBps: Number.MAX_SAFE_INTEGER, maintenanceBps: 400 }],
  marginCallBps: 12_000,
  targetBps: 15_000,
  maxTrancheBps: 10_000,
};

const ON = {
  APP_ENV: 'test',
  LOG_LEVEL: 'info',
  TRADE_FUTURES_JOBS_ENABLED: 'true',
  TRADE_FUTURES_ENABLED: 'true',
  TRADE_FUTURES_LIQ_INTERVAL_MS: '3600000',
  TRADE_FUTURES_PROFIT_SOURCE: formatAccountRef(recipeProfitFundingAccount('USDT')),
  TRADE_FUTURES_FUNDING_MAX_ABS_RATE: '0.0075',
  TRADE_FUTURES_FUNDING_MARKET_IDS: FUNDING_MARKETS.join(','),
  TRADE_FUTURES_FUNDING_INTERVAL_MS: '28800000',
  TRADE_VENUE_MARK_VENUE: 'binance-spot',
  TRADE_VENUE_MARK_SYMBOLS: `${VENUE_MARKET}:BTCUSDT`,
  TRADE_FUTURES_LADDER_POLICY: JSON.stringify(LADDER),
  TRADE_FUTURES_SETTLEMENT_FIXING: 'owner-stamp',
  TRADE_FUTURES_MAX_LEVERAGE: '5',
  TRADE_FUTURES_CONDITIONAL_JOBS_ENABLED: 'true',
  TRADE_FUTURES_CONDITIONAL_JOBS_INTERVAL_MS: '3600000',
};
const OFF: Record<string, string | undefined> = Object.fromEntries(Object.keys(ON).map((k) => [k, undefined]));
Object.assign(OFF, { APP_ENV: 'test', LOG_LEVEL: 'info' });

/** The exports whose calls the boot records, by the module that defines them. */
const SPY = {
  './futures/futures-jobs.js': ['startFuturesJobs'],
  './futures/futures-jobs-host.js': ['futuresJobsHostDeps'],
  './futures/conditional-orders/index.js': ['startConditionalOrderJobs'],
  './futures/mark-from-venue.js': ['createConfiguredVenueMarkSource'],
  './futures/position-service.js': ['PositionService'],
  './public-rest.js': ['registerPublicRest'],
  './private-rest.js': ['registerPrivateRest'],
} as const;

/** The ladder table that exists only for tests: the entry must never load it. */
const HARNESS = './ladder-policy.test-harness.js';
const harnessLoads: string[] = [];

interface Boot {
  boot: BootedTrade;
  /** Every pino line the entry wrote while it booted, parsed. */
  logs: Record<string, unknown>[];
  env: ReturnType<typeof tradeEnvOf>;
}

let on: Boot;
let off: Boot;

async function boot(env: Record<string, string | undefined>): Promise<Boot> {
  const written: string[] = [];
  const keep = (chunk: unknown) => {
    if (typeof chunk === 'string') written.push(chunk);
    else if (chunk instanceof Uint8Array) written.push(Buffer.from(chunk).toString('utf8'));
  };
  const realWrite = fs.write.bind(fs);
  const realWriteSync = fs.writeSync.bind(fs);
  const write = vi.spyOn(fs, 'write').mockImplementation(((fd: number, chunk: unknown, ...rest: unknown[]) => {
    if (fd === 1) keep(chunk);
    return (realWrite as (...a: unknown[]) => unknown)(fd, chunk, ...rest);
  }) as never);
  const writeSync = vi.spyOn(fs, 'writeSync').mockImplementation(((fd: number, chunk: unknown, ...rest: unknown[]) => {
    if (fd === 1) keep(chunk);
    return (realWriteSync as (...a: unknown[]) => number)(fd, chunk, ...rest);
  }) as never);
  const stdout = vi.spyOn(process.stdout, 'write');
  try {
    const booted = await bootTrade(env, { spy: SPY });
    for (const call of stdout.mock.calls) keep(call[0]);
    for (const handle of [...(booted.results.startFuturesJobs ?? []), ...(booted.results.startConditionalOrderJobs ?? [])]) {
      (handle as { stop(): void }).stop();
    }
    const logs = written
      .join('')
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const set = Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined));
    return { boot: booted, logs, env: tradeEnvOf(set) };
  } finally {
    write.mockRestore();
    writeSync.mockRestore();
    stdout.mockRestore();
  }
}

beforeAll(async () => {
  vi.doMock(HARNESS, async (importOriginal) => {
    harnessLoads.push(HARNESS);
    return importOriginal();
  });
  on = await boot(ON);
  off = await boot(OFF);
}, BOOT_MS);

afterAll(async () => {
  vi.doUnmock(HARNESS);
  await on?.boot.close();
  await off?.boot.close();
});

/** The one call of `name` the boot made, as its arguments. */
function only(b: Boot, name: string): unknown[] {
  const calls = b.boot.calls[name] ?? [];
  expect(calls, name).toHaveLength(1);
  return calls[0]!;
}

function made<T>(b: Boot, name: string): T {
  only(b, name);
  return b.boot.results[name]![0] as T;
}

/** Every key at any depth of `value` (functions and class instances are not walked into). */
function deepKeys(value: unknown, seen = new Set<unknown>()): string[] {
  if (value === null || typeof value !== 'object' || seen.has(value)) return [];
  seen.add(value);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null && !Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([k, v]) => [k, ...deepKeys(v, seen)]);
}

type JobsDeps = Record<string, unknown> & { config: Record<string, unknown>; ladderPolicy?: unknown };
type JobsHandle = {
  publishFundingRate(entry: { marketId: string; rate: string; periodId: string; asOfMs: number }): void;
  markPrice: (marketId: string) => Promise<string | null>;
  marginCalls: { getOpenForPosition(positionId: string): Promise<MarginCallRecord | null> };
};

const both = () =>
  [
    ['set', on],
    ['unset', off],
  ] as const;

describe('the futures jobs get exactly what futuresJobsHostDeps makes of the env', () => {
  it('hands startFuturesJobs the host assembly’s own answer, nothing spread beside it, built from the parsed env', () => {
    for (const [label, b] of both()) {
      const [deps] = only(b, 'startFuturesJobs');
      const [envArg, parts] = only(b, 'futuresJobsHostDeps') as [Record<string, unknown>, Record<string, unknown>];
      expect(deps, label).toBe(made(b, 'futuresJobsHostDeps'));
      for (const key of [
        'TRADE_FUTURES_MATCHING_ENABLED',
        'TRADE_FUTURES_LADDER_POLICY',
        'TRADE_FUTURES_JOBS_ENABLED',
        'TRADE_FUTURES_LIQ_INTERVAL_MS',
        'TRADE_FUTURES_LIQUIDATION_LIMITS',
        'TRADE_FUTURES_FUNDING_INTERVAL_MS',
        'TRADE_FUTURES_FUNDING_COMPUTER_POLL_MS',
        'TRADE_FUTURES_SETTLEMENT_FIXING',
      ] as const) {
        expect(envArg[key], `${label} ${key}`).toEqual(b.env[key]);
      }
      expect(parts.fundingMarketIds, label).toEqual(label === 'set' ? FUNDING_MARKETS : []);
      expect(parts.fundingMaxAbsRate, label).toBe(label === 'set' ? '0.0075' : null);
      const venue = made<{ source: unknown } | null>(b, 'createConfiguredVenueMarkSource');
      expect(parts.venueMarkSource, label).toBe(label === 'set' ? venue!.source : null);
      expect(Object.keys(parts).sort(), label).toEqual(
        [
          'bus',
          'fundingMarketIds',
          'fundingMaxAbsRate',
          'ledger',
          'liquidationFeeFraction',
          'markBookFor',
          'matchedLiquidation',
          'matching',
          'onError',
          'sql',
          'venueMarkSource',
        ].sort(),
      );
    }
  });

  it('passes no owner settlement price, last trade, mark or loader override, and the env’s own fixing stamp', () => {
    for (const [label, b] of both()) {
      const [deps] = only(b, 'startFuturesJobs') as [JobsDeps];
      for (const slot of ['ownerSettlementPriceFor', 'lastTradePrice', 'markPrice', 'datedSettlement']) {
        expect(deps, `${label} ${slot}`).not.toHaveProperty(slot);
      }
      expect(deps.config.settlementFixing, label).toBe(label === 'set' ? 'owner-stamp' : '');
    }
  });

  it('passes no ladder but the owner’s published one, and no maintenance number, ADL policy or reduce cap', () => {
    const [unset] = only(off, 'startFuturesJobs') as [JobsDeps];
    expect(unset.ladderPolicy).toBeUndefined();
    const [set] = only(on, 'startFuturesJobs') as [JobsDeps];
    expect(set.ladderPolicy).toEqual(LADDER);
    for (const [label, b] of both()) {
      const [deps] = only(b, 'startFuturesJobs');
      const keys = deepKeys(deps);
      expect(
        keys.filter((k) => /maintenanceBps|maxReduceBps|^adl$|adlPolicy/i.test(k) && k !== 'ladderPolicy'),
        label,
      ).toEqual(label === 'set' ? ['maintenanceBps'] : []);
      // The one maintenance number on the set boot is the owner's own, inside the ladder he published.
      if (label === 'set') expect((deps as JobsDeps).ladderPolicy).toEqual(LADDER);
    }
  });

  it('never loads the test-only ladder table', () => {
    expect(harnessLoads).toEqual([]);
  });
});

describe('the position book the entry builds', () => {
  it('takes the owner’s leverage cap as parsed (blank stays null) and no ADL policy or reduce cap', () => {
    for (const [label, b] of both()) {
      const args = only(b, 'PositionService');
      const deps = args[2] as Record<string, unknown>;
      expect(deps.maxLeverage, label).toEqual(label === 'set' ? parseAmount('5') : null);
      expect(
        deepKeys(deps).filter((k) => /maxReduceBps|^adl$|adlPolicy/i.test(k)),
        label,
      ).toEqual([]);
    }
  });

  it('routes POST leverage to the position book’s own setLeverage', async () => {
    for (const [label, b] of both()) {
      const positions = made<Record<string, unknown>>(b, 'PositionService');
      const seen: unknown[] = [];
      positions.setLeverage = async (input: unknown, principal: unknown) => {
        seen.push([input, principal]);
        return { leveraged: label };
      };
      const [, deps] = only(b, 'registerPrivateRest') as [unknown, Record<string, (...a: unknown[]) => Promise<unknown>>];
      const input = { symbol: 'BTC/USDT-PERP', leverage: '5', positionId: 'pos-1', clientAdjustmentId: 'lev-1' };
      const answer = await deps.setLeverage!({ userId: '11111111-1111-4111-8111-111111111111' }, input);
      expect(seen, label).toHaveLength(1);
      // Every field, as the door handed it: the caller's own id, the symbol, the leverage parsed (never a fixed one).
      expect(seen[0], label).toEqual([
        {
          userId: '11111111-1111-4111-8111-111111111111',
          symbol: 'BTC/USDT-PERP',
          leverage: parseAmount('5'),
          positionId: 'pos-1',
          clientAdjustmentId: 'lev-1',
        },
        { userId: '11111111-1111-4111-8111-111111111111' },
      ]);
      expect(answer, label).toEqual({ leveraged: label });
    }
  });
});

describe('the margin-call door the entry mounts', () => {
  it('answers presentMarginCallWire of the stored row only: no grace deadline, and nothing for another user', async () => {
    for (const [label, b] of both()) {
      const handle = made<JobsHandle>(b, 'startFuturesJobs');
      const at = new Date('2026-09-03T00:00:00.000Z');
      const row: MarginCallRecord = {
        positionId: 'p1',
        userId: 'u1',
        marketId: 'BTC-PERP',
        sequence: 2,
        healthBps: 11_000,
        calledAt: at,
        deliveredAt: at,
        clearedAt: null,
      } as MarginCallRecord;
      handle.marginCalls.getOpenForPosition = async (positionId) =>
        positionId === 'p1' ? ({ ...row, graceExpiresAt: new Date(at.getTime() + 60_000) } as MarginCallRecord) : null;
      const [, deps] = only(b, 'registerPrivateRest') as [unknown, Record<string, (...a: unknown[]) => Promise<unknown>>];
      const wire = await deps.getOpenMarginCall!({ userId: 'u1' }, 'p1');
      expect(wire, label).toEqual(presentMarginCallWire(row));
      expect(JSON.stringify(wire), label).not.toMatch(/grace/i);
      expect(await deps.getOpenMarginCall!({ userId: 'u2' }, 'p1'), label).toBeNull();
      expect(await deps.getOpenMarginCall!({ userId: 'u1' }, 'p9'), label).toBeNull();
    }
  });
});

describe('the funding quote the entry publishes', () => {
  it('quotes the published entry with no index price and no next funding time, even with a mark in hand', async () => {
    for (const [label, b] of both()) {
      const handle = made<JobsHandle>(b, 'startFuturesJobs');
      handle.publishFundingRate({ marketId: 'm-perp', rate: '0.0001', periodId: 'p1', asOfMs: 1_700_000_000_000 });
      handle.markPrice = async () => '50000';
      const [, deps] = only(b, 'registerPublicRest') as [unknown, Record<string, (...a: unknown[]) => Promise<unknown>>];
      expect(await deps.fundingRateForMarket!('m-perp', 'BTC/USDT-PERP'), label).toEqual({
        fundingRate: '0.0001',
        fundingTimestamp: 1_700_000_000_000,
        fundingDatetime: new Date(1_700_000_000_000).toISOString(),
        nextFundingTimestamp: null,
        markPrice: '50000',
        indexPrice: null,
      });
      expect(await deps.fundingRateForMarket!('m-none', 'X'), label).toBeNull();
    }
  });
});

describe('what the running service reports about its futures jobs', () => {
  it('GET /health futuresJobs is the presenter of the env and parsed counts, with no rate, ids, venue or interval', async () => {
    for (const [label, b] of both()) {
      const res = await b.boot.request('/health');
      expect(res.status, label).toBe(200);
      const body = (await res.json()) as { futuresJobs: unknown };
      const set = label === 'set';
      expect(body.futuresJobs, label).toEqual(
        presentFuturesJobsHealth({
          enabled: set,
          fundingMarketCount: set ? 2 : 0,
          fundingMaxAbsRateConfigured: set,
          fundingIntervalConfigured: set,
          venueMarkConfigured: set,
        }),
      );
      expect(JSON.stringify(body.futuresJobs), label).not.toMatch(
        /0\.0075|aaaaaaaa|bbbbbbbb|binance|28_?800_?000|fundingMarketIds|venueId/,
      );
    }
  });

  it('GET /capabilities notes.futures carries each flag and the count from the env, never the ids, rate or interval', async () => {
    for (const [label, b] of both()) {
      const res = await b.boot.request('/api/v1/capabilities');
      expect(res.status, label).toBe(200);
      const note = ((await res.json()) as { notes: { futures: Record<string, unknown> } }).notes.futures;
      const set = label === 'set';
      expect(note, label).toMatchObject({
        jobsEnabled: set,
        orderableEnabled: set,
        profitSourceConfigured: set,
        fundingMaxAbsRateConfigured: set,
        fundingMarketCount: set ? 2 : 0,
        venueMarkConfigured: set,
        fundingIntervalConfigured: set,
        nextFundingTimestamp: 'unpublished',
        indexPrice: 'unpublished',
      });
      expect(note, label).not.toHaveProperty('fundingMarketIds');
      expect(note, label).not.toHaveProperty('fundingMaxAbsRate');
      expect(note, label).not.toHaveProperty('fundingIntervalMs');
      expect(JSON.stringify(note), label).not.toMatch(/0\.0075|aaaaaaaa|28_?800_?000|binance/);
    }
  });

  it('the listening log line names the venue mark as configured with its symbol count, never the venue id', () => {
    for (const [label, b] of both()) {
      const line = b.logs.find((l) => Array.isArray(l.futuresJobs) && 'venueMark' in l);
      expect(line, label).toBeDefined();
      expect(line!.venueMark, label).toEqual(label === 'set' ? { configured: true, symbolCount: 1 } : null);
      expect(JSON.stringify(line), label).not.toMatch(/binance/);
    }
  });
});

describe('the conditional-order jobs the entry starts', () => {
  it('follow TRADE_FUTURES_CONDITIONAL_JOBS_ENABLED and its interval, off when unset', () => {
    expect(tradeEnvOf().TRADE_FUTURES_CONDITIONAL_JOBS_ENABLED).toBe(false);
    for (const [label, b] of both()) {
      const [input] = only(b, 'startConditionalOrderJobs') as [{ config: { enabled: boolean; intervalMs: number | null } }];
      expect(input.config, label).toEqual(
        label === 'set' ? { enabled: true, intervalMs: 3_600_000 } : { enabled: false, intervalMs: null },
      );
    }
  });
});
