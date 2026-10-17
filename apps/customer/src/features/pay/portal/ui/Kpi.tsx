import type { ReactNode } from 'react';

/** The number of tiles a strip may show: fewer than four reads as a gap, more than eight as a wall. */
export const KPI_MIN = 4;
export const KPI_MAX = 8;

/**
 * A tile always names its period and opens the list that holds the same numbers. Both are required props, so a
 * tile without either does not compile. The link carries the exact filter in its address.
 */
export type KpiTileProps = {
  label: string;
  period: string;
  href: string;
  value: ReactNode;
  note?: ReactNode;
  tone?: 'attention';
  /** `text`: the value is a date or a few words, not a figure, so it is set smaller and cannot wrap over three lines. */
  size?: 'text';
};

export function KpiTile({ label, period, href, value, note, tone, size }: KpiTileProps) {
  return (
    <a className={`pp-kpi pp-kpi--link${tone ? ` pp-kpi--${tone}` : ''}`} href={href}>
      <span className="pp-kpi-label">
        {label}
        <em>{period}</em>
      </span>
      <strong className={`pp-kpi-value numeric${size === 'text' ? ' pp-kpi-value--text' : ''}`}>{value}</strong>
      {note && <small className="pp-kpi-note">{note}</small>}
    </a>
  );
}

export function KpiStrip({ label, tiles }: { label: string; tiles: readonly KpiTileProps[] }) {
  return (
    <div className="pp-kpis" role="group" aria-label={label}>
      {tiles.slice(0, KPI_MAX).map((tile) => (
        <KpiTile key={`${tile.label}:${tile.period}`} {...tile} />
      ))}
    </div>
  );
}
