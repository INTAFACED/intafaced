// svc-token's refusal reader, for the records its routers mount: the code of a refusal its handlers send.
import { TRPCError } from '@intafaced/contracts/trpc';
import type { RefusalOf } from '@intafaced/contracts/procedure-mount';
import { ActionApprovalConsumeError } from './action-approval-consume.js';
import { BallotError } from './ballot-tally.js';
import { DualControlError } from './dual-control.js';
import { LaunchError } from './launch/errors.js';
import { TokenError } from './token-service.js';

/** The errors that carry a svc-token refusal's code. */
const coded = (cause: unknown) =>
  cause instanceof TokenError ||
  cause instanceof LaunchError ||
  cause instanceof BallotError ||
  cause instanceof DualControlError ||
  cause instanceof ActionApprovalConsumeError
    ? cause.code
    : undefined;

/**
 * A refusal is a `TRPCError` whose cause is the svc-token error that names it. The same error is handed back, so the wire
 * is what the handler sent; anything else is not named here and leaves as it was thrown.
 */
export const tokenRefusal: RefusalOf = (err) => {
  if (!(err instanceof TRPCError)) return undefined;
  const code = coded(err.cause);
  return code === undefined ? undefined : { code, error: err };
};
