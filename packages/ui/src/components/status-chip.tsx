'use client';

import * as React from 'react';
import { cn } from './cn.js';
import { type Density, DEFAULT_DENSITY } from './density.js';
import { type AsOf, type Freshness, asOfIso, formatAsOf, freshnessOf } from './freshness.js';
import { useFreshnessClock } from './use-freshness-clock.js';

export type ChipShape = 'dot' | 'ring' | 'dashed' | 'slashed';

// Each kind has a colour, a shape and a word, so colour is never the only cue.
const look: Record<Freshness, { tone: string; shape: ChipShape; label: string }> = {
  live: { tone: 'text-accent-text', shape: 'dot', label: 'Live' },
  stale: { tone: 'text-warn', shape: 'ring', label: 'Stale' },
  unknown: { tone: 'text-fg-2', shape: 'dashed', label: 'Unknown' },
  refused: { tone: 'text-error-text', shape: 'slashed', label: 'Refused' },
};

function Shape({ shape }: { shape: ChipShape }) {
  const common = {
    'data-shape': shape,
    'aria-hidden': true,
    viewBox: '0 0 12 12',
    className: 'size-3 shrink-0',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
  } as const;
  switch (shape) {
    case 'dot':
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="3.5" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'ring':
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="4.5" />
          <path d="M6 3.5V6l1.75 1" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'dashed':
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="4.5" strokeDasharray="2 2" />
          <path d="M4.9 4.9a1.15 1.15 0 1 1 1.6 1.05c-.35.2-.5.4-.5.8" strokeLinecap="round" strokeWidth={1} />
          <circle cx="6" cy="8.6" r="0.55" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'slashed':
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="4.5" />
          <path d="M2.8 9.2 9.2 2.8" strokeLinecap="round" />
        </svg>
      );
  }
}

export interface StatusChipProps extends Omit<React.ComponentProps<'span'>, 'children'> {
  /** Fixed kind. If omitted it is derived from asOf / now / staleAfterMs / refused with freshnessOf. */
  kind?: Freshness;
  asOf?: AsOf;
  /** Epoch ms. Leave it out and the chip keeps its own clock and turns Stale by itself; pass it only for stable tests and screenshots, or if your screen re-renders on its own clock. */
  now?: number;
  staleAfterMs?: number | null;
  refused?: boolean;
  /** Replaces the default English words. */
  labels?: Partial<Record<Freshness, string>>;
  /** Draw "<Word> · as of 14:03:07" (needs a usable asOf). */
  showAsOf?: boolean;
  /** Replaces the English "as of" in the line above. */
  asOfLabel?: string;
  timeZone?: string;
  locale?: string;
  /** Why it is unknown or refused. Shown in the title and in an sr-only span (a title alone is not read reliably). */
  reason?: string;
  density?: Density;
}

/** Data-freshness chip: a shape plus a word (Live, Stale, Unknown, Refused). Announced politely as a status. */
export function StatusChip({
  kind,
  asOf,
  now,
  staleAfterMs,
  refused,
  labels,
  showAsOf = false,
  asOfLabel = 'as of',
  timeZone,
  locale,
  reason,
  density = DEFAULT_DENSITY,
  className,
  title,
  ...props
}: StatusChipProps) {
  const clock = useFreshnessClock({ asOf, now, staleAfterMs, refused, enabled: kind == null });
  const resolved: Freshness = kind ?? freshnessOf({ asOf, now: clock, staleAfterMs, refused });
  const l = look[resolved];
  const iso = showAsOf ? asOfIso(asOf) : null;
  const shown = iso ? formatAsOf(asOf, { timeZone, locale, now: clock }) : null;
  return (
    <span
      role="status"
      data-slot="status-chip"
      data-freshness={resolved}
      data-density={density}
      title={title ?? reason}
      className={cn('inline-flex items-center gap-1.5 whitespace-nowrap', density === 'dense' ? 'text-2xs' : 'text-xs', l.tone, className)}
      {...props}
    >
      <Shape shape={l.shape} />
      <span>
        <span data-part="word">{labels?.[resolved] ?? l.label}</span>
        {iso && shown ? (
          <span className="text-fg-2">
            {' · '}
            {asOfLabel}{' '}
            <time dateTime={iso} className="if-num tabular-nums">
              {shown}
            </time>
          </span>
        ) : null}
      </span>
      {reason ? <span className="sr-only">{reason}</span> : null}
    </span>
  );
}
