import type { Part } from '@/lib/desk/part';

/**
 * Recipient health: strict reader for svc-notify's `notify.operatorRecipients` (admin:read) and the request the release
 * action sends (`notify.operatorReleaseRecipient`, admin:write).
 *
 * What a row is: one (person, out-of-app channel) address. `active` is confirmed and sendable, `unconfirmed` never
 * passed verification, `quarantined` had enough terminal failures in a row that svc-notify stopped sending to it. The
 * address is already masked by the service; this console never sees or shows a full one. A blank threshold means
 * svc-notify never quarantines, and the desk says that instead of showing a number.
 */

export const RECIPIENT_STATES = ['quarantined', 'unconfirmed', 'active'] as const;
export type RecipientState = (typeof RECIPIENT_STATES)[number];
export const RECIPIENTS_PAGE = 200;
export const RELEASE_REASON_MIN = 10;
export const RELEASE_REASON_MAX = 500;
export const OUT_OF_APP_CHANNELS = ['email', 'push', 'sms'] as const;
export type RecipientChannel = (typeof OUT_OF_APP_CHANNELS)[number];

export interface RecipientRow {
  readonly userId: string;
  readonly channel: RecipientChannel;
  readonly address: string;
  readonly state: RecipientState;
  readonly consecutiveFailures: number;
  readonly lastFailureAt: string | null;
  readonly lastFailureCode: string | null;
  readonly quarantinedAt: string | null;
  readonly quarantineReason: string | null;
}

export interface RecipientsRead {
  readonly state: RecipientState;
  readonly limit: number;
  /** Failures in a row that quarantine an address; null when the owner has not set it (svc-notify never quarantines). */
  readonly threshold: number | null;
  readonly thresholdCode: string | null;
  readonly items: readonly RecipientRow[];
}

export type RecipientsView = Part<RecipientsRead>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
const isIso = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));
const isNullableString = (v: unknown): v is string | null => v === null || typeof v === 'string';

export const isRecipientState = (v: unknown): v is RecipientState =>
  typeof v === 'string' && (RECIPIENT_STATES as readonly string[]).includes(v);

export function readRecipients(raw: unknown, state: RecipientState, limit: number): RecipientsRead | null {
  if (!isRecord(raw) || !Array.isArray(raw.items)) return null;
  const { threshold, thresholdCode } = raw;
  if (!(threshold === null || (typeof threshold === 'number' && Number.isInteger(threshold) && threshold > 0))) return null;
  if (!isNullableString(thresholdCode)) return null;
  const items: RecipientRow[] = [];
  for (const item of raw.items) {
    if (!isRecord(item)) return null;
    const { userId, channel, address, consecutiveFailures, lastFailureAt, lastFailureCode, quarantinedAt, quarantineReason } = item;
    if (typeof userId !== 'string' || userId === '' || typeof address !== 'string') return null;
    if (typeof channel !== 'string' || !(OUT_OF_APP_CHANNELS as readonly string[]).includes(channel)) return null;
    // A row is shown under the tab that was asked for; a row that says otherwise means the shapes disagree.
    if (item.state !== state) return null;
    if (typeof consecutiveFailures !== 'number' || !Number.isInteger(consecutiveFailures) || consecutiveFailures < 0) return null;
    if (!(lastFailureAt === null || isIso(lastFailureAt)) || !(quarantinedAt === null || isIso(quarantinedAt))) return null;
    if (!isNullableString(lastFailureCode) || !isNullableString(quarantineReason)) return null;
    items.push({
      userId,
      channel: channel as RecipientChannel,
      address,
      state,
      consecutiveFailures,
      lastFailureAt,
      lastFailureCode,
      quarantinedAt,
      quarantineReason,
    });
  }
  return { state, limit, threshold, thresholdCode, items };
}

/** The reader svc-notify's release answer must match; anything else is an unknown outcome, not a success. */
export function readReleased(raw: unknown): { readonly replayed: boolean } | null {
  return isRecord(raw) && raw.released === true && typeof raw.replayed === 'boolean' ? { replayed: raw.replayed } : null;
}

/**
 * The business key of one release: the same quarantine of the same address always has the same key, so a retry after an
 * unknown outcome replays instead of lifting twice.
 */
export function releaseKey(row: Pick<RecipientRow, 'userId' | 'channel' | 'quarantinedAt'>): string {
  return `notify-release:${row.userId}:${row.channel}:${row.quarantinedAt ?? 'none'}`;
}

export type ReleaseCheck = { readonly ok: true; readonly reason: string } | { readonly ok: false; readonly message: string };

export function checkReleaseReason(raw: string): ReleaseCheck {
  const reason = raw.trim();
  if (reason.length < RELEASE_REASON_MIN)
    return { ok: false, message: `Write at least ${RELEASE_REASON_MIN} characters on why this address is safe to send to again.` };
  if (reason.length > RELEASE_REASON_MAX) return { ok: false, message: `Keep the reason to ${RELEASE_REASON_MAX} characters or fewer.` };
  return { ok: true, reason };
}

export type ReleaseReply =
  | { readonly ok: true; readonly replayed: boolean }
  | { readonly ok: false; readonly title: string; readonly body: string; readonly next: string; readonly changed: 'no' | 'unknown' };
