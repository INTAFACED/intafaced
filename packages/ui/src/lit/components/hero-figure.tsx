/**
 * HeroFigure: the one large money figure a room is about (a total balance), drawn by Figure at the hero size. With
 * balances hidden it is a mask, read out by `hiddenLabel`; with no figure it is a dash read out by `unknownLabel`, never
 * a zero. It does not animate, so reduced motion needs nothing. The parts come from packages/i18n's *ToParts formatters,
 * from a decimal string: the kit never holds money in a number.
 */
import { clsx } from 'clsx';
import { Figure, type FigurePart } from './index.js';

export type HeroFigureProps = {
  /** The formatted figure, or null when there is none to show. */
  parts: readonly FigurePart[] | null;
  /** Balances hidden: the figure is masked. */
  hidden?: boolean;
  /** What a screen reader says for the mask ("Balance hidden"). */
  hiddenLabel: string;
  /** What a screen reader says for the dash ("Not available"). */
  unknownLabel: string;
  /** Illustrative figure: shows the TEST label. */
  test?: boolean;
  /** Older than its freshness limit: its age in words. */
  stale?: string;
  className?: string;
  'data-testid'?: string;
};

export const HIDDEN_MASK = '••••••';

export function HeroFigure({ parts, hidden, hiddenLabel, unknownLabel, test, stale, className, 'data-testid': testId }: HeroFigureProps) {
  if (hidden || parts === null)
    return (
      <span
        className={clsx('lit-figure', 'lit-hero', className)}
        data-slot="hero-figure"
        data-size="hero"
        data-hidden={hidden || undefined}
        data-unknown={!hidden || undefined}
        data-testid={testId}
        role="img"
        aria-label={hidden ? hiddenLabel : unknownLabel}
      >
        <span aria-hidden="true">{hidden ? HIDDEN_MASK : '—'}</span>
      </span>
    );
  return (
    <span className={clsx('lit-hero', className)} data-slot="hero-figure" data-testid={testId}>
      <Figure parts={parts} size="hero" test={test} stale={stale} />
    </span>
  );
}
