import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FEE_SCHEDULE_RESIDUAL,
  feeScreenLines,
  FeeScheduleError,
  parseFeeScheduleJson,
  previewFeeBps,
  publishedProductBps,
  requirePublishedFeeSchedule,
  TRADE_FEE_SCHEDULE_ENV,
  UNPUBLISHED_FEE_SCHEDULE,
} from './fee-schedule.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const here = dirname(fileURLToPath(import.meta.url));

const PUBLISHED = JSON.stringify({
  published: true,
  version: 'ptx-m21-test',
  makerBps: '10',
  takerBps: '20',
});

describe('parseFeeScheduleJson', () => {
  it('empty env → unpublished (never invents bps)', () => {
    expect(parseFeeScheduleJson('')).toEqual(UNPUBLISHED_FEE_SCHEDULE);
    expect(parseFeeScheduleJson(null)).toEqual(UNPUBLISHED_FEE_SCHEDULE);
    expect(parseFeeScheduleJson('  ')).toEqual(UNPUBLISHED_FEE_SCHEDULE);
    expect(parseFeeScheduleJson(undefined)).toEqual(UNPUBLISHED_FEE_SCHEDULE);
  });

  it('published false → unpublished', () => {
    expect(parseFeeScheduleJson('{"published":false}')).toEqual(UNPUBLISHED_FEE_SCHEDULE);
  });

  it('published true with decimal-string bps', () => {
    const schedule = parseFeeScheduleJson(PUBLISHED);
    expect(schedule).toEqual({
      published: true,
      version: 'ptx-m21-test',
      makerBps: 10,
      takerBps: 20,
      makerRebateBps: null,
      perpetual: null,
    });
  });

  it('explicit zero rebate is owner-set, not invented', () => {
    const schedule = parseFeeScheduleJson(
      JSON.stringify({
        published: true,
        version: 'v1',
        makerBps: '0',
        takerBps: '0',
        makerRebateBps: '0',
      }),
    );
    expect(schedule.published).toBe(true);
    if (schedule.published) expect(schedule.makerRebateBps).toBe(0);
  });

  it('refuses JSON numbers for bps — decimal strings only', () => {
    const raw = JSON.stringify({ published: true, version: 'v1', makerBps: 10, takerBps: 20 });
    expect(() => parseFeeScheduleJson(raw)).toThrow(FeeScheduleError);
    try {
      parseFeeScheduleJson(raw);
    } catch (err) {
      expect(err).toBeInstanceOf(FeeScheduleError);
      expect((err as FeeScheduleError).code).toBe('trade.fee_schedule_blank');
      expect((err as FeeScheduleError).residual).toBe(FEE_SCHEDULE_RESIDUAL);
    }
  });

  it('refuses blank / missing / non-integer / out-of-range bps', () => {
    const bases = { published: true, version: 'v1', takerBps: '20' };
    for (const makerBps of [undefined, null, '', '10.5', '-1', '10000', '01a']) {
      expect(() => parseFeeScheduleJson(JSON.stringify({ ...bases, makerBps }))).toThrow(FeeScheduleError);
    }
  });

  it('refuses invalid JSON instead of inventing a schedule', () => {
    expect(() => parseFeeScheduleJson('{')).toThrow(FeeScheduleError);
    expect(() => parseFeeScheduleJson('[]')).toThrow(FeeScheduleError);
    expect(() => parseFeeScheduleJson('"nope"')).toThrow(FeeScheduleError);
  });

  it('refuses published without a version', () => {
    expect(() => parseFeeScheduleJson(JSON.stringify({ published: true, makerBps: '10', takerBps: '20' }))).toThrow(FeeScheduleError);
  });
});

describe('previewFeeBps', () => {
  it('unpublished → null (preview must refuse, not invent listing bps)', () => {
    expect(previewFeeBps(UNPUBLISHED_FEE_SCHEDULE, 'taker')).toBeNull();
    expect(previewFeeBps(UNPUBLISHED_FEE_SCHEDULE, 'maker')).toBeNull();
  });

  it('published → owner maker/taker counts', () => {
    const schedule = parseFeeScheduleJson(PUBLISHED);
    expect(previewFeeBps(schedule, 'maker')).toBe(10);
    expect(previewFeeBps(schedule, 'taker')).toBe(20);
  });

  it('a rank discount of 5000 on a 100 bps taker fee previews 50, and zero discount posts the published rate', () => {
    const schedule = parseFeeScheduleJson(JSON.stringify({ published: true, version: 'rank-50', makerBps: '80', takerBps: '100' }));
    expect(previewFeeBps(schedule, 'taker', 5000)).toBe(50);
    expect(previewFeeBps(schedule, 'taker', 0)).toBe(100);
    expect(previewFeeBps(schedule, 'maker', 0)).toBe(80);
  });
});

