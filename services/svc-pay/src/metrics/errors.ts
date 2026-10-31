import { TRPCError } from '@intafaced/contracts';

/**
 * Refusals of the metrics read model. `code` reaches the client as
 * `error.data.cause.code` (the contracts error formatter copies it).
 */
export type MetricsErrorCode =
  /** The merchant id does not exist OR the caller may not see it: one answer for both (M1). */
  | 'pay.merchant_not_found'
  | 'pay.metrics_window_invalid'
  | 'pay.metrics_window_unaligned'
  | 'pay.metrics_window_too_wide'
  | 'pay.metrics_cursor_invalid'
  | 'pay.metrics_filter_invalid'
  /** `tierId` filter: tiers belong to the control room (W1), which has not landed. */
  | 'pay.metrics_filter_unsupported'
  /** The ledger could not be read, so balances cannot be stated. Never zero-filled. */
  | 'pay.metrics_balance_unavailable'
  /** No list of assets a business can settle in is set (`PAY_SETTLEMENT_ASSETS` blank). Never a guessed list. */
  | 'pay.settlement_assets_unset';

export class MetricsError extends Error {
  constructor(
    readonly code: MetricsErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = 'MetricsError';
  }
}

/** The single not-found answer. Carries no id, so an unknown id and someone else's id are byte-identical. */
export const merchantNotFound = () => new MetricsError('pay.merchant_not_found', 'pay.merchant_not_found');

export function metricsToTrpcError(err: unknown): unknown {
  if (err instanceof TRPCError) return err;
  if (err instanceof MetricsError) {
    const code =
      err.code === 'pay.merchant_not_found'
        ? 'NOT_FOUND'
        : err.code === 'pay.metrics_balance_unavailable'
          ? 'SERVICE_UNAVAILABLE'
          : err.code === 'pay.settlement_assets_unset'
            ? 'PRECONDITION_FAILED'
            : 'BAD_REQUEST';
    return new TRPCError({ code, message: err.message, cause: err });
  }
  return err;
}
