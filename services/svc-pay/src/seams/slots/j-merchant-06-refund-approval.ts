import type { PartialPayGuards } from '../guards.js';
import { createRefundApprovalGuards } from '../../refund-control/service.js';

/**
 * Guard slot for the owner's refund approval rule (J-merchant-06 #5), built from `services/svc-pay/src/refund-control/**`.
 *
 * Its own slot, not the W1 control room's: the owner asked for this rule, so it holds whatever PAY_MERCHANT_CONTROLS
 * says, and W1's `off` mode stays a true no-op. No rule set, nothing is held.
 */
export function createRefundApprovalGuardSlot(): PartialPayGuards {
  return createRefundApprovalGuards();
}
