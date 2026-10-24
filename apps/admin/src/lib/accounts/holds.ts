import {
  STAFF_HOLD_AMOUNT_PATTERN,
  STAFF_HOLD_ASSET_PATTERN,
  STAFF_HOLD_REASON_MAX,
  staffHoldListInputSchema,
  type StaffHold,
  type StaffHoldMovement,
  type StaffHoldState,
} from '@intafaced/contracts/ops-staff-holds';

/**
 * Staff holds on one customer's funds, as the console shows them (OPS-accounts-desk-01, J-ops-console-04 #2-#5). svc-ops keeps
 * the hold and posts it in the ledger; the console only asks and shows what svc-ops answered. Pure, so the page and the routes
 * read a place form the same way.
 */

export const HOLD_STATE_LABEL: Readonly<Record<StaffHoldState, string>> = {
  placing: 'Being placed: the ledger has not answered yet',
  active: 'Held',
  partially_released: 'Partly released',
  released: 'Released',
  confirmed: 'Confirmed: moved to the owner-named account',
  expired: 'Released when it expired',
  refused: 'Refused by the ledger: nothing is held',
};

const MOVEMENT_LABEL: Readonly<Record<StaffHoldMovement['kind'], string>> = { place: 'Hold', release: 'Release', confirm: 'Confirm' };

const STATUS_LABEL: Readonly<Record<StaffHoldMovement['status'], string>> = {
  posted: 'posted',
  refused: 'refused',
  settling: 'waiting for the ledger’s answer',
  pending_retry: 'waiting to be sent again',
};

export function movementLine(m: StaffHoldMovement): string {
  const who = m.cause === 'expiry' ? 'the expiry, no approver' : m.approverId ? `approved by ${m.approverId.slice(0, 8)}` : 'one founder';
  const code = m.code ? ` (${m.code})` : '';
  return `${MOVEMENT_LABEL[m.kind]} ${m.no}: ${m.amount}, ${who}, ${STATUS_LABEL[m.status]}${code}`;
}

/** Release and confirm are open only on a hold that still holds something and has nothing settling. */
export function holdActionable(hold: StaffHold): boolean {
  const open = hold.movements.some((m) => m.status === 'settling' || m.status === 'pending_retry');
  return (hold.state === 'active' || hold.state === 'partially_released') && !open;
}

export interface PlaceForm {
  readonly userId: string;
  readonly assetId: string;
  readonly amount: string;
  readonly reason: string;
  readonly expiresInHours: number | null;
  readonly idempotencyKey: string;
}

/**
 * The business key of the next hold placed on an account: the account and the newest hold the founder saw on it (0 for none).
 * A retry, a reload or a second tab reading the same list sends the same key, so svc-ops returns the hold it stored rather
 * than place a second one; once the list shows that hold, the next place gets the next key.
 */
export function placeKey(userId: string, holds: readonly Pick<StaffHold, 'holdNo'>[]): string {
  const newest = holds.reduce((max, h) => (BigInt(h.holdNo) > max ? BigInt(h.holdNo) : max), 0n);
  return `console:hold:${userId}:after:${newest}`;
}

const KEY = /^console:hold:([0-9a-f-]{36}):after:(0|[1-9][0-9]{0,18})$/;

/** The place form exactly as svc-ops takes it, or null. The key must be this account's own place key (`placeKey`). */
export function readPlaceForm(raw: unknown): PlaceForm | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).sort().join(',') !== 'amount,assetId,expiresInHours,idempotencyKey,reason,userId') return null;
  if (typeof r.userId !== 'string' || !staffHoldListInputSchema.safeParse({ userId: r.userId }).success) return null;
  if (typeof r.assetId !== 'string' || !STAFF_HOLD_ASSET_PATTERN.test(r.assetId)) return null;
  if (typeof r.amount !== 'string' || !STAFF_HOLD_AMOUNT_PATTERN.test(r.amount) || !/[1-9]/.test(r.amount)) return null;
  if (typeof r.reason !== 'string' || r.reason.trim() !== r.reason || r.reason.length < 1 || r.reason.length > STAFF_HOLD_REASON_MAX)
    return null;
  const hours = r.expiresInHours;
  if (!(hours === null || (typeof hours === 'number' && Number.isInteger(hours) && hours >= 1 && hours <= 8760))) return null;
  if (typeof r.idempotencyKey !== 'string' || KEY.exec(r.idempotencyKey)?.[1] !== r.userId) return null;
  return {
    userId: r.userId,
    assetId: r.assetId,
    amount: r.amount,
    reason: r.reason,
    expiresInHours: hours,
    idempotencyKey: r.idempotencyKey,
  };
}
