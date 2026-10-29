import { describe, expect, it } from 'vitest';
import {
  breakdownFromQuery,
  dayOf,
  marketKey,
  missingOf,
  offsetMinutes,
  lineChart,
  pnlLinePoints,
  rangeFromQuery,
  rangeInputs,
  rangeKey,
  rangeSearch,
  resolveRange,
  type PnlPoint,
} from './pnl-time-model';

// Every figure is TEST data.
const NOW = Date.UTC(2026, 9, 24, 15, 30);
const point = (iso: string, totalUsd: string | null, missing: PnlPoint['missing'] = []): PnlPoint => ({
  at: iso,
  totalUsd,
  realizedUsd: totalUsd,
  unrealizedUsd: totalUsd === null ? null : '0',
  missing,
});

describe('rangeFromQuery', () => {
  it('reads a preset, two whole days, and refuses anything else', () => {
    expect(rangeFromQuery('')).toEqual({ kind: 'preset', range: '1M' });
    expect(rangeFromQuery('?range=1w')).toEqual({ kind: 'preset', range: '1W' });
    expect(rangeFromQuery('?range=ALL')).toEqual({ kind: 'preset', range: 'all' });
    expect(rangeFromQuery('?from=2026-10-01&to=2026-10-20')).toEqual({ kind: 'custom', fromDay: '2026-10-01', toDay: '2026-10-20' });
    expect(rangeFromQuery('?range=2Y')).toEqual({ kind: 'invalid' });
    expect(rangeFromQuery('?from=2026-10-20&to=2026-10-01')).toEqual({ kind: 'invalid' });
    expect(rangeFromQuery('?from=2026-10-01')).toEqual({ kind: 'invalid' });
    expect(rangeFromQuery('?from=2026-02-30&to=2026-03-01')).toEqual({ kind: 'invalid' });
  });

  it('keys a range by the range alone, not by the room’s other choices', () => {
    expect(rangeKey(rangeFromQuery('?range=1W&by=market'))).toBe(rangeKey(rangeFromQuery('?range=1W')));
    expect(rangeKey(rangeFromQuery('?view=realised'))).toBe('1M');
    expect(rangeKey(rangeFromQuery('?from=2026-10-01&to=2026-10-02'))).toBe('2026-10-01..2026-10-02');
  });

  it('keeps the room’s other choices in the link', () => {
    expect(rangeSearch('view=realised&range=1W', { range: '1M' })).toBe('view=realised');
    expect(rangeSearch('view=realised', { fromDay: '2026-10-01', toDay: '2026-10-02' })).toBe(
      'view=realised&from=2026-10-01&to=2026-10-02',
    );
    expect(rangeSearch('from=2026-10-01&to=2026-10-02', { range: '1D' })).toBe('range=1D');
  });
});

describe('resolveRange', () => {
  it('ends a preset now and runs a custom range from the first midnight to the end of the last day, in the customer zone', () => {
    expect(resolveRange({ kind: 'preset', range: '1D' }, NOW, 0, null)).toEqual({ from: '2026-10-23T15:30:00.000Z' });
    // UTC+8: 1 Oct starts at 30 Sep 16:00 UTC, and 2 Oct ends at 2 Oct 16:00 UTC.
    expect(resolveRange({ kind: 'custom', fromDay: '2026-10-01', toDay: '2026-10-02' }, NOW, 480, null)).toEqual({
      from: '2026-09-30T16:00:00.000Z',
      to: '2026-10-02T16:00:00.000Z',
    });
  });

  it('starts All on the customer day of the first trade, and asks nothing of an empty book', () => {
    expect(resolveRange({ kind: 'preset', range: 'all' }, NOW, -300, '2026-10-05T03:00:00.000Z')).toEqual({
      from: '2026-10-04T05:00:00.000Z',
    });
    expect(resolveRange({ kind: 'preset', range: 'all' }, NOW, 0, null)).toBeNull();
    expect(resolveRange({ kind: 'invalid' }, NOW, 0, null)).toBeNull();
  });

  it('keeps a preset start put when only the first trade or the zone arrives, and moves All and custom ranges with them', () => {
    const day = { kind: 'preset', range: '1D' } as const;
    const all = { kind: 'preset', range: 'all' } as const;
    const custom = { kind: 'custom', fromDay: '2026-10-01', toDay: '2026-10-02' } as const;
    expect(rangeInputs(day, 0, null)).toBe(rangeInputs(day, 480, '2026-10-05T03:00:00.000Z'));
    expect(rangeInputs(all, 0, null)).not.toBe(rangeInputs(all, 0, '2026-10-05T03:00:00.000Z'));
    expect(rangeInputs(all, 0, '2026-10-05T03:00:00.000Z')).not.toBe(rangeInputs(all, 480, '2026-10-05T03:00:00.000Z'));
    expect(rangeInputs(custom, 0, null)).toBe(rangeInputs(custom, 0, '2026-10-05T03:00:00.000Z'));
    expect(rangeInputs(custom, 0, null)).not.toBe(rangeInputs(custom, 480, null));
  });

  it('reads the zone the customer picked, else the device', () => {
    expect(offsetMinutes('UTC', NOW)).toBe(0);
    expect(offsetMinutes('UTC+8', NOW)).toBe(480);
    expect(offsetMinutes('device', NOW)).toBe(-new Date(NOW).getTimezoneOffset());
    expect(dayOf(NOW, 600)).toBe('2026-10-25');
  });
});

