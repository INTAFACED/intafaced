/**
 * How an alert reaches the person (J-charts-desk-10, C-alerts-scan-04), on the alert form and on each alert's row.
 *
 * - The form's channel group: in-app (always: every alert writes its row in the notifications), popup and sound (played by
 *   this app while it is open), email, push and webhook. A channel that needs an outside delivery service the platform has
 *   not got says so beside it, in words, and nothing ever reports the alert as sent that way.
 * - The webhook: a URL, checked by the service when the alert is saved, and the published retry policy, read from the
 *   service: how many times one trigger is tried in all and the wait before each retry.
 * - On each row, the webhook's delivery log: every attempt, numbered, with the receiver's answer (its HTTP status, or the
 *   error), and the next attempt while one is waiting.
 */
import { useCallback, useEffect, useId, useState } from 'react';
import { useSession } from '../../features/session/session';
import { alertsCopy } from './alerts-copy';
import {
  ALERT_CHANNELS,
  channelStatus,
  listWebhookAttempts,
  readWebhookPolicy,
  type AlertChannel,
  type ChannelRow,
  type WebhookAttempt,
  type WebhookPolicy,
} from './notify-api';

export type PolicyState = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; policy: WebhookPolicy | null };

/** The channel statuses, the webhook policy and the webhook log of the person's alerts. `reload` reads the log again. */
export function useAlertDelivery() {
  const { api, userId } = useSession();
  const [statuses, setStatuses] = useState<readonly ChannelRow[] | null>(null);
  const [policy, setPolicy] = useState<PolicyState>({ status: 'loading' });
  const [attempts, setAttempts] = useState<readonly WebhookAttempt[]>([]);
  const [cycle, setCycle] = useState(0);
  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    void channelStatus(api, controller.signal).then((result) => {
      if (!controller.signal.aborted) setStatuses(result.ok ? result.data : null);
    });
    void readWebhookPolicy(api, controller.signal).then((result) => {
      if (!controller.signal.aborted) setPolicy(result.ok ? { status: 'ready', policy: result.data.policy } : { status: 'failed' });
    });
    return () => controller.abort();
  }, [api, userId]);
  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    void listWebhookAttempts(api, controller.signal).then((result) => {
      if (!controller.signal.aborted && result.ok) setAttempts(result.data.items);
    });
    return () => controller.abort();
  }, [api, userId, cycle]);
  const reload = useCallback(() => setCycle((value) => value + 1), []);
  return { statuses, policy, attempts, reload };
}

const LABEL = {
  inapp: 'channelInapp',
  popup: 'channelPopup',
  sound: 'channelSound',
  email: 'channelEmail',
  push: 'channelPush',
  webhook: 'channelWebhook',
} as const satisfies Record<AlertChannel, string>;
const HINT = {
  inapp: 'channelInappHint',
  popup: 'channelPopupHint',
  sound: 'channelSoundHint',
  email: null,
  push: null,
  webhook: null,
} as const;
/** The channels that need an outside delivery service, and the notice each says while it has none. */
const OFF_NOTICE = { email: 'emailOff', push: 'pushOff' } as const;

