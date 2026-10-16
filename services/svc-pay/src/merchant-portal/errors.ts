import { TRPCError } from '@intafaced/contracts';
import { PayError } from '../payment-service.js';
import { ListQueryError } from '../list-page.js';
import { MetricsError, metricsToTrpcError } from '../metrics/errors.js';

export type PortalErrorKind = 'not_found' | 'forbidden' | 'bad_request' | 'conflict' | 'precondition';

/**
 * Refusals for the merchant portal procedures. The message is the code only, so
 * a missing id and a foreign id that share a code are byte-identical.
 */
export class PortalError extends Error {
  constructor(
    readonly code: `pay.${string}`,
    readonly kind: PortalErrorKind,
  ) {
    super(code);
    this.name = 'PortalError';
  }
}

const TRPC_CODE = {
  not_found: 'NOT_FOUND',
  forbidden: 'FORBIDDEN',
  bad_request: 'BAD_REQUEST',
  conflict: 'CONFLICT',
  precondition: 'PRECONDITION_FAILED',
} as const satisfies Record<PortalErrorKind, string>;

export async function wrapPortal<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof PortalError) {
      throw new TRPCError({ code: TRPC_CODE[err.kind], message: err.code, cause: err });
    }
    if (err instanceof ListQueryError) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: err.code, cause: err });
    }
    if (err instanceof PayError) {
      const code =
        err.code === 'pay.merchant_not_found'
          ? 'NOT_FOUND'
          : err.code === 'pay.submerchant_permission_denied'
            ? 'FORBIDDEN'
            : 'BAD_REQUEST';
      throw new TRPCError({ code, message: err.message, cause: err });
    }
    if (err instanceof MetricsError) throw metricsToTrpcError(err);
    throw err;
  }
}
