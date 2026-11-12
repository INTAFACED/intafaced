/**
 * THE CARD PARTNER A SIGNAL SUBSCRIPTION IS PAID THROUGH (CB-bots-api-signal-04, J-copy-bots-otc-21 #2; OWNER 226).
 *
 * At launch INTAFACED holds no customer money. A person pays for access to a signal by card, through a licensed card
 * partner: the partner takes the payment, holds it, and settles the price to our reserve at that partner. Our ledger
 * records only what is ours: the revenue when the partner takes the payment, and the partner's settlement of it.
 *
 * This is the port. No card partner is named yet, so in production the port is absent and every purchase refuses
 * `market.signal_payment_partner_unset`. On the local TEST stack the TEST partner card stands in for it (below): it
 * approves every payment and settles it at once, each labelled TEST. It is not a partner's answer, and refuses to run
 * outside APP_ENV dev or test.
 */
import { createHash } from 'node:crypto';

export interface CardPaymentRequest {
  /** Our business key for this payment. The partner answers the same key with its first answer, never a second charge. */
  readonly key: string;
  readonly buyerId: string;
  readonly assetId: string;
  /** The price, a decimal string. */
  readonly amount: string;
}

export type CardPaymentAnswer =
  | {
      readonly status: 'approved';
      /** The partner's id for the payment it took. */
      readonly paymentId: string;
      /** The partner's settlement line that paid the price to our reserve there. */
      readonly settlementId: string;
    }
  | { readonly status: 'declined'; readonly code: string };

export interface CardPartner {
  /** Our name for the partner: the reserve the price settles to is `partner-reserve:<id>`. */
  readonly id: string;
  /** True on the TEST partner card: every surface that shows the payment says TEST. */
  readonly test: boolean;
  /** Take one payment under our key. Throws when the answer is not known; the caller asks again with the same key. */
  pay(request: CardPaymentRequest): Promise<CardPaymentAnswer>;
}

export const TEST_CARD_PARTNER_ID = 'test-card';

const ref = (prefix: string, key: string) => `${prefix}-${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;

/**
 * The TEST partner card: approves every payment and settles it at once. Its ids derive from our key, so the same key
 * is always the same payment. TEST only.
 */
export function testCardPartner(appEnv: string | undefined, nodeEnv: string | undefined): CardPartner {
  if ((appEnv !== 'dev' && appEnv !== 'test') || nodeEnv === 'production') {
    throw new Error('MARKET_SIGNAL_CARD_PARTNER=test is the TEST partner card and refuses to start outside APP_ENV=dev or test');
  }
  return {
    id: TEST_CARD_PARTNER_ID,
    test: true,
    async pay(request) {
      return { status: 'approved', paymentId: ref('test-pay', request.key), settlementId: ref('test-settle', request.key) };
    },
  };
}