/** Seconds as the person reads them: "5 s", "1 min 30 s". */
const waitWords = (ms: number) => {
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes} min${seconds ? ` ${seconds} s` : ''}` : `${seconds} s`;
};

/** The published retry policy, in words, with its numbers on the element for anyone checking them. */
export function WebhookPolicyNote({ policy }: { policy: PolicyState }) {
  const copy = alertsCopy.useCopy();
  if (policy.status === 'loading') return null;
  if (policy.status === 'failed')
    return (
      <p className="nf-muted" data-testid="alerts-webhook-policy-unread">
        {copy.t('webhookPolicyUnread')}
      </p>
    );
  if (!policy.policy)
    return (
      <p className="nf-muted" data-testid="alerts-webhook-policy-off">
        {copy.t('webhookPolicyOff')}
      </p>
    );
  const { maxAttempts, backoffMs } = policy.policy;
  return (
    <p
      className="nf-muted"
      data-testid="alerts-webhook-policy"
      data-max-attempts={String(maxAttempts)}
      data-backoff-ms={backoffMs.join(',')}
    >
      {copy.t(maxAttempts === 1 ? 'webhookPolicyOnce' : 'webhookPolicy', {
        max: String(maxAttempts),
        waits: backoffMs.map(waitWords).join(', then '),
      })}
    </p>
  );
}

/** The form's channel group. The in-app inbox is always on; a channel with no delivery service names it beside the box. */
export function AlertChannelsField({
  chosen,
  onChange,
  webhookUrl,
  onWebhookUrl,
  webhookProblem,
  statuses,
  policy,
  disabled,
}: {
  chosen: ReadonlySet<AlertChannel>;
  onChange: (next: ReadonlySet<AlertChannel>) => void;
  webhookUrl: string;
  onWebhookUrl: (url: string) => void;
  webhookProblem: boolean;
  statuses: readonly ChannelRow[] | null;
  policy: PolicyState;
  disabled: boolean;
}) {
  const copy = alertsCopy.useCopy();
  const id = useId();
  const configured = (channel: 'email' | 'push') => statuses?.find((row) => row.channel === channel)?.configured ?? null;
  const toggle = (channel: AlertChannel, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(channel);
    else next.delete(channel);
    next.add('inapp');
    onChange(next);
  };
  return (
    <fieldset className="nf-field nf-channels" disabled={disabled} data-testid="alerts-channels">
      <legend>{copy.t('channelsLegend')}</legend>
      {ALERT_CHANNELS.map((channel) => {
        const hint = HINT[channel];
        const off = channel === 'email' || channel === 'push' ? configured(channel) : null;
        return (
          <div key={channel} className="nf-channel">
            <label className="nf-channel__box">
              <input
                type="checkbox"
                checked={channel === 'inapp' || chosen.has(channel)}
                disabled={channel === 'inapp'}
                onChange={(event) => toggle(channel, event.target.checked)}
              />
              <span>{copy.t(LABEL[channel])}</span>
            </label>
            {hint ? <small className="nf-muted">{copy.t(hint)}</small> : null}
            {(channel === 'email' || channel === 'push') && off === false ? (
              <small className="nf-muted" data-testid="alert-channel-notice" data-channel={channel}>
                {copy.t(OFF_NOTICE[channel])}
              </small>
            ) : null}
            {(channel === 'email' || channel === 'push') && off === null && statuses === null ? (
              <small className="nf-muted" data-testid="alert-channel-unread" data-channel={channel}>
                {copy.t('channelUnread')}
              </small>
            ) : null}
            {channel === 'webhook' && chosen.has('webhook') ? (
              <label className="nf-field" htmlFor={`${id}-hook`}>
                <span>{copy.t('webhookUrlLabel')}</span>
                <input
                  id={`${id}-hook`}
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  value={webhookUrl}
                  aria-invalid={webhookProblem || undefined}
                  onChange={(event) => onWebhookUrl(event.target.value)}
                />
                <small className={webhookProblem ? 'nf-error' : 'nf-muted'}>
                  {copy.t(webhookProblem ? 'webhookUrlMissing' : 'webhookUrlHint')}
                </small>
              </label>
            ) : null}
            {channel === 'webhook' ? <WebhookPolicyNote policy={policy} /> : null}
          </div>
        );
      })}
    </fieldset>
  );
}

/** One alert's webhook log: every attempt made, numbered, with its answer; and the next one while it waits. */
export function WebhookAttempts({ attempts, stamp }: { attempts: readonly WebhookAttempt[]; stamp: (iso: string) => string }) {
  const copy = alertsCopy.useCopy();
  if (attempts.length === 0) return null;
  const made = attempts.filter((row) => row.status !== 'pending');
  const waiting = attempts.filter((row) => row.status === 'pending');
  return (
    <ol className="nf-body nf-body--wrap nf-attempts" aria-label={copy.t('webhookLog')} data-testid="alert-webhook-log">
      {made.map((row) => (
        <li
          key={`${row.trigger}:${row.attempt}`}
          data-testid="alert-webhook-attempt"
          data-trigger={String(row.trigger)}
          data-attempt={String(row.attempt)}
          data-outcome={row.status}
          data-http-status={row.httpStatus === null ? '' : String(row.httpStatus)}
        >
          {copy.t(row.status === 'delivered' ? 'attemptDelivered' : 'attemptFailed', {
            n: String(row.attempt),
            answer: row.httpStatus !== null ? `HTTP ${row.httpStatus}` : (row.error ?? copy.t('attemptNoAnswer')),
            when: row.attemptedAt ? stamp(row.attemptedAt) : '',
          })}
        </li>
      ))}
      {waiting.map((row) => (
        <li key={`${row.trigger}:${row.attempt}`} data-testid="alert-webhook-next" data-attempt={String(row.attempt)}>
          {copy.t('attemptNext', { n: String(row.attempt), when: stamp(row.dueAt) })}
        </li>
      ))}
    </ol>
  );
}
