import { TRPCError } from '@intafaced/contracts';
import { DualControlError } from '../dual-control.js';
import { ActionApprovalConsumeError } from '../action-approval-consume.js';

/**
 * One typed refusal for every registry rule. `code` reaches the client as
 * `error.data.cause.code` (see the contracts error formatter), and the message
 * never carries internals.
 */
export type RegistryErrorCode =
  | 'registries.live_mode_refused'
  | 'registries.venue_unknown'
  | 'registries.not_found'
  | 'registries.already_exists'
  | 'registries.version_conflict'
  | 'registries.create_must_be_inert'
  | 'registries.limits_inverted'
  | 'registries.network_unknown'
  | 'registries.asset_not_on_network'
  | 'registries.not_routable'
  | 'registries.enabled_needs_testnet';

const KIND: Record<RegistryErrorCode, TRPCError['code']> = {
  'registries.live_mode_refused': 'FORBIDDEN',
  'registries.venue_unknown': 'BAD_REQUEST',
  'registries.not_found': 'NOT_FOUND',
  'registries.already_exists': 'CONFLICT',
  'registries.version_conflict': 'CONFLICT',
  'registries.create_must_be_inert': 'BAD_REQUEST',
  'registries.limits_inverted': 'BAD_REQUEST',
  'registries.network_unknown': 'BAD_REQUEST',
  'registries.asset_not_on_network': 'BAD_REQUEST',
  'registries.not_routable': 'PRECONDITION_FAILED',
  'registries.enabled_needs_testnet': 'BAD_REQUEST',
};

export class RegistryError extends Error {
  constructor(
    readonly code: RegistryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RegistryError';
  }
}

/** Domain errors become tRPC errors with the typed cause kept; anything else is rethrown untouched. */
export function toTrpcError(error: unknown): unknown {
  if (error instanceof TRPCError) return error;
  if (error instanceof RegistryError) {
    return new TRPCError({ code: KIND[error.code], message: `${error.code}: ${error.message}`, cause: error });
  }
  if (error instanceof DualControlError || error instanceof ActionApprovalConsumeError) {
    return new TRPCError({ code: 'PRECONDITION_FAILED', message: error.message, cause: error });
  }
  return error;
}
