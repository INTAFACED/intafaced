import { ControlError } from './errors.js';

/**
 * ROLLING RESERVE: the ledger side.
 *
 * The amount is computed at settlement and stored on the pricing snapshot
 * (`reserve_amount`, `reserve_release_at`, `reserve_ledger_status = 'unwired'`).
 * No recipe in packages/ledger-client books a merchant rolling reserve, and a
 * second money book is out (AGENTS.md, Money 3). So holding the reserve back
 * from a payout, and releasing it on `reserve_release_at`, is refused with a
 * typed error until the ledger owner adds a recipe. Nothing here invents one.
 */
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
