/**
 * The beta's page layout: one wide grid every first-party screen sits in, so landing, home, markets, money and
 * sign-up share one width, one gutter and one rhythm, matching the owner's picked landing and home references:
 *
 * - the page fills the screen up to 150rem, with a gutter that grows from 1rem on a phone to 2.5rem;
 * - under 64rem of its own width everything is one column; from 64rem the layout's columns apply;
 * - from 125rem of screen (2000 px, an ultra-wide) the page draws a step larger, so 2560 reads like 1440 does
 *   instead of a narrow strip in the middle (`scale="off"` keeps it 1:1, for a desk that wants the extra room).
 *
 * The grid measures its own box (a container), so it lays out the same inside the shell's rail or without it.
 */
import * as React from 'react';
import { clsx } from 'clsx';

type Div = React.HTMLAttributes<HTMLDivElement>;

/**
 * `split`: a main column and a side column, 8 to 4 (home: net worth and the table, then the next step and widgets).
 * `hero`: 5 to 7, words beside a live panel (landing's value line beside the markets table).
 * `even`: two equal columns (a form beside its summary). `full`: one column the full width (a list room).
 */
export type PageLayout = 'split' | 'hero' | 'even' | 'full';

export type PageGridProps = Div & {
  layout?: PageLayout;
  /** `off` keeps the page 1:1 on an ultra-wide screen. */
  scale?: 'auto' | 'off';
};

/** The page: its width, gutter and columns. Its direct children are the columns (`PageColumn`) or full-width bands. */
export function PageGrid({ layout = 'full', scale = 'auto', className, children, ...rest }: PageGridProps) {
  return (
    <div className="lt-page" data-scale={scale}>
      <div {...rest} className={clsx('lt-page-grid', className)} data-layout={layout}>
        {children}
      </div>
    </div>
  );
}

/** One column of the page: panels stacked with the page's gap. `span="all"` makes a band across every column. */
export function PageColumn({ span, className, ...rest }: Div & { span?: 'all' }) {
  return <div {...rest} className={clsx('lt-page-col', className)} data-span={span} />;
}

/**
 * A row of equal tiles that wraps by width: what's moving, the trust strip, the stat row. `min` is the narrowest a
 * tile may get before the row wraps: `narrow` 11rem (a stat), `card` 14rem (a market tile; on a phone the row swipes
 * sideways instead), `wide` 18rem (a note).
 */
export function TileRow({ min = 'card', className, ...rest }: Div & { min?: 'narrow' | 'card' | 'wide' }) {
  return <div {...rest} className={clsx('lt-tile-row', className)} data-min={min} />;
}

/**
 * A panel's head: its title at the start, an aside at the end (tabs, a link, "Live, TEST prices"). The title is a
 * heading at `level` (default 2) so the page's outline reads in order.
 */
export function PanelHead({
  title,
  aside,
  level = 2,
  className,
  ...rest
}: Omit<Div, 'title'> & { title: React.ReactNode; aside?: React.ReactNode; level?: 2 | 3 }) {
  const H = level === 2 ? 'h2' : 'h3';
  return (
    <div {...rest} className={clsx('lt-panel-head', className)} data-part="panel-head">
      <H className="lt-panel-title">{title}</H>
      {aside === undefined ? null : <div className="lt-panel-aside">{aside}</div>}
    </div>
  );
}
