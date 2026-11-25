import { useMemo, useState } from 'react';
import { AreaChart, Segmented, Skeleton } from '@intafaced/ui/lit/templates';
import { useValueOverTime } from '../money/pnl-source';
import { commandCopy } from './command-copy';
import { compareDecimal, dec, type HomeHolding } from './deps';
import { MaskedMoney } from './MaskedMoney';

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

export function ValueChart({ range }: { range: RangeKey }) {
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
  const first = points[0]!.value;
  const last = points.at(-1)!.value;
  const cmp = compareDecimal(last, first) ?? 0;
  return (
    <div className="hm-chart" data-testid="home-value-chart">
      <AreaChart
        soft
        live
        label={t('Your value over time, {range}', { range: t(range) })}
        points={points}
        asset="USD"
        tone={cmp > 0 ? 'up' : cmp < 0 ? 'down' : 'neutral'}
      />
    </div>
  );
}

/** Where the total sits, by coin: one bar in shares of the total and a legend with each part's value. */
export function Allocation({ holdings, hidden }: { holdings: readonly HomeHolding[]; hidden: boolean }) {
  const { t } = commandCopy.useCopy();
  const parts = useMemo(() => {
    const priced = holdings
      .map((h) => ({ asset: h.asset, usd: h.usdValue, cents: dec(h.usdValue) ?? 0n }))
      .filter((h) => h.cents > 0n)
      .sort((a, b) => (b.cents > a.cents ? 1 : b.cents < a.cents ? -1 : 0));
    const total = priced.reduce((sum, h) => sum + h.cents, 0n);
    if (total === 0n) return [];
    const top = priced.slice(0, 4);
    const rest = priced.slice(4);
    const restCents = rest.reduce((sum, h) => sum + h.cents, 0n);
    const shown = restCents > 0n ? [...top, { asset: t('Other'), usd: null as string | null, cents: restCents }] : top;
    // Shares for drawing only (the kit's rule: floats place pixels, never money).
    return shown.map((h) => ({ ...h, share: Number((h.cents * 10_000n) / total) / 100 }));
  }, [holdings, t]);
  if (parts.length === 0) return null;
  return (
    <div className="hm-mix" data-testid="home-mix">
      <div className="hm-mix-bar" role="img" aria-label={t('Where it sits')}>
        {parts.map((p, i) => (
          <i key={p.asset} data-tier={i} style={{ flexGrow: Math.max(p.share, 1.5) }} />
        ))}
      </div>
      <ul className="hm-mix-legend">
        {parts.map((p, i) => (
          <li key={p.asset}>
            <i data-tier={i} aria-hidden="true" />
            <span>{p.asset}</span>
            <b>{p.usd === null ? `${p.share.toFixed(0)}%` : <MaskedMoney usd={p.usd} hidden={hidden} />}</b>
          </li>
        ))}
      </ul>
    </div>
  );
}
