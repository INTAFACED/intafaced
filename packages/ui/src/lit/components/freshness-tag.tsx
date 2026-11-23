/**
 * FreshnessTag: how fresh the figures on screen are, as a kit tag with a word (Live, Stale, Unknown, Refused) and,
 * when live or stale, the time they are as of. It turns Stale by itself when a feed stops (`useFreshnessClock`).
 * Announced politely as a status; a reason (why unknown or refused) is in its title and read to assistive tech.
 * Words arrive as props.
 */
import * as React from 'react';
import { type AsOf, asOfIso, formatAsOf, freshnessOf, type Freshness } from '../../components/freshness.js';
import { useFreshnessClock } from '../../components/use-freshness-clock.js';

const TONE: Record<Freshness, 'up' | 'neutral' | 'down'> = { live: 'up', stale: 'neutral', unknown: 'neutral', refused: 'down' };

export interface FreshnessTagProps {
  asOf: AsOf;
  staleAfterMs: number;
  refused?: boolean;
  words: Record<Freshness, string>;
  /** "as of", before the time. */
  asOfLabel: string;
  timeZone?: string;
  locale?: string;
  reason?: string;
}

export function FreshnessTag({ asOf, staleAfterMs, refused, words, asOfLabel, timeZone, locale, reason }: FreshnessTagProps) {
  const now = useFreshnessClock({ asOf, staleAfterMs, refused });
  const kind = freshnessOf({ asOf, now, staleAfterMs, refused });
  const iso = kind === 'live' || kind === 'stale' ? asOfIso(asOf) : null;
  const shown = iso ? formatAsOf(asOf, { timeZone, locale, now }) : null;
  return (
    <span role="status" className="lit-tag" data-tone={TONE[kind]} data-freshness={kind} title={reason}>
      <span data-part="word">{words[kind]}</span>
      {iso && shown ? (
        <span>
          {asOfLabel}{' '}
          <time dateTime={iso} className="lt-num">
            {shown}
          </time>
        </span>
      ) : null}
      {reason ? <span className="lt-sr">{reason}</span> : null}
    </span>
  );
}
