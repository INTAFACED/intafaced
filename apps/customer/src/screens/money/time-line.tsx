import { useMemo, useState, type PointerEvent } from 'react';
import { moneyCopy } from './copy';
import { Amount, fmtUsd } from './deps';
import { lineChart, type LinePoint } from './pnl-time-model';
import { stamp } from './time';
import { usePreferences } from '../../shared/preferences';

type Copy = ReturnType<typeof moneyCopy.useCopy>;

export const LINE_W = 1000;
export const LINE_H = 240;

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
  if (!chart) return <p className="money-note">{t('Pnl chart none')}</p>;
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
