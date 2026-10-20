import { TRPCError } from '@intafaced/contracts';

export type CustodyUtxoErrorCode =
  | 'rail.crypto'
  | 'utxo.wallet_not_found'
  | 'utxo.wallet_has_no_address'
  | 'utxo.not_found'
  | 'utxo.not_labellable'
  | 'utxo.network_unknown'
  | 'utxo.triggers_unset'
  | 'utxo.confirmations_unset'
  | 'utxo.not_due'
  | 'utxo.nothing_to_consolidate'
  | 'utxo.intent_differs'
  | 'utxo.outcome_unknown'
  | 'utxo.node_failed';

const KIND: Record<CustodyUtxoErrorCode, TRPCError['code']> = {
  'rail.crypto': 'SERVICE_UNAVAILABLE',
  'utxo.wallet_not_found': 'NOT_FOUND',
  'utxo.wallet_has_no_address': 'PRECONDITION_FAILED',
  'utxo.not_found': 'NOT_FOUND',
  'utxo.not_labellable': 'CONFLICT',
  'utxo.network_unknown': 'BAD_REQUEST',
  'utxo.triggers_unset': 'PRECONDITION_FAILED',
  'utxo.confirmations_unset': 'PRECONDITION_FAILED',
  'utxo.not_due': 'PRECONDITION_FAILED',
  'utxo.nothing_to_consolidate': 'PRECONDITION_FAILED',
  'utxo.intent_differs': 'CONFLICT',
  'utxo.outcome_unknown': 'SERVICE_UNAVAILABLE',
  'utxo.node_failed': 'SERVICE_UNAVAILABLE',
};

/** One typed refusal per rule. `code` reaches the client as `error.data.cause.code`. */
export class CustodyUtxoError extends Error {
  constructor(
    readonly code: CustodyUtxoErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CustodyUtxoError';
  }
}

export function custodyUtxoToTrpcError(error: unknown): unknown {
  if (error instanceof TRPCError) return error;
  if (error instanceof CustodyUtxoError) {
    return new TRPCError({ code: KIND[error.code], message: `${error.code}: ${error.message}`, cause: error });
  }
  return error;
}
