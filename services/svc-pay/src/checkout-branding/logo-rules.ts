import { CHECKOUT_LOGO_MAX_BYTES_CEILING } from '@intafaced/contracts';
import { readImageByteRule } from '../catalog/image-rules.js';

/**
 * The owner's rule for hosted checkout logos (M-payments-core-08, J-merchant-04 step 1): the largest logo a business may
 * save, in bytes. Blank means no size is published, and every logo refuses `pay.checkout_logo_rules_unset`; a brand
 * colour can still be saved. Never a guessed default.
 */
export const CHECKOUT_LOGO_MAX_BYTES_ENV = 'PAY_CHECKOUT_LOGO_MAX_BYTES';

export interface CheckoutLogoRule {
  readonly maxBytes: number | null;
}

/** A whole number of bytes from 1 to the ceiling (200 000), or blank. Anything else refuses to boot. */
export function readCheckoutLogoRule(env: Record<string, string | undefined>): CheckoutLogoRule {
  return readImageByteRule(env, CHECKOUT_LOGO_MAX_BYTES_ENV, CHECKOUT_LOGO_MAX_BYTES_CEILING);
}
