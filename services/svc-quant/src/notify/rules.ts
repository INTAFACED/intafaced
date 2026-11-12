import {
  QUANT_ALERT_FIELDS,
  QUANT_ALERT_TEMPLATE_MAX,
  QUANT_NOTIFY_CHANNELS,
  QUANT_NOTIFY_UNAVAILABLE_CHANNELS,
  type QuantAlertField,
  type QuantNotifyChannel,
} from '@intafaced/contracts';
import { QUANT_ALERT_TEMPLATE_INVALID, QUANT_NOTIFY_CHANNEL_UNAVAILABLE, QuantError } from '../errors.js';

const FIELD = /\{([^{}]*)\}/g;

/**
 * A fill alert's message template, checked (AL-alerts-01). Plain text with allow-listed fields in braces; a template is
 * never evaluated, so it cannot run code. A blank template, a stray brace or a field outside the list refuses by name.
 */
export function checkTemplate(raw: string): string {
  const template = raw.trim();
  if (!template) throw new QuantError(QUANT_ALERT_TEMPLATE_INVALID, 'template — write the message the alert sends');
  if (template.length > QUANT_ALERT_TEMPLATE_MAX) {
    throw new QuantError(QUANT_ALERT_TEMPLATE_INVALID, `template — at most ${QUANT_ALERT_TEMPLATE_MAX} characters`);
  }
  for (const match of template.matchAll(FIELD)) {
    const name = match[1]!.trim();
    if (!(QUANT_ALERT_FIELDS as readonly string[]).includes(name)) {
      throw new QuantError(
        QUANT_ALERT_TEMPLATE_INVALID,
        `template — {${name}} is not a field; use ${QUANT_ALERT_FIELDS.map((f) => `{${f}}`).join(', ')}`,
      );
    }
  }
  if (/[{}]/.test(template.replace(FIELD, ''))) {
    throw new QuantError(QUANT_ALERT_TEMPLATE_INVALID, 'template — a brace is not closed; a field is written {name}');
  }
  return template;
}

/** The message for one fill: each field replaced by its value, nothing else read. */
export function renderTemplate(template: string, values: Readonly<Record<QuantAlertField, string>>): string {
  return template.replace(FIELD, (_, name: string) => values[name.trim() as QuantAlertField] ?? '');
}

/**
 * The channels a strategy notifies through (AL-live-06), in-app always first. A webhook or chat app refuses as unavailable
 * (no outbound sender exists), and anything else as not a channel; either way nothing is saved.
 */
export function checkChannels(raw: readonly string[]): QuantNotifyChannel[] {
  const chosen = new Set<QuantNotifyChannel>(['inapp']);
  for (const value of raw) {
    const channel = value.trim();
    if ((QUANT_NOTIFY_UNAVAILABLE_CHANNELS as readonly string[]).includes(channel)) {
      throw new QuantError(
        QUANT_NOTIFY_CHANNEL_UNAVAILABLE,
        `${channel} — no outbound sender exists for this channel in this build; nothing was saved`,
      );
    }
    if (!(QUANT_NOTIFY_CHANNELS as readonly string[]).includes(channel)) {
      throw new QuantError('quant.params_invalid', `channels — ${channel || 'blank'} is not a channel`);
    }
    chosen.add(channel as QuantNotifyChannel);
  }
  return QUANT_NOTIFY_CHANNELS.filter((channel) => chosen.has(channel));
}

/** The alert's key, from the count of the strategy's alerts the form read: a retry reads the same alert. */
export function alertKey(strategyId: string, accountId: string, ordinal: number): string {
  return `quant.alert:${strategyId}:${accountId}:${ordinal}`;
}

/** The event id of one fill under one alert: the same fill always carries the same id. */
export function fillEventId(alertId: string, runId: string, seq: number): string {
  return `quant.fill:${alertId}:${runId}:${seq}`;
}
