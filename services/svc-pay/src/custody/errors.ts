import { TRPCError } from '@intafaced/contracts';

export type CustodyErrorCode =
  | 'custody.entity_not_found'
  | 'custody.entity_differs'
  | 'custody.vault_not_found'
  | 'custody.vault_differs'
  | 'custody.name_taken'
  | 'custody.version_conflict'
  | 'custody.network_unknown'
  | 'custody.asset_not_on_network'
  | 'custody.wallet_not_found'
  | 'custody.address_not_found'
  | 'custody.customer_already_has_entity';

const KIND: Record<CustodyErrorCode, TRPCError['code']> = {
  'custody.entity_not_found': 'NOT_FOUND',
  'custody.entity_differs': 'CONFLICT',
  'custody.vault_not_found': 'NOT_FOUND',
  'custody.vault_differs': 'CONFLICT',
  'custody.name_taken': 'CONFLICT',
  'custody.version_conflict': 'CONFLICT',
  'custody.network_unknown': 'BAD_REQUEST',
  'custody.asset_not_on_network': 'BAD_REQUEST',
  'custody.wallet_not_found': 'NOT_FOUND',
  'custody.address_not_found': 'NOT_FOUND',
  'custody.customer_already_has_entity': 'CONFLICT',
};

/** One typed refusal per rule. `code` reaches the client as `error.data.cause.code`. */
export class CustodyError extends Error {
  constructor(
    readonly code: CustodyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CustodyError';
  }
}

export function custodyToTrpcError(error: unknown): unknown {
  if (error instanceof TRPCError) return error;
  if (error instanceof CustodyError) {
    return new TRPCError({ code: KIND[error.code], message: `${error.code}: ${error.message}`, cause: error });
  }
  return error;
}
