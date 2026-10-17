import type { Sql } from 'postgres';
import { PAY_RESERVE_NOT_ENFORCED } from '@intafaced/contracts';
import { ControlError } from './errors.js';
import { effectiveReserve, loadMerchantControl } from './store.js';

/**
 * ROLLING RESERVE: the ledger side.
 *
 * The amount is computed at settlement and stored on the pricing snapshot
 * (`reserve_amount`, `reserve_release_at`, `reserve_ledger_status = 'unwired'`).
 * No recipe in packages/ledger-client books a merchant rolling reserve
 * (`loanReserveFund` is the lending book, not this one), and a second money
 * book is out (AGENTS.md, Money 3). So holding the reserve back from a payout,
 * and releasing it on `reserve_release_at`, is refused with a typed error until
 * the ledger owner adds a recipe. Nothing here invents one.
 *
 * `set_reserve` with a percentage refuses with `pay.reserve_ledger_unwired`.
 * A fresh payout for a merchant who already has one refuses the same way,
 * before any admission. A resumed admission finishes under the net it was
 * admitted with. Clearing a reserve (both fields null) still applies.
 * Existing rows are not rewritten.
 */
export const RESERVE_NOT_ENFORCED = PAY_RESERVE_NOT_ENFORCED;

const UNWIRED = 'no ledger recipe books a merchant rolling reserve yet';

/** A configured percentage cannot be saved until a ledger recipe books it. Null/null is a clear and is allowed. */
export function assertReserveMayBeConfigured(reserve: { rollingReserveBps: number | null; holdDays: number | null }): void {
  if (reserve.rollingReserveBps !== null || reserve.holdDays !== null) {
    throw new ControlError('pay.reserve_ledger_unwired', UNWIRED);
  }
}

/**
 * A fresh payout for a reserved merchant is refused before any admission.
 * A resumed admission finishes under the net it was admitted with; callers
 * run this only when no admission existed at entry. There is no recipe to
 * hold the reserved part, so a non-null reserve must not leave as the full net.
 *
 * A database that has not migrated the control tables has no reserve rows.
 * That is "no reserve", and the payout continues. Any other read failure still
 * refuses the payout.
 */
export async function assertPayoutReserveWired(sql: Sql, merchantId: string): Promise<void> {
  let control;
  try {
    control = await loadMerchantControl(sql, merchantId);
  } catch (error) {
    if (missingControlTables(error)) return;
    throw error;
  }
  if (effectiveReserve(control) !== null) throw new ControlError('pay.reserve_ledger_unwired', UNWIRED);
}

/** Undefined-table on the W1 control tables only. Any other relation is a real fault. */
function missingControlTables(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ((error as { code?: unknown }).code !== '42P01') return false;
  const message = error instanceof Error ? error.message : '';
  return message.includes('pay.control_merchant_profiles') || message.includes('pay.control_tiers');
}

export interface ReserveLedgerPort {
  hold(input: { settlementId: string; merchantId: string; assetCode: string; amount: string }): Promise<void>;
  release(input: { settlementId: string; merchantId: string; assetCode: string; amount: string }): Promise<void>;
}

export const unwiredReserveLedger: ReserveLedgerPort = {
  async hold() {
    throw new ControlError('pay.reserve_ledger_unwired', 'no ledger recipe books a merchant rolling reserve yet');
  },
  async release() {
    throw new ControlError('pay.reserve_ledger_unwired', 'no ledger recipe books a merchant rolling reserve yet');
  },
};
