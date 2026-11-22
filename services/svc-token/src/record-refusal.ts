import { TRPCError } from '@intafaced/contracts/trpc';
import type { RefusalOf } from '@intafaced/contracts/procedure-mount';
import { TokenError } from './token-service.js';

/**
 * svc-token's one reader of its own refusals, for `mountRecord`: a handler's `TokenError` has already left `toTrpcError`
 * as a TRPCError carrying it as its cause, so the wire stays what that mapping sends; this only names its code for the
 * record's list.
 */
export const tokenRefusal: RefusalOf = (err) =>
  err instanceof TRPCError && err.cause instanceof TokenError ? { code: err.cause.code, error: err } : undefined;
