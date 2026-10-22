/**
 * M-payments-core-02 (partial): one fixed map from the payment status enum to
 * a plain-language state, derived only from fields a payment already has.
 * The enum itself is unchanged. Failure sentences come only from the
 * catalogue in merchant-failure.ts (ENGINE-SPEC PI-8). Reads nothing, posts nothing.
 */
import { safeFailure, type MerchantFailure } from './merchant-failure.js';

export const PAYMENT_STATUSES = ['created', 'authorized', 'captured', 'settled', 'refunded', 'disputed', 'failed'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export type PlainStateKey =
  | 'needs_customer_action'
  | 'waiting_for_confirmations'
  | 'authorised_not_captured'
  | 'checking_with_rail'
  | 'paid'
  | 'settled'
  | 'refunded'
  | 'disputed'
  | 'failed';

export interface PlainState {
  key: PlainStateKey;
  label: string;
  sentence: string;
  /** Only for waiting_for_confirmations, and only when both counts are known. */
  confirmations?: { seen: number; required: number };
  failure?: MerchantFailure;
}

const TEXT: Record<PlainStateKey, { label: string; sentence: string }> = {
  needs_customer_action: { label: 'Needs customer action', sentence: 'The customer has not paid yet.' },
  waiting_for_confirmations: {
    label: 'Waiting for confirmations',
    sentence: 'The transfer arrived and is waiting for network confirmations.',
  },
  authorised_not_captured: { label: 'Authorised, not captured', sentence: 'The payment is authorised; capture it to collect the money.' },
  checking_with_rail: { label: 'Checking with the rail', sentence: 'The rail has not told us the result yet. Nothing is marked failed.' },
  paid: { label: 'Paid', sentence: 'The money was collected and is waiting to settle.' },
  settled: { label: 'Settled', sentence: 'The money settled to your balance.' },
  refunded: { label: 'Refunded', sentence: 'The payment was refunded.' },
  disputed: { label: 'Disputed', sentence: 'The customer opened a dispute on this payment.' },
  failed: { label: 'Failed', sentence: 'The payment could not be completed.' },
};

export interface PlainStateInput {
  status: PaymentStatus;
  /** Raw failure code on the payment, if any. */
  failureReason?: string | null;
  /** Chain transfer seen for this payment, with its confirmation counts if known. */
  chainTransfer?: { confirmations: number | null; required: number | null } | null;
  /** True when the last authorise/capture call to the rail has no known outcome. */
  railOutcomeUnknown?: boolean;
}

function make(key: PlainStateKey, extra: Partial<PlainState> = {}): PlainState {
  return { key, ...TEXT[key], ...extra };
}

export function plainPaymentState(input: PlainStateInput): PlainState {
  switch (input.status) {
    case 'created': {
      if (input.railOutcomeUnknown) return make('checking_with_rail');
      const t = input.chainTransfer;
      if (t) {
        const known = Number.isInteger(t.confirmations) && Number.isInteger(t.required);
        return make('waiting_for_confirmations', known ? { confirmations: { seen: t.confirmations!, required: t.required! } } : {});
      }
      return make('needs_customer_action');
    }
    case 'authorized':
      return input.railOutcomeUnknown ? make('checking_with_rail') : make('authorised_not_captured');
    case 'captured':
      return make('paid');
    case 'settled':
      return make('settled');
    case 'refunded':
      return make('refunded');
    case 'disputed':
      return make('disputed');
    case 'failed': {
      const failure = safeFailure(input.failureReason) ?? safeFailure('pay.failed')!;
      return make('failed', { sentence: failure.message, failure });
    }
  }
}