describe('requirePublishedFeeSchedule', () => {
  it('unpublished throws trade.fee_schedule_blank', () => {
    expect(() => requirePublishedFeeSchedule(UNPUBLISHED_FEE_SCHEDULE)).toThrow(FeeScheduleError);
    try {
      requirePublishedFeeSchedule(UNPUBLISHED_FEE_SCHEDULE);
    } catch (err) {
      expect((err as FeeScheduleError).code).toBe('trade.fee_schedule_blank');
    }
  });

  it('published returns owner integer bps from decimal strings', () => {
    const schedule = requirePublishedFeeSchedule(parseFeeScheduleJson(PUBLISHED));
    expect(schedule.makerBps).toBe(10);
    expect(schedule.takerBps).toBe(20);
  });
});

describe('TRADE_FEE_SCHEDULE wiring', () => {
  it('compose passes the owner schedule through with no default magnitude', () => {
    const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
    expect(compose).toMatch(/TRADE_FEE_SCHEDULE:\s*\$\{TRADE_FEE_SCHEDULE:-\}/);
    expect(compose).not.toMatch(/TRADE_FEE_SCHEDULE:\s*\$\{TRADE_FEE_SCHEDULE:-[^}]+\}/);
  });

  it('env.ts defaults blank (unpublished)', () => {
    const envTs = readFileSync(join(ROOT, 'services/svc-trade/src/env.ts'), 'utf8');
    expect(envTs).toMatch(/TRADE_FEE_SCHEDULE:\s*z\.string\(\)\.default\(''\)/);
  });

  it('index hitch parses env and passes feeSchedule into place and the preview door', () => {
    const index = readFileSync(join(ROOT, 'services/svc-trade/src/index.ts'), 'utf8');
    expect(index).toMatch(/parseFeeScheduleJson\(env\.TRADE_FEE_SCHEDULE\)/);
    expect(index).toMatch(/new TradeService\([\s\S]*feeSchedule/);
    expect(index).toMatch(/registerSpotOrderPreviewRest\(app, \{[\s\S]*feeSchedule/);
  });

  it('does not recut router.ts', () => {
    const router = readFileSync(join(here, '..', 'router.ts'), 'utf8');
    expect(router).not.toMatch(/TRADE_FEE_SCHEDULE|parseFeeScheduleJson|fee-schedule/);
  });

  it('place/fill hitch uses owner schedule, not market.makerBps', () => {
    const service = readFileSync(join(here, 'trade-service.ts'), 'utf8');
    expect(service).toContain('assertOwnerFeeSchedulePublished');
    expect(service).toMatch(/feeRatesForFill\(\s*this\.feeSchedule/);
    expect(service).not.toMatch(/ratesForFill\(market/);
  });

  it('names the env key constantly', () => {
    expect(TRADE_FEE_SCHEDULE_ENV).toBe('TRADE_FEE_SCHEDULE');
  });
});

describe('product rates and the fee screen (TRD-0466, TRD-0526)', () => {
  const spotOnly = parseFeeScheduleJson(JSON.stringify({ published: true, version: 'spot-only', makerBps: '10', takerBps: '20' }));

  it('a perpetual fill is refused when only the spot rate is published', () => {
    expect(publishedProductBps(spotOnly, 'spot')).toEqual({ makerBps: 10, takerBps: 20 });
    expect(publishedProductBps(spotOnly, 'perpetual')).toBeNull();
  });

  it('a published perpetual block is its own rate', () => {
    const both = parseFeeScheduleJson(
      JSON.stringify({
        published: true,
        version: 'both',
        makerBps: '10',
        takerBps: '20',
        perpetual: { makerBps: '4', takerBps: '8' },
      }),
    );
    expect(publishedProductBps(both, 'perpetual')).toEqual({ makerBps: 4, takerBps: 8 });
  });

  it('a blank trade schedule does not change the withdrawal network fee', () => {
    expect(feeScreenLines({ schedule: UNPUBLISHED_FEE_SCHEDULE, withdrawalNetworkFee: '1.25' })).toEqual({
      trading: null,
      withdrawalNetworkFee: '1.25',
    });
    expect(feeScreenLines({ schedule: spotOnly, withdrawalNetworkFee: '1.25' })).toEqual({
      trading: { makerBps: 10, takerBps: 20 },
      withdrawalNetworkFee: '1.25',
    });
  });
});
