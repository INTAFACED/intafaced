/**
 * Founder read and halt of in-flight execution children.
 * The EMS journal is the source. A missing journal refuses. A wired empty
 * journal is an empty list, not a guessed zero of money.
 */
import { createHash } from 'node:crypto';
import {
  createIdentityApprovalClient,
  founderAttestationVerdict,
  type ActionApproval,
  type ActionApprovalConsumeInput,
  type ServiceAuthMode,
  type ServiceSigner,
} from '@intafaced/contracts';
import type { EmsOrderEvidence, EmsOrderState } from './oms-ems-store.js';

export const EXECUTION_EMS_STORE_UNWIRED = 'execution.ems_store_unwired' as const;
export const EXECUTION_HALT_SCOPE = 'execution.halt_scope' as const;
export const EXECUTION_IDEMPOTENCY_KEY_INVALID = 'execution.idempotency_key_invalid' as const;
export const EXECUTION_IDEMPOTENCY_CONFLICT = 'execution.idempotency_conflict' as const;
export const EXECUTION_APPROVAL_UNWIRED = 'action_approval.identity_unwired' as const;
export const EXECUTION_APPROVAL_MISSING = 'action_approval.missing' as const;
export const EXECUTION_APPROVAL_WRONG = 'action_approval.wrong_action' as const;

const TERMINAL = new Set<EmsOrderState>(['REJECTED', 'UNWIRED', 'CANCELED']);

export interface InFlightChild {
  readonly clientOrderId: string;
  readonly venueId: string;
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly state: EmsOrderState | null;
  readonly account: string | null;
  readonly session: string | null;
  readonly parentClientOrderId: string | null;
}

export function inFlightChildren(rows: readonly EmsOrderEvidence[]): InFlightChild[] {
  return rows
    .filter((row) => row.state === undefined || !TERMINAL.has(row.state))
    .map((row) => ({
      clientOrderId: row.clientOrderId,
      venueId: row.venueId,
      symbol: row.symbol,
      side: row.side,
      state: row.state ?? null,
      account: row.account ?? null,
      session: row.session ?? null,
      parentClientOrderId: row.parentClientOrderId ?? null,
    }));
}

export class OperatorDeskError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'OperatorDeskError';
  }
}

export function assertIdempotencyKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length < 8 || trimmed.length > 200) {
    throw new OperatorDeskError('idempotencyKey must be 8 to 200 characters', EXECUTION_IDEMPOTENCY_KEY_INVALID);
  }
  return trimmed;
}

export interface HaltScope {
  readonly account?: string;
  readonly session?: string;
  readonly targetId: string;
}

export function haltScope(input: { account?: string; session?: string }): HaltScope {
  const account = input.account?.trim() ?? '';
  const session = input.session?.trim() ?? '';
  if (account && session) {
    throw new OperatorDeskError('halt exactly one account or one session', EXECUTION_HALT_SCOPE);
  }
  if (!account && !session) {
    throw new OperatorDeskError('account or session is required', EXECUTION_HALT_SCOPE);
  }
  return account ? { account, targetId: `halt:${account}` } : { session, targetId: `halt:${session}` };
}

export interface ApprovalConsumer {
  consume(input: ActionApprovalConsumeInput): Promise<ActionApproval>;
}

/** Identity answers or the halt refuses: the shared client bounds the call with a timeout and checks the CONSUMED echo. */
export function createExecutionApprovalClient(
  baseUrl: string,
  internalSecret: string,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
  timeoutMs?: number,
): ApprovalConsumer {
  return createIdentityApprovalClient({
    service: 'svc-execution',
    baseUrl,
    internalSecret,
    s2s,
    timeoutMs,
    fail: (message) => new OperatorDeskError(message, EXECUTION_APPROVAL_UNWIRED),
  });
}

export function unwiredExecutionApproval(): ApprovalConsumer {
  return {
    async consume() {
      throw new OperatorDeskError(
        'IDENTITY_URL is unpublished; execution halt does not invent a second person',
        EXECUTION_APPROVAL_UNWIRED,
      );
    },
  };
}

export function executionHaltHash(targetId: string): string {
  const payload = JSON.stringify({ actionType: 'execution.halt', targetId });
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}

export async function consumeExecutionHalt(
  approvals: ApprovalConsumer | undefined,
  input: { approvalId: string; operationId: string; targetId: string; requesterId: string },
): Promise<ActionApproval> {
  const approvalId = input.approvalId.trim();
  const operationId = input.operationId.trim();
  if (!approvalId || !operationId) {
    throw new OperatorDeskError('approvalId and operationId are required', EXECUTION_APPROVAL_MISSING);
  }
  const consumer = approvals ?? unwiredExecutionApproval();
  let consumed: ActionApproval;
  try {
    consumed = await consumer.consume({
      approvalId,
      operationId,
      payloadHash: executionHaltHash(input.targetId),
      targetService: 'svc-execution',
      targetId: input.targetId,
      expectedVersion: '1',
    });
  } catch (err) {
    if (err instanceof OperatorDeskError) throw err;
    throw new OperatorDeskError(err instanceof Error ? err.message : 'identity did not consume the approval', EXECUTION_APPROVAL_UNWIRED);
  }
  if (consumed.actionType !== 'execution.halt' || consumed.targetService !== 'svc-execution' || consumed.targetId !== input.targetId) {
    throw new OperatorDeskError('the approval is not for this halt', EXECUTION_APPROVAL_WRONG);
  }
  if (consumed.requesterId.trim().toLowerCase() !== input.requesterId.trim().toLowerCase()) {
    throw new OperatorDeskError('the approval was proposed by someone else', EXECUTION_APPROVAL_WRONG);
  }
  const verdict = founderAttestationVerdict(consumed, {
    actionType: 'execution.halt',
    targetService: 'svc-execution',
    targetId: input.targetId,
  });
  if (!verdict.ok) {
    throw new OperatorDeskError('the halt approval is not a consumed protective brake', EXECUTION_APPROVAL_WRONG);
  }
  const approver = consumed.approverId?.trim() ?? '';
  if (!approver || approver.toLowerCase() === consumed.requesterId.trim().toLowerCase()) {
    throw new OperatorDeskError('the approval has no distinct approver', EXECUTION_APPROVAL_MISSING);
  }
  return consumed;
}
