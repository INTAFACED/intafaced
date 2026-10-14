import { useMemo, useState } from 'react';
import { PreviewChip } from '../../../preview';
import { str, type Scaled } from '../../../data/decimal';
import type { PerpContract } from '../../../preview/fixtures/futures';
import { futuresCopy } from './copy';
import { d } from './math';
import { priceCell } from './show';

const W = 800;
const H = 320;
const RANGES = [
  { id: '6h', candles: 24 },
  { id: '12h', candles: 48 },
  { id: '24h', candles: 96 },
] as const;
type RangeId = (typeof RANGES)[number]['id'];

export interface ChartLine {
  readonly id: 'mark' | 'entry' | 'liq';
  readonly price: Scaled;
}

/** Candles from the sample series drawn as SVG. Pixel coordinates come from bigint division, never from a float price. */
export function Chart({ contract, lines }: { contract: PerpContract; lines: readonly ChartLine[] }) {
  const { t } = futuresCopy.useCopy();
  const [range, setRange] = useState<RangeId>('24h');
  const count = RANGES.find((r) => r.id === range)!.candles;

  const geometry = useMemo(() => {
    const candles = contract.candles.slice(-count).map((c) => ({ o: d(c.open), h: d(c.high), l: d(c.low), c: d(c.close) }));
    let lo = candles.reduce((m, c) => (c.l < m ? c.l : m), candles[0]!.l);
    let hi = candles.reduce((m, c) => (c.h > m ? c.h : m), candles[0]!.h);
    const pad = (hi - lo) / 12n;
    lo -= pad;
    hi += pad;
    // A line that falls outside the candles' range is dropped rather than squashing the chart.
    const visible = lines.filter((line) => line.price >= lo && line.price <= hi);
    const span = hi - lo === 0n ? 1n : hi - lo;
    const y = (value: Scaled) => Number(((hi - value) * BigInt(H)) / span);
    const step = W / candles.length;
    const bodies = candles.map((c, i) => {
      const x = i * step + step / 2;
      const top = y(c.o > c.c ? c.o : c.c);
      const bottom = y(c.o > c.c ? c.c : c.o);
      return { x, w: Math.max(2, step * 0.62), up: c.c >= c.o, top, height: Math.max(1, bottom - top), wickTop: y(c.h), wickBottom: y(c.l) };
    });
    const grid = Array.from({ length: 5 }, (_, i) => {
      const value = hi - (span * BigInt(i + 1)) / 6n;
      return { y: y(value), label: priceCell(str(value), contract.tick) };
    });
    return { bodies, grid, lines: visible.map((line) => ({ ...line, y: y(line.price) })) };
  }, [contract, count, lines]);

  return (
    <section className="fx-panel fx-chart" aria-labelledby="fx-chart-title">
      <header className="fx-panel__head">
        <h2 className="fx-panel__title" id="fx-chart-title">
          {t('Chart')} <PreviewChip />
        </h2>
        <div className="fx-range" role="group" aria-label={t('Chart range')}>
          {RANGES.map((r) => (
            <button key={r.id} type="button" className="fx-range__btn" aria-pressed={range === r.id} onClick={() => setRange(r.id)}>
              {r.id}
            </button>
          ))}
        </div>
      </header>
      <div className="fx-chart__plot">
        <svg
          className="fx-chart__svg"
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={t('Chart label', { contract: `${contract.id}`, hours: range })}
        >
          {geometry.grid.map((g) => (
            <line key={g.y} className="fx-chart__grid" x1={0} x2={W} y1={g.y} y2={g.y} />
          ))}
          {geometry.bodies.map((b) => (
            <g key={b.x} className={b.up ? 'fx-candle fx-candle--up' : 'fx-candle fx-candle--down'}>
              <line x1={b.x} x2={b.x} y1={b.wickTop} y2={b.wickBottom} />
              <rect x={b.x - b.w / 2} y={b.top} width={b.w} height={b.height} />
            </g>
          ))}
          {geometry.lines.map((line) => (
            <line key={line.id} className={`fx-chart__line fx-chart__line--${line.id}`} x1={0} x2={W} y1={line.y} y2={line.y} />
          ))}
        </svg>
        <ul className="fx-chart__scale" aria-hidden="true">
          {geometry.grid.map((g) => (
            <li key={g.y} style={{ top: `${(g.y / H) * 100}%` }}>
              {g.label}
            </li>
          ))}
        </ul>
        {geometry.lines.map((line) => (
          <span key={line.id} className={`fx-chart__tag fx-chart__tag--${line.id}`} style={{ top: `${(line.y / H) * 100}%` }}>
            {t(line.id === 'mark' ? 'Mark' : line.id === 'entry' ? 'Entry' : 'Liquidation')} {priceCell(str(line.price), contract.tick)}
          </span>
        ))}
      </div>
      <p className="fx-chart__foot">{t('Chart foot', { hours: range })}</p>
    </section>
  );
}
