import { TRPCError } from '@intafaced/contracts/trpc';
import type { RefusalOf } from '@intafaced/contracts/procedure-mount';
import { NotifyVerifyCodePepperUnsetError, NotifyVerifyTtlUnsetError } from './notify-service.js';

/**
 * svc-notify's one refusal reader for its record-mounted calls: an owner value the call needs and the owner has not set
 * is PRECONDITION_FAILED with its code. Anything else is not a named refusal and leaves as it was thrown.
 */
export const notifyRefusal: RefusalOf = (err) =>
  err instanceof NotifyVerifyTtlUnsetError || err instanceof NotifyVerifyCodePepperUnsetError
    ? { code: err.code, error: new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err }) }
    : undefined;
