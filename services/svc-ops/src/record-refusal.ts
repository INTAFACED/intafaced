import { TRPCError } from '@intafaced/contracts/trpc';
import type { RefusalOf } from '@intafaced/contracts/procedure-mount';
import { OpsError } from './codes.js';
import { OutreachError } from './outreach/config.js';

/**
 * svc-ops's one reader of its own refusals, for `mountRecord`. Each desk's router already turns its typed error into the
 * `TRPCError` it sends (`mapError`, `deskError` and the like), with that error as the cause, so the error leaves exactly
 * as thrown and the code a record lists is the cause's `code`. Anything else (a cursor this list did not return, a guard's
 * refusal) is not a named refusal and goes on unchanged, so mounting a call from its record moves nothing on the wire. A
 * router whose refusal carries no typed cause keeps its own reader beside it (outreach's `storageRefusal`).
 */
export const opsRefusal: RefusalOf = (err) => {
  if (!(err instanceof TRPCError)) return undefined;
  const cause: unknown = err.cause;
  return cause instanceof OpsError || cause instanceof OutreachError ? { code: cause.code, error: err } : undefined;
};
