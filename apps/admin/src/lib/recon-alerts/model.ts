/**
 * Pure model of the reconciliation alerts room (OPS-reconciliation-03, -04). Client components reach this file, so it declares
 * plain words only and never imports the contracts entry point.
 */

export const ALERT_ACTIONS = ['acknowledge', 'snooze', 'unsnooze', 'resolve'] as const;
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
  'ops.resolve_transaction_not_found': 'The ledger has never booked at least one of those transaction ids. Nothing was changed.',
  'ops.resolve_note_required': 'Accepting a discrepancy needs a note. Nothing was changed and no approval was spent.',
  'ops.resolve_ledger_unavailable':
    'svc-ops could not ask the ledger whether those transactions exist, so it resolved nothing. Try again once the ledger answers.',
};

/** Why a resolve or accept cannot be asked for on this alert, or null when it can. Shown beside the control; never hides it. */
export function closeBlocked(state: string, cause: string): string | null {
  if (cause === 'error')
    return 'This alert is a run that could not finish (platform team). There is no discrepancy to fix or accept: it resolves when a run of the same control and period passes.';
  if (state === 'resolved') return 'This alert is resolved. A repeat failure in its period reopens it.';
  if (state === 'accepted') return 'This discrepancy is accepted and its evidence is frozen. It cannot be changed.';
  return null;
}

/** Corrective transaction ids as typed: comma or whitespace separated, lower case, each once. */
export function txIdsFrom(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[\s,]+/)
        .filter(Boolean)
        .map((t) => t.toLowerCase()),
    ),
  ];
}

export function refusalWords(code: string | null): string | null {
  return code !== null && Object.hasOwn(REFUSAL_WORDS, code) ? REFUSAL_WORDS[code]! : null;
}

export const NOTICE_WORDS: Readonly<Record<string, string>> = {
  sent: 'notice sent',
  not_due: 'notice not due yet',
  repeat_unset: 'no repeat interval set (ops.alert_repeat_unset), no notice',
  snoozed: 'snoozed, no notice',
};

export const TEAM_WORDS: Readonly<Record<string, string>> = {
  finance: 'Finance team: the books disagree',
  platform: 'Platform team: the run could not finish',
};

/**
 * The business key for one founder's move on one version of one alert. Built on the server from the session's own user id,
 * so a retry of the same press returns the stored result and two founders never share a key.
 */
export function alertKey(action: AlertAction, alertId: string, version: number, userId: string): string {
  return `alert:${action}:${alertId}:v${version}:${userId}`;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
