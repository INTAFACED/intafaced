'use client';

import { useEffect, useState } from 'react';
import { fetchRatingSummary } from '@/lib/support/browser';
import { SCORES, WINDOW_DAYS, averageScore, formatShare, ratingWindow, type WindowDays } from '@/lib/support/ratings';
import type { SupportRatingSummaryView } from '@/lib/support/types';
import { formatWhen } from '@/lib/as-of';
import { Failed } from './support-action-parts';

/**
 * CUSTOMER RATINGS — read-only, staff only.
 *
 * Covers the requests that are resolved or closed now and last changed inside the window you pick. The window is
 * stated on the card; the service has no default. With no ratings it says zero responses and shows no average or
 * percentage. A rating is a record of the request, never a score without real responses.
 */

export interface RatingsSummaryViewProps {
  readonly days: WindowDays;
  readonly onDays: (days: WindowDays) => void;
  readonly view: SupportRatingSummaryView | null;
  readonly loading: boolean;
}

export function RatingsSummaryView({ days, onDays, view, loading }: RatingsSummaryViewProps) {
  const part = view?.summary;
  const summary = part?.kind === 'ok' ? part.data : null;
  const average = summary ? averageScore(summary) : null;
  return (
    <section className="dk-stack" aria-label="Customer ratings" data-testid="ratings-summary">
      <h4>Customer ratings</h4>
      <p className="dk-muted">
        Requests solved in the window you pick (resolved or closed now, last changed inside it). Only support staff see this.
      </p>
      <div className="dk-row" role="group" aria-label="Window">
        {WINDOW_DAYS.map((d) => (
          <button key={d} type="button" className="adm-btn" aria-pressed={days === d} onClick={() => onDays(d)} disabled={loading}>
            Last {d} days
          </button>
        ))}
      </div>
      {!view ? (
        <p className="dk-muted">{loading ? 'Reading…' : 'svc-support could not be read. Nothing is shown rather than a guess.'}</p>
      ) : part?.kind === 'failed' ? (
        <Failed name="Customer ratings" part={part} />
      ) : summary ? (
        <>
          <p className="dk-muted" data-testid="ratings-window">
            {formatWhen(summary.from)} to {formatWhen(summary.to)}
          </p>
          <dl className="dk-kv">
            <dt>Requests solved</dt>
            <dd data-testid="ratings-solved">{summary.solved}</dd>
            <dt>Responses</dt>
            <dd data-testid="ratings-responses">{summary.responses}</dd>
            <dt>Rated share</dt>
            <dd data-testid="ratings-share">{formatShare(summary.ratedShareBasisPoints)}</dd>
            <dt>Average score</dt>
            <dd data-testid="ratings-average">{average ?? 'No ratings yet'}</dd>
            {SCORES.map((score) => (
              <div key={score} style={{ display: 'contents' }}>
                <dt>Score {score}</dt>
                <dd data-testid={`ratings-score-${score}`}>{summary.perScore[score]}</dd>
              </div>
            ))}
          </dl>
        </>
      ) : null}
    </section>
  );
}

/** Reads the window on mount and whenever the pick changes. The window is stamped at the moment of the read. */
export function RatingsSummary() {
  const [days, setDays] = useState<WindowDays>(30);
  const [view, setView] = useState<SupportRatingSummaryView | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void fetchRatingSummary(ratingWindow(days, new Date()), controller.signal).then((next) => {
      if (controller.signal.aborted) return;
      setView(next);
      setLoading(false);
    });
    return () => controller.abort();
  }, [days]);
  return <RatingsSummaryView days={days} onDays={setDays} view={view} loading={loading} />;
}
