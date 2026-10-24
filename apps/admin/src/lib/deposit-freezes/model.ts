import { DEPOSIT_ADDRESS, NETWORK_ID, REASON_MAX, REASON_MIN, UUID } from '@/lib/desk/approval-packet';

/**
 * A compliance freeze on one customer deposit address (W-compliance-notices-03, J-wallet-03 #4), as this console asks for it.
 *
 * Placing a freeze is one founder with a reason: it moves no money, it only holds deposits that are not credited yet. Lifting it
 * is the two-founder desk request `pay.deposit_address.unfreeze`, because a lift credits what the freeze held.
 *
 * Pure, so the browser builds the request with the same rules the server checks.
 */

export interface DepositFreezeRequest {
  readonly userId: string;
  readonly networkId: string;
  readonly address: string;
  readonly reason: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/** Strict reader. The reason is trimmed the way svc-pay keeps it; anything off-shape is null. */
export function readFreezeRequest(raw: unknown): DepositFreezeRequest | null {
  if (!isRecord(raw) || Object.keys(raw).sort().join(',') !== 'address,networkId,reason,userId') return null;
  if (typeof raw.userId !== 'string' || !UUID.test(raw.userId)) return null;
  if (typeof raw.networkId !== 'string' || !NETWORK_ID.test(raw.networkId)) return null;
  if (typeof raw.address !== 'string' || !DEPOSIT_ADDRESS.test(raw.address)) return null;
  if (typeof raw.reason !== 'string') return null;
  const reason = raw.reason.trim();
  if (reason.length < REASON_MIN || reason.length > REASON_MAX) return null;
  return { userId: raw.userId, networkId: raw.networkId, address: raw.address, reason };
}

export interface FreezeOutcome {
  readonly held: number;
  readonly creditedUntouched: number;
}

/** What the founder reads after a freeze. A credited deposit (or one whose credit already started) is never undone here: that is the account freeze, at identity. */
export function freezeDetail(address: string, outcome: FreezeOutcome): string {
  const held =
    outcome.held === 0
      ? 'No deposit to it was on its way, so nothing was held now; any that arrives is held until the freeze is lifted.'
      : `${outcome.held} deposit${outcome.held === 1 ? '' : 's'} on the way to it ${outcome.held === 1 ? 'is' : 'are'} on hold and not credited.`;
  const credited =
    outcome.creditedUntouched === 0
      ? ''
      : ` ${outcome.creditedUntouched} deposit${outcome.creditedUntouched === 1 ? ' was' : 's were'} already credited (or being credited) and stay${outcome.creditedUntouched === 1 ? 's' : ''} as ${outcome.creditedUntouched === 1 ? 'it is' : 'they are'}: to stop money already in the account, freeze the account under Account controls.`;
  return `svc-pay froze deposit address ${address}. ${held}${credited}`;
}

/** What the founder reads after the lift ran. */
export function unfreezeDetail(address: string, released: number, credited: number): string {
  if (released === 0) return `svc-pay lifted the freeze on ${address}. No deposit was held by it.`;
  const waiting = released - credited;
  return `svc-pay lifted the freeze on ${address}. ${credited} held deposit${credited === 1 ? ' was' : 's were'} credited once${
    waiting > 0 ? `; ${waiting} still wait${waiting === 1 ? 's' : ''} for confirmations or a retry and will be credited once` : ''
  }.`;
}

export interface FreezeAnswer {
  readonly freezeId: string;
  readonly userId: string;
  readonly networkId: string;
  readonly address: string;
}

const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function readFreezeView(raw: unknown): FreezeAnswer | null {
  if (!isRecord(raw)) return null;
  const { id, userId, networkId, address } = raw;
  if (typeof id !== 'string' || typeof userId !== 'string' || typeof networkId !== 'string' || typeof address !== 'string') return null;
  return { freezeId: id, userId, networkId, address };
}

/** svc-pay's `founderAdmin.depositFreezes.freeze` answer, or null when it is not that shape. */
export function readFreezeAnswer(raw: unknown): (FreezeAnswer & FreezeOutcome) | null {
  if (!isRecord(raw) || !count(raw.held) || !count(raw.creditedUntouched)) return null;
  const freeze = readFreezeView(raw.freeze);
  return freeze ? { ...freeze, held: raw.held, creditedUntouched: raw.creditedUntouched } : null;
}

/** svc-pay's `founderAdmin.depositFreezes.unfreeze` answer, or null when it is not that shape. */
export function readUnfreezeAnswer(raw: unknown): (FreezeAnswer & { released: number; credited: number }) | null {
  if (!isRecord(raw) || !count(raw.released) || !count(raw.credited) || raw.credited > raw.released) return null;
  const freeze = readFreezeView(raw.freeze);
  return freeze ? { ...freeze, released: raw.released, credited: raw.credited } : null;
}
