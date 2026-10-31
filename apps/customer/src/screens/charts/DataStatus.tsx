/**
 * The chart's data status: the chip beside the title, the banner for the states that stop the chart reading as live, the
 * TEST label on test markets, and the source line. Every word comes from the data status (data-status.ts), never from
 * the page: a state the rules do not name is never guessed.
 */
import type { ReactNode } from 'react';
import type { DataStatus, TradeRefusal } from './data-status';
import { chartsCopy } from './copy';

type Words = ReturnType<typeof chartsCopy.useCopy>['t'];

const CHIP_KEY = {
  live: 'Status live',
  delayed: 'Status delayed',
  end_of_day: 'Status end of day',
  stale: 'Status stale',
  down: 'Status down',
  halted: 'Status halted',
  not_open: 'Status not open',
  lifecycle_unavailable: 'Status lifecycle unavailable',
  book_unavailable: 'Status book unavailable',
  no_data: 'Status no data',
  class_unset: 'Status class unset',
  class_unread: 'Status class unread',
  threshold_unset: 'Status threshold unset',
  tick_unread: 'Status tick unread',
  loading: 'Status loading',
} as const;

/** The chip's words, with the age of the newest trade where the state judges one. */
export function chipText(status: DataStatus, t: Words): string {
  const word = t(CHIP_KEY[status.chip]);
  const showsAge = ['live', 'delayed', 'stale', 'down', 'threshold_unset'].includes(status.chip);
  if (!showsAge) return word;
  return status.ageSeconds === null
    ? `${word} · ${t('Status no age')}`
    : `${word} · ${t('Status age', { seconds: String(status.ageSeconds) })}`;
}

export function StatusChip({ status }: { status: DataStatus }) {
  const { t } = chartsCopy.useCopy();
  const text = chipText(status, t);
  return (
    <span
      className="cw-status"
      data-testid="chart-status"
      data-status={status.chip}
      data-feed={status.feed}
      aria-label={t('Status label', { status: text })}
    >
      <span className="cw-status-dot" aria-hidden="true" />
      {text}
    </span>
  );
}

export function TestLabel({ status }: { status: DataStatus }) {
  const { t } = chartsCopy.useCopy();
  if (!status.test) return null;
  return (
    <span className="cw-test" data-testid="chart-test" title={t('Status test title')}>
      {t('Status test')}
    </span>
  );
}

/**
 * The banner for a state that stops the chart reading as live. Halted and not-open states give the time they took effect;
 * a time the route does not name is said so, never guessed. Nothing is shown for a live, class-unset or threshold-unset
 * chart: the chip carries those words.
 */
export function StatusBanner({ status, format }: { status: DataStatus; format: (ms: number) => string }): ReactNode {
  const { t } = chartsCopy.useCopy();
  const tick = status.lastTradeMs === null ? t('Banner time unknown') : format(status.lastTradeMs);
  const since = status.stateSinceMs === null ? t('Banner time unknown') : format(status.stateSinceMs);
  let kind: string | null = null;
  let body = '';
  if (status.chip === 'halted') {
    kind = 'halted';
    body = t('Banner halted', { asOf: since });
  } else if (status.chip === 'not_open') {
    kind = 'not-open';
    body = t('Banner not open', { state: status.state ?? '', asOf: since });
  } else if (status.chip === 'lifecycle_unavailable') {
    kind = 'lifecycle';
    body = t('Banner lifecycle');
  } else if (status.chip === 'book_unavailable') {
    kind = 'book';
    body = t('Banner book');
  } else if (status.chip === 'down') {
    kind = 'down';
    body = t('Banner down', { tick });
  } else if (status.chip === 'stale') {
    kind = 'stale';
    body = t('Banner stale', { seconds: String(status.feedAgeSeconds ?? 0), tick });
  } else if (status.chip === 'delayed' && status.ageSeconds !== null) {
    kind = 'delayed';
    body = t(status.delayedBy === 'class' ? 'Banner delayed class' : 'Banner delayed', {
      seconds: String(status.ageSeconds),
      threshold: String(status.thresholdSeconds ?? 0),
      tick,
    });
  }
  if (kind === null) return null;
  return (
    <p className="cw-banner" role="status" data-testid="chart-banner" data-kind={kind}>
      {body}
    </p>
  );
}

/** The one line that says where the candles come from, so no bar is read as a trade it is not. */
export function SourceLine() {
  const { t } = chartsCopy.useCopy();
  return (
    <p className="cw-source" data-testid="chart-source">
      {t('Source line')}
    </p>
  );
}

/** The words for a refusal of order entry, from the one rule (tradeRefusal) the chip and the trade link share. */
export function refusalText(refusal: { code: TradeRefusal; state: string | null } | null, t: Words): string | null {
  if (refusal === null) return null;
  if (refusal.code === 'loading') return t('Refused loading');
  if (refusal.code === 'lifecycle_unavailable') return t('Refused lifecycle');
  if (refusal.code === 'book_unavailable') return t('Refused book');
  if (refusal.code === 'halted' || refusal.code === 'book_halted') return t('Refused halted');
  return t('Refused not open', { state: refusal.state ?? '' });
}
