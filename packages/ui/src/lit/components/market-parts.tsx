/**
 * The market parts several beta screens share, so landing's markets panel, home's watchlist, the markets screen and
 * the movers row draw one market the same way: its mark, symbol and name; its price, 24h change, 7-day line and
 * volume, figures end-aligned in tabular digits.
 *
 * - `MarketTable`: the kit's Table with the market columns; rows open the market's desk; a row action (Trade) at the end.
 * - `MoverTile`: one market as a tile (symbol and change, price, its line), for what's moving.
 *
 * No copy here: every word arrives as a prop. Figures arrive formatted (by `packages/i18n`), never as numbers.
 */
import * as React from 'react';
import { clsx } from 'clsx';
import { AssetIcon } from './asset-icon.js';
import { Sparkline } from './b2-charts.js';
import { Table, type Column, type DataMarks } from './b2-table.js';
import { Pct, Price } from './b2-values.js';
import type { DecimalString } from '../templates/types.js';

export interface MarketRow {
  /** The market's id (BTC-USD); the row's key. */
  id: string;
  /** The base asset's ticker, for its mark and the bold symbol (BTC). */
  symbol: string;
  /** Its name, quieter beside the symbol (Bitcoin). */
  name?: string;
  /** Formatted price, or null when unknown (drawn as a dash). */
  price: string | null;
  /** Formatted signed 24h change ("+1.84%"), or null. */
  change: string | null;
  /** The last 7 days' closes, oldest first, for the line; fewer than two draw nothing. */
  trend?: readonly DecimalString[];
  /** Formatted 24h volume ("$41.2B"), or null. */
  volume?: string | null;
  /** Where the row opens (the market's desk). */
  href?: string;
}

export interface MarketTableLabels {
  /** The table's accessible name. */
  caption: string;
  market: string;
  price: string;
  change: string;
  /** The 7-day line's header; with no `trend` on any row the column is left out. */
  trend?: string;
  /** With no `volume` on any row the column is left out. */
  volume?: string;
  /** A screen reader's name for a row's line: given the row, says what it shows ("BTC, last 7 days"). */
  trendLabel?: (row: MarketRow) => string;
}

export interface MarketTableProps {
  labels: MarketTableLabels;
  rows: readonly MarketRow[];
  /** A control at the end of each row (a Trade link); shown on hover on a computer, always on a phone. */
  action?: (row: MarketRow) => React.ReactNode;
  /** The action column's header, said to assistive tech only. */
  actionLabel?: string;
  /** Loading: this many placeholder rows hold the table's shape. */
  loadingRows?: number;
  /** Shown in the body when there are no rows. */
  empty?: React.ReactNode;
  rowMarks?: (row: MarketRow) => DataMarks;
  mode?: 'simple' | 'pro';
}

const PLACEHOLDER = (i: number): MarketRow => ({ id: `placeholder-${i}`, symbol: '', price: null, change: null });

/** The market's naming cell: its mark, the symbol in bold, the name quieter beside it. */
export function MarketName({ symbol, name }: { symbol: string; name?: string }) {
  return (
    <span className="lt-market-name">
      {symbol === '' ? <span className="lt-market-bone" aria-hidden="true" /> : <AssetIcon asset={symbol} />}
      <span className="lt-market-symbol">{symbol}</span>
      {name ? <span className="lt-market-full">{name}</span> : null}
    </span>
  );
}

