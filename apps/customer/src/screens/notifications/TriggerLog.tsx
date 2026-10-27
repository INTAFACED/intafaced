import { usePreferences } from '../../shared/preferences';
import { stamp } from '../money/time';
import { alertsCopy } from './alerts-copy';
import { StateBlock } from './deps';
import type { AlertCondition } from './notify-api';
import type { TriggersState } from './use-triggers';

const CONDITION_KEY = {
  greater_than: 'above',
  less_than: 'below',
  crossing_up: 'crossingUp',
  crossing_down: 'crossingDown',
  crossing: 'crossing',
} as const satisfies Record<AlertCondition, string>;

/**
 * Every time one of the person's alerts triggered, with the price that triggered it, newest first. The history is the platform's
 * record, so an alert deleted since still shows here until the platform's own retention removes the row.
 */
export function TriggerLog({
  state,
  onRetry,
  marketLabel,
}: {
  state: TriggersState;
  onRetry: () => void;
  marketLabel: (marketId: string) => string;
}) {
  const copy = alertsCopy.useCopy();
  const { timeZone } = usePreferences();
  return (
    <section
      className="nf-card"
      aria-label={copy.t('logTitle')}
      aria-busy={state.status === 'loading' || undefined}
      data-testid="alerts-log"
    >
      <div className="nf-listhead">
        <h2 className="nf-h2 nf-h2--flush">{copy.t('logTitle')}</h2>
      </div>
      {state.status === 'loading' ? (
        <StateBlock kind="loading" rows={2} rowHeight={56} label={copy.t('logLoading')} className="nf-card__loading" />
      ) : state.status === 'failed' ? (
        <StateBlock kind="error" title={copy.t('logFailed')} onRetry={onRetry} retryLabel={copy.t('retry')} />
      ) : state.status === 'off' ? (
        <StateBlock kind="empty" title={copy.t('logOffTitle')} body={copy.t('logOffBody')} />
      ) : state.page.items.length === 0 ? (
        <StateBlock kind="empty" title={copy.t('logEmptyTitle')} body={copy.t('logEmptyBody')} />
      ) : (
        <>
          <ul className="nf-list" data-testid="alerts-log-list">
            {state.page.items.map((row) => (
              <li key={`${row.alertId}:${row.seq ?? 1}`} className="nf-alertrow" data-testid="alert-trigger">
                <div className="nf-text">
                  <span data-testid="nf-title" className="nf-title">
                    {marketLabel(row.marketId)}
                  </span>
                  <span data-testid="nf-body" className="nf-body nf-body--wrap">
                    {copy.t('logRow', { side: copy.t(CONDITION_KEY[row.condition]), price: row.targetPrice, mark: row.markPrice })}
                  </span>
                  <span className="nf-muted">{copy.t('logWhen', { when: stamp(row.firedAt, timeZone) })}</span>
                </div>
              </li>
            ))}
          </ul>
          <p className="nf-note">{copy.t('logKept', { days: String(state.page.retentionDays) })}</p>
        </>
      )}
    </section>
  );
}
