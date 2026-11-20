import { useEffect } from 'react';
import { ServiceOffNotice } from '@intafaced/ui/lit/templates';
import { usePreferences } from '../../shared/preferences';
import { stamp } from '../money/time';
import { alertsCopy } from './alerts-copy';
import { StateBlock } from './deps';
import type { AlertCondition, AlertTrigger, Delivery, WebhookCause } from './notify-api';
import { sortDeliveries } from './prefs';
import type { TriggersState } from './use-triggers';

const CONDITION_KEY = {
  greater_than: 'above',
  less_than: 'below',
  crossing_up: 'crossingUp',
  crossing_down: 'crossingDown',
  crossing: 'crossing',
} as const satisfies Record<AlertCondition, string>;

const CAUSE_KEY = {
  ok: 'causeOk',
  redirect: 'causeRedirect',
  refused: 'causeRefused',
  unavailable: 'causeUnavailable',
  gateway_timeout: 'causeGatewayTimeout',
  timeout: 'causeTimeout',
  unreachable: 'causeUnreachable',
  private_address: 'causePrivate',
} as const satisfies Record<WebhookCause, string>;

/** How often the history is read again while a webhook is still being sent, so each resend shows as it happens. */
const PENDING_REFRESH_MS = 2_000;

/**
 * Where one firing went: the in-app row, each out-of-app channel from the service's own delivery rows, and the webhook with every
 * attempt. A channel is never shown as sent unless its row says a delivery service took it.
 */
function FiringDelivery({ row, zone }: { row: AlertTrigger; zone: ReturnType<typeof usePreferences>['timeZone'] }) {
  const copy = alertsCopy.useCopy();
  const channels = sortDeliveries(row.deliveries ?? []);
  const name = (d: Delivery) => copy.t(d.channel === 'email' ? 'deliveryEmail' : d.channel === 'push' ? 'deliveryPush' : 'deliveryInApp');
  if (channels.length === 0 && !row.webhook) return null;
  return (
    <ul className="nf-deliveries" data-testid="alert-trigger-delivery">
      {channels.map((d) => (
        <li key={d.channel} data-testid="alert-trigger-channel" data-channel={d.channel} data-status={d.status}>
          {d.channel === 'inapp' ? (
            <span className="nf-body nf-body--wrap">
              {d.status === 'accepted' ? copy.t('logInApp') : copy.t('logChannelPending', { channel: name(d) })}
            </span>
          ) : d.status === 'accepted' ? (
            <span className="nf-body nf-body--wrap">{copy.t('logChannelHanded', { channel: name(d) })}</span>
          ) : d.status === 'refused' ? (
            <>
              <span className="nf-body nf-body--wrap">{copy.t('logChannelNotSent', { channel: name(d) })}</span>
              {d.refusalCode === 'channel.not_configured' && (d.channel === 'email' || d.channel === 'push') ? (
                <ServiceOffNotice
                  code={d.channel === 'email' ? 'vendor.email' : 'vendor.push'}
                  sentence={copy.t(d.channel === 'email' ? 'deliveryEmailOff' : 'deliveryPushOff')}
                  className="nf-why"
                />
              ) : (
                <span className="nf-muted" lang="zxx">
                  {d.refusalCode ?? ''}
                </span>
              )}
            </>
          ) : d.status === 'pending' ? (
            <span className="nf-body nf-body--wrap">{copy.t('logChannelPending', { channel: name(d) })}</span>
          ) : (
            <span className="nf-body nf-body--wrap">{copy.t('logChannelFailed', { channel: name(d) })}</span>
          )}
        </li>
      ))}
      {row.webhook ? (
        <li data-testid="alert-trigger-webhook" data-status={row.webhook.status}>
          <span className="nf-body nf-body--wrap" data-testid="alert-webhook-state">
            {row.webhook.status === 'delivered'
              ? copy.t('logWebhookDelivered')
              : row.webhook.status === 'failed'
                ? copy.t('logWebhookFailed', { count: String(row.webhook.attempts.length) })
                : row.webhook.nextAttemptAt && row.webhook.attempts.length > 0
                  ? copy.t('logWebhookPending', { when: stamp(row.webhook.nextAttemptAt, zone, Date.now(), true) })
                  : copy.t('logWebhookSending')}
          </span>
          {row.webhook.attempts.length > 0 ? (
            <ol className="nf-list" data-testid="alert-webhook-attempts">
              {row.webhook.attempts.map((a) => (
                <li key={a.n} data-testid="alert-webhook-attempt" data-status={a.status ?? ''} data-cause={a.cause}>
                  <span className="nf-muted">
                    {copy.t('logWebhookAttempt', {
                      n: String(a.n),
                      when: stamp(a.at, zone, Date.now(), true),
                      result: a.status === null ? copy.t('logWebhookNoAnswer') : copy.t('logWebhookStatus', { status: String(a.status) }),
                    })}
                  </span>
                  <span className="nf-body nf-body--wrap">{copy.t(CAUSE_KEY[a.cause])}</span>
                </li>
              ))}
            </ol>
          ) : null}
        </li>
      ) : null}
    </ul>
  );
}

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
  // While a webhook is still being sent, read the history again so its resends and their outcome appear without a reload.
  const sending = state.status === 'ready' && state.page.items.some((row) => row.webhook?.status === 'pending');
  useEffect(() => {
    if (!sending) return;
    const timer = setTimeout(onRetry, PENDING_REFRESH_MS);
    return () => clearTimeout(timer);
  }, [sending, state, onRetry]);
  return (
    <section
      className="nf-card"
      aria-label={copy.t('logTitle')}
      aria-busy={state.status === 'loading' || undefined}
      data-testid="alerts-log"
    >
      <div className="nf-listhead">
        <h2 className="nf-h2 nf-h2--flush">{copy.t('logTitle')}</h2>
        <button type="button" className="nf-link nf-linkbutton" data-testid="alerts-log-refresh" onClick={onRetry}>
          {copy.t('refresh')}
        </button>
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
                  <FiringDelivery row={row} zone={timeZone} />
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
