/**
 * Email team invites.
 *
 * The stored member id is the reserved token `email:<normalised address>`.
 * The invite never looks up whether that address already has an account, so
 * the reply cannot say so. Sign-in claims the row onto the real account.
 *
 * The rate window and the invite lifetime are owner-published. Any of them
 * unset, blank, zero, or not a positive integer leaves email invite
 * unconfigured: sending refuses, and a claim binds nothing. There is no
 * default count, window, or lifetime.
 */

export const EMAIL_INVITE_PREFIX = 'email:';

const EMAIL_SHAPE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Trimmed, lowercased address, or null when it is not one mailbox. */
export function normaliseTeamInviteEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (email.length < 3 || email.length > 254) return null;
  if (/\s/.test(email)) return null;
  if (!EMAIL_SHAPE.test(email)) return null;
  return email;
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
