import { TRPCError } from '@intafaced/contracts';
import { PayError } from '../payment-service.js';

/** A PayFac parent that lacks a metrics area is refused by name (`pay.submerchant_permission_denied`) as FORBIDDEN. */
export function toPayfacTrpcError(err: unknown): unknown {
  if (err instanceof PayError) {
    return new TRPCError({ code: 'FORBIDDEN', message: `${err.code}: ${err.message}`, cause: err });
  }
  return err;
}
