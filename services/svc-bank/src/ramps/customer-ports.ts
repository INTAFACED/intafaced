/**
 * Ports for customer ramp quotes. Production leaves every one unset.
 *
 * A quote, a fee, and a hosted payment URL come from the port or they are not
 * returned. This service does not price a spread, invent a zero fee, or build
 * a checkout URL from a rail id.
 */

/** `pay_by_bank` is a hosted bank-payment page, like card and wallet: the partner returns where to pay. */
export const ONRAMP_METHODS = ['card', 'bank_transfer', 'pay_by_bank', 'wallet_pay'] as const;
export type OnrampMethod = (typeof ONRAMP_METHODS)[number];

export interface OnrampQuoteTerms {
  payAmount: string;
  fee: string;
  rate: string;
  payCurrency: string;
  expiresAt: Date;
  /** How long the money takes to arrive, in the source's words. Absent: the source did not say, and none is made up. */
  deliveryEstimate?: string | null;
}

export interface OnrampQuoteSource {
  quote(input: { assetId: string; amount: string; method: OnrampMethod; country: string }): Promise<OnrampQuoteTerms | null>;
}

export interface OnrampBankInstruction {
  reference: string;
  accountName: string;
  accountRef: string;
}

export interface OnrampPaymentInstruction {
  partnerRail: string;
  hostedUrl?: string | null;
  bank?: OnrampBankInstruction | null;
}

export interface OnrampPaymentPort {
  open(input: {
    onrampId: string;
    quoteId: string;
    method: OnrampMethod;
    userId: string;
    assetId: string;
    amount: string;
  }): Promise<OnrampPaymentInstruction | null>;
}

export interface OfframpFeeTerms {
  fee: string;
  netAmount: string;
  expiresAt: Date;
}

export interface OfframpFeeSource {
  quote(input: { assetId: string; amount: string; kind: 'crypto' | 'fiat'; destinationRef: string }): Promise<OfframpFeeTerms | null>;
}
