import { useMemo, useState } from 'react';
import { AreaChart, Parts, Segmented, Skeleton, sumDecimals } from '@intafaced/ui/lit/templates';
import { useValueOverTime } from '../money/pnl-source';
import { commandCopy } from './command-copy';
import { HIDDEN_MASK } from '@intafaced/ui/lit';
import { compareDecimal, dec, fmtUsd, type HomeHolding } from './deps';

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
      <div className="hm-chart hm-chart-note" data-testid="home-value-down">
        <p>{t('Value chart down')}</p>
      </div>
    );
  const points =
    value.status === 'ready' ? value.data.points.flatMap((p) => (p.valueUsd === null ? [] : [{ at: p.at, value: p.valueUsd }])) : [];
  const moved = points.some((p) => (dec(p.value) ?? 0n) !== 0n);
  if (points.length < 2 || !moved)
    return (
      <div className="hm-chart hm-chart-note" data-testid="home-value-empty">
        <svg className="hm-chart-flat" viewBox="0 0 600 200" preserveAspectRatio="none" aria-hidden="true">
          <path d="M8,180 L592,180" vectorEffect="non-scaling-stroke" />
        </svg>
        <p>{t('Value chart empty')}</p>
      </div>
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

/**
 * Where the total sits, by coin: the kit's parts bar with its legend on one row. The four largest coins by value, the
 * rest as Other; every amount stays a decimal string (the kit draws the bar and reconciles the parts to the total).
 */
export function Allocation({ holdings, hidden }: { holdings: readonly HomeHolding[]; hidden: boolean }) {
  const { t } = commandCopy.useCopy();
  const priced = useMemo(
    () =>
      holdings
        .flatMap((h) => (h.usdValue !== null && (compareDecimal(h.usdValue, '0') ?? 0) > 0 ? [{ label: h.asset, value: h.usdValue }] : []))
        .sort((a, b) => compareDecimal(b.value, a.value) ?? 0),
    [holdings],
  );
  if (priced.length === 0) return null;
  return (
    <div data-testid="home-mix">
      <Parts
        label={t('Where it sits')}
        total={sumDecimals(priced.map((p) => p.value))}
        parts={priced.slice(0, 4)}
        asset="USD"
        otherLabel={t('Other')}
        hidden={hidden}
        legend="row"
      />
    </div>
  );
}
