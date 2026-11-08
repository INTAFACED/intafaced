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
 * bridge, not funds; the burn account holds tokens taken out of supply. Neither counts.
 */

export const OWN_FUNDS_OWNER_TYPES = ['house', 'module'] as const;
/** Merchant money in module accounts (the same prefixes as `custody-layer.ts`). */
export const OWN_FUNDS_EXCLUDED_MODULE_PREFIXES = ['pay:clearing:', 'pay:proceeds:'] as const;
/** Tokens debited here have left supply for good: not funds anyone holds. */
export const OWN_FUNDS_EXCLUDED_HOUSE = ['burn'] as const;

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
    if (isCustomerBalanceAccount(r) || (r.ownerType === 'house' && (OWN_FUNDS_EXCLUDED_HOUSE as readonly string[]).includes(r.ownerId))) {
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
