// svc-ops's refusal reader, for the records its routers mount: the code of a refusal its handlers send.
import { TRPCError } from '@trpc/server';
import type { RefusalOf } from '@intafaced/contracts/procedure-mount';
import { OpsError } from './codes.js';

/**
 * A refusal is a `TRPCError` whose cause is the `OpsError` that names it. The same error is handed back, so the wire is
 * what the handler sent; anything else is not named here and leaves as it was thrown.
 */
export const opsRefusal: RefusalOf = (err) =>
  err instanceof TRPCError && err.cause instanceof OpsError ? { code: err.cause.code, error: err } : undefined;
