'use client';

import * as React from 'react';
import { cn } from './cn.js';
import { type Density, DEFAULT_DENSITY } from './density.js';
import { type AsOf, type Freshness, freshnessOf } from './freshness.js';
import { ChangeText, Money } from './numbers.js';
import { Skeleton } from './skeleton.js';
import { StatusChip } from './status-chip.js';
import { useFreshnessClock } from './use-freshness-clock.js';

export type StatSize = 'sm' | 'md' | 'lg';

// Value text size and its exact line height (24 / 28 / 28 px), so the loading skeleton matches.
const valueSize: Record<StatSize, { text: string; height: string }> = {
  sm: { text: 'text-md', height: 'h-6' },
  md: { text: 'text-lg', height: 'h-7' },
  lg: { text: 'text-xl', height: 'h-7' },
};

export interface StatProps extends Omit<React.ComponentProps<'div'>, 'children'> {
  label: string;
  /** Pre-formatted text. null = unknown: draws the dash, never 0. */
  value: string | null;
  unit?: string;
  hint?: string;
  /** Pre-formatted signed change ("+1.24%"); the sign decides colour and glyph. */
  delta?: string | null;
  /** When given (or when refused), a StatusChip with the as-of time is drawn under the value. */
  asOf?: AsOf;
  /** Epoch ms. Leave it out and the figure re-checks itself and turns Stale by itself; pass it only for stable tests and screenshots, or if your screen re-renders on its own clock. */
  now?: number;
  staleAfterMs?: number | null;
  refused?: boolean;
  /** Why the figure is unknown or refused, for the chip title and screen readers. */
  reason?: string;
  labels?: Partial<Record<Freshness, string>>;
  timeZone?: string;
  locale?: string;
  size?: StatSize;
  density?: Density;
  align?: 'start' | 'end';
  /** Mask the value (and delta) while "hide balances" is on, using HideBalancesProvider. */
  sensitive?: boolean;
  loading?: boolean;
}

/** One headline figure with its label, optional change and optional data-freshness chip. */
export function Stat({
  label,
  value,
  unit,
  hint,
  delta,
  asOf,
  now,
  staleAfterMs,
  refused,
  reason,
  labels,
  timeZone,
  locale,
  size = 'md',
  density = DEFAULT_DENSITY,
  align = 'start',
  sensitive = false,
  loading = false,
  className,
  ...props
}: StatProps) {
  const id = React.useId();
  const labelId = `${id}-label`;
  const hintId = `${id}-hint`;
  const hasFreshness = !loading && (asOf != null || refused === true);
  const clock = useFreshnessClock({ asOf, now, staleAfterMs, refused, enabled: hasFreshness });
  const freshness = hasFreshness ? freshnessOf({ asOf, now: clock, staleAfterMs, refused }) : undefined;
  const dense = density === 'dense';
  const v = valueSize[size];
  return (
    <div
      role="group"
      aria-labelledby={labelId}
      aria-describedby={hint ? hintId : undefined}
      aria-busy={loading || undefined}
      data-slot="stat"
      data-density={density}
      data-size={size}
      data-state={loading ? 'loading' : undefined}
      data-freshness={freshness}
      className={cn(
        'flex min-w-0 flex-col',
        dense ? 'gap-0.5' : 'gap-1',
        align === 'end' ? 'items-end text-right' : 'items-start',
        className,
      )}
      {...props}
    >
      <span id={labelId} className={cn('text-fg-2', dense ? 'text-2xs' : 'text-xs')}>
        {label}
      </span>
      {loading ? (
        <Skeleton className={cn(v.height, 'w-24')} />
      ) : (
        <div className={cn('flex items-baseline gap-1.5', align === 'end' && 'justify-end')}>
          <Money value={value} sensitive={sensitive} className={cn(v.text, 'font-medium')} />
          {unit ? <span className={cn('text-fg-2', dense ? 'text-sm' : 'text-base')}>{unit}</span> : null}
        </div>
      )}
      {!loading && delta != null ? <ChangeText value={delta} sensitive={sensitive} className={dense ? 'text-sm' : 'text-base'} /> : null}
      {hint ? (
        <span id={hintId} className="text-xs text-fg-2">
          {hint}
        </span>
      ) : null}
      {hasFreshness ? (
        <StatusChip
          asOf={asOf}
          now={now}
          staleAfterMs={staleAfterMs}
          refused={refused}
          reason={reason}
          labels={labels}
          timeZone={timeZone}
          locale={locale}
          showAsOf
          density={density}
        />
      ) : null}
    </div>
  );
}
