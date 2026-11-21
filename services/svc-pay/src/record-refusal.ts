import { TRPCError } from '@intafaced/contracts';
import type { RefusalOf } from '@intafaced/contracts/procedure-mount';
import { PayError } from './payment-service.js';
import { PayGuardRefusal } from './seams/guards.js';
import { AllowlistError } from './withdrawals/allowlist/errors.js';
import { WithdrawalApprovalError } from './withdrawals/approvals/errors.js';
import { WithdrawalNetworkRuleError } from './withdrawals/network-rules/service.js';
import { WithdrawalQuoteError } from './withdrawals/quotes/errors.js';

/** svc-pay's typed errors: each carries the code a record lists. */
const TYPED = [AllowlistError, PayError, PayGuardRefusal, WithdrawalApprovalError, WithdrawalNetworkRuleError, WithdrawalQuoteError];

/**
 * svc-pay's one reader of its refusals for a door mounted from a record (`mountRecord`): each handler runs inside the
 * router's `wrap`, so a refusal arrives already in its wire form (`toTrpcError`), and its code is the typed error it was
 * made from. Anything else (an opaque failure, a scope or region refusal from the guard) is not a named refusal and leaves
 * as it was made.
 */
export const payRefusal: RefusalOf = (err) => {
  if (!(err instanceof TRPCError)) return undefined;
  const cause: unknown = err.cause;
  const typed = TYPED.find((type) => cause instanceof type);
  return typed && cause instanceof typed ? { code: cause.code, error: err } : undefined;
};
