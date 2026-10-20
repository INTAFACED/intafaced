import { TRPCError } from '@intafaced/contracts';

export type PurchaseHoldErrorCode = 'purchase_hold.amount_invalid' | 'purchase_hold.ref_differs';

const KIND: Record<PurchaseHoldErrorCode, TRPCError['code']> = {
  'purchase_hold.amount_invalid': 'BAD_REQUEST',
  'purchase_hold.ref_differs': 'CONFLICT',
};

/** One typed refusal per rule. `code` reaches the client as `error.data.cause.code`. */
export class PurchaseHoldError extends Error {
  constructor(
    readonly code: PurchaseHoldErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PurchaseHoldError';
  }
}

export function purchaseHoldToTrpcError(error: unknown): unknown {
  if (error instanceof TRPCError) return error;
  if (error instanceof PurchaseHoldError) {
    return new TRPCError({ code: KIND[error.code], message: `${error.code}: ${error.message}`, cause: error });
  }
  return error;
}
