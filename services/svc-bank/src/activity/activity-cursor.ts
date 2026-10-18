import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

/**
 * THE COMPOSITE CURSOR for `bank.activity.list`.
 *
 * A user's history is read from several ledger owners (their account and each
 * named Space), each with its own opaque ledger cursor. The page cursor carries
 * where every one of them stopped.
 *
 * WHAT STOPS IT BEING REPOINTED. The cursor is `payload.signature`, the
 * signature an HMAC-SHA256 over the payload under a key HKDF-derived from the
 * service secret (so the raw secret never signs anything it also signs elsewhere). It binds
 * the user id and the asset filter, so a cursor cannot be moved to another
 * user, another asset filter, or edited to name a different position. And it
 * never decides WHICH owners are read: the owner list is rebuilt from the
 * session on every call, and the cursor only supplies a position for owners the
 * session already has. A valid cursor for owner X is simply ignored if the
 * session does not own X. A cursor is a bookmark, not a key.
 *
 * Position per owner: a ledger cursor string (resume after it), `null` (not
 * started, read from the newest), or `false` (nothing older, skip).
 */

export type OwnerPosition = string | null | false;

export interface CursorBody {
  readonly userId: string;
  readonly assetId: string | null;
  readonly owners: Readonly<Record<string, OwnerPosition>>;
  /** Set only for a filtered page, so an unfiltered bookmark cannot skip a filtered one. */
  readonly filterKey?: string;
  /** Matching rows already returned from this owner position. Unfiltered cursors omit it. */
  readonly skip?: number;
}

export class ActivityCursorInvalidError extends Error {
  constructor() {
    super('Activity cursor is not valid, start again without a cursor');
    this.name = 'ActivityCursorInvalidError';
  }
}

/** HKDF `info`: the cursor key is derived from the service secret, never the raw secret itself. */
export const CURSOR_KEY_INFO = 'bank.activity.cursor.v1';
const MAX_CURSOR_LENGTH = 16_384;

const keyCache = new Map<string, Buffer>();

/** HKDF-SHA256 (RFC 5869) of the service secret, empty salt, `info` = {@link CURSOR_KEY_INFO}. */
export function deriveCursorKey(secret: string): Buffer {
  let key = keyCache.get(secret);
  if (key === undefined) {
    key = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), CURSOR_KEY_INFO, 32));
    keyCache.set(secret, key);
  }
  return key;
}

function sign(secret: string, payload: string): Buffer {
  return createHmac('sha256', deriveCursorKey(secret)).update(payload).digest();
}

export function encodeCursor(secret: string, body: CursorBody): string {
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      u: body.userId,
      a: body.assetId,
      o: body.owners,
      ...(body.filterKey ? { f: body.filterKey } : {}),
      ...(body.skip ? { s: body.skip } : {}),
    }),
    'utf8',
  ).toString('base64url');
  return `${payload}.${sign(secret, payload).toString('base64url')}`;
}

/** Throws `ActivityCursorInvalidError` unless the cursor is ours, intact, and issued to this user for this filter. */
export function decodeCursor(
  secret: string,
  cursor: string,
  expected: { userId: string; assetId: string | null; filterKey?: string | null },
): CursorBody {
  if (cursor.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cursor)) throw new ActivityCursorInvalidError();
  const [payload, mac] = cursor.split('.') as [string, string];
  const given = Buffer.from(mac, 'base64url');
  const want = sign(secret, payload);
  if (given.length !== want.length || !timingSafeEqual(given, want)) throw new ActivityCursorInvalidError();

  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new ActivityCursorInvalidError();
  }
  if (raw === null || typeof raw !== 'object') throw new ActivityCursorInvalidError();
  const r = raw as { v?: unknown; u?: unknown; a?: unknown; o?: unknown; f?: unknown; s?: unknown };
  if (r.v !== 1 || r.u !== expected.userId || (r.a ?? null) !== expected.assetId) throw new ActivityCursorInvalidError();
  if (r.o === null || typeof r.o !== 'object' || Array.isArray(r.o)) throw new ActivityCursorInvalidError();
  const storedFilter = typeof r.f === 'string' ? r.f : null;
  if (storedFilter !== (expected.filterKey ?? null)) throw new ActivityCursorInvalidError();
  const skip = r.s === undefined ? 0 : r.s;
  if (typeof skip !== 'number' || !Number.isInteger(skip) || skip < 0 || skip > 100_000) throw new ActivityCursorInvalidError();
  if (skip > 0 && storedFilter === null) throw new ActivityCursorInvalidError();

  const owners: Record<string, OwnerPosition> = {};
  for (const [key, pos] of Object.entries(r.o as Record<string, unknown>)) {
    if (pos !== null && pos !== false && typeof pos !== 'string') throw new ActivityCursorInvalidError();
    owners[key] = pos;
  }
  return {
    userId: r.u,
    assetId: expected.assetId,
    owners,
    ...(storedFilter ? { filterKey: storedFilter } : {}),
    ...(skip ? { skip } : {}),
  };
}
