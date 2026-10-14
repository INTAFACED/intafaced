/**
 * MONEY-OUT STEP-UP GATE (ADR 2026-10-14-money-out-step-up, phase 1).
 *
 * Money that leaves for another person, and the standing rights that decide who may move it,
 * need a fresh same-person approval from svc-identity. The caller sends `stepUpApprovalId`
 * beside its normal session token. Bank:
 *
 *   1. recomputes the payload hash from its OWN validated input (never the client's claim),
 *   2. consumes the approval at identity (single use, user + session bound, five minutes),
 *   3. records (approval, operation) so a retry of the SAME operation replays, and a
 *      different operation presenting the same approval is refused.
 *
 * It FAILS CLOSED: identity unreachable or unwired, an unreadable answer, a missing, spent,
 * expired, foreign or mismatched approval all refuse and nothing is posted.
 *
 * Not a bearer: no scope is granted and `trade:withdraw` is neither read nor minted here. The
 * existing `ramps.setWithdrawDestination` / `ramps.offramp` doors keep requiring
 * `trade:withdraw` and never look at an approval.
 *
 * `BANK_STEP_UP_MONEY_OUT=off` (the default) makes `require` a no-op, so every door behaves
 * exactly as before.
 */
import { actionApprovalConsumeInputSchema, type SamePersonActionType } from '@intafaced/contracts';
import { ActionApprovalConsumeError, bankActionPayloadHash, type ActionApprovalConsumer } from '../action-approval-consume.js';
import { BankError } from '../errors.js';
import { MemoryStepUpUseStore, type StepUpUseStore } from './step-up-store.js';

export type StepUpMode = 'off' | 'required';

export const STEP_UP_MODES: readonly StepUpMode[] = ['off', 'required'];

export type StepUpRequest = {
  readonly userId: string;
  readonly sessionId: string;
  readonly actionType: SamePersonActionType;
  /** Every business field the approval must bind. Strings only; the hash sorts the keys. */
  readonly fields: Record<string, string>;
  /** The client-supplied idempotency id inside `fields` (transferId, scheduleId, payrollId, clientId, cardId...). */
  readonly operationKey: string;
  readonly approvalId: string | null | undefined;
  /**
   * True when the operation is naturally idempotent on `operationKey` (a retried transfer is the
   * same transfer), so a repeat with the same approval is answered from the use record. False for
   * state flips like unfreeze, where a repeat could re-apply the change: the second use is refused.
   */
  readonly replay: boolean;
};

export interface StepUpGate {
  readonly mode: StepUpMode;
  require(req: StepUpRequest): Promise<void>;
}

export function parseStepUpMode(raw: string | undefined): StepUpMode {
  if (raw === undefined) return 'off';
  if ((STEP_UP_MODES as readonly string[]).includes(raw)) return raw as StepUpMode;
  throw new Error(`BANK_STEP_UP_MONEY_OUT must be one of ${STEP_UP_MODES.join(' | ')}, got "${raw}"`);
}

/** The gate for tests and for a router built without one: never enforces. */
export const stepUpOff: StepUpGate = {
  mode: 'off',
  async require() {
    return;
  },
};

const IDENTITY_CODE = /\[(action_approval\.[a-z_]+)\]/;

function refuse(
  code: 'bank.step_up_required' | 'bank.step_up_mismatch' | 'bank.step_up_used' | 'bank.step_up_unavailable',
  message: string,
): never {
  throw new BankError(message, code);
}

/** Identity's refusal text carries `[action_approval.<code>]`; anything unreadable is "unavailable". */
function refuseFromConsumeFailure(err: unknown): never {
  if (err instanceof ActionApprovalConsumeError) {
    const code = IDENTITY_CODE.exec(err.message)?.[1];
    switch (code) {
      case 'action_approval.consumed':
        return refuse('bank.step_up_used', 'This approval was already used. Confirm again.');
      case 'action_approval.payload_mismatch':
      case 'action_approval.target_mismatch':
        return refuse('bank.step_up_mismatch', 'The approval was for different details. Confirm again.');
      case 'action_approval.expired':
      case 'action_approval.not_found':
      case 'action_approval.not_approved':
      case 'action_approval.not_pending':
      case 'action_approval.already_terminal':
      case 'action_approval.not_requester':
      case 'action_approval.service_mismatch':
        return refuse('bank.step_up_required', 'A fresh confirmation is required. Confirm again.');
      default:
        break;
    }
  }
  return refuse('bank.step_up_unavailable', 'Confirmation could not be checked right now. Nothing was sent. Try again shortly.');
}

export function createStepUpGate(options: {
  readonly mode: StepUpMode;
  readonly approvals: ActionApprovalConsumer;
  readonly store?: StepUpUseStore;
  readonly clock?: () => Date;
}): StepUpGate {
  const store = options.store ?? new MemoryStepUpUseStore();
  const clock = options.clock ?? (() => new Date());
  return {
    mode: options.mode,
    async require(req) {
      if (options.mode === 'off') return;
      const approvalId = req.approvalId?.trim() ?? '';
      if (approvalId === '') {
        return refuse('bank.step_up_required', 'This needs a fresh confirmation (passkey or authenticator code).');
      }
      const payloadHash = bankActionPayloadHash(req.actionType, req.fields);

      const earlier = await store.get(approvalId);
      if (earlier) {
        if (earlier.userId !== req.userId || earlier.sessionId !== req.sessionId || earlier.actionType !== req.actionType) {
          return refuse('bank.step_up_required', 'A fresh confirmation is required. Confirm again.');
        }
        if (earlier.payloadHash !== payloadHash) {
          return refuse('bank.step_up_mismatch', 'The approval was for different details. Confirm again.');
        }
        if (req.replay && earlier.operationKey === req.operationKey && clock().getTime() < earlier.expiresAt.getTime()) return;
        return refuse('bank.step_up_used', 'This approval was already used. Confirm again.');
      }

      let consumed;
      try {
        consumed = await options.approvals.consume(
          actionApprovalConsumeInputSchema.parse({
            approvalId,
            operationId: approvalId,
            payloadHash,
            targetService: 'svc-bank',
            targetId: req.actionType,
            expectedVersion: '1',
            principalUserId: req.userId,
            principalSessionId: req.sessionId,
          }),
        );
      } catch (err) {
        return refuseFromConsumeFailure(err);
      }
      // Identity already enforced this; a second look costs nothing and survives a misconfigured stub.
      if (consumed.kind !== 'same_person' || consumed.requesterId !== req.userId || consumed.approverId !== req.userId) {
        return refuse('bank.step_up_required', 'A fresh confirmation is required. Confirm again.');
      }

      const winner = await store.record({
        approvalId,
        userId: req.userId,
        sessionId: req.sessionId,
        actionType: req.actionType,
        payloadHash,
        operationKey: req.operationKey,
        expiresAt: new Date(consumed.expiresAt),
      });
      // Two requests raced to spend the same approval: only the same operation may share it.
      if (winner.sessionId !== req.sessionId || winner.operationKey !== req.operationKey || winner.payloadHash !== payloadHash) {
        return refuse('bank.step_up_used', 'This approval was already used. Confirm again.');
      }
    },
  };
}
