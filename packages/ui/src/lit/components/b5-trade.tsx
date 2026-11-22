/**
 * Four parts the buy and convert cards need that the sheet lacked: a coin's mark, a disclosure (a question and its
 * answer, or a note behind a small control), a progress bar and the TEST label. Each reads only lit roles through
 * `components.css`; every word arrives as a prop. Names and meanings are in `../contracts.ts`.
 */
import * as React from 'react';
import { clsx } from 'clsx';
import { coinArt } from '../../components/coins/coin-art.generated.js';

export type CoinMarkProps = Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'> & {
  /** Ticker, any case: BTC, ETH, USDT, USDC. A coin without artwork gets its first letter in a circle. */
  asset: string;
  /** `sm` for field rows, `md` (default) for list rows. */
  size?: 'sm' | 'md';
};

/** A coin's mark beside its ticker. Decoration only: the ticker beside it is what names the coin. */
export function CoinMark({ asset, size = 'md', className, ...rest }: CoinMarkProps) {
  const key = asset.toUpperCase();
  const svg = coinArt[key];
  return (
    <span
      {...rest}
      aria-hidden="true"
      className={clsx('lit-coin', className)}
      data-asset={key}
      data-size={size}
      data-fallback={svg ? undefined : 'lettered'}
    >
      {/* The artwork is the kit's own generated SVG (coins/manifest.json), never text from a service. */}
      {svg ? <span data-part="art" dangerouslySetInnerHTML={{ __html: svg }} /> : key.charAt(0)}
    </span>
  );
}

export type DisclosureProps = Omit<React.DetailsHTMLAttributes<HTMLElement>, 'children'> & {
  /** What the control says: a question, or a small mark with `summaryLabel` as its name. */
  summary: React.ReactNode;
  /** The control's accessible name when `summary` is a mark rather than words. */
  summaryLabel?: string;
  /** `row` (default): one question of a list, full width. `inline`: a small control beside a line. */
  variant?: 'row' | 'inline';
  children: React.ReactNode;
};

/** A question and its answer, or a note behind a small control: a native details element, so it works by keyboard. */
export function Disclosure({ summary, summaryLabel, variant = 'row', className, children, ...rest }: DisclosureProps) {
  return (
    <details {...rest} className={clsx('lit-disclosure', className)} data-variant={variant}>
      <summary aria-label={summaryLabel}>{summary}</summary>
      <div data-part="panel">{children}</div>
    </details>
  );
}

export type ProgressProps = Omit<React.ProgressHTMLAttributes<HTMLProgressElement>, 'value' | 'max' | 'children'> & {
  /** What it measures, as its accessible name. */
  label: string;
  value: number;
  max: number;
  /** The value in words ("12s"), read out in place of a percentage. */
  valueText?: string;
};

/** How far along something is (the time left on a held price): a native progress bar. */
export function Progress({ label, value, max, valueText, className, ...rest }: ProgressProps) {
  return (
    <progress {...rest} className={clsx('lit-progress', className)} aria-label={label} aria-valuetext={valueText} value={value} max={max} />
  );
}

/** The TEST label an illustrative or TEST-venue figure carries. Its word comes from the room's copy (default TEST). */
export function TestLabel({ children = 'TEST', className, ...rest }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span {...rest} className={clsx('lit-test', className)}>
      {children}
    </span>
  );
}
