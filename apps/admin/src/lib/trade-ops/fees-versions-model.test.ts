import { describe, expect, it } from 'vitest';
import {
  buildProposal,
  draftFrom,
  pairGroupViews,
  parseDraft,
  parseFeeHistory,
  rateText,
  rebateTiers,
  shownTime,
  shownVersions,
  tierProgramOf,
  tierProgramText,
  versionInForce,
  versionStates,
  type FeeVersionRow,
} from './fees-versions-model';
import { feeScheduleSetPayloadHash } from './fees-hash';

const regular = (pairGroup: string, makerBps: string, takerBps = '10', over: Record<string, unknown> = {}) => ({
  pairGroup,
  tierId: 'regular',
  zeroFee: false,
  makerBps,
  takerBps,
  minFee: null,
  ...over,
});
const schedule = (maker: string, extra: Record<string, unknown> = {}) => ({
  defaultPairGroup: 'all-others',
  pairGroups: { 'IFC/USDT': 'test-fee-change', 'ETH/USDC': 'test-zero-fee' },
  rows: [
    regular('all-others', '8'),
    regular('test-fee-change', maker),
    { pairGroup: 'test-zero-fee', tierId: 'regular', zeroFee: true, minFee: null },
  ],
  perpetual: { makerBps: '2', takerBps: '5' },
  ...extra,
});
const version = (v: string, effectiveAt: string, sched: Record<string, unknown>): FeeVersionRow => ({
  version: v,
  schedule: sched,
  effectiveAt,
  operatorId: 'a',
  approverId: 'b',
  reason: 'TEST version',
  createdAt: effectiveAt,
});
const NOW = new Date('2026-11-06T10:00:00.000Z');
const HISTORY = [
  version('1', '2026-11-06T09:00:00.000Z', schedule('5')),
  version('2', '2026-11-06T09:30:00.000Z', schedule('4')),
  version('3', '2026-11-06T10:05:00.000Z', schedule('2')),
];

describe('fee versions', () => {
  it('parses the operator read and refuses a body of another shape whole', () => {
    expect(parseFeeHistory({ version: '3', history: HISTORY })?.history).toHaveLength(3);
    expect(parseFeeHistory({ version: '3', history: [...HISTORY, { version: 'x' }] })).toBeNull();
    expect(parseFeeHistory({ version: 3, history: [] })).toBeNull();
    expect(parseFeeHistory(null)).toBeNull();
  });

  it('calls the latest started version current, a later one scheduled and the rest previous, as svc-trade picks it', () => {
    expect([...versionStates(HISTORY, NOW)]).toEqual([
      ['1', 'previous'],
      ['2', 'current'],
      ['3', 'scheduled'],
    ]);
    // At the stated time exactly, the new version is the one in force.
    expect(versionInForce(HISTORY, new Date('2026-11-06T10:05:00.000Z'))?.version).toBe('3');
    expect(versionInForce(HISTORY, new Date('2026-11-06T08:00:00.000Z'))).toBeNull();
    // Two versions at the same time: the higher one wins.
    const tie = [version('1', '2026-11-06T09:00:00.000Z', schedule('5')), version('2', '2026-11-06T09:00:00.000Z', schedule('4'))];
    expect(versionInForce(tie, NOW)?.version).toBe('2');
  });

  it('shows every scheduled version, the current one and at most five before it, newest first', () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      version(String(i + 1), new Date(Date.parse('2026-11-06T01:00:00.000Z') + i * 3_600_000).toISOString(), schedule('4')),
    );
    expect(shownVersions(many, NOW).map((s) => `${s.row.version}:${s.state}`)).toEqual([
      '9:current',
      '8:previous',
      '7:previous',
      '6:previous',
      '5:previous',
      '4:previous',
    ]);
    expect(shownVersions(many, new Date('2026-11-06T05:30:00.000Z')).map((s) => `${s.row.version}:${s.state}`)).toEqual([
      '9:scheduled',
      '8:scheduled',
      '7:scheduled',
      '6:scheduled',
      '5:current',
      '4:previous',
      '3:previous',
      '2:previous',
      '1:previous',
    ]);
  });

  it('regroups the versions by pair group with exact rates, a zero-fee row named, a blank rebate "not set"', () => {
    const groups = pairGroupViews(HISTORY, NOW);
    expect(groups.map((g) => [g.group, g.markets])).toEqual([
      ['all-others', null],
      ['test-fee-change', ['IFC/USDT']],
      ['test-zero-fee', ['ETH/USDC']],
    ]);
    expect(groups[1]!.lines).toEqual([
      {
        version: '3',
        state: 'scheduled',
        effectiveAt: '2026-11-06T10:05:00.000Z',
        tierId: 'regular',
        maker: '0.02% (2 bps)',
        taker: '0.10% (10 bps)',
        rebate: 'not set',
        minFee: 'none',
      },
      {
        version: '2',
        state: 'current',
        effectiveAt: '2026-11-06T09:30:00.000Z',
        tierId: 'regular',
        maker: '0.04% (4 bps)',
        taker: '0.10% (10 bps)',
        rebate: 'not set',
        minFee: 'none',
      },
      {
        version: '1',
        state: 'previous',
        effectiveAt: '2026-11-06T09:00:00.000Z',
        tierId: 'regular',
        maker: '0.05% (5 bps)',
        taker: '0.10% (10 bps)',
        rebate: 'not set',
        minFee: 'none',
      },
    ]);
    expect(groups[2]!.lines[0]).toMatchObject({ maker: 'zero fee', taker: 'zero fee' });
    // A flat schedule is one row for every market.
    expect(pairGroupViews([version('1', '2026-11-06T09:00:00.000Z', { makerBps: '8', takerBps: '10' })], NOW)[0]).toMatchObject({
      group: 'every market',
      markets: null,
      lines: [{ maker: '0.08% (8 bps)', taker: '0.10% (10 bps)' }],
    });
  });

  it('writes rates exactly with integer maths, and times in UTC', () => {
    expect(rateText('0')).toBe('0.00% (0 bps)');
    expect(rateText('8')).toBe('0.08% (8 bps)');
    expect(rateText('125')).toBe('1.25% (125 bps)');
    expect(rateText('9999')).toBe('99.99% (9999 bps)');
    expect(rateText(null)).toBe('not set');
    expect(shownTime('2026-11-06T10:05:00.123Z')).toBe('2026-11-06 10:05:00 UTC');
  });

  it('lists the maker rebate tiers of the version in force, read only, a row with none "not set"', () => {
    const rebate = version('4', '2026-11-06T09:45:00.000Z', {
      ...schedule('4'),
      rows: [regular('all-others', '8'), regular('test-rebate', '0', '10', { makerRebateBps: '5' })],
    });
    expect(rebateTiers(rebate)).toEqual([
      { pairGroup: 'all-others', tierId: 'regular', maker: '0.08% (8 bps)', rebate: 'not set' },
      { pairGroup: 'test-rebate', tierId: 'regular', maker: '0.00% (0 bps)', rebate: '0.05% (5 bps)' },
    ]);
    expect(rebateTiers(null)).toEqual([]);
  });

  it('reads a VIP programme, and none as null', () => {
    const p = tierProgramOf(
      schedule('4', { tierProgram: { thresholds: [{ tierId: 'test-vip-1', minVolume30d: '500' }], snapshotTimeUtc: '10:42' } }),
    );
    expect(p).toEqual({ thresholds: [{ tierId: 'test-vip-1', minVolume30d: '500' }], snapshotTimeUtc: '10:42' });
    expect(tierProgramText(p!)).toBe('test-vip-1 from 500 · snapshot 10:42 UTC');
    expect(tierProgramOf(schedule('4'))).toBeNull();
  });
});

