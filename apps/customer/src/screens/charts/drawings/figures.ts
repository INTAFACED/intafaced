/**
 * The figures of a drawing as text lines, for the object tree: the levels of a Fibonacci tool, the risk and reward of a
 * position box, the bars, price difference and span of a measure. Every number comes from the stored points through
 * `geometry.ts` (decimal arithmetic at the tick size). A refusal is a line too, so the person sees why there is no figure.
 */
import {
  EXTENSION_LEVELS,
  extensionPrices,
  FIB_LEVELS,
  gannSlopes,
  measureFigures,
  positionFigures,
  retracementPrices,
  type Refusal,
} from './geometry';
import type { Drawing } from './model';

export type FigureLabel = (key: string, vars?: Record<string, string>) => string;

export function figureLines(d: Drawing, tick: string, indexOf: (time: number) => number, t: FigureLabel): string[] {
  const [a, b, c] = d.points;
  if (!a) return [];
  switch (d.kind) {
    case 'fib':
    case 'fibExtension': {
      const levels =
        d.kind === 'fib'
          ? b
            ? retracementPrices(a, b, d.levels ?? FIB_LEVELS, tick)
            : 'bad-price'
          : c
            ? extensionPrices(a, b!, c, d.levels ?? EXTENSION_LEVELS, tick)
            : 'bad-price';
      if (typeof levels === 'string') return [refusalLine(levels, t)];
      return levels.map((l) => t('Figure level', { level: l.level, price: l.price }));
    }
    case 'long':
    case 'short': {
      if (!b || !c) return [];
      const figures = positionFigures(d.kind, a, b, c, tick);
      if (typeof figures === 'string') return [refusalLine(figures, t)];
      return [
        t('Figure risk', { value: figures.risk, pct: figures.riskPct }),
        t('Figure reward', { value: figures.reward, pct: figures.rewardPct }),
        t('Figure ratio', { value: figures.ratio }),
        t('Position box note'),
      ];
    }
    case 'measure':
    case 'info': {
      if (!b) return [];
      const figures = measureFigures(a, b, tick, indexOf);
      if (typeof figures === 'string') return [refusalLine(figures, t)];
      return [
        t('Figure bars', { count: String(figures.bars) }),
        t('Figure diff', { value: figures.priceDiff }),
        t('Figure pct', { value: figures.pct ?? '' }),
        t('Figure span', { value: figures.span }),
      ];
    }
    case 'gannFan': {
      if (!b) return [];
      const slopes = gannSlopes(a, b, tick, indexOf);
      if (typeof slopes === 'string') return [refusalLine(slopes, t)];
      return slopes.map((s) => t('Figure gann', { ratio: s.ratio, slope: s.slope }));
    }
    default:
      return [];
  }
}

/** A figure that cannot be computed says why, in the same words as a refused placement. */
function refusalLine(reason: Refusal, t: FigureLabel): string {
  return t(`Refused ${reason}`);
}