export function MarketTable({ labels, rows, action, actionLabel, loadingRows, empty, rowMarks, mode }: MarketTableProps) {
  const loading = loadingRows !== undefined && loadingRows > 0 && rows.length === 0;
  const shown = loading ? Array.from({ length: loadingRows }, (_, i) => PLACEHOLDER(i)) : rows;
  const hasTrend = labels.trend !== undefined && (loading || rows.some((r) => (r.trend?.length ?? 0) > 1));
  const hasVolume = labels.volume !== undefined && (loading || rows.some((r) => r.volume != null));
  const columns: Column<MarketRow>[] = [
    { key: 'market', label: labels.market, cell: (r) => <MarketName symbol={r.symbol} name={r.name} /> },
    { key: 'price', label: labels.price, align: 'end', cell: (r) => (loading ? null : <Price value={r.price} />) },
    { key: 'change', label: labels.change, align: 'end', cell: (r) => (loading ? null : <Pct value={r.change} />) },
  ];
  if (hasTrend)
    columns.push({
      key: 'trend',
      label: labels.trend ?? '',
      align: 'end',
      cell: (r) =>
        r.trend && r.trend.length > 1 ? (
          <Sparkline size="row" values={r.trend} label={labels.trendLabel?.(r) ?? r.symbol} tone={toneOf(r.change)} />
        ) : null,
    });
  if (hasVolume)
    columns.push({
      key: 'volume',
      label: labels.volume ?? '',
      align: 'end',
      cell: (r) => (loading ? null : <Price value={r.volume ?? null} />),
    });
  if (action)
    columns.push({
      key: 'action',
      label: actionLabel ?? '',
      align: 'end',
      cell: (r) => (loading ? null : <span className="lt-market-action">{action(r)}</span>),
    });
  const anyHref = !loading && rows.some((r) => r.href !== undefined);
  return (
    <div className="lt-market-table" data-loading={loading || undefined}>
      <Table
        caption={labels.caption}
        columns={columns}
        rows={shown}
        rowKey={(r) => r.id}
        rowHref={anyHref ? (r) => r.href ?? '#' : undefined}
        empty={empty}
        rowMarks={rowMarks}
        busy={loading}
        mode={mode}
      />
    </div>
  );
}

function toneOf(change: string | null): 'up' | 'down' | 'neutral' {
  const t = change?.trim() ?? '';
  if (t.startsWith('+')) return 'up';
  if (t.startsWith('−') || t.startsWith('-')) return 'down';
  return 'neutral';
}

export interface MoverTileProps {
  symbol: string;
  /** The quote side, drawn quieter after the symbol ("/USDT"), so two pairs of one coin never read as one market. */
  quote?: string;
  price: string | null;
  change: string | null;
  trend?: readonly DecimalString[];
  /** A screen reader's name for the line. */
  trendLabel?: string;
  href?: string;
  className?: string;
}

/** One market as a tile: symbol and change on top, the price large, its line under it. A link when `href` is given. */
export function MoverTile({ symbol, quote, price, change, trend, trendLabel, href, className }: MoverTileProps) {
  const body = (
    <>
      <span className="lt-mover-top">
        <span>
          <span className="lt-market-symbol">{symbol}</span>
          {quote ? <span className="lt-market-full">/{quote}</span> : null}
        </span>
        <Pct value={change} />
      </span>
      <Price className="lt-mover-price" value={price} cents />
      {trend && trend.length > 1 ? <Sparkline values={trend} label={trendLabel ?? symbol} tone={toneOf(change)} size="row" /> : null}
    </>
  );
  return href ? (
    <a className={clsx('lt-mover', className)} href={href}>
      {body}
    </a>
  ) : (
    <div className={clsx('lt-mover', className)}>{body}</div>
  );
}

export interface StatCell {
  key: string;
  label: React.ReactNode;
  /** Formatted figure, or words when there is none ("Side empty"); null draws the dash. */
  value: React.ReactNode | null;
  /** Up or down colours the figure; its sign must already be in the text. */
  tone?: 'up' | 'down';
  /** A figure in tabular digits, kept left to right; false for words. Default true. */
  num?: boolean;
  'data-testid'?: string;
}

/**
 * A row of label-over-figure pairs under hairline dividers: a desk's contract and risk strips, a header's 24h figures,
 * home's small totals. It wraps by width; `dense` is the desk's size.
 */
