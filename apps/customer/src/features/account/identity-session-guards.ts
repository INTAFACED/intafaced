import { z } from 'zod';
const uuid = z.string().uuid();
const instant = z
  .string()
  .datetime({ offset: true })
  .refine((value) => Number.isFinite(Date.parse(value)));
// The service lists id and createdAt; a device name, address, last-seen time and a current-session flag are read when it sends them.
export const identitySeat = z.object({
  id: uuid,
  createdAt: instant,
  revoked: z.literal(false),
  device: z.string().max(200).nullish(),
  ip: z.string().max(80).nullish(),
  lastSeenAt: instant.nullish(),
  current: z.boolean().nullish(),
});
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
