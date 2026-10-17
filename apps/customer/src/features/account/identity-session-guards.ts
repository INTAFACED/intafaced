import { z } from 'zod';
const uuid = z.string().uuid();
const instant = z
  .string()
  .datetime({ offset: true })
  .refine((value) => Number.isFinite(Date.parse(value)));
export const identitySeat = z.object({ id: uuid, createdAt: instant, revoked: z.literal(false) });
export type IdentitySeat = z.infer<typeof identitySeat>;
export interface PrivateSessionSource {
  userId: string;
  sessions: IdentitySeat[];
}
export function sessionsFor(owner: string, limit: number) {
  return z
    .object({ userId: uuid, sessions: z.array(identitySeat).max(limit) })
    .refine(
      (value) =>
        value.userId === owner &&
        new Set(value.sessions.map((seat) => seat.id)).size === value.sessions.length &&
        value.sessions.every((seat, index, rows) => index === 0 || Date.parse(rows[index - 1]!.createdAt) >= Date.parse(seat.createdAt)),
    );
}
export const revokeResponse = z.object({ userId: uuid, sessionId: uuid, revoked: z.boolean() });
export const revokeMarker = z.object({ requestId: uuid, owner: uuid, seat: identitySeat, createdAt: instant });
export type RevokeMarker = z.infer<typeof revokeMarker>;
export type StoredRevoke = { marker: RevokeMarker | null; failed: boolean };
export const sessionRevokeKey = (owner: string) => 'intafaced.customer.session-revoke.v1:' + owner;
export function readRevoke(owner: string): StoredRevoke {
  try {
    const text = localStorage.getItem(sessionRevokeKey(owner));
    if (text === null) return { marker: null, failed: false };
    const parsed = revokeMarker.safeParse(JSON.parse(text));
    return parsed.success && parsed.data.owner === owner ? { marker: parsed.data, failed: false } : { marker: null, failed: true };
  } catch {
    return { marker: null, failed: true };
  }
}
function sameMarker(a: RevokeMarker, b: RevokeMarker) {
  return (
    a.requestId === b.requestId &&
    a.owner === b.owner &&
    a.createdAt === b.createdAt &&
    a.seat.id === b.seat.id &&
    a.seat.createdAt === b.seat.createdAt &&
    a.seat.revoked === b.seat.revoked
  );
}
export function saveRevoke(marker: RevokeMarker): boolean {
  try {
    localStorage.setItem(sessionRevokeKey(marker.owner), JSON.stringify(marker));
    const saved = readRevoke(marker.owner);
    return !saved.failed && saved.marker?.requestId === marker.requestId && sameMarker(saved.marker, marker);
  } catch {
    return false;
  }
}
/** Only the same bound, known response can remove its own journal. Lists never do. */
export function finishRevoke(marker: RevokeMarker): boolean {
  const saved = readRevoke(marker.owner);
  if (saved.failed || !saved.marker || !sameMarker(saved.marker, marker)) return false;
  try {
    localStorage.removeItem(sessionRevokeKey(marker.owner));
    return localStorage.getItem(sessionRevokeKey(marker.owner)) === null;
  } catch {
    return false;
  }
}

/**
 * The id of the session this browser is signed in with, read from its own access token (a signed token whose middle part
 * carries the session id as "sid"). It is only used to label a row "This device" and to keep that row from being signed
 * out by mistake; the server still decides what any sign-out does. Null when the token is not in that shape.
 */
export function sessionIdFromToken(token: string | null | undefined): string | null {
  try {
    const part = token?.split('.')[1];
    if (!part) return null;
    const padded = part
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(part.length / 4) * 4, '=');
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    const payload: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const sid = payload && typeof payload === 'object' ? (payload as { sid?: unknown }).sid : undefined;
    const parsed = uuid.safeParse(sid);
    return parsed.success ? parsed.data.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** How many of the newest sessions stay in view before "Show N more". */
export const VISIBLE_SESSIONS = 5;

/**
 * The newest five sessions (and this device's own, whatever its age) stay in view; the rest fold behind "Show N more".
 * Order is kept. A start time that cannot be read counts as oldest, never as newest.
 */
export function splitSessions<T extends { id: string; createdAt: string }>(
  seats: readonly T[],
  currentId: string | null,
  visible: number = VISIBLE_SESSIONS,
): { recent: T[]; older: T[] } {
  const time = (seat: T) => {
    const at = Date.parse(seat.createdAt);
    return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
  };
  const newest = new Set(
    seats
      .map((seat, index) => ({ seat, index }))
      .sort((left, right) => time(right.seat) - time(left.seat) || left.index - right.index)
      .slice(0, visible)
      .map(({ seat }) => seat),
  );
  const recent: T[] = [];
  const older: T[] = [];
  for (const seat of seats) (newest.has(seat) || seat.id.toLowerCase() === currentId ? recent : older).push(seat);
  return { recent, older };
}

/**
 * The one "show more" control under the session list. It first unfolds rows already loaded, then asks the server for the next
 * page, and only then offers to fold the older rows away again. The server may hold more only when it filled the page it was
 * asked for.
 */
export function sessionMoreControl(input: {
  hidden: number;
  expanded: boolean;
  returned: number;
  limit: number;
  maxLimit: number;
}): 'unfold' | 'fetch' | 'fold' | 'none' {
  if (input.hidden > 0 && !input.expanded) return 'unfold';
  if (input.returned >= input.limit && input.limit < input.maxLimit) return 'fetch';
  return input.hidden > 0 && input.expanded ? 'fold' : 'none';
}
