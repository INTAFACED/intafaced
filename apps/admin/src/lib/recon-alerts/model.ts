/**
 * Pure model of the reconciliation alerts room (OPS-reconciliation-03). Client components reach this file, so it declares
 * plain words only and never imports the contracts entry point.
 */

export const ALERT_ACTIONS = ['acknowledge', 'snooze', 'unsnooze'] as const;
export type AlertAction = (typeof ALERT_ACTIONS)[number];

const REFUSAL_WORDS: Readonly<Record<string, string>> = {
  'ops.alert_not_found': 'No alert has that id.',
  'ops.alert_state_illegal': 'Another founder moved this alert first, or the move does not fit its state. Nothing was changed.',
  'ops.alert_note_required': 'An acknowledgement needs a note. Nothing was changed.',
  'ops.alert_snooze_end_invalid': 'A snooze must end after now. Nothing was changed.',
  'ops.alert_storage_unconfigured': 'svc-ops has no durable storage for alerts on this deployment. Nothing was read or saved.',
  'ops.alert_forbidden': 'This write needs a second factor on this founder session.',
  'ops.alert_actor_unset': 'svc-ops could not name the founder on this session. Nothing was saved.',
  'ops.idempotency_conflict': 'This request key was already used for a different change. Reload and try again.',
};

export function refusalWords(code: string | null): string | null {
  return code !== null && Object.hasOwn(REFUSAL_WORDS, code) ? REFUSAL_WORDS[code]! : null;
}

export const NOTICE_WORDS: Readonly<Record<string, string>> = {
  sent: 'notice sent',
  not_due: 'notice not due yet',
  repeat_unset: 'no repeat interval set (ops.alert_repeat_unset), no notice',
  snoozed: 'snoozed, no notice',
};

/**
 * The business key for one founder's move on one version of one alert. Built on the server from the session's own user id,
 * so a retry of the same press returns the stored result and two founders never share a key.
 */
export function alertKey(action: AlertAction, alertId: string, version: number, userId: string): string {
  return `alert:${action}:${alertId}:v${version}:${userId}`;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