describe('lineChart', () => {
  const points = [
    point('2026-10-01T00:00:00.000Z', '-10'),
    point('2026-10-02T00:00:00.000Z', '30'),
    point('2026-10-03T00:00:00.000Z', null, [{ assetId: 'BTC', reason: 'no_price' }]),
    point('2026-10-04T00:00:00.000Z', '10'),
    point('2026-10-05T00:00:00.000Z', '20'),
  ];

  it('breaks the line at a missing point instead of drawing it at zero, and keeps time to scale', () => {
    const chart = lineChart(pnlLinePoints(points), 1000, 200)!;
    expect(chart.runs).toEqual([
      [
        { x: '0', y: '200' },
        { x: '250', y: '0' },
      ],
      [
        { x: '750', y: '100' },
        { x: '1000', y: '50' },
      ],
    ]);
    expect(chart.zeroY).toBe('150');
    expect(chart).toMatchObject({ low: '-10', high: '30' });
  });

  it('draws nothing with no known figure or no span of time', () => {
    expect(lineChart(pnlLinePoints([point('2026-10-01T00:00:00.000Z', null)]), 1000, 200)).toBeNull();
    expect(
      lineChart(pnlLinePoints([point('2026-10-01T00:00:00.000Z', null), point('2026-10-02T00:00:00.000Z', null)]), 1000, 200),
    ).toBeNull();
    expect(lineChart(pnlLinePoints([]), 1000, 200)).toBeNull();
  });

  it('a flat line sits in the middle', () => {
    const chart = lineChart(pnlLinePoints([point('2026-10-01T00:00:00.000Z', '5'), point('2026-10-02T00:00:00.000Z', '5')]), 1000, 200)!;
    expect(chart.runs[0]).toEqual([
      { x: '0', y: '100' },
      { x: '1000', y: '100' },
    ]);
    expect(chart.zeroY).toBeNull();
  });

  it('names each missing coin once', () => {
    const more = [
      ...points,
      point('2026-10-06T00:00:00.000Z', null, [
        { assetId: 'BTC', reason: 'no_price' },
        { assetId: 'ETH', reason: 'cost_unknown' },
      ]),
    ];
    expect(missingOf(more)).toEqual({
      count: 2,
      coins: [
        { assetId: 'BTC', reason: 'no_price' },
        { assetId: 'ETH', reason: 'cost_unknown' },
      ],
    });
  });
});

describe('breakdown keys', () => {
  it('reads a market, the held price move and a withdrawal', () => {
    expect(marketKey('BTC/USDT')).toEqual({ kind: 'market', market: 'BTC/USDT' });
    expect(marketKey('held')).toEqual({ kind: 'held' });
    expect(marketKey('moved:BTC')).toEqual({ kind: 'moved', assetId: 'BTC' });
    expect(marketKey('swap:ETH')).toEqual({ kind: 'swap', assetId: 'ETH' });
    expect(breakdownFromQuery('?by=day')).toBe('day');
    expect(breakdownFromQuery('?by=nope')).toBe('asset');
  });
});
