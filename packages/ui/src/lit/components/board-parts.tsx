/**
 * The board a markets screen opens on: one market large with its day, then what's moving; and the quiet parts around
 * a list (a toolbar's end slot, a footnote line).
 *
 * - `MarketBoard`: the board's panels in a column, sitting on the page (a template region it fills draws no panel).
 * - `MarketHero`: one market large: chips to pick it, its mark and name, the price at the big-figure size, its move,
 *   one action, its figures, and its day's chart beside them (under them on a phone, where the figures fold away).
 * - `MarketBoardSkeleton`: the board at its final size while the markets load.
 * - `ToolbarEnd`: the end of an `lt-toolbar` (a search), a whole row on a phone.
 * - `FootNotes`: short quiet lines under a list (what is not offered here, and why).
 * - `StarToggle`: a market's favourite star, grey when off and white when on (lime is the main action's alone).
 *
 * No copy here: every word arrives as a prop. Figures arrive formatted, never as numbers.
 */
import * as React from 'react';
import { clsx } from 'clsx';
import { AssetIcon } from './asset-icon.js';
import { TileRow } from './page-grid.js';
import { Star } from 'lucide-react';
import { Price } from './b2-values.js';

type Div = React.HTMLAttributes<HTMLDivElement>;

/** The board's panels in a column, with the page's section gap; the region it fills draws no panel of its own. */
export function MarketBoard({ className, ...rest }: Div) {
  return <div {...rest} className={clsx('lt-market-board', className)} />;
}

export interface MarketHeroProps extends Omit<React.HTMLAttributes<HTMLElement>, 'title'> {
  /** The section's name for a screen reader ("BTC/USDC today"). */
  label: string;
  /** Chips that choose which market is shown (ToggleChips), above its name. */
  picks?: React.ReactNode;
  /** The base asset, for its mark. */
  asset: string;
  /** The market's symbol, bold (BTC/USDC, BTC-PERP). */
  symbol: React.ReactNode;
  /** A tag beside the symbol (Spot, 40x). */
  tag?: React.ReactNode;
  /** The asset's name, quieter under the symbol. */
  name?: React.ReactNode;
  /** The price, formatted. */
  price: string;
  /** The move (the kit's Pct) and its words ("in 24h"). */
  change: React.ReactNode;
  /** The one action (ButtonLink). */
  action?: React.ReactNode;
  /** The market's figures as label and formatted value; folded away on a phone. */
  stats: ReadonlyArray<readonly [label: string, value: string]>;
  /** The chart's caption ("Price, last 24 hours"); folded away on a phone. */
  chartTitle: React.ReactNode;
  /** The chart (AreaChart soft, tone ink: lime is the main action's alone), or the words for none. */
  chart: React.ReactNode;
}

/** One market large, with its day beside it. */
export function MarketHero({
  label,
  picks,
  asset,
  symbol,
  tag,
  name,
  price,
  change,
  action,
  stats,
  chartTitle,
  chart,
  className,
  ...rest
}: MarketHeroProps) {
  return (
    <section {...rest} className={clsx('lt-market-hero', className)} aria-label={label}>
      <div className="lt-market-hero-main">
        {picks ? <div className="lt-market-hero-picks">{picks}</div> : null}
        <div className="lt-market-hero-name">
          <AssetIcon asset={asset} size="md" />
          <span className="lt-market-hero-pair">
            <span className="lt-market-name">
              <strong>{symbol}</strong>
              {tag}
            </span>
            {name ? <span className="lt-market-hero-dim">{name}</span> : null}
          </span>
        </div>
        <p className="lt-market-hero-price" dir="ltr">
          <Price value={price} cents />
        </p>
        <p className="lt-market-hero-change">{change}</p>
        {action ? <div className="lt-market-hero-go">{action}</div> : null}
        <dl className="lt-market-hero-stats">
          {stats.map(([statLabel, value]) => (
            <div key={statLabel}>
              <dt>{statLabel}</dt>
              <dd dir="ltr">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="lt-market-hero-chart">
        <span className="lt-market-hero-dim" data-part="chart-title">
          {chartTitle}
        </span>
        {chart}
      </div>
    </section>
  );
}

/** Quieter words inside a hero or a board's head (the asset's name, "in 24h", "No price history"). */
export function Dim({ children }: { children: React.ReactNode }) {
  return <span className="lt-market-hero-dim">{children}</span>;
}

/** The board at its final size while the markets load: the hero and a row of `tiles` movers, so nothing moves. */
export function MarketBoardSkeleton({ tiles = 6, className, ...rest }: Div & { tiles?: number }) {
  return (
    <div {...rest} className={clsx('lt-market-board', className)} aria-hidden="true">
      <div className="lt-market-hero lt-market-bone-block" data-size="hero" />
      <TileRow min="card">
        {Array.from({ length: tiles }, (_, index) => (
          <div key={index} className="lt-mover lt-market-bone-block" data-size="tile" />
        ))}
      </TileRow>
    </div>
  );
}

/** The end of a toolbar (`lt-toolbar`): pushed to the end, a whole row on a phone. */
export function ToolbarEnd({ className, ...rest }: Div) {
  return <div {...rest} className={clsx('lt-toolbar-end', className)} />;
}

/** Short quiet lines under a list; each child is an `li`. */
export function FootNotes({ className, ...rest }: React.HTMLAttributes<HTMLUListElement>) {
  return <ul {...rest} className={clsx('lt-footnotes', className)} />;
}

export type StarToggleProps =
  | { label: string; href: string; on?: undefined; onToggle?: undefined }
  | { label: string; on: boolean; onToggle: () => void; href?: undefined };

/** A market's favourite star: a link to sign in, or a pressed/unpressed button; grey when off, white when on. */
export function StarToggle(props: StarToggleProps) {
  if (props.href !== undefined)
    return (
      <a className="lt-star" href={props.href} aria-label={props.label}>
        <Star size={16} aria-hidden="true" />
      </a>
    );
  return (
    <button type="button" className="lt-star" aria-pressed={props.on} aria-label={props.label} onClick={props.onToggle}>
      <Star size={16} aria-hidden="true" fill={props.on ? 'currentColor' : 'none'} />
    </button>
  );
}
