import { TRPCError } from '@intafaced/contracts/trpc';
import type { ProcedureRecord, TrpcTransport } from '@intafaced/contracts/procedure';
import { mountRecord, type RecordHandler, type RefusalOf } from '@intafaced/contracts/procedure-mount';
import { TokenError } from './token-service.js';

/**
 * svc-token's refusal, read once: a handler's `TokenError` has already left `toTrpcError` as a TRPCError carrying it as
 * its cause, so the wire stays what that mapping sends; this only names its code for the record's list.
 */
const tokenRefusal: RefusalOf = (err) =>
  err instanceof TRPCError && err.cause instanceof TokenError ? { code: err.cause.code, error: err } : undefined;

/**
 * One svc-token call mounted from its record: `mountRecord(record, handler, tokenRefusal)`. The router (not made from
 * records as a whole yet) places it at the record's path.
 */
export function mountTokenRecord<const R extends ProcedureRecord & TrpcTransport>(record: R, handler: RecordHandler<R>) {
  return mountRecord(record, handler, tokenRefusal);
}
