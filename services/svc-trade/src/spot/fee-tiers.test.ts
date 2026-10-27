import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import { parseFeeScheduleJson } from './fee-schedule.js';
import {
  lastSnapshotInstant,
  nextSnapshotInstant,
  nextThreshold,
  parseTierProgram,
  tierForVolume,
  tierSnapshotKey,
  volumeWindow,
  type FeeTierProgram,
} from './fee-tiers.js';

/** The tier programme (SP-fees-vip-03, J-cex-spot-10 #5-#6): TEST thresholds, never owner values. */

const ROWS = [
  { pairGroup: 'all-others', tierId: 'regular', zeroFee: false, makerBps: '8', takerBps: '10', minFee: null },
  { pairGroup: 'all-others', tierId: 'test-vip-1', zeroFee: false, makerBps: '6', takerBps: '9', minFee: null },
  { pairGroup: 'all-others', tierId: 'test-vip-2', zeroFee: false, makerBps: '4', takerBps: '8', minFee: null },
  { pairGroup: 'test-zero-fee', tierId: 'regular', zeroFee: true, minFee: null },
  { pairGroup: 'test-zero-fee', tierId: 'test-vip-1', zeroFee: true, minFee: null },
  { pairGroup: 'test-zero-fee', tierId: 'test-vip-2', zeroFee: true, minFee: null },
];
const PROGRAM = {
  thresholds: [
    { tierId: 'test-vip-1', minVolume30d: '1000' },
    { tierId: 'test-vip-2', minVolume30d: '5000' },
  ],
  volumeQuotes: ['USDT', 'USDC'],
  snapshotTimeUtc: '07:00',
  downgradeGraceDays: null,
  subAccounts: null,
  botsAndCopy: null,
};

const schedule = (tierProgram: unknown, rows: unknown[] = ROWS) =>
  parseFeeScheduleJson(
    JSON.stringify({
      published: true,
      version: 'test',
      defaultPairGroup: 'all-others',
      pairGroups: { 'ETH/USDC': 'test-zero-fee' },
      rows,
      tierProgram,
    }),
  );
const program = (overrides: Record<string, unknown> = {}): FeeTierProgram => {
  const parsed = schedule({ ...PROGRAM, ...overrides });
  if (parsed.published !== true || !parsed.tierProgram) throw new Error('no programme');
  return parsed.tierProgram;
};
const refusal = (overrides: Record<string, unknown>, rows?: unknown[]) => {
  try {
    schedule({ ...PROGRAM, ...overrides }, rows);
  } catch (err) {
    return { code: (err as { code: string }).code, message: (err as Error).message };
  }
  throw new Error('the programme was accepted');
};

describe('the tier programme in the fee schedule', () => {
  it('reads the thresholds, the counted quotes and the snapshot time; no programme is none', () => {
    expect(program()).toEqual({
      thresholds: [
        { tierId: 'test-vip-1', minVolume30d: '1000' },
        { tierId: 'test-vip-2', minVolume30d: '5000' },
      ],
      volumeQuotes: ['USDT', 'USDC'],
      snapshotTimeUtc: '07:00',
      benefits: null,
      application: null,
      trial: null,
    });
    expect(program({ snapshotTimeUtc: null }).snapshotTimeUtc).toBeNull();
    const none = schedule(undefined);
    expect(none.published === true && none.tierProgram).toBeNull();
  });

  it('refuses a rule it cannot apply yet rather than storing and ignoring it', () => {
    expect(refusal({ downgradeGraceDays: '3' }).message).toMatch(/grace period is not applied yet/);
    expect(refusal({ subAccounts: 'count-to-parent' }).message).toMatch(/sub-account volume/);
    expect(refusal({ botsAndCopy: 'count' }).message).toMatch(/copy trading volume/);
    expect(refusal({ thresholds: [{ tierId: 'test-vip-1', minVolume30d: '1000', minAssets: '100' }] }).message).toMatch(/asset tier/);
    // A blank rule is written as null, never left out.
    const { botsAndCopy: _dropped, ...withoutBots } = PROGRAM;
    expect(() => schedule(withoutBots)).toThrow(/botsAndCopy must be null/);
  });

  it('refuses a tier with no row in a pair group, so a snapshot never gives a tier a market cannot price', () => {
    const rows = ROWS.filter((row) => !(row.pairGroup === 'test-zero-fee' && row.tierId === 'test-vip-2'));
    expect(refusal({}, rows)).toEqual({
      code: 'trade.fee_schedule_blank',
      message: expect.stringContaining("tier 'test-vip-2' has no row in pair group 'test-zero-fee'"),
    });
  });

  it('refuses thresholds out of order, repeated, at zero, as numbers, or naming the regular tier', () => {
    expect(
      refusal({
        thresholds: [
          { tierId: 'test-vip-2', minVolume30d: '5000' },
          { tierId: 'test-vip-1', minVolume30d: '1000' },
        ],
      }).message,
    ).toMatch(/above the threshold before it/);
    expect(refusal({ thresholds: [{ tierId: 'test-vip-1', minVolume30d: '0' }] }).message).toMatch(/above zero/);
    expect(refusal({ thresholds: [{ tierId: 'test-vip-1', minVolume30d: 1000 }] }).message).toMatch(/decimal string/);
    expect(refusal({ thresholds: [{ tierId: 'regular', minVolume30d: '1' }] }).message).toMatch(/tier below every threshold/);
    expect(refusal({ thresholds: [] }).message).toMatch(/non-empty/);
    expect(refusal({ volumeQuotes: [] }).message).toMatch(/volumeQuotes/);
    expect(refusal({ snapshotTimeUtc: '7:00' }).message).toMatch(/HH:MM/);
  });

  it('refuses a programme on the flat schedule, which has no tiers', () => {
    expect(() =>
      parseFeeScheduleJson(JSON.stringify({ published: true, version: 'flat', makerBps: '8', takerBps: '10', tierProgram: PROGRAM })),
    ).toThrow(/needs a rows schedule/);
  });
});

