import type { ReactNode, HTMLAttributes } from 'react';

/**
 * CONSOLE / HUD PRIMITIVES (§3 Phase 0 deliverable).
 *
 * Panel · Ticker · RankBadge · StatBlock · LobbyCard.
 *
 * These are structural, not decorative: they carry the semantics every surface
 * shares (live state, direction, rank tier) so a trading terminal and an academy
 * lobby read as the same machine. Styling lives in tokens.css; components emit
 * class names and data attributes, never inline hex.
 */

type Direction = 'up' | 'down' | 'flat';

function cx(...values: Array<string | false | undefined | null>): string {
  return values.filter(Boolean).join(' ');
}

/** Direction from a signed change — the one place the comparison is written. A decimal string is read by its sign and
 * digits, never through a float, so `0.000…01` past seventeen digits still reads as up. */
export function directionOf(change: number | string): Direction {
  if (typeof change === 'number') {
    if (!Number.isFinite(change) || change === 0) return 'flat';
    return change > 0 ? 'up' : 'down';
  }
  const m = /^\s*([+\-\u2212])?(\d*)(?:\.(\d*))?\s*%?\s*$/.exec(change);
  if (!m || (!m[2] && !m[3]) || /^0*$/.test(`${m[2]}${m[3] ?? ''}`)) return 'flat';
  return m[1] === '-' || m[1] === '\u2212' ? 'down' : 'up';
}

// ── Panel ────────────────────────────────────────────────────────────────────

export interface PanelProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title?: ReactNode;
  /** Rendered at the right of the header — filters, timeframe switches. */
  actions?: ReactNode;
  /** Streaming or otherwise live; gets the accent bloom. */
  live?: boolean;
  children: ReactNode;
}

export function Panel({ title, actions, live = false, children, className, ...rest }: PanelProps) {
  return (
    <section className={cx('if-panel', className)} data-live={live} {...rest}>
      {(title || actions) && (
        <header className="if-panel__header">
          {title && <h2 className="if-panel__title">{title}</h2>}
          {actions}
        </header>
      )}
      <div className="if-panel__body">{children}</div>
    </section>
  );
}

// ── Ticker ───────────────────────────────────────────────────────────────────

export interface TickerProps extends HTMLAttributes<HTMLSpanElement> {
  symbol: string;
  /** Pre-formatted. Formatting is the caller's job — it knows the asset's precision. */
  price: string;
  /** Signed percentage change, e.g. "+2.41" or -0.87. */
  change?: number | string;
  changeLabel?: string;
}

export function Ticker({ symbol, price, change, changeLabel, className, ...rest }: TickerProps) {
  const direction = change === undefined ? 'flat' : directionOf(change);
  const label = changeLabel ?? (change === undefined ? undefined : `${direction === 'up' ? '+' : ''}${change}%`);

  return (
    <span className={cx('if-ticker', className)} {...rest}>
      <span className="if-ticker__symbol">{symbol}</span>
      <span className="if-ticker__price">{price}</span>
      {label && (
        <span className="if-ticker__change" data-direction={direction}>
          {label}
        </span>
      )}
    </span>
  );
}

// ── RankBadge ────────────────────────────────────────────────────────────────

export interface RankBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  rank: number;
  /** Optional title, e.g. "Operator". Falls back to the bare rank. */
  title?: string;
  /** Elite ranks get the bloom treatment. */
  tier?: 'standard' | 'elite';
}

export function RankBadge({ rank, title, tier = 'standard', className, ...rest }: RankBadgeProps) {
  return (
    <span className={cx('if-rank', className)} data-tier={tier} {...rest}>
      <span className="if-rank__number">{rank}</span>
      {title && <span>{title}</span>}
    </span>
  );
}

// ── StatBlock ────────────────────────────────────────────────────────────────

export interface StatBlockProps extends HTMLAttributes<HTMLDivElement> {
  label: ReactNode;
  /** Pre-formatted value. Balances arrive as decimal strings and stay strings. */
  value: ReactNode;
  delta?: number | string;
  deltaLabel?: string;
}

export function StatBlock({ label, value, delta, deltaLabel, className, ...rest }: StatBlockProps) {
  const direction = delta === undefined ? 'flat' : directionOf(delta);

  return (
    <div className={cx('if-stat', className)} {...rest}>
      <span className="if-stat__label">{label}</span>
      <span className="if-stat__value">{value}</span>
      {(delta !== undefined || deltaLabel) && (
        <span className="if-stat__delta" data-direction={direction}>
          {deltaLabel ?? `${direction === 'up' ? '+' : ''}${delta}`}
        </span>
      )}
    </div>
  );
}

// ── LobbyCard ────────────────────────────────────────────────────────────────

export interface LobbyCardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title: ReactNode;
  host?: ReactNode;
  /** Occupancy — `capacity` omitted means uncapped. */
  occupancy?: number;
  capacity?: number | null;
  live?: boolean;
  /** free · staked · invite (§8.3 capacity tiers). */
  access?: 'free' | 'staked' | 'invite';
  footer?: ReactNode;
}

export function LobbyCard({ title, host, occupancy, capacity, live = false, access = 'free', footer, className, ...rest }: LobbyCardProps) {
  return (
    <article className={cx('if-lobby', className)} data-live={live} data-access={access} {...rest}>
      <span className="if-lobby__status">
        <span className="if-lobby__pulse" aria-hidden="true" />
        {live ? 'Live' : 'Scheduled'}
      </span>

      <h3 className="if-lobby__title">{title}</h3>

      <div className="if-lobby__meta">
        {host && <span>{host}</span>}
        {occupancy !== undefined && <span>{capacity ? `${occupancy}/${capacity}` : `${occupancy} in room`}</span>}
        <span>{access}</span>
      </div>

      {footer}
    </article>
  );
}
