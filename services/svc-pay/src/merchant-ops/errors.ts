import { TRPCError } from '@intafaced/contracts';

/**
 * One refusal type for the whole merchant-operations area (W15).
 *
 * `code` reaches the client as `error.data.cause.code`. The message IS the code:
 * it never carries the id the caller sent, so "this belongs to another
 * merchant" and "this does not exist" produce byte-identical answers (isolation
 * rule M1). Do not put ids, names or counts in a message.
 */
export type MerchantOpsErrorKind = 'not_found' | 'forbidden' | 'bad_request' | 'conflict' | 'precondition' | 'unavailable';

export class MerchantOpsError extends Error {
  constructor(
    readonly code: `pay.${string}`,
    readonly kind: MerchantOpsErrorKind,
  ) {
    super(code);
    this.name = 'MerchantOpsError';
  }
}

const TRPC_CODE = {
  not_found: 'NOT_FOUND',
  forbidden: 'FORBIDDEN',
  bad_request: 'BAD_REQUEST',
  conflict: 'CONFLICT',
  precondition: 'PRECONDITION_FAILED',
  unavailable: 'SERVICE_UNAVAILABLE',
} as const satisfies Record<MerchantOpsErrorKind, string>;

export const notFound = (code: `pay.${string}`) => new MerchantOpsError(code, 'not_found');

/** Run a service call and turn its typed refusal into the tRPC error the wire carries. */
export async function wrapOps<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof MerchantOpsError) {
      throw new TRPCError({ code: TRPC_CODE[error.kind], message: error.code, cause: error });
    }
    throw error;
  }
}
