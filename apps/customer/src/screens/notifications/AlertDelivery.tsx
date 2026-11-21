import { useEffect, useState } from 'react';
import { ServiceOffNotice } from '@intafaced/ui/lit/templates';
import { useSession } from '../../features/session/session';
import { alertsCopy } from './alerts-copy';
import { channelStatus, readWebhookPolicy, type AlertChannel, type ChannelRow, type WebhookPolicy } from './notify-api';

export type DeliveryChoice = { readonly email: boolean; readonly push: boolean; readonly webhookUrl: string };
export const NO_DELIVERY_CHOICE: DeliveryChoice = { email: false, push: false, webhookUrl: '' };

type Loaded<T> = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; value: T };

/** The channel status and the webhook policy the delivery choice is drawn from, read once with the page. */
export function useDeliveryFacts() {
  const { api, userId } = useSession();
  const [channels, setChannels] = useState<Loaded<ChannelRow[]>>({ status: 'loading' });
  const [policy, setPolicy] = useState<Loaded<WebhookPolicy>>({ status: 'loading' });
  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    void channelStatus(api, controller.signal).then((result) => {
      if (!controller.signal.aborted) setChannels(result.ok ? { status: 'ready', value: result.data } : { status: 'failed' });
    });
    void readWebhookPolicy(api, controller.signal).then((result) => {
      if (!controller.signal.aborted) setPolicy(result.ok ? { status: 'ready', value: result.data } : { status: 'failed' });
    });
    return () => controller.abort();
  }, [api, userId]);
  return { channels, policy };
}

/** Why a chosen channel will not send, from the service's own status: no sender (`channel.not_configured`), or switched off. */
export function channelBlock(rows: Loaded<ChannelRow[]>, channel: AlertChannel): 'off' | 'disabled' | 'unknown' | null {
  if (rows.status !== 'ready') return rows.status === 'failed' ? 'unknown' : null;
  const row = rows.value.find((r) => r.channel === channel) as (ChannelRow & { reason?: string | null }) | undefined;
  if (!row) return 'unknown';
  if (row.reason === 'channel.not_configured') return 'off';
  if (row.reason === 'channel.disabled') return 'disabled';
  return null;
}

/** A URL the service may accept: it checks the rest (https, the port, a public address). */
export function webhookProblem(raw: string): 'invalid' | null {
  const text = raw.trim();
  if (text === '') return null;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' || url.protocol === 'http:' ? null : 'invalid';
  } catch {
    return 'invalid';
  }
}

/** The resend schedule in the page's words: `5, 5 and 5`. */
const listWords = (values: readonly number[]) =>
  values.length <= 1 ? values.join('') : `${values.slice(0, -1).join(', ')} and ${values[values.length - 1]}`;

/**
 * Where an alert reaches the person (J-charts-desk-10): the in-app row always, email and push when ticked, and their own webhook.
 * A ticked channel that cannot send says so beside it, in the words the service's status supports; nothing here claims a send.
 */
export function AlertDelivery({
  value,
  onChange,
  disabled,
  facts,
}: {
  value: DeliveryChoice;
  onChange: (next: DeliveryChoice) => void;
  disabled: boolean;
  facts: ReturnType<typeof useDeliveryFacts>;
}) {
  const copy = alertsCopy.useCopy();
  const policy = facts.policy;
  const webhookOff = policy.status !== 'ready' || policy.value.ports === null;
  const problem = webhookProblem(value.webhookUrl);
  const note = (channel: AlertChannel) => {
    const block = channelBlock(facts.channels, channel);
    if (block === 'off') {
      return (
        <ServiceOffNotice
          code={channel === 'email' ? 'vendor.email' : 'vendor.push'}
          sentence={copy.t(channel === 'email' ? 'deliveryEmailOff' : 'deliveryPushOff')}
          className="nf-why"
          role="note"
        />
      );
    }
    if (block === 'disabled')
      return (
        <p className="nf-why" role="note">
          {copy.t('deliveryChannelDisabled')}
        </p>
      );
    if (block === 'unknown')
      return (
        <p className="nf-why" role="note">
          {copy.t('deliveryChannelUnknown')}
        </p>
      );
    return <p className="nf-muted">{copy.t('deliveryAddressNote')}</p>;
  };
  return (
    <fieldset className="nf-field nf-delivery-choice" data-testid="alerts-delivery" disabled={disabled}>
      <legend>{copy.t('deliveryLegend')}</legend>
      <label className="nf-check">
        <input type="checkbox" checked disabled readOnly />
        <span>{copy.t('deliveryInApp')}</span>
      </label>
      <label className="nf-check" data-testid="alerts-delivery-email">
        <input type="checkbox" checked={value.email} onChange={(event) => onChange({ ...value, email: event.target.checked })} />
        <span>{copy.t('deliveryEmail')}</span>
      </label>
      {value.email ? <div data-testid="alerts-delivery-email-note">{note('email')}</div> : null}
      <label className="nf-check" data-testid="alerts-delivery-push">
        <input type="checkbox" checked={value.push} onChange={(event) => onChange({ ...value, push: event.target.checked })} />
        <span>{copy.t('deliveryPush')}</span>
      </label>
      {value.push ? <div data-testid="alerts-delivery-push-note">{note('push')}</div> : null}
      <label className="nf-field">
        <span>{copy.t('webhookLabel')}</span>
        <input
          type="url"
          inputMode="url"
          autoComplete="off"
          maxLength={2048}
          value={value.webhookUrl}
          disabled={disabled || webhookOff}
          aria-invalid={problem !== null}
          onChange={(event) => onChange({ ...value, webhookUrl: event.target.value })}
        />
        <small className={problem ? 'nf-error' : 'nf-muted'}>{problem ? copy.t('webhookInvalid') : copy.t('webhookHint')}</small>
      </label>
      <p className="nf-muted" data-testid="alerts-webhook-policy">
        {policy.status === 'loading'
          ? copy.t('webhookPolicyLoading')
          : policy.status === 'failed'
            ? copy.t('webhookPolicyFailed')
            : policy.value.ports === null
              ? copy.t('webhookOff')
              : policy.value.retrySeconds === null
                ? copy.t('webhookPolicyNoRetry', { ports: listWords(policy.value.ports) })
                : copy.t('webhookPolicy', { ports: listWords(policy.value.ports), delays: listWords(policy.value.retrySeconds) })}
      </p>
    </fieldset>
  );
}

/** The choice as the create sends it: only the ticked channels, and the webhook when one was typed. */
export function deliveryIntent(choice: DeliveryChoice): { channels: AlertChannel[]; webhookUrl?: string } {
  const channels: AlertChannel[] = [...(choice.email ? (['email'] as const) : []), ...(choice.push ? (['push'] as const) : [])];
  const url = choice.webhookUrl.trim();
  return { channels, ...(url ? { webhookUrl: url } : {}) };
}