describe("the owner's benefits table", () => {
  const ROW = {
    tierId: 'regular',
    prioritySupport: null,
    vipPortal: null,
    ambassador: null,
    subAccountCap: null,
    withdrawalLimit24h: null,
  };

  it('reads a row per tier, each cell set or not set, and an absent or null table as none', () => {
    const benefits = [
      ROW,
      {
        ...ROW,
        tierId: 'test-vip-1',
        prioritySupport: true,
        vipPortal: false,
        subAccountCap: 20,
        withdrawalLimit24h: { asset: 'USDT', amount: '250000.50' },
      },
    ];
    expect(program({ benefits }).benefits).toEqual([
      ROW,
      {
        tierId: 'test-vip-1',
        prioritySupport: true,
        vipPortal: false,
        ambassador: null,
        subAccountCap: 20,
        withdrawalLimit24h: { asset: 'USDT', amount: '250000.5' },
      },
    ]);
    expect(program({ benefits: [{ ...ROW, tierId: ' test-vip-1 ' }] }).benefits?.[0]?.tierId).toBe('test-vip-1');
    expect(program().benefits).toBeNull();
    expect(program({ benefits: null }).benefits).toBeNull();
  });

  it.each([
    ['a cell left out', [{ tierId: 'regular', prioritySupport: null }], /must be set or null/],
    ['a tier the programme does not name', [{ ...ROW, tierId: 'test-vip-9' }], /tierId must be/],
    ['a repeated tier', [ROW, ROW], /repeats a tier/],
    ['an unknown field', [{ ...ROW, cashback: '1' }], /unknown fields: cashback/],
    ['a flag as text', [{ ...ROW, vipPortal: 'yes' }], /vipPortal must be true, false or null/],
    ['a fractional cap', [{ ...ROW, subAccountCap: 2.5 }], /subAccountCap must be a whole number/],
    ['a limit as a number', [{ ...ROW, withdrawalLimit24h: { asset: 'USDT', amount: 1000 } }], /amount must be a decimal string/],
    ['a zero limit', [{ ...ROW, withdrawalLimit24h: { asset: 'USDT', amount: '0' } }], /amount must be above zero/],
    ['an empty table', [], /non-empty array or null/],
  ])('refuses %s as a blank schedule', (_name, benefits, message) => {
    const refused = refusal({ benefits });
    expect(refused.code).toBe('trade.fee_schedule_blank');
    expect(refused.message).toMatch(message);
  });
});