export function StatStrip({
  cells,
  label,
  dense,
  className,
}: {
  cells: readonly StatCell[];
  label?: string;
  dense?: boolean;
  className?: string;
}) {
  return (
    <dl className={clsx('lt-stat-strip', className)} aria-label={label} data-dense={dense || undefined}>
      {cells.map((c) => (
        <div key={c.key}>
          <dt>{c.label}</dt>
          <dd
            className={c.num === false ? undefined : 'lt-num'}
            data-direction={c.tone}
            dir={c.num === false ? undefined : 'ltr'}
            data-testid={c['data-testid']}
          >
            {c.value ?? '—'}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export interface MarketHeaderProps {
  /** The base asset's ticker, for its mark. */
  asset: string;
  /** The market's name as the venue lists it (BTC-PERP, PURR/USDC). */
  symbol: string;
  /** Quieter beside the symbol (Bitcoin perpetual). */
  name?: string;
  /** Beside the symbol: the TEST tag, a leverage badge. */
  badges?: React.ReactNode;
  /** Formatted last price, or null when there is no print. */
  price: string | null;
  /** Formatted signed 24h change, or null when the venue publishes none (then nothing is drawn). */
  change: string | null;
  /** The rest of the line: best bid and ask, mark, funding, volume. */
  stats?: readonly StatCell[];
  /** At the end: the as-of time, a favourite star. */
  aside?: React.ReactNode;
  /** The header's accessible name ("Market"). */
  label: string;
  priceTestId?: string;
  dense?: boolean;
  'data-testid'?: string;
}

/**
 * The line at the top of a market (the desk and the markets room): its mark, symbol and badges; the last price large
 * with its 24h change; then its figures as a stat strip, and an aside at the end.
 */
export function MarketHeader({
  asset,
  symbol,
  name,
  badges,
  price,
  change,
  stats,
  aside,
  label,
  priceTestId,
  dense,
  'data-testid': testId,
}: MarketHeaderProps) {
  return (
    <section className="lt-market-header" aria-label={label} data-dense={dense || undefined} data-testid={testId}>
      <span className="lt-market-header-id">
        <AssetIcon asset={asset} />
        <span className="lt-market-symbol">{symbol}</span>
        {name ? <span className="lt-market-full">{name}</span> : null}
        {badges}
      </span>
      <span className="lt-market-header-price">
        <Price className="lt-market-header-last" value={price} cents={!dense} data-testid={priceTestId} />
        {/* An unpublished change is left out, never drawn as a dash beside the price. */}
        {change !== null ? <Pct value={change} arrow /> : null}
      </span>
      {stats && stats.length > 0 ? <StatStrip cells={stats} dense /> : null}
      {aside !== undefined ? <span className="lt-market-header-aside">{aside}</span> : null}
    </section>
  );
}

export interface MarketTileProps {
  /** The market as the venue lists it ("BTC-USD", "PURR/USDC"). */
  symbol: string;
  /** Formatted last price, or null when the venue publishes none (then no price line is drawn). */
  price: string | null;
  /** Formatted signed 24h change, or null when the venue publishes none (then nothing is drawn). */
  change: string | null;
  /** The market the desk is on now. */
  selected?: boolean;
  onSelect?: () => void;
  className?: string;
  'data-testid'?: string;
}

/**
 * One market in a desk's strip of pairs: a flat tile with the symbol and its 24h change on top and the last price under
 * them, pressed to switch the desk to it. A figure the venue does not publish is left out, never drawn as a dash.
 */
export function MarketTile({ symbol, price, change, selected, onSelect, className, 'data-testid': testId }: MarketTileProps) {
  return (
    <button
      type="button"
      className={clsx('lt-market-tile', className)}
      aria-pressed={selected ?? false}
      onClick={onSelect}
      data-testid={testId}
    >
      <span className="lt-market-tile-top">
        <span className="lt-market-symbol">{symbol}</span>
        {change !== null ? <Pct value={change} /> : null}
      </span>
      {price !== null ? <Price className="lt-market-tile-price" value={price} cents /> : null}
    </button>
  );
}
