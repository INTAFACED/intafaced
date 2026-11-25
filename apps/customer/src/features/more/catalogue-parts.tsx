import type { ReactNode } from 'react';
import { Button } from '@intafaced/ui/lit';
import { Text } from './copy';

/**
 * The More rooms' shared form and list parts (`./common`'s Limit and Details) for the catalogue rooms
 * on the kit (intafaced issue 9566): the same words and order, drawn only from the kit's `lt-` classes.
 */

/** Format integer basis points as an exact percentage string without float rounding (100 -> "1", 25 -> "0.25"). */
export function formatBpsPercent(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const frac = Math.abs(bps % 100);
  if (frac === 0) return String(whole);
  const decimals = String(frac).padStart(2, '0').replace(/0+$/, '');
  return `${bps < 0 ? '-' : ''}${Math.abs(whole)}.${decimals}`;
}

/** How many rows one read returned when at the limit, with a wider read while the cap allows one. */
export function Limit({ count, limit, cap, onChange }: { count: number; limit: number; cap: number; onChange: (limit: number) => void }) {
  if (count < limit) return null;
  return (
    <div className="lt-toolbar">
      <small className="lt-hint">
        <Text k="common.showing" />
        {count}
        <Text k="common.requested.limit" />
        {limit}
        <Text k="common.this.service.publishes.no.continuation.cursor" />
      </small>
      {count >= limit && limit < cap ? (
        <Button tone="secondary" onClick={() => onChange(Math.min(cap, limit + 50))}>
          <Text k="common.load.a.larger.window" />
        </Button>
      ) : count >= cap ? (
        <small className="lt-hint">
          <Text k="common.the.published.limit.is" />
          {cap}
          <Text k="common.older.rows.cannot.be.requested.here" />
        </small>
      ) : null}
    </div>
  );
}

/** Label and value rows. A value is a node, so a row keeps the hooks a journey finds it by. */
export function Details({ items }: { items: readonly [string, ReactNode][] }) {
  return (
    <dl className="lt-kv">
      {items.map(([label, value], index) => (
        <div key={index}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