describe("the owner's VIP trial", () => {
  it('reads the tier and the days; absent or null is none', () => {
    expect(program({ trial: { tierId: 'test-vip-2', days: 30 } }).trial).toEqual({ tierId: 'test-vip-2', days: 30 });
    expect(program({ trial: null }).trial).toBeNull();
    expect(program().trial).toBeNull();
  });

  it.each([
    ['a tier the thresholds do not name', { tierId: 'test-vip-9', days: 30 }, /tierId must be a tier the thresholds name/],
    ['the regular tier', { tierId: 'regular', days: 30 }, /tierId must be a tier the thresholds name/],
    ['no days', { tierId: 'test-vip-1' }, /whole number of days from 1 to 366/],
    ['zero days', { tierId: 'test-vip-1', days: 0 }, /whole number of days from 1 to 366/],
    ['a fraction of a day', { tierId: 'test-vip-1', days: 1.5 }, /whole number of days from 1 to 366/],
    ['days as text', { tierId: 'test-vip-1', days: '30' }, /whole number of days from 1 to 366/],
    ['more than a year', { tierId: 'test-vip-1', days: 367 }, /whole number of days from 1 to 366/],
    ['an unknown field', { tierId: 'test-vip-1', days: 30, amount: '1' }, /unknown fields: amount/],
    ['a list', [{ tierId: 'test-vip-1', days: 30 }], /must be an object or null/],
  ])('refuses %s as a blank schedule', (_name, trial, message) => {
    const refused = refusal({ trial });
    expect(refused.code).toBe('trade.fee_schedule_blank');
    expect(refused.message).toMatch(message);
  });
});

describe('the tier a volume reaches', () => {
  const p = program();
  it('is the highest threshold at or below it, else regular, and names the next one', () => {
    expect(tierForVolume(p, parseAmount('999.99'))).toBe('regular');
    expect(tierForVolume(p, parseAmount('1000'))).toBe('test-vip-1');
    expect(tierForVolume(p, parseAmount('7000'))).toBe('test-vip-2');
    expect(nextThreshold(p, parseAmount('250.5'))).toEqual({ tierId: 'test-vip-1', minVolume30d: '1000', remaining: '749.5' });
    expect(nextThreshold(p, parseAmount('1000'))).toEqual({ tierId: 'test-vip-2', minVolume30d: '5000', remaining: '4000' });
    expect(nextThreshold(p, parseAmount('5000'))).toBeNull();
  });
});

describe('the snapshot clock', () => {
  const p = program();
  const since = new Date('2026-10-01T00:00:00Z');
  it('is the day’s snapshot time once it passed, else the day before', () => {
    expect(lastSnapshotInstant(p, since, new Date('2026-10-24T07:00:00Z'))?.toISOString()).toBe('2026-10-24T07:00:00.000Z');
    expect(lastSnapshotInstant(p, since, new Date('2026-10-24T06:59:59Z'))?.toISOString()).toBe('2026-10-23T07:00:00.000Z');
    expect(nextSnapshotInstant(p, since, new Date('2026-10-24T06:59:59Z'))?.toISOString()).toBe('2026-10-24T07:00:00.000Z');
    expect(nextSnapshotInstant(p, since, new Date('2026-10-24T07:00:00Z'))?.toISOString()).toBe('2026-10-25T07:00:00.000Z');
  });

  it('never snapshots a moment before the version carrying the programme took effect', () => {
    const effective = new Date('2026-10-24T06:30:00Z');
    expect(lastSnapshotInstant(p, effective, new Date('2026-10-24T06:45:00Z'))).toBeNull();
    expect(lastSnapshotInstant(p, effective, new Date('2026-10-24T07:00:30Z'))?.toISOString()).toBe('2026-10-24T07:00:00.000Z');
    expect(nextSnapshotInstant(p, new Date('2026-10-26T00:00:00Z'), new Date('2026-10-24T08:00:00Z'))?.toISOString()).toBe(
      '2026-10-26T07:00:00.000Z',
    );
  });

  it('runs no snapshot without a snapshot time', () => {
    const blank = program({ snapshotTimeUtc: null });
    expect(lastSnapshotInstant(blank, since, new Date('2026-10-24T08:00:00Z'))).toBeNull();
    expect(nextSnapshotInstant(blank, since, new Date('2026-10-24T08:00:00Z'))).toBeNull();
  });

  it('keys each account’s row by the snapshot minute, and counts the 30 days before it', () => {
    const instant = new Date('2026-10-24T07:00:00Z');
    expect(tierSnapshotKey(instant, '11111111-1111-4111-8111-111111111111')).toBe(
      'tier-snapshot:2026-10-24T07:00Z:11111111-1111-4111-8111-111111111111',
    );
    expect(volumeWindow(instant).from.toISOString()).toBe('2026-09-24T07:00:00.000Z');
  });
});
