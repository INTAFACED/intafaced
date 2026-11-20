import { TRPCError } from '@intafaced/contracts';
import type { RefusalOf } from '@intafaced/contracts/procedure-mount';
import { AllowlistError } from './withdrawals/allowlist/errors.js';

/**
 * svc-pay's one reader of its refusals for a door mounted from a record (`mountRecord`): each handler runs inside the
 * router's `wrap`, so a refusal arrives already in its wire form (`toTrpcError`), and its code is the typed error it was
 * made from. Anything else (an opaque failure, a scope or region refusal from the guard) is not a named refusal and leaves
 * as it was made.
 */
export const payRefusal: RefusalOf = (err) =>
  err instanceof TRPCError && err.cause instanceof AllowlistError ? { code: err.cause.code, error: err } : undefined;
