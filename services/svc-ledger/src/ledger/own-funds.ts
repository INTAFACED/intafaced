import { formatAmount, isCustomerBalanceAccount, type Amount } from '@intafaced/ledger-client';
import type { LedgerOwnFunds } from '@intafaced/contracts';

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

export class OwnFundsCustomerRowError extends Error {
  constructor(ownerId: string) {
    super(`the own-funds read returned an account that holds customer money (${ownerId}); nothing was answered`);
    this.name = 'OwnFundsCustomerRowError';
  }
}

export function serializeOwnFunds(asOf: Date, rows: readonly OwnFundsRow[]): LedgerOwnFunds {
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
  };
}
