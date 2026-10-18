/**
 * Email team invites.
 *
 * The stored member id starts as the reserved token `email:<normalised address>`.
 * The invite never looks up whether that address already has an account, so
 * the reply cannot say so. A confirmed mailbox binds that row to the account
 * and leaves it invited. The team list keeps showing the email token until
 * the person accepts. There is no migration for a second column: `user_id`
 * holds the account, and the label keeps the email token behind a separator
 * the list does not return.
 *
 * The rate window and the invite lifetime are owner-published. Any of them
 * unset, blank, zero, or not a positive integer leaves email invite
 * unconfigured: sending refuses, and a claim binds nothing. There is no
 * default count, window, or lifetime.
 */

export const EMAIL_INVITE_PREFIX = 'email:';

/**
 * Splits a merchant's label from the email token stored for display.
 * Record separator is not a mailbox character. Labels written by invite
 * have it removed, so only a claim introduces it.
 */
export const INVITE_EMAIL_SEPARATOR = '\u001e';

const EMAIL_SHAPE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Trimmed, lowercased address, or null when it is not one mailbox. Non-ASCII is refused before case folding. */
export function normaliseTeamInviteEmail(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length < 3 || trimmed.length > 254) return null;
  // Case-folding is not identity for every letter (Kelvin sign folds to "k").
  // Refuse those before lowercasing so two different addresses cannot collide.
  if (/[^\u0000-\u007f]/.test(trimmed)) return null;
  if (/\s/.test(trimmed)) return null;
  const email = trimmed.toLowerCase();
  if (!EMAIL_SHAPE.test(email)) return null;
  return email;
}

/** Label text safe to store. The display separator is removed so a claim can use it. */
export function plainTeamLabel(label: string | null | undefined): string | null {
  if (label == null) return null;
  const clean = label.split(INVITE_EMAIL_SEPARATOR).join('').trim();
  return clean.length > 0 ? clean : null;
}

/** Keep the email token beside the merchant's label. The account id is not in this string. */
export function stashInviteEmail(label: string | null, token: string): string {
  return `${label ?? ''}${INVITE_EMAIL_SEPARATOR}${token}`;
}

/** The email token and the merchant's label, or null when this label is not a claim stash. */
export function readStashedInviteEmail(label: string | null): { token: string; label: string | null } | null {
  if (!label) return null;
  const at = label.indexOf(INVITE_EMAIL_SEPARATOR);
  if (at < 0) return null;
  const token = label.slice(at + INVITE_EMAIL_SEPARATOR.length);
  if (!token.startsWith(EMAIL_INVITE_PREFIX) || token.includes(INVITE_EMAIL_SEPARATOR)) return null;
  const visible = label.slice(0, at);
  return { token, label: visible.length > 0 ? visible : null };
}

/**
 * What the merchant team list and its audit trail may show.
 * An unaccepted email claim keeps the email token. The account id stays off that trail.
 */
export function teamEventMemberUserId(userId: string, label: string | null, status: string): string {
  if (status === 'active') return userId;
  return readStashedInviteEmail(label)?.token ?? userId;
}

export function emailInviteToken(email: string): string {
  return `${EMAIL_INVITE_PREFIX}${email}`;
}

/** Account ids must not use the email-invite token namespace. */
export function isReservedTeamUserId(userId: string): boolean {
  return userId.trim().toLowerCase().startsWith(EMAIL_INVITE_PREFIX);
}

export interface TeamEmailInviteLimit {
  readonly maxPerWindow: number;
  readonly windowMs: number;
  /** Pending email invites older than this are not claimed. */
  readonly ttlMs: number;
}

const POSITIVE_INT = /^[1-9][0-9]*$/;

export function loadTeamEmailInviteLimit(env: Record<string, string | undefined>): TeamEmailInviteLimit | undefined {
  const maxRaw = env.PAY_TEAM_EMAIL_INVITE_MAX?.trim() ?? '';
  const windowRaw = env.PAY_TEAM_EMAIL_INVITE_WINDOW_MS?.trim() ?? '';
  const ttlRaw = env.PAY_TEAM_EMAIL_INVITE_TTL_MS?.trim() ?? '';
  if (!POSITIVE_INT.test(maxRaw) || !POSITIVE_INT.test(windowRaw) || !POSITIVE_INT.test(ttlRaw)) return undefined;
  const maxPerWindow = Number(maxRaw);
  const windowMs = Number(windowRaw);
  const ttlMs = Number(ttlRaw);
  if (!Number.isSafeInteger(maxPerWindow) || !Number.isSafeInteger(windowMs) || !Number.isSafeInteger(ttlMs)) return undefined;
  return { maxPerWindow, windowMs, ttlMs };
}

/** A published lifetime. Anything else means email invites are not claimable. */
export function publishedTeamEmailInviteTtlMs(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isSafeInteger(value) || value < 1) return undefined;
  return value;
}
