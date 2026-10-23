/**
 * Who may start a follow, and with how much (CB-copy-03, CB-copy-04; J-copy-bots-otc-01 #5 and #7).
 *
 * Everything here runs before a follow is read or written:
 * - a sub-account never follows (one role per account);
 * - the follower's verification tier must reach the owner's copy tier, and a blank owner tier refuses every follow;
 * - the reserve (the most this follow may use, in the markets' quote asset) must fit the follower's free spot balance
 *   less what their other follows already reserve.
 *
 * The reserve is a svc-trade limit row, not a ledger hold: nothing posts when it is held, and each copied order still
 * takes its own order hold through the ordinary trade recipes. The follow id comes from the caller's request key, so a
 * second press of the same request returns the same follow instead of a second one.
 */

import { createHash } from 'node:crypto';
import { formatAmount, type Amount, type Balance } from '@intafaced/ledger-client';
import { TIER_ORDER, type Principal } from '@intafaced/auth';
import { CopyError } from './errors.js';

export const COPY_MIN_TIER_KEY = 'TRADE_COPY_MIN_TIER';

export type CopyTier = Exclude<Principal['tier'], 'none'>;

/** The owner's copy tier. Blank is null: every follow refuses until the owner sets it. */
export function parseCopyMinTier(raw: string | null | undefined): CopyTier | null {
  const value = raw?.trim() ?? '';
  if (!value) return null;
  if (value === 'basic' || value === 'full' || value === 'institutional') return value;
  throw new Error(`${COPY_MIN_TIER_KEY} must be basic, full or institutional (got "${value}")`);
}

/** The principal's own facts only. Nothing is read from identity's tables. */
export function assertMayFollow(principal: Pick<Principal, 'tier' | 'sub_account'>, minTier: CopyTier | null): void {
  if (principal.sub_account) {
    throw new CopyError('A sub-account cannot follow a leader. Follow from the main account.', 'trade.copy_subaccount_refused');
  }
  if (minTier === null) {
    throw new CopyError('Copy trading is not available yet: the verification level for copying is not set.', 'trade.copy_tier_unset');
  }
  if (TIER_ORDER[principal.tier] < TIER_ORDER[minTier]) {
    throw new CopyError(`Copy trading needs ${minTier} verification. Your account is at ${principal.tier}.`, 'trade.tier_insufficient');
  }
}

const REQUEST_KEY = /^[A-Za-z0-9:._-]{8,120}$/;

/**
 * The follow id for one request: the same follower, leader and request key always give the same id, so a retried
 * press finds the follow it already made. A UUID shape, so it fits every place a follow id goes.
 */
export function copyFollowIdFor(followerId: string, leaderId: string, clientRequestId: string): string {
  if (!REQUEST_KEY.test(clientRequestId)) {
    throw new CopyError('clientRequestId must be 8 to 120 letters, digits or : . _ -', 'trade.copy_envelope_invalid');
  }
  const hex = createHash('sha256').update(`copy.follow\0${followerId}\0${leaderId}\0${clientRequestId}`).digest('hex');
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Copy runs from the spot balance of the markets' one quote asset. Mixed quotes have no single reserve. */
export function copyQuoteAsset(permittedMarkets: readonly string[]): string {
  const quotes = new Set(
    permittedMarkets.map((symbol) => {
      // Spot symbols are BASE/QUOTE; market ids are BASE-QUOTE.
      const quote = symbol.split(/[/-]/)[1]?.trim();
      if (!quote) throw new CopyError(`${symbol} is not a spot market`, 'trade.copy_envelope_invalid');
      return quote;
    }),
  );
  if (quotes.size !== 1) {
    throw new CopyError('Choose markets that settle in the same asset', 'trade.copy_market_quote_mixed');
  }
  return [...quotes][0]!;
}

/** Free spot balance of one asset: the ledger's available rows, as the balances read shows them. */
export function freeSpotBalance(rows: readonly Balance[], asset: string): Amount {
  let free = 0n;
  for (const row of rows) {
    if (row.account.assetId === asset && row.account.kind === 'available') free += row.amount;
  }
  return free;
}

export function assertReserveFits(input: { amount: Amount; free: Amount; reservedElsewhere: Amount; asset: string }): void {
  const left = input.free > input.reservedElsewhere ? input.free - input.reservedElsewhere : 0n;
  if (input.amount > left) {
    throw new CopyError(
      `The amount for this copy is more than your free ${input.asset}: ${formatAmount(left)} ${input.asset} is free after your other copies.`,
      'trade.copy_reserve_exceeds_balance',
    );
  }
}