describe('a proposal', () => {
  const base = HISTORY[2]!;
  const later = '2026-11-06T10:30:00Z';
  const reason = 'TEST maker change for IFC/USDT';
  const edit = (maker: string, taker = '10', effectiveAt = later) => {
    const d = draftFrom(base);
    return {
      ...d,
      effectiveAt,
      rates: d.rates.map((r) => (r.pairGroup === 'test-fee-change' ? { ...r, makerBps: maker, takerBps: taker } : r)),
    };
  };

  it('starts from the latest version: every non-zero-fee row, no programme, no time', () => {
    expect(draftFrom(base)).toEqual({
      rates: [
        { pairGroup: 'all-others', tierId: 'regular', makerBps: '8', takerBps: '10' },
        { pairGroup: 'test-fee-change', tierId: 'regular', makerBps: '2', takerBps: '10' },
      ],
      thresholds: null,
      snapshotTimeUtc: null,
      effectiveAt: '',
    });
  });

  it('puts the edits into the base schedule and keeps everything else exactly', () => {
    const check = buildProposal(base, edit('1'), reason, NOW);
    expect(check).toEqual({
      ok: true,
      effectiveAt: '2026-11-06T10:30:00.000Z',
      schedule: { ...schedule('2'), rows: [regular('all-others', '8'), regular('test-fee-change', '1'), schedule('2').rows[2]] },
    });
    // The base it started from is left as it was.
    expect(base.schedule).toEqual(schedule('2'));
    // The same draft gives the same schedule, so the approval's hash can be worked out again when it is written.
    const again = buildProposal(base, edit('1'), reason, NOW);
    expect(again.ok && check.ok && feeScheduleSetPayloadHash({ ...again, expectedVersion: '3', reason })).toBe(
      check.ok && feeScheduleSetPayloadHash({ ...check, expectedVersion: '3', reason }),
    );
  });

  it('refuses a blank taker fee with svc-trade’s typed code, naming the row', () => {
    expect(buildProposal(base, edit('2', ''), reason, NOW)).toEqual({
      ok: false,
      code: 'trade.fee_schedule_blank',
      message: 'The taker fee of test-fee-change / regular is blank. Every rate needs a value.',
    });
    expect(buildProposal(base, edit(' ', '10'), reason, NOW)).toMatchObject({ ok: false, code: 'trade.fee_schedule_blank' });
  });

  it('refuses a rate that is not a whole number of bps from 0 to 9999', () => {
    for (const bad of ['0.5', '-1', '10000', '1e2', '08', 'abc'])
      expect(buildProposal(base, edit(bad), reason, NOW), bad).toMatchObject({ ok: false, code: 'trade.fee_schedule_blank' });
    expect(buildProposal(base, edit('9999'), reason, NOW).ok).toBe(true);
    expect(buildProposal(base, edit('0'), reason, NOW).ok).toBe(true);
  });

  it('refuses a time that is not UTC, not after now, or before the version it starts from', () => {
    expect(buildProposal(base, edit('1', '10', '2026-11-06 10:30'), reason, NOW)).toMatchObject({
      code: 'trade_ops.fee_effective_invalid',
    });
    expect(buildProposal(base, edit('1', '10', '2026-11-06T10:30:00+01:00'), reason, NOW)).toMatchObject({
      code: 'trade_ops.fee_effective_invalid',
    });
    expect(buildProposal(base, edit('1', '10', '2026-11-06T10:00:00Z'), reason, NOW)).toMatchObject({
      code: 'fee_schedule_effective_in_past',
    });
    expect(buildProposal(base, edit('1', '10', '2026-11-06T10:04:00Z'), reason, NOW)).toMatchObject({
      code: 'fee_schedule_effective_out_of_order',
    });
  });

  it('refuses a reason shorter than 12 or longer than 500 characters', () => {
    expect(buildProposal(base, edit('1'), 'too short', NOW)).toMatchObject({ code: 'trade_ops.reason_required' });
    expect(buildProposal(base, edit('1'), 'x'.repeat(501), NOW)).toMatchObject({ code: 'trade_ops.reason_required' });
  });

  it('edits the VIP thresholds and the snapshot time through the same proposal', () => {
    const tiered = version('5', '2026-11-06T09:50:00.000Z', {
      ...schedule('4'),
      tierProgram: {
        thresholds: [{ tierId: 'test-vip-1', minVolume30d: '1000' }],
        volumeQuotes: ['USDT'],
        snapshotTimeUtc: '16:00',
        downgradeGraceDays: null,
      },
    });
    const draft = {
      ...draftFrom(tiered),
      effectiveAt: later,
      thresholds: [{ tierId: 'test-vip-1', minVolume30d: '500' }],
      snapshotTimeUtc: '10:42',
    };
    const check = buildProposal(tiered, draft, reason, NOW);
    expect(check.ok && check.schedule.tierProgram).toEqual({
      thresholds: [{ tierId: 'test-vip-1', minVolume30d: '500' }],
      volumeQuotes: ['USDT'],
      snapshotTimeUtc: '10:42',
      downgradeGraceDays: null,
    });
    expect(buildProposal(tiered, { ...draft, thresholds: [{ tierId: 'test-vip-1', minVolume30d: '' }] }, reason, NOW)).toMatchObject({
      code: 'trade.fee_schedule_blank',
    });
    expect(buildProposal(tiered, { ...draft, snapshotTimeUtc: '24:00' }, reason, NOW)).toMatchObject({ code: 'trade.fee_schedule_blank' });
    expect(buildProposal(tiered, { ...draft, snapshotTimeUtc: '' }, reason, NOW)).toMatchObject({ code: 'trade.fee_schedule_blank' });
    expect(buildProposal(tiered, { ...draft, thresholds: [{ tierId: 'test-vip-9', minVolume30d: '1' }] }, reason, NOW)).toMatchObject({
      code: 'trade_ops.fee_row_unknown',
    });
  });

  it('reads the draft back from the browser, and refuses one of another shape', () => {
    const draft = edit('1');
    expect(parseDraft(JSON.parse(JSON.stringify(draft)))).toEqual(draft);
    expect(parseDraft({ ...draft, rates: [{ pairGroup: 'x' }] })).toBeNull();
    expect(parseDraft({ ...draft, thresholds: 'x' })).toBeNull();
    expect(parseDraft(null)).toBeNull();
  });
});

describe('the approval hash', () => {
  // Golden vector shared with services/svc-trade/src/admin/fees-convert-desk.pg.test.ts (svc-trade's own payloadHash) and
  // tooling/scripts/local-test-gates.mjs: a founder who approves this version approves exactly these bytes.
  it('matches the value svc-trade computes for the same version', () => {
    expect(
      feeScheduleSetPayloadHash({
        schedule: {
          defaultPairGroup: 'all-others',
          rows: [{ pairGroup: 'all-others', tierId: 'regular', zeroFee: false, makerBps: '8', takerBps: '10', minFee: null }],
          tierProgram: { thresholds: [{ tierId: 'vip-1', minVolume30d: '500' }], snapshotTimeUtc: '10:42', downgradeGraceDays: 3 },
        },
        effectiveAt: '2026-11-06T10:42:00.000Z',
        expectedVersion: '7',
        reason: 'TEST golden fee version',
      }),
    ).toBe('sha256:df267bb64187d88019b2f182a8c62dae7c76452f092dc9adb3b09f4185cd6fb1');
  });
});
