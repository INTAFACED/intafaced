import { useMemo, useState, type ReactNode } from 'react';
import { AreaChart, Segmented, Skeleton } from '@intafaced/ui/lit/templates';
import { useValueOverTime } from '../money/pnl-source';
import { commandCopy } from './command-copy';
import { HIDDEN_MASK } from '@intafaced/ui/lit';
import { dec, fmtUsd } from './deps';

/**
 * Home's value over time (the owner's Home A): the bank's own replay of what the account was worth
 * (`bank.portfolio.valueOverTime`, the same source as Money's value over time). Never a made-up line: no history draws an
 * honest empty line, an unreadable history says so, and points with no price are left out of the line, not drawn at zero.
 */
const RANGES = [
  { key: '1D', hours: 24 },
  { key: '1W', hours: 24 * 7 },
  { key: '1M', hours: 24 * 30 },
  { key: '1Y', hours: 24 * 365 },
  // All: five years back; the line starts where the account first held anything (the empty start is not drawn).
  { key: 'All', hours: 24 * 365 * 5 },
] as const;
type RangeKey = (typeof RANGES)[number]['key'];

/** The range's start, on the minute, so the read is shared and stable while the page is open. */
const fromOf = (hours: number) => new Date(Math.floor((Date.now() - hours * 3_600_000) / 60_000) * 60_000).toISOString();

export function ValueRanges({ range, onRange }: { range: RangeKey; onRange: (range: RangeKey) => void }) {
  const { t } = commandCopy.useCopy();
  return (
    <Segmented
      label={t('Value range')}
      options={RANGES.map((r) => ({ value: r.key, label: t(r.key) }))}
      value={range}
      onChange={(value) => onRange(value as RangeKey)}
    />
  );
}

export function useValueRange() {
  return useState<RangeKey>('1D');
}

export function ValueChart({ range, hidden }: { range: RangeKey; hidden: boolean }) {
  const { t } = commandCopy.useCopy();
  const hours = RANGES.find((r) => r.key === range)!.hours;
  const from = useMemo(() => fromOf(hours), [hours]);
  const value = useValueOverTime({ from });
  if (value.status === 'loading')
    return (
      <div className="hm-chart" aria-busy="true">
        <Skeleton shape="chart" />
      </div>
    );
  if (value.status === 'error' || value.status === 'refused')
    return (
      <ChartFrame testId="home-value-down">
        <p>{t('Value chart down')}</p>
      </ChartFrame>
    );
  const all =
    value.status === 'ready' ? value.data.points.flatMap((p) => (p.valueUsd === null ? [] : [{ at: p.at, value: p.valueUsd }])) : [];
  // Before the account held anything the line is not drawn: the history starts at its first non-zero point.
  const start = all.findIndex((p) => (dec(p.value) ?? 0n) !== 0n);
  const points = start < 0 ? [] : all.slice(start);
  if (points.length < 2)
    return (
      <ChartFrame testId="home-value-empty">
        <p>{t('Value chart empty')}</p>
      </ChartFrame>
    );
  return (
    <div className="hm-chart" data-testid="home-value-chart">
      <AreaChart
        soft
        live
        grid
        tone="ink"
        marker={hidden ? HIDDEN_MASK : fmtUsd(points.at(-1)!.value)}
        label={t('Your value over time, {range}', { range: t(range) })}
        points={points}
        asset="USD"
      />
    </div>
  );
}

/** The chart's frame with no line in it: the same size as the chart, its guide lines, and the honest words in the middle. */
function ChartFrame({ testId, children }: { testId: string; children: ReactNode }) {
  return (
    <div className="hm-chart hm-chart-note" data-testid={testId}>
      <svg className="hm-chart-flat" viewBox="0 0 600 200" preserveAspectRatio="none" aria-hidden="true">
        <path d="M0,50 L600,50 M0,100 L600,100 M0,150 L600,150" vectorEffect="non-scaling-stroke" />
      </svg>
      {children}
    </div>
  );
}
