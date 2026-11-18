import { formatAmount, isCustomerBalanceAccount, isOwnFundsPlace, OWN_FUNDS_PLACE_PREFIXES, type Amount } from '@intafaced/ledger-client';
import type { LedgerOwnFunds, LedgerOwnFundsPlace, OwnFundsPlaceKind } from '@intafaced/contracts';

/**
 * INTAFACED'S OWN FUNDS: every house and module account with a balance, for svc-ops' capital monitor (J-ops-console-24 #1).
 *
 * A READ, like `feeRevenue`: no lock, no write, no path into `post()`. The one caller is svc-ops.
 *
 * What counts as ours is the custody switch's own split (`isCustomerBalanceAccount`, OWNER 226): an account a person or
 * their sub-account owns, and a merchant's clearing or proceeds pot, hold a customer's money and are never counted. The
 * query leaves them out, and `serializeOwnFunds` checks every row again with the same function, so a query that drifted
 * from it would refuse rather than count customer money as ours. Treasury accounts are the outside side of a rail or a
 * bridge, not funds. Pots that hold someone else's money outside that split are left out too (the lists below).
 *
 * THE NAMED PLACES (project-state OWNER.md item 288; b2 change 3): our own money that sits outside our own book is at a
 * named place, one `treasury` account per place and asset (`isOwnFundsPlace`: our builder account at a venue, a reserve
 * at a partner, our treasury wallet). Its negative balance is what the book shows of ours there. The read answers every
 * place it has an account for, in the same snapshot, so svc-ops can set each beside the outside figure it is checked
 * against. A place is never a customer's account, and `serializeOwnFunds` refuses a row that is not a place.
 */

export const OWN_FUNDS_OWNER_TYPES = ['house', 'module'] as const;
/**
 * Module pots that hold someone else's money: a merchant's (the same prefixes as `custody-layer.ts`), a customer's balance
 * taken off them under a confirmed staff hold (`ops:hold-confirm:*`, whose owner decides where it goes), and a customer's
 * locked campaign reward (`campaigns:lock:*`, owed to them on unlock).
 */
export const OWN_FUNDS_EXCLUDED_MODULE_PREFIXES = ['pay:clearing:', 'pay:proceeds:', 'ops:hold-confirm:', 'campaigns:lock:'] as const;
/**
 * House pots that are not funds of ours: the burn account (tokens out of supply for good) and the futures clearing pot
 * (`futures-loss`), which traders' realised losses pay into and their realised profits are paid out of.
 */
export const OWN_FUNDS_EXCLUDED_HOUSE = ['burn', 'futures-loss'] as const;

/** True for an account the own-funds read must never count. */
export function excludedFromOwnFunds(r: Pick<OwnFundsRow, 'ownerType' | 'ownerId'>): boolean {
  if (isCustomerBalanceAccount(r)) return true;
  if (r.ownerType === 'house') return (OWN_FUNDS_EXCLUDED_HOUSE as readonly string[]).includes(r.ownerId);
  return OWN_FUNDS_EXCLUDED_MODULE_PREFIXES.some((p) => r.ownerId.startsWith(p));
}

export interface OwnFundsRow {
  readonly ownerType: 'house' | 'module';
  readonly ownerId: string;
  readonly assetId: string;
  readonly kind: string;
  readonly purpose: string;
  readonly balance: Amount;
}

/** One own-funds place as the ledger reads it: its account and its balance (zero or below; the negative is ours). */
export interface OwnFundsPlaceRow {
  readonly ownerId: string;
  readonly assetId: string;
  readonly balance: Amount;
}

const PLACE_KIND: Readonly<Record<(typeof OWN_FUNDS_PLACE_PREFIXES)[number], OwnFundsPlaceKind>> = {
  'venue-builder-account:': 'venue_builder_account',
  'partner-reserve:': 'partner_reserve',
  'treasury-wallet:': 'treasury_wallet',
};

export class OwnFundsPlaceRowError extends Error {
  constructor(ownerId: string, why: string) {
    super(`the own-funds read returned a place row it cannot answer for (${ownerId}: ${why}); nothing was answered`);
    this.name = 'OwnFundsPlaceRowError';
  }
}

/** The place a row is, by its prefix, with what the book shows of ours there. Refuses a row that is not a place. */
export function placeOf(r: OwnFundsPlaceRow): LedgerOwnFundsPlace {
  if (!isOwnFundsPlace({ ownerType: 'treasury', ownerId: r.ownerId })) throw new OwnFundsPlaceRowError(r.ownerId, 'not an own-funds place');
  // A place may never go above zero (`balanceAllowed`), so a positive balance is a book this read must not answer for.
  if (r.balance > 0n) throw new OwnFundsPlaceRowError(r.ownerId, 'a place shows less than nothing of ours');
  const prefix = OWN_FUNDS_PLACE_PREFIXES.find((p) => r.ownerId.startsWith(p))!;
  const placeId = r.ownerId.slice(prefix.length);
  if (placeId === '') throw new OwnFundsPlaceRowError(r.ownerId, 'the place has no id');
  return { kind: PLACE_KIND[prefix], placeId, assetId: r.assetId, held: formatAmount(-r.balance) };
}

export class OwnFundsCustomerRowError extends Error {
  constructor(ownerId: string) {
    super(`the own-funds read returned an account that holds customer money (${ownerId}); nothing was answered`);
    this.name = 'OwnFundsCustomerRowError';
  }
}

export function serializeOwnFunds(asOf: Date, rows: readonly OwnFundsRow[], places: readonly OwnFundsPlaceRow[]): LedgerOwnFunds {
  for (const r of rows) {
    if (excludedFromOwnFunds(r)) {
      throw new OwnFundsCustomerRowError(r.ownerId);
    }
  }
  return {
    asOf: asOf.toISOString(),
    accounts: rows
      .filter((r) => r.balance > 0n)
      .map((r) => ({
        ownerType: r.ownerType,
        ownerId: r.ownerId,
        assetId: r.assetId,
        kind: r.kind,
        purpose: r.purpose,
        balance: formatAmount(r.balance),
      })),
    places: places.map(placeOf),
  };
}
