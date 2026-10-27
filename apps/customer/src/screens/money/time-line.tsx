import { useMemo, useState, type PointerEvent } from 'react';
import { moneyCopy } from './copy';
import { Amount, Button, fmtUsd, navigate } from './deps';
import { PNL_RANGES, dayOf, lineChart, rangeFromQuery, rangeSearch, type LinePoint, type PnlRange } from './pnl-time-model';
import { stamp } from './time';
import { usePreferences } from '../../shared/preferences';

type Copy = ReturnType<typeof moneyCopy.useCopy>;

export const LINE_W = 1000;
export const LINE_H = 240;

const RANGE_COPY: Record<PnlRange, 'Range 1D' | 'Range 1W' | 'Range 1M' | 'Range 1Y' | 'Range all'> = {
  '1D': 'Range 1D',
  '1W': 'Range 1W',
  '1M': 'Range 1M',
  '1Y': 'Range 1Y',
  all: 'Range all',
};

export const INTERVAL_COPY: Record<
  '5m' | '1h' | '4h' | '1d' | '1w',
  'Point every 5m' | 'Point every 1h' | 'Point every 4h' | 'Point every 1d' | 'Point every 1w'
> = {
  '5m': 'Point every 5m',
  '1h': 'Point every 1h',
  '4h': 'Point every 4h',
  '1d': 'Point every 1d',
  '1w': 'Point every 1w',
};

export function go(search: string) {
  navigate(`/money/pnl${search === '' ? '' : `?${search}`}`, true);
}

/** The preset switch and the two dates of a custom range. Both live in the link, like the result view. */
export function RangePicker({ search, offset, copy }: { search: string; offset: number; copy: Copy }) {
  const { t } = copy;
  const ask = rangeFromQuery(search);
  const today = dayOf(Date.now(), offset);
  const [fromDay, setFromDay] = useState(ask.kind === 'custom' ? ask.fromDay : '');
  const [toDay, setToDay] = useState(ask.kind === 'custom' ? ask.toDay : today);
  const ready = fromDay !== '' && toDay !== '' && fromDay <= toDay;
  return (
    <div className="money-pnl-range">
      <div className="money-alloc__switch" role="group" aria-label={t('Pnl range')}>
        {PNL_RANGES.map((option) => (
          <button
            key={option}
            type="button"
            className="money-alloc__opt"
            aria-pressed={ask.kind === 'preset' && ask.range === option}
            onClick={() => go(rangeSearch(search, { range: option }))}
          >
            {t(RANGE_COPY[option])}
          </button>
        ))}
      </div>
      <form
        className="money-pnl-range__dates"
        aria-label={t('Pnl custom range')}
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) go(rangeSearch(search, { fromDay, toDay }));
        }}
      >
        <label className="money-note-form__label">
          {t('Range from')}{' '}
          <input
            type="date"
            className="money-note-form__input"
            value={fromDay}
            max={today}
            onChange={(event) => setFromDay(event.target.value)}
          />
        </label>
        <label className="money-note-form__label">
          {t('Range to')}{' '}
          <input
            type="date"
            className="money-note-form__input"
            value={toDay}
            max={today}
            onChange={(event) => setToDay(event.target.value)}
          />
        </label>
        <Button type="submit" variant="secondary" size={40} disabled={!ready}>
          {t('Show range')}
        </Button>
      </form>
    </div>
  );
}

/**
 * A line over time (J-portfolio-05 #4 and #7). Time runs along the bottom, so a missing stretch is a gap of its real
 * width, never a drop to zero. Hovering names the nearest point; the table under each line carries every point for
 * anyone who cannot see it.
 */
export function TimeLine({
  points,
  from,
  to,
  label,
  chart: id,
  signed,
  hidden,
  copy,
}: {
  points: readonly LinePoint[];
  from: string;
  to: string;
  label: string;
  chart: string;
  /** A result shows its sign (+/−); a value does not. */
  signed: boolean;
  hidden: boolean;
  copy: Copy;
}) {
  const { t } = copy;
  const { timeZone } = usePreferences();
  const chart = useMemo(() => lineChart(points, LINE_W, LINE_H), [points]);
  const [hover, setHover] = useState<number | null>(null);
  const t0 = Date.parse(points[0]?.at ?? '');
  const span = Date.parse(points[points.length - 1]?.at ?? '') - t0;
  const usd = (value: string) => fmtUsd(value, { showPlus: signed });
  const pick = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width <= 0 || !(span > 0)) return;
    const at = t0 + ((event.clientX - box.left) / box.width) * span;
    let best = 0;
    points.forEach((point, index) => {
      if (Math.abs(Date.parse(point.at) - at) < Math.abs(Date.parse(points[best]!.at) - at)) best = index;
    });
    setHover(best);
  };
  const focus = hover === null ? null : points[hover]!;
  if (!chart)
    return (
      <p data-testid="money-note" className="money-note">
        {t('Pnl chart none')}
      </p>
    );
  return (
    <figure className="money-pnl-chart">
      <div className="money-pnl-chart__plot">
        <svg
          viewBox={`0 0 ${LINE_W} ${LINE_H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={label}
          data-chart={id}
          onPointerMove={pick}
          onPointerLeave={() => setHover(null)}
        >
          {chart.zeroY !== null ? (
            <line
              x1="0"
              x2={LINE_W}
              y1={chart.zeroY}
              y2={chart.zeroY}
              stroke="var(--if-line-stronger)"
              strokeDasharray="6 6"
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
          {chart.runs.map((run, index) =>
            run.length === 1 ? (
              <line
                key={index}
                x1={run[0]!.x}
                x2={run[0]!.x}
                y1={run[0]!.y}
                y2={run[0]!.y}
                stroke="var(--if-lime)"
                strokeWidth="8"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
                data-run={index}
              />
            ) : (
              <polyline
                key={index}
                points={run.map((p) => `${p.x},${p.y}`).join(' ')}
                fill="none"
                stroke="var(--if-lime)"
                strokeWidth="2"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
                data-run={index}
              />
            ),
          )}
          {focus && span > 0 ? (
            <line
              x1={String(Math.round(((Date.parse(focus.at) - t0) / span) * LINE_W))}
              x2={String(Math.round(((Date.parse(focus.at) - t0) / span) * LINE_W))}
              y1="0"
              y2={LINE_H}
              stroke="var(--if-line-stronger)"
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
        </svg>
        {focus ? (
          <p className="money-pnl-chart__tip" role="status" data-at={focus.at}>
            {stamp(focus.at, timeZone)}: {focus.usd === null ? t('Pnl point missing') : <Amount value={usd(focus.usd)} hidden={hidden} />}
          </p>
        ) : null}
      </div>
      <figcaption className="money-pnl-chart__axis">
        <span>{stamp(from, timeZone)}</span>
        <span>
          {t('Pnl chart low')} <Amount value={usd(chart.low)} hidden={hidden} /> · {t('Pnl chart high')}{' '}
          <Amount value={usd(chart.high)} hidden={hidden} />
        </span>
        <span>{stamp(to, timeZone)}</span>
      </figcaption>
    </figure>
  );
}
