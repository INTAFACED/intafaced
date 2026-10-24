import { describe, expect, it } from 'vitest';
import { dec, str } from '../../data/decimal';
import { lineChart } from './pnl-time-model';
import {
  BRIDGE_LEGS,
  bankValueOverTimeSchema,
  bridgeValue,
  signedLine,
  valueLine,
  valueMissingOf,
  type BankValueOverTime,
} from './value-time-model';

// Every figure is TEST data.
const answer: BankValueOverTime = bankValueOverTimeSchema.parse({
  from: '2026-10-01T00:00:00.000Z',
  to: '2026-10-04T00:00:00.000Z',
  interval: '1d',
  points: [
    { at: '2026-10-01T00:00:00.000Z', valueUsd: '0', missing: [] },
    { at: '2026-10-02T00:00:00.000Z', valueUsd: '1000', missing: [] },
    { at: '2026-10-03T00:00:00.000Z', valueUsd: null, missing: [{ assetId: 'SOL', reason: 'no_price' }] },
    { at: '2026-10-04T00:00:00.000Z', valueUsd: null, missing: [{ assetId: 'SOL', reason: 'no_price' }] },
  ],
  bridge: {
    openingUsd: '0',
    depositsUsd: '1000',
    withdrawalsUsd: '100',
    feesUsd: '3',
    otherFlowsUsd: '-20',
    marketMoveUsd: '-77',
    closingUsd: '800',
    missing: [],
  },
});

describe('value over time', () => {
  it('a missing moment is a gap in the line, never a drop to zero, and its coin is named once', () => {
    const chart = lineChart(valueLine(answer.points), 1000, 200)!;
    expect(chart.runs).toHaveLength(1);
    expect(chart.runs[0]!.map((p) => p.y)).toEqual(['200', '0']);
    expect(chart).toMatchObject({ low: '0', high: '1000' });
    expect(valueMissingOf(answer.points)).toEqual({ count: 2, coins: ['SOL'] });
  });

  it('reads the bridge in order, a withdrawal and a fee as what they take away, and the lines add up to the end', () => {
    const lines = BRIDGE_LEGS.map(({ leg, sign }) => [leg, signedLine(bridgeValue(answer.bridge, leg), sign)]);
    expect(lines).toEqual([
      ['opening', '0'],
      ['deposits', '1000'],
      ['withdrawals', '-100'],
      ['fees', '-3'],
      ['otherFlows', '-20'],
      ['marketMove', '-77'],
      ['closing', '800'],
    ]);
    const sum = lines.slice(0, -1).reduce((total, [, value]) => total + dec(value)!, 0n);
    expect(str(sum)).toBe('800');
    expect(signedLine(null, -1)).toBeNull();
  });
});
