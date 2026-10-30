import { ControlError } from '../control/errors.js';

/**
 * M-money-out-02: topping up the business balance.
 *
 * A top-up brings money into the business from outside, so it needs a rail that
 * takes money in for a business and tells svc-pay it arrived. No such rail exists
 * in svc-pay today, so every top-up read refuses with `pay.topup_unconfigured`
 * (412) after the caller's ownership check. Nothing is ever posted from here:
 * the business balance stays what the ledger says, and no instruction (an
 * address, a reference, an amount) is made up. When a rail lands, the credit
 * goes through a `packages/ledger-client` recipe keyed on the rail's own
 * reference, and this read returns what that rail accepts.
 */
export function refuseTopUpUnwired(): never {
  throw new ControlError('pay.topup_unconfigured');
}
