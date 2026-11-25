/**
 * The front pages' shared parts: a navigation link drawn as the kit's button, the display headline and section title,
 * the live dot, a strip of equal cells under hairlines, and the featured market tile. No copy here: every word arrives
 * as a prop. Figures arrive formatted, never as numbers.
 */
import * as React from 'react';
import { clsx } from 'clsx';
import { AssetIcon } from './asset-icon.js';
import { AreaChart, type Point } from './b2-charts.js';
import { Pct, Price } from './b2-values.js';

/** A link that looks like the kit's Button (a call to action that goes somewhere: Create account, All markets). */
export function ButtonLink({
  tone = 'secondary',
  size = 'md',
  block,
  className,
  ...rest
}: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
  tone?: 'primary' | 'secondary' | 'quiet';
  size?: 'sm' | 'md' | 'lg';
  block?: boolean;
}) {
  return (
    <a
      {...rest}
      className={clsx('lit-button', className)}
      data-slot="button"
      data-variant={tone === 'quiet' ? 'ghost' : tone}
      data-tone={tone}
      data-size={size}
      data-block={block || undefined}
    />
  );
}

/**
 * The page's display headline: the wide face, very large, tight. `second` is a second line drawn dimmed ("One
 * account."). An h1 by default.
 */
export function Display({
  children,
  second,
  as: Tag = 'h1',
  className,
}: {
  children: React.ReactNode;
  second?: React.ReactNode;
  as?: 'h1' | 'h2';
  className?: string;
}) {
  return (
    <Tag className={clsx('lt-display', className)}>
      <span className="lt-display-line">{children}</span>
      {second !== undefined ? <span className="lt-display-line lt-display-second">{second}</span> : null}
    </Tag>
  );
}

/** A section's title on a front page (What's moving; Trade, hold, pay and build): the wide face, a step under Display. */
export function SectionTitle({ children, as: Tag = 'h2', className }: { children: React.ReactNode; as?: 'h2' | 'h3'; className?: string }) {
  return <Tag className={clsx('lt-section-title', className)}>{children}</Tag>;
}

/** A small glowing dot in the up colour beside its words ("Live prices"); `off` draws it grey for stale data. */
export function LiveDot({ children, off }: { children: React.ReactNode; off?: boolean }) {
  return (
    <span className="lt-live-mark" data-off={off || undefined}>
      <span className="lt-live-mark-dot" aria-hidden="true" />
      {children}
    </span>
  );
}

export interface StripCell {
  key: string;
  title: React.ReactNode;
  /** A badge beside the title (the kit's Tag with a warn tone for "Placeholder"). */
  badge?: React.ReactNode;
  body: React.ReactNode;
}

/** Equal cells in one panel, divided by hairlines: the trust strip (reserves, licences, passkeys, fees). */
export function TrustStrip({ cells, label }: { cells: readonly StripCell[]; label?: string }) {
  return (
    <ul className="lt-strip" aria-label={label}>
      {cells.map((c) => (
        <li key={c.key}>
          <span className="lt-strip-head">
            <span className="lt-strip-title">{c.title}</span>
            {c.badge}
          </span>
          <span className="lt-strip-body">{c.body}</span>
        </li>
      ))}
    </ul>
  );
}

/** A warn-toned pill for a value that is not real yet ("Placeholder"). */
export function WarnBadge({ children }: { children: React.ReactNode }) {
  return <span className="lt-warn-badge">{children}</span>;
}

export interface FeaturedMarketProps {
  symbol: string;
  /** Its name or pair, quieter beside the symbol. */
  name?: string;
  price: string | null;
  change: string | null;
  /** The recent closes for the chart; fewer than two draw no chart. */
  points?: readonly Point[];
  /** The chart's name for a screen reader. */
  chartLabel: string;
  /** The asset the chart's values are in (USD). */
  asset: string;
  href?: string;
}

/** The busiest market in a sunken tile: its mark and name, the price large, its change, and its chart filling the end. */
export function FeaturedMarket({ symbol, name, price, change, points, chartLabel, asset, href }: FeaturedMarketProps) {
  const dir = change?.trim().startsWith('+') ? 'up' : change?.trim().match(/^[−-]/) ? 'down' : 'neutral';
  const body = (
    <>
      <span className="lt-featured-figure">
        <span className="lt-featured-name">
          <AssetIcon asset={symbol} size="sm" />
          <span className="lt-market-symbol">{symbol}</span>
          {name ? <span className="lt-market-full">{name}</span> : null}
        </span>
        <Price className="lt-featured-price" value={price} />
        <Pct value={change} />
      </span>
      <span className="lt-featured-chart">
        {points && points.length > 1 ? <AreaChart soft fit tone={dir} label={chartLabel} asset={asset} points={points} /> : null}
      </span>
    </>
  );
  return href ? (
    <a className="lt-featured" href={href}>
      {body}
    </a>
  ) : (
    <div className="lt-featured">{body}</div>
  );
}
