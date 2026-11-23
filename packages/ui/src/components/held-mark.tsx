'use client';

import * as React from 'react';
import { cn } from './cn.js';
import type { HeldState } from './freshness.js';

// Each state has a shape, a word and a tone, so colour is never the only cue, and two holders' figures read apart
// side by side under one header. Known is quiet: its time is enough.
const look: Record<HeldState, { tone: string; label: string | null }> = {
  known: { tone: 'text-fg-2', label: null },
  stale: { tone: 'text-warn', label: 'Stale' },
  unknown: { tone: 'text-fg-2', label: 'Not known' },
  transit: { tone: 'text-accent-text', label: 'In transit' },
};

function Shape({ state }: { state: HeldState }) {
  const common = {
    'data-shape': state,
    'aria-hidden': true,
    viewBox: '0 0 12 12',
    className: 'size-3 shrink-0',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
  } as const;
  switch (state) {
    case 'known':
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="3" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'stale':
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="4.5" />
          <path d="M6 3.5V6l1.75 1" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'unknown':
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="4.5" strokeDasharray="2 2" />
          <path d="M4.9 4.9a1.15 1.15 0 1 1 1.6 1.05c-.35.2-.5.4-.5.8" strokeLinecap="round" strokeWidth={1} />
          <circle cx="6" cy="8.6" r="0.55" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'transit':
      return (
        <svg {...common} className="size-3 shrink-0 rtl:-scale-x-100">
          <path d="M1.5 6h8M7 3.25 9.75 6 7 8.75" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
  }
}

export interface HeldMarkProps extends Omit<React.ComponentProps<'span'>, 'children'> {
  state: HeldState;
  /** The figure's as-of time as ISO text, for the <time> element. Not drawn for "not known". */
  asOf?: string | null;
  /** The as-of time as the screen words it ("As of 17 Oct 2026, 14:03:07"). Defaults to the ISO text. */
  asOfText?: string;
  /** Replaces the English words (Stale, Not known, In transit). */
  labels?: Partial<Record<HeldState, string>>;
  /** For money in transit: where it left and where it is going, as the screen words them ("From X to Y"). */
  route?: string;
  /** Extra props for the <time> element (a test id). */
  timeProps?: Omit<React.ComponentProps<'time'>, 'dateTime' | 'children'>;
}

/**
 * The state of one holder's figure: known with its as-of time; stale, still with its time; not known (said in words,
 * never an empty or zero figure); in transit between two holders. Use it beside the figure, or in its place when the
 * figure is not known.
 */
export function HeldMark({ state, asOf, asOfText, labels, route, timeProps, className, ...props }: HeldMarkProps) {
  const l = look[state];
  const word = labels?.[state] ?? l.label;
  const time = state !== 'unknown' && asOf ? asOf : null;
  return (
    <span data-slot="held-mark" data-held={state} className={cn('inline-flex items-center gap-1.5 text-xs', l.tone, className)} {...props}>
      <Shape state={state} />
      <span>
        {word ? <span data-part="word">{word}</span> : null}
        {state === 'transit' && route ? (
          <span data-part="route">
            {' · '}
            {route}
          </span>
        ) : null}
        {time ? (
          <span className="text-fg-2">
            {word ? ' · ' : null}
            <time dateTime={time} className="if-num tabular-nums" {...timeProps}>
              {asOfText ?? time}
            </time>
          </span>
        ) : null}
      </span>
    </span>
  );
}
