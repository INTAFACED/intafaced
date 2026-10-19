/**
 * Email invites, as the team service stores and returns them. The service keeps the member id as the reserved token
 * `email:<address>` and never looks the address up. These helpers mirror its rules so the form can say what will
 * be sent, and mask the address wherever the team list shows it.
 */
const PREFIX = 'email:';
const SHAPE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** The address as the service will read it: trimmed and lower-case. Null when it is not one mailbox. */
export function normaliseInviteEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || /\s/.test(email)) return null;
  return SHAPE.test(email) ? email : null;
}

/** The address behind a pending email invite, or null when this member id is an ordinary account id. */
export function inviteEmailOf(userId: string): string | null {
  return userId.toLowerCase().startsWith(PREFIX) ? userId.slice(PREFIX.length) : null;
}

/** `priya.n@example.com` becomes `p***@example.com`: enough to recognise, not enough to copy. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}
