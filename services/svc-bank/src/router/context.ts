import { consumeBankOpsApproval, consumeBankOpsApprovalPair, unwiredApprovalConsumer } from '../action-approval-consume.js';
import { LimitRequestService } from '../transfers/limit-requests.js';
import { stepUpOff } from '../step-up/step-up-gate.js';
import type { DoorBinding } from '../step-up/money-out-fields.js';
import { type BankRouterOptions } from './shared.js';
import type { BankServices } from '../bank-service.js';
import type { JobProcedure } from '../router.js';

/** The values createBankRouter built before its routers, handed to each area's router. Moved verbatim from router.ts. */
export function createRouterContext(bank: BankServices, options: BankRouterOptions, kept: { readonly jobProcedure: JobProcedure }) {
  const scheduledTransfersEnabled = options.scheduledTransfersEnabled ?? true;
  const interestAccrualEnabled = options.interestAccrualEnabled ?? true;
  const loanAccrualEnabled = options.loanAccrualEnabled ?? true;
  const loanRiskSweepEnabled = options.loanRiskSweepEnabled ?? true;
  const autoInvestEnabled = options.autoInvestEnabled ?? true;
  const autoInvestConvertWired = options.autoInvestConvertWired ?? false;
  const approvals = options.approvals ?? unwiredApprovalConsumer();
  // Same connection as the transfer reads; built lazily so mounts with a partial fake never touch it.
  let limitRequestService: LimitRequestService | undefined;
  const limitRequests = () => (limitRequestService ??= new LimitRequestService(bank.transferOps.sql));
  const stepUp = options.stepUp ?? stepUpOff;
  const stepUpEnforced = stepUp.mode === 'required';
  async function requireStepUp(
    principal: { readonly userId: string; readonly sid: string },
    binding: DoorBinding,
    approvalId: string | undefined,
    replay = true,
  ): Promise<void> {
    await stepUp.require({
      userId: principal.userId,
      sessionId: principal.sid,
      actionType: binding.actionType,
      fields: binding.fields,
      operationKey: binding.operationKey,
      approvalId,
      replay,
    });
  }
  /** The asset of a space the caller names, for the hash. Unknown spaces hash as '' and the service refuses them. */
  async function assetOfSpace(spaceId: string): Promise<string> {
    return (await bank.spaces.find(spaceId))?.assetId ?? '';
  }
  async function consumeOpsApproval(
    input: { readonly approvalId?: string | null; readonly operationId?: string | null },
    targetId: string,
    fields: Record<string, string>,
  ): Promise<string> {
    return consumeBankOpsApproval(approvals, input, targetId, fields);
  }
  /** As consumeOpsApproval, with the proposer and the approval consumed, for a row that records both people. */
  async function consumeOpsApprovalPair(
    input: { readonly approvalId?: string | null; readonly operationId?: string | null },
    targetId: string,
    fields: Record<string, string>,
  ): Promise<{ approvalId: string; requesterId: string; approverId: string }> {
    return consumeBankOpsApprovalPair(approvals, input, targetId, fields);
  }

  return {
    ...kept,
    bank,
    options,
    scheduledTransfersEnabled,
    interestAccrualEnabled,
    loanAccrualEnabled,
    loanRiskSweepEnabled,
    autoInvestEnabled,
    autoInvestConvertWired,
    approvals,
    limitRequests,
    stepUp,
    stepUpEnforced,
    requireStepUp,
    assetOfSpace,
    consumeOpsApproval,
    consumeOpsApprovalPair,
  };
}

export type BankRouterContext = ReturnType<typeof createRouterContext>;
